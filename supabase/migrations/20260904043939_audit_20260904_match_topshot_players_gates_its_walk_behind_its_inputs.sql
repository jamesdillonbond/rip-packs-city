-- #54: match-topshot-players is a daily no-op that costs 17-126 s of IO-bound work (a GROUP BY over
-- wallet_moments_cache) to alias 0 names, because nba_players is a 174-row partial load frozen since
-- 2026-05-07 and Fast Break (its only consumer) has never been used. The decision, delegated
-- 2026-09-03: keep the pipeline alive and honest, gate the expensive walk behind its INPUTS.
--
-- A full run happens when any of these changed since the last full run, or when 7 days have
-- passed: nba_players row count, its newest created_at/last_synced_at, nba_player_aliases row count.
-- Otherwise the function returns in milliseconds with `gated: true` and a stated reason, which the
-- edge function forwards into pipeline_runs.extra. The weekly full run still catches new Top Shot
-- names against the (unchanged) roster, so nothing that could match is missed for more than a week.
--
-- State lives in a one-row table the function owns, so the gate does not depend on what the edge
-- function chooses to log. The previous function body was created outside the repo; this migration
-- is now its record (the matching logic below is verbatim, only the gate and the state write are new).

CREATE TABLE IF NOT EXISTS public.match_topshot_players_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_full_run_at timestamptz NOT NULL,
  players integer NOT NULL,
  players_newest timestamptz,
  aliases integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.match_topshot_players_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.match_topshot_players_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.match_topshot_players_state TO service_role;

CREATE OR REPLACE FUNCTION public.match_topshot_players_run()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
SET statement_timeout = '300s'
AS $$
DECLARE
  v_topshot_collection_id uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_skipped int;
  v_auto_aliased int := 0;
  v_total_unresolved int;
  v_needs_review jsonb;
  v_players int;
  v_players_newest timestamptz;
  v_aliases int;
  v_state public.match_topshot_players_state%ROWTYPE;
BEGIN
  -- ── The gate: inputs unchanged and the last full run is younger than 7 days → no walk ──
  SELECT count(*), max(greatest(created_at, last_synced_at)) INTO v_players, v_players_newest FROM public.nba_players;
  SELECT count(*) INTO v_aliases FROM public.nba_player_aliases;
  SELECT * INTO v_state FROM public.match_topshot_players_state WHERE id = true;

  IF FOUND
     AND v_state.last_full_run_at > now() - interval '7 days'
     AND v_state.players = v_players
     AND v_state.players_newest IS NOT DISTINCT FROM v_players_newest
     AND v_state.aliases = v_aliases THEN
    RETURN jsonb_build_object(
      'skipped', 0,
      'auto_aliased', 0,
      'needs_review', '[]'::jsonb,
      'total_unresolved', 0,
      'gated', true,
      'gate_reason', format('inputs unchanged since the last full run at %s (players %s, aliases %s); next full run after %s',
                            to_char(v_state.last_full_run_at, 'YYYY-MM-DD HH24:MI:SS TZ'), v_players, v_aliases,
                            to_char(v_state.last_full_run_at + interval '7 days', 'YYYY-MM-DD HH24:MI:SS TZ')),
      'last_full_run_at', v_state.last_full_run_at
    );
  END IF;

  -- ── Full run (verbatim from the previous body) ──
  CREATE TEMP TABLE _cache_names ON COMMIT DROP AS
  SELECT player_name, COUNT(DISTINCT wallet_address)::int AS owners
  FROM wallet_moments_cache
  WHERE collection_id = v_topshot_collection_id
    AND player_name IS NOT NULL
    AND length(trim(player_name)) > 0
  GROUP BY player_name;

  CREATE TEMP TABLE _resolved ON COMMIT DROP AS
  SELECT cn.player_name
  FROM _cache_names cn
  WHERE EXISTS (
    SELECT 1 FROM nba_players p
    WHERE p.full_name_normalized = normalize_player_name(cn.player_name)
  ) OR EXISTS (
    SELECT 1 FROM nba_player_aliases a
    WHERE a.alias_normalized = normalize_player_name(cn.player_name)
  );

  SELECT COUNT(*) INTO v_skipped FROM _resolved;

  CREATE TEMP TABLE _per_name ON COMMIT DROP AS
  SELECT
    u.player_name,
    u.owners,
    (
      SELECT COUNT(*) FROM nba_players p
      WHERE similarity(p.full_name, u.player_name) >= 0.85
    )::int AS candidate_count,
    (
      SELECT p.id FROM nba_players p
      WHERE similarity(p.full_name, u.player_name) >= 0.85
      ORDER BY similarity(p.full_name, u.player_name) DESC, p.id
      LIMIT 1
    ) AS best_id,
    (
      SELECT MAX(similarity(p.full_name, u.player_name))
      FROM nba_players p
    ) AS best_sim
  FROM _cache_names u
  LEFT JOIN _resolved r ON r.player_name = u.player_name
  WHERE r.player_name IS NULL;

  SELECT COUNT(*) INTO v_total_unresolved FROM _per_name;

  WITH inserts AS (
    INSERT INTO nba_player_aliases (nba_player_id, alias_normalized, source)
    SELECT pn.best_id, normalize_player_name(pn.player_name), 'auto'
    FROM _per_name pn
    WHERE pn.candidate_count = 1 AND pn.best_id IS NOT NULL
    ON CONFLICT (alias_normalized) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_auto_aliased FROM inserts;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'name', t.player_name,
        'owners', t.owners,
        'best_sim', t.best_sim,
        'candidate_count', t.candidate_count
      )
      ORDER BY t.owners DESC
    ),
    '[]'::jsonb
  )
  INTO v_needs_review
  FROM (
    SELECT pn.player_name, pn.owners, pn.best_sim, pn.candidate_count
    FROM _per_name pn
    WHERE pn.candidate_count <> 1 AND pn.owners >= 5
  ) t;

  -- Record the inputs AS OF THE END of this run (aliases includes what this run inserted).
  SELECT count(*) INTO v_aliases FROM public.nba_player_aliases;
  INSERT INTO public.match_topshot_players_state AS s (id, last_full_run_at, players, players_newest, aliases, updated_at)
  VALUES (true, now(), v_players, v_players_newest, v_aliases, now())
  ON CONFLICT (id) DO UPDATE SET
    last_full_run_at = EXCLUDED.last_full_run_at,
    players = EXCLUDED.players,
    players_newest = EXCLUDED.players_newest,
    aliases = EXCLUDED.aliases,
    updated_at = now();

  RETURN jsonb_build_object(
    'skipped', v_skipped,
    'auto_aliased', v_auto_aliased,
    'needs_review', v_needs_review,
    'total_unresolved', v_total_unresolved,
    'gated', false,
    'last_full_run_at', now()
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.match_topshot_players_run() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_topshot_players_run() TO service_role;