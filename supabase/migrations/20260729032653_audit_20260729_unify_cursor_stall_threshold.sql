-- 2026-07-29 — close the 2h..6h blind window in indexer alerting.
--
-- DEFECT: the cursor-stall threshold was expressed TWICE at two different values.
--   * view public.silent_indexer_failures classified 'cursor_stalled' at 2h
--   * get_pipeline_alerts() alerted on it at 6h, reading event_cursor directly
-- The view's CASE is first-match-wins, so at 2h an indexer flipped to
-- 'cursor_stalled' and thereby stopped matching the 'ok' / 'resolving_editions' /
-- 'silent_failure' arms that get_pipeline_alerts() consumes. Nothing alerts on the
-- 'cursor_stalled' STATUS, and the real cursor_stalled arm is on its own 6h clock —
-- so between 2h and 6h the indexer emitted NO alert of any kind.
-- Observed live 2026-07-29: ufc_sales, cursor age 2.27h, unmapped_written_24h 210,
-- status 'cursor_stalled', absent from get_pipeline_alerts() entirely.
--
-- FIX: express the threshold ONCE (public.cursor_stall_threshold) and have both
-- objects call it, at the alerting value of 6h. Between 2h and 6h an indexer now
-- keeps its prior honest classification ('ok' / 'resolving_editions') and stays
-- visible under it, until the real 6h alert fires. No new alert volume: lowering
-- the alert arm to 2h instead would have paged on cursors legitimately idle 2-6h
-- (several watchlist entries are max-governed well past 2h).
--
-- REVERT:
--   1) restore the view arm to the 2h literal:
--      ... WHEN cursor_updated_at < (now() - '02:00:00'::interval) THEN 'cursor_stalled' ...
--   2) restore the alert arm literal: WHERE updated_at < now() - interval '6 hours'
--   3) DROP FUNCTION public.cursor_stall_threshold();

-- 1. The single source of truth.
CREATE OR REPLACE FUNCTION public.cursor_stall_threshold()
RETURNS interval
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$ SELECT interval '6 hours' $fn$;

COMMENT ON FUNCTION public.cursor_stall_threshold() IS
  'Canonical cursor-staleness threshold. Called by BOTH public.silent_indexer_failures '
  '(the cursor_stalled status arm) and get_pipeline_alerts() (the cursor_stalled alert arm) '
  'so the two can never drift apart. These were 2h and 6h respectively until 2026-07-29, '
  'which left a 4h window where a stalled indexer matched no alert arm at all. '
  'Guarded by check_cursor_stall_threshold_drift().';

REVOKE EXECUTE ON FUNCTION public.cursor_stall_threshold() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cursor_stall_threshold() TO postgres, service_role;

-- 2. Repoint the view's CASE arm. Rebuilt from pg_get_viewdef via a guarded
--    replace so the rest of the definition stays byte-identical; the guard
--    RAISEs (aborting the migration) rather than silently no-opping on a miss.
DO $mig$
DECLARE
  v_def  text;
  v_hits int;
  c_old  constant text := 'cursor_updated_at < (now() - ''02:00:00''::interval)';
  c_new  constant text := 'cursor_updated_at < (now() - public.cursor_stall_threshold())';
BEGIN
  v_def  := pg_get_viewdef('public.silent_indexer_failures'::regclass, true);
  v_hits := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'silent_indexer_failures: expected exactly 1 occurrence of the 2h cursor_stalled arm, found %', v_hits;
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.silent_indexer_failures AS ' || replace(v_def, c_old, c_new);
END
$mig$;

-- CREATE OR REPLACE VIEW wipes reloptions — re-assert (this has bitten twice this week).
ALTER VIEW public.silent_indexer_failures SET (security_invoker = true);

-- 3. Repoint the alert arm. Same guarded-replace discipline; ACL, owner and
--    SECURITY DEFINER survive CREATE OR REPLACE FUNCTION.
DO $mig$
DECLARE
  v_def  text;
  v_hits int;
  c_old  constant text := 'WHERE updated_at < now() - interval ''6 hours''';
  c_new  constant text := 'WHERE updated_at < now() - public.cursor_stall_threshold()';
BEGIN
  v_def  := pg_get_functiondef('public.get_pipeline_alerts()'::regprocedure);
  v_hits := (length(v_def) - length(replace(v_def, c_old, ''))) / length(c_old);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'get_pipeline_alerts: expected exactly 1 occurrence of the 6h cursor_stalled arm, found %', v_hits;
  END IF;
  EXECUTE replace(v_def, c_old, c_new);
END
$mig$;