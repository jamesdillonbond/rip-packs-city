-- R107 (register, P1) — `edition_fmv_current` serves values its own source contradicts, and the
-- fix its column comment names (a periodic FULL reconcile) was UNREACHABLE: the full-rebuild branch
-- was gated on `v_watermark IS NULL`, i.e. only an EMPTY table (inbox 2026-09-19T2350Z). This makes
-- the branch callable, backs the cache up, runs the reconcile once, and schedules it daily.
--
-- Applied from Cowork cloud 2026-09-19 ~7:0x PM PT, on Trevor's "do what you think is best for
-- RPC long term and our users". ⚠ That session's push tooling is its own concern; this file
-- commits as usual.
--
-- ── WHY THIS IS THE RIGHT CALL FOR USERS (the decision, re-litigable) ────────────────────────
--   Eleven public insight boards read this table (R50). Measured 2026-09-19 7:00 PM PT: 105 cached
--   rows name an (edition_id, computed_at) pair that no longer exists in fmv_snapshots and 15 are
--   AHEAD of their edition's newest snapshot — the delete-then-insert class the comment describes.
--   check_edition_fmv_current_source_drift(1) read 1 live disagreement at that minute (edition
--   99b090d0…: cached 2,999.00 vs source 1,649.45 — the pre-haircut ask published as FMV). Every
--   one of these is a price a user can see that the pricing model itself does not hold. A reconcile
--   changes what users are told a moment is worth ONLY in the direction of what the model already
--   says; it invents nothing. Cost measured by the filing: ~27 s warm / 1.56 M buffers for the full
--   DISTINCT ON; on cron_heavy's 600 s budget at 09:36Z (the quietest band of the day, per the
--   portfolio-snapshot filing's failures-per-hour table) that is affordable daily.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────────────────────
--   1. `refresh_edition_fmv_current(p_full boolean DEFAULT false)` replaces the zero-arg function
--      (DROP + CREATE: a defaulted parameter beside the old signature would make `f()` ambiguous).
--      Body is the live body verbatim except `v_full := p_full OR v_watermark IS NULL`. The prune in
--      the full branch stays — it removes ONLY cache rows whose edition has NO snapshot at all
--      (measured: 0 such rows today). The existing caller `refresh_series_detail_rollup()` (jobid 357,
--      cron_heavy, hourly :59) calls `refresh_edition_fmv_current()` and resolves to the default.
--      🚨 cron_heavy held an EXPLICIT EXECUTE grant on the old OID; a DROP loses it and jobid 357
--      would fail as silence — re-granted below and asserted with has_function_privilege.
--   2. A backup of the pre-reconcile cache: `audit_20260919_efc_full_reconcile_backup` (RLS on,
--      no anon/authenticated grants) — the revert path for the DATA half.
--   3. `run_edition_fmv_current_full_reconcile_job()` — the house wrapper: calls the full branch and
--      writes a `pipeline_runs` row (`edition-fmv-current-full-reconcile`) so the sentinel sees it.
--   4. pg_cron `rpc-edition-fmv-current-full-reconcile` as cron_heavy at `36 9 * * *` (09:36Z =
--      2:36 AM PT; no job carries that minute in that hour). The first real run is dispatched by
--      hand right after this applies (one-off job, unscheduled afterwards) and its numbers go in
--      the ledger.
--
-- EXIT: after the first full run, check_edition_fmv_current_source_drift(1) reads [] and the
--   orphan-pair count (cache rows naming a missing (edition_id, computed_at)) reads 0; then the
--   09:36Z tick reads `succeeded` daily with a pipeline_runs row.
-- FALSIFIER: drift rows or orphan pairs that do NOT go to ~0 after a full run mean the drift has a
--   second mechanism and the watermark was never the whole story (the filing's own caveat).
-- REVERT (data): TRUNCATE public.edition_fmv_current; INSERT INTO public.edition_fmv_current
--   SELECT * FROM public.audit_20260919_efc_full_reconcile_backup;
-- REVERT (code): re-apply the zero-arg refresh_edition_fmv_current() from 20260823181157 (the last body-defining migration; 20260919022626 only changed the COMMENT), DROP the
--   p_full overload and the wrapper, cron.unschedule('rpc-edition-fmv-current-full-reconcile').
--
-- anon-exec: intentional — both functions REVOKEd from PUBLIC, anon, authenticated below; callers
-- are pg_cron (cron_heavy) and refresh_series_detail_rollup (refresh_edition_fmv_current,
-- run_edition_fmv_current_full_reconcile_job)

CREATE TABLE IF NOT EXISTS public.audit_20260919_efc_full_reconcile_backup AS
  SELECT * FROM public.edition_fmv_current;
ALTER TABLE public.audit_20260919_efc_full_reconcile_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260919_efc_full_reconcile_backup FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.audit_20260919_efc_full_reconcile_backup IS
  'Pre-reconcile copy of edition_fmv_current taken 2026-09-19 ~7:0x PM PT before the first callable FULL reconcile (R107). Revert path only; drop after 2026-10-19.';

DROP FUNCTION IF EXISTS public.refresh_edition_fmv_current();

CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_current(p_full boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_stamp     timestamptz := now();
  v_watermark timestamptz;
  v_cutoff    timestamptz;
  v_rows      int;
  v_pruned    int := 0;
  v_full      boolean;
BEGIN
  SELECT max(computed_at) INTO v_watermark FROM edition_fmv_current;
  -- 2026-09-19 (R107): callable on demand. Until today this was `v_watermark IS NULL`, i.e. only
  -- an EMPTY table could ever take the full branch, so the reconcile the column comment asks for
  -- did not exist as a schedulable thing.
  v_full := p_full OR v_watermark IS NULL;

  IF v_full THEN
    -- Cold start, or the daily reconcile. ~1.2M+ rows; ~27 s warm, minutes when cold.
    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.edition_id)
             s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM fmv_snapshots s
      ORDER BY s.edition_id, s.computed_at DESC
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    -- Prune = cache rows whose edition no longer has ANY snapshot (every edition with one was
    -- just stamped v_stamp above). Measured 0 such rows on 2026-09-19.
    DELETE FROM edition_fmv_current WHERE refreshed_at < v_stamp;
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  ELSE
    v_cutoff := v_watermark - interval '2 hours';

    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.edition_id)
             s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM fmv_snapshots s
      WHERE s.computed_at > v_cutoff
      ORDER BY s.edition_id, s.computed_at DESC
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at
    -- Never move a row backwards: a late-arriving OLDER snapshot must not
    -- overwrite a newer one just because it was written after it.
    WHERE EXCLUDED.computed_at >= t.computed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'full_rebuild', v_full,
    'watermark', v_watermark,
    'cutoff', v_cutoff,
    'upserted', v_rows,
    'pruned', v_pruned,
    'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_edition_fmv_current(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_edition_fmv_current(boolean) TO cron_heavy;

COMMENT ON FUNCTION public.refresh_edition_fmv_current(boolean) IS
  'Refreshes edition_fmv_current. p_full=false (default): incremental, snapshots newer than max(computed_at)-2h — cannot see a delete-then-insert correction that keeps its computed_at. p_full=true: full DISTINCT ON over fmv_snapshots plus a prune of editions with no snapshot; the daily reconcile (jobid rpc-edition-fmv-current-full-reconcile, 09:36Z, cron_heavy) runs this. Callers: refresh_series_detail_rollup() hourly (incremental) and run_edition_fmv_current_full_reconcile_job() daily (full). 2026-09-19, R107.';

CREATE OR REPLACE FUNCTION public.run_edition_fmv_current_full_reconcile_job()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
BEGIN
  BEGIN
    v_res := public.refresh_edition_fmv_current(true);
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 at cron_heavy's 600 s role budget: the reconcile rolls back whole, the
    -- cache keeps its previous state, and the row below still lands.
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run(
    'edition-fmv-current-full-reconcile', v_started, 0,
    (v_res->>'upserted')::int, (v_res->>'pruned')::int, v_ok, v_err,
    p_extra => coalesce(v_res, '{}'::jsonb) || jsonb_build_object('via', 'pg_cron',
      'wall_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN coalesce(v_res, jsonb_build_object('ok', false, 'error', v_err));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_edition_fmv_current_full_reconcile_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_edition_fmv_current_full_reconcile_job() TO cron_heavy;

COMMENT ON FUNCTION public.run_edition_fmv_current_full_reconcile_job() IS
  'Daily FULL reconcile of edition_fmv_current (R107): calls refresh_edition_fmv_current(true) and writes a pipeline_runs row edition-fmv-current-full-reconcile. Scheduled as cron_heavy at 36 9 UTC (2026-09-19).';

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule(
  'rpc-edition-fmv-current-full-reconcile',
  '36 9 * * *',
  'SELECT public.run_edition_fmv_current_full_reconcile_job();'
);
RESET ROLE;

DO $$
DECLARE v_user text; v_sched text;
BEGIN
  IF NOT has_function_privilege('cron_heavy', 'public.refresh_edition_fmv_current(boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'cron_heavy lost EXECUTE on refresh_edition_fmv_current — jobid 357 would fail as silence';
  END IF;
  IF NOT has_function_privilege('cron_heavy', 'public.run_edition_fmv_current_full_reconcile_job()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cron_heavy has no EXECUTE on the wrapper';
  END IF;
  IF has_function_privilege('anon', 'public.refresh_edition_fmv_current(boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.run_edition_fmv_current_full_reconcile_job()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'refresh_edition_fmv_current' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one refresh_edition_fmv_current overload';
  END IF;
  SELECT username, schedule INTO v_user, v_sched FROM cron.job WHERE jobname = 'rpc-edition-fmv-current-full-reconcile';
  IF v_user IS DISTINCT FROM 'cron_heavy' OR v_sched <> '36 9 * * *' THEN
    RAISE EXCEPTION 'reconcile job not scheduled as expected: % %', v_user, v_sched;
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE relname = 'audit_20260919_efc_full_reconcile_backup') IS NOT TRUE THEN
    RAISE EXCEPTION 'backup table has RLS off';
  END IF;
  IF (SELECT count(*) FROM public.audit_20260919_efc_full_reconcile_backup) <> (SELECT count(*) FROM public.edition_fmv_current) THEN
    RAISE EXCEPTION 'backup row count differs from the live cache';
  END IF;
END $$;
