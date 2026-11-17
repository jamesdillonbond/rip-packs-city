-- 2026-10-02 (PT) — the Top Shot stub resolver stops re-asking the chain, 2,300
-- times a day, for player names the chain has already said it does not have.
--
-- WHY. `resolve-topshot-stubs` (cron-job.org → /api/cron/resolve-topshot-stubs →
-- edge fn topshot-stub-resolver, every 30 min) pulls 50 stub editions from
-- get_topshot_stub_targets(), asks the Flow REST node for each play's metadata
-- and fills whatever is missing. Measured 10-02 ~9:00 AM PT: the eligible queue
-- is 226 editions, EVERY one missing only `player_name`, and every one a team or
-- multi-player set (Clamps 66, Fit Check 34, Dynamic Duos 28, Skyline 17, Squad
-- Goals 17, The Champion's Path 15+11, Season Rewind …) whose on-chain play has
-- no FullName at all. The last 48 runs (24 h) each report `targets_found: 50,
-- rows_resolved: 0, rows_no_change_no_onchain_player: 50`; the queue rotates on
-- updated_at, so every edition is re-asked ~10× a day. Cost: 48 lambda runs of
-- 12–30 s (1,030 worker-seconds / 24 h, all on runs that wrote nothing), ~2,300
-- Cadence calls a day, and ~2,300 no-op `editions` UPDATEs (each firing the
-- updated_at trigger). 20260902092542 halved this queue (520 → 253) by filling
-- names from wallet_moments_cache; what is left is the part no source can fill.
--
-- WHAT. Record the chain's "no player" answer and let it suppress the edition
-- for 30 days — a suppression with its own age, re-checked monthly, never a
-- permanent exclusion (the chain's metadata could in principle gain a name).
--
--   1. `topshot_stub_chain_checks (edition_id PK, checked_at, checks)`: one row
--      per edition the chain has been asked about and could not name. Its own
--      table, not a column on `editions` (no %ROWTYPE / SELECT * blast radius).
--   2. `upsert_topshot_edition_metadata` — SOLE caller is topshot-stub-resolver
--      (repo grep: index.ts + its _shared parse helper; no DB function calls it),
--      which passes `p_player_name` = the chain's answer for the play. The UPDATE
--      and the boolean are unchanged; after it, when the chain gave no name
--      (`p_player_name IS NULL`) and the edition still has none, the check row is
--      stamped (upsert; count of checks kept). A name arriving later is written as
--      before — the stamp is then irrelevant because the target predicate keys on
--      the missing name, not on the stamp.
--   3. `get_topshot_stub_targets` — excludes editions stamped within 30 days.
--   4. `v_topshot_stub_queue` — the honest read: eligible / suppressed / due, so
--      a run reporting "no stub targets" can be told apart from "no stubs".
--
-- Effect: the next five runs stamp the 226 (50 a run), then the lane reads
-- `targets_found: 0` ("no stub targets") in ~1 s instead of 12–30 s, 48× a day;
-- each edition is re-asked once per 30 days (~8 a day in steady state).
--
-- Positive control inside this migration: one eligible edition is put through
-- the upsert with a NULL player name (exactly what the next run would do to it
-- ~30 min from now), the stamp must exist, and the targets RPC must stop
-- returning it. Live function bodies carried verbatim from pg_proc.prosrc
-- (upsert md5 0523d75d…, targets md5 048971aa…); headers preserved.
--
-- Revert: DROP VIEW public.v_topshot_stub_queue; re-apply the two bodies from
--   20260510073500 (upsert; live body == this file minus the stamp block) and
--   20260902092542 (targets); DROP TABLE public.topshot_stub_chain_checks.

CREATE TABLE IF NOT EXISTS public.topshot_stub_chain_checks (
  edition_id uuid PRIMARY KEY REFERENCES public.editions(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL DEFAULT now(),
  checks     integer     NOT NULL DEFAULT 1
);
COMMENT ON TABLE public.topshot_stub_chain_checks IS
  'Top Shot stub editions the chain has been asked to name and could not (play metadata carries no FullName — team / multi-player sets). Stamped by upsert_topshot_edition_metadata when called with a NULL player name for an edition still missing one; get_topshot_stub_targets skips an edition stamped within 30 days. A suppression with an age, not an exclusion.';
ALTER TABLE public.topshot_stub_chain_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_stub_chain_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.topshot_stub_chain_checks TO postgres, service_role;

-- anon-exec: unchanged (upsert_topshot_edition_metadata) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false authenticated=false 2026-10-02.
CREATE OR REPLACE FUNCTION public.upsert_topshot_edition_metadata(p_edition_id uuid, p_player_name text, p_set_name text, p_tier tier_type, p_circulation_count integer DEFAULT NULL::integer, p_thumbnail_url text DEFAULT NULL::text, p_video_url text DEFAULT NULL::text, p_team text DEFAULT NULL::text, p_series integer DEFAULT NULL::integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_before public.editions%ROWTYPE;
  v_after  public.editions%ROWTYPE;
BEGIN
  SELECT * INTO v_before
    FROM editions
   WHERE id = p_edition_id
     AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Unconditional: the match itself is the attempt record (updated_at cursor).
  -- Field semantics are unchanged — fill-only, never overwrite a present value.
  UPDATE editions
     SET player_name       = COALESCE(NULLIF(player_name,''), p_player_name),
         set_name          = COALESCE(NULLIF(set_name,''),    p_set_name),
         tier              = COALESCE(tier, p_tier),
         circulation_count = COALESCE(circulation_count, p_circulation_count),
         thumbnail_url     = COALESCE(NULLIF(thumbnail_url,''), p_thumbnail_url),
         video_url         = COALESCE(NULLIF(video_url,''), p_video_url),
         team_name         = COALESCE(NULLIF(team_name,''), p_team),
         series            = COALESCE(series, p_series::smallint)
   WHERE id = p_edition_id
     AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  RETURNING * INTO v_after;

  -- 2026-10-02: the caller (topshot-stub-resolver, the only one) passes the
  -- chain's answer. No name from the chain for an edition still missing one is
  -- a fact worth keeping: stamp it so get_topshot_stub_targets() can rest this
  -- edition for 30 days instead of re-asking ~10x a day. Fill-only semantics
  -- above are untouched; a name that arrives later still lands.
  IF p_player_name IS NULL AND (v_after.player_name IS NULL OR v_after.player_name = '') THEN
    INSERT INTO public.topshot_stub_chain_checks (edition_id, checked_at, checks)
    VALUES (p_edition_id, now(), 1)
    ON CONFLICT (edition_id) DO UPDATE
      SET checked_at = now(), checks = public.topshot_stub_chain_checks.checks + 1;
  END IF;

  -- TRUE only if a tracked column actually took a new value. Compared post-trigger
  -- so a normalizer (zzz_topshot_normalize_base_club_circulation) counts as a change.
  RETURN (v_after.player_name, v_after.set_name, v_after.tier, v_after.circulation_count,
          v_after.thumbnail_url, v_after.video_url, v_after.team_name, v_after.series)
     IS DISTINCT FROM
         (v_before.player_name, v_before.set_name, v_before.tier, v_before.circulation_count,
          v_before.thumbnail_url, v_before.video_url, v_before.team_name, v_before.series);
END;
$function$;

-- anon-exec: unchanged (get_topshot_stub_targets) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false authenticated=false 2026-10-02.
CREATE OR REPLACE FUNCTION public.get_topshot_stub_targets(p_limit integer DEFAULT 50)
 RETURNS TABLE(edition_id uuid, external_id text, play_id_onchain bigint, set_id_onchain bigint, has_player_name boolean, has_set_name boolean, has_tier boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT e.id,
         e.external_id,
         e.play_id_onchain,
         e.set_id_onchain,
         (e.player_name IS NOT NULL AND e.player_name <> ''),
         (e.set_name IS NOT NULL AND e.set_name <> ''),
         (e.tier IS NOT NULL)
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (
      e.player_name IS NULL OR e.player_name = ''
      OR e.set_name IS NULL OR e.set_name = ''
      OR e.tier IS NULL
    )
    AND e.play_id_onchain IS NOT NULL
    AND e.set_id_onchain  IS NOT NULL
    -- 2026-10-02: rest an edition the chain could not name for 30 days
    -- (topshot_stub_chain_checks, stamped by upsert_topshot_edition_metadata).
    AND NOT EXISTS (SELECT 1 FROM public.topshot_stub_chain_checks c
                     WHERE c.edition_id = e.id AND c.checked_at > now() - interval '30 days')
  -- least-recently-ATTEMPTED first: every attempt bumps updated_at via
  -- trg_editions_updated, so this rotates the whole queue instead of grinding
  -- the same oldest 50 rows. created_at is the tiebreak for never-touched rows.
  ORDER BY e.updated_at ASC NULLS FIRST, e.created_at ASC
  LIMIT p_limit;
$function$;

-- The honest read of the queue: a run that logs "no stub targets" can be told
-- apart from "no stubs left".
CREATE OR REPLACE VIEW public.v_topshot_stub_queue
WITH (security_invoker = on) AS
  WITH elig AS (
    SELECT e.id
    FROM public.editions e
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND (e.player_name IS NULL OR e.player_name = '' OR e.set_name IS NULL OR e.set_name = '' OR e.tier IS NULL)
      AND e.play_id_onchain IS NOT NULL AND e.set_id_onchain IS NOT NULL
  )
  SELECT (SELECT count(*) FROM elig)::integer AS eligible,
         (SELECT count(*) FROM elig x JOIN public.topshot_stub_chain_checks c ON c.edition_id = x.id
           WHERE c.checked_at > now() - interval '30 days')::integer AS resting_chain_no_player,
         (SELECT count(*) FROM elig x WHERE NOT EXISTS (SELECT 1 FROM public.topshot_stub_chain_checks c
           WHERE c.edition_id = x.id AND c.checked_at > now() - interval '30 days'))::integer AS due,
         (SELECT min(c.checked_at) + interval '30 days' FROM elig x JOIN public.topshot_stub_chain_checks c ON c.edition_id = x.id) AS next_recheck_at;
COMMENT ON VIEW public.v_topshot_stub_queue IS
  'Top Shot stub-resolver queue: eligible stubs, how many are resting because the chain had no player name for them (30-day suppression), how many the next run will pull, and when the first rest expires.';
REVOKE ALL ON public.v_topshot_stub_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_topshot_stub_queue TO postgres, service_role;

-- Positive control + post-conditions.
DO $$
DECLARE
  v_id uuid;
  v_set text;
  v_changed boolean;
  v_before_due integer;
  v_after_due integer;
  v_stamps integer;
BEGIN
  IF has_function_privilege('anon', 'public.upsert_topshot_edition_metadata(uuid,text,text,tier_type,integer,text,text,text,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_topshot_stub_targets(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'stub RPCs: anon EXECUTE appeared';
  END IF;
  SELECT due INTO v_before_due FROM public.v_topshot_stub_queue;
  -- one eligible edition that still has a set name (so the resolver would reach the upsert)
  SELECT t.edition_id, e.set_name INTO v_id, v_set
    FROM public.get_topshot_stub_targets(1) t JOIN public.editions e ON e.id = t.edition_id
   WHERE e.set_name IS NOT NULL AND e.set_name <> '' AND (e.player_name IS NULL OR e.player_name = '');
  IF v_id IS NULL THEN
    RAISE NOTICE 'no eligible nameless edition to control on; skipping the positive control';
    RETURN;
  END IF;
  v_changed := public.upsert_topshot_edition_metadata(v_id, NULL, v_set, NULL);
  IF v_changed THEN RAISE EXCEPTION 'control: a NULL-name upsert reported a change on %', v_id; END IF;
  SELECT count(*) INTO v_stamps FROM public.topshot_stub_chain_checks WHERE edition_id = v_id AND checked_at > now() - interval '1 minute';
  IF v_stamps <> 1 THEN RAISE EXCEPTION 'control: expected one fresh stamp for %, found %', v_id, v_stamps; END IF;
  IF EXISTS (SELECT 1 FROM public.get_topshot_stub_targets(1000) t WHERE t.edition_id = v_id) THEN
    RAISE EXCEPTION 'control: stamped edition % is still a target', v_id;
  END IF;
  SELECT due INTO v_after_due FROM public.v_topshot_stub_queue;
  IF v_after_due <> v_before_due - 1 THEN
    RAISE EXCEPTION 'control: due should drop by exactly one (% -> %)', v_before_due, v_after_due;
  END IF;
  RAISE NOTICE 'control ok: edition % stamped and rested; due % -> %', v_id, v_before_due, v_after_due;
END $$;
