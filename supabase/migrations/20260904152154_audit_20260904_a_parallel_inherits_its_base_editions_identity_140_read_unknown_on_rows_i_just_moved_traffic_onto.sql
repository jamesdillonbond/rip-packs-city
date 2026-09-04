-- Found by opening the corrected parallel ladder and reading it as a collector would.
-- `98:3150::5` — the Coded parallel of the Sacramento Kings *Clamps* Moment — displays
-- **"Unknown — Clamps"**, because its `player_name` is NULL while the base `98:3150` carries
-- "Sacramento Kings".
--
-- A parallel IS the same Moment as its base. Same play, same player, same team; the ONLY thing a
-- `::N` row differs in is the printing. So the base's identity is not a guess for the parallel —
-- it is the same fact, and the `::N` suffix is the proof, since the parallel key is built from the
-- base key. This is why the copy is safe in a way the wmc name-sync explicitly was NOT (there the
-- two sides disagreed on diacritics in BOTH directions, so either could be the wrong one; here
-- one side is empty and the other is the same row's own base).
--
-- MEASURED: 140 of 3,868 Top Shot parallels read "Unknown" or carry no player_name; **107 have a
-- base that does**; 537 holder rows sit on them. The shape is unanimous and it is TEAM Moments —
-- Top Shot's convention is `player_name = team_name` for a team highlight, the base has it, and
-- the parallel was created without it:
--     98:3130::5   Coded  team "Cleveland Cavaliers"  base player "Cleveland Cavaliers", parallel NULL
--     118:4134::9  Bit    team "Cleveland Cavaliers"  base name "2022-23 Season Rewind", parallel same
-- The remaining 33 have a base that is also empty; they are left alone rather than invented.
--
-- ⚠ THESE ARE ROWS I MOVED TRAFFIC ONTO TODAY. The parallel re-key sent 67,530 wmc rows from
-- `set:play` to `set:play::N`, so collectors are now reading edition rows that were never on the
-- display path before — and they are thinner than the base rows they replaced. Same lesson as the
-- mint_count entry: after re-pointing readers at a different row, go and READ that row.
--
-- GUARDS: Top Shot only; parallels only; the parallel's own field must be NULL/empty (never an
-- overwrite); the base's must be non-empty; and `team_name` must already agree where both have one,
-- which is a redundant check on top of the key relationship and costs nothing.
-- anon-exec: REVOKE … FROM PUBLIC, anon, authenticated below; postgres/service_role/cron_heavy only.
-- REVERT: UPDATE public.editions e SET player_name = a.old_player_name, team_name = a.old_team_name,
--           name = a.old_name FROM public.audit_20260904_parallel_identity a WHERE a.edition_id = e.id;
--         SELECT cron.unschedule('rpc-topshot-parallel-identity-sync');

CREATE TABLE IF NOT EXISTS public.audit_20260904_parallel_identity (
  edition_id      uuid PRIMARY KEY,
  external_id     text NOT NULL,
  old_name        text,
  old_player_name text,
  old_team_name   text,
  applied_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260904_parallel_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_parallel_identity FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_parallel_identity TO postgres, service_role, cron_heavy;

CREATE OR REPLACE FUNCTION public.sync_topshot_parallel_identity_from_base(p_limit integer DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started timestamptz := clock_timestamp();
  v_n integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('sync_topshot_parallel_identity_from_base')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  WITH cand AS (
    SELECT e.id, e.external_id,
           e.name AS old_name, e.player_name AS old_player, e.team_name AS old_team,
           CASE WHEN e.name IS NULL OR e.name LIKE 'Unknown%' THEN b.name ELSE e.name END AS new_name,
           CASE WHEN COALESCE(e.player_name, '') = '' THEN b.player_name ELSE e.player_name END AS new_player,
           CASE WHEN COALESCE(e.team_name, '')   = '' THEN b.team_name   ELSE e.team_name   END AS new_team
      FROM public.editions e
      JOIN public.editions b
        ON b.collection_id = e.collection_id
       AND b.external_id   = split_part(e.external_id, '::', 1)
     WHERE e.collection_id = v_ts
       AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
       -- only ever FILL: the parallel must be missing what the base has
       AND (COALESCE(e.player_name, '') = '' OR COALESCE(e.team_name, '') = '' OR e.name LIKE 'Unknown%')
       AND COALESCE(b.player_name, '') <> ''
       -- redundant agreement check on top of the key relationship: if both name a team, it matches
       AND (COALESCE(e.team_name, '') = '' OR COALESCE(b.team_name, '') = '' OR e.team_name = b.team_name)
     LIMIT GREATEST(p_limit, 1)
  ),
  changed AS (
    SELECT * FROM cand
     WHERE new_name   IS DISTINCT FROM old_name
        OR new_player IS DISTINCT FROM old_player
        OR new_team   IS DISTINCT FROM old_team
  ),
  logged AS (
    INSERT INTO public.audit_20260904_parallel_identity (edition_id, external_id, old_name, old_player_name, old_team_name)
    SELECT id, external_id, old_name, old_player, old_team FROM changed
    ON CONFLICT (edition_id) DO NOTHING
  ),
  upd AS (
    UPDATE public.editions e
       SET name        = c.new_name,
           player_name = c.new_player,
           team_name   = c.new_team
      FROM changed c
     WHERE e.id = c.id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;

  IF v_n > 0 THEN
    PERFORM public.log_pipeline_run('topshot-parallel-identity-sync', v_started, v_n, v_n, 0, true, NULL,
              'nba_top_shot', NULL, NULL,
              jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                 'filled', v_n, 'via', 'pg_cron'));
  END IF;
  RETURN jsonb_build_object('filled', v_n);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.sync_topshot_parallel_identity_from_base(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_topshot_parallel_identity_from_base(integer) TO postgres, service_role, cron_heavy;

-- :52 — a free minute; a no-op once drained, and it re-fills any parallel a future catalog write
-- creates without an identity, so this cannot become a treadmill in the other direction.
SELECT cron.schedule('rpc-topshot-parallel-identity-sync', '52 * * * *', $$SELECT public.sync_topshot_parallel_identity_from_base(500)$$);
