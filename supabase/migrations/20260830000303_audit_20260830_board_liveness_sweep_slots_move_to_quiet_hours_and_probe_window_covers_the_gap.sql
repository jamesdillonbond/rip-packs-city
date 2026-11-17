-- audit_20260830_board_liveness_sweep_slots_move_to_quiet_hours_and_probe_window_covers_the_gap
--
-- WHY: public_board_empty_count / public_board_slow_count read 999 (BREACH) for roughly a third of every day, and the
-- 2026-08-29 05:08Z probe comment established the mechanism: jobid 288 (`28 */6`) truncates at 12Z/18Z. Re-measured over
-- 14 days of cron.job_run_details: avg 142 s @00Z (0 failed/14) · 423 s @06Z (3/13) · 620 s @12Z (5/10) · 658 s @18Z (3/12)
-- against a 600 s internal budget and 900 s statement_timeout. A truncated sweep leaves boards unprobed for >8 h, the probe
-- (correctly) calls that inconclusive, and the platform's ONLY dark-public-board detector is blind AND loud for hours.
--
-- WHAT (cadence-neutral, zero added IO -- the same four sweeps a day):
--  (1) jobid 288 rpc-public-board-liveness-sweep  `28 */6 * * *` -> `28 0,6,11,20 * * *`
--      jobid 290 rpc-capture-board-liveness-history `51 */6 * * *` -> `51 0,6,11,20 * * *` (follows the sweep by 23 min, as before)
--      Hours 11 and 20 carry ZERO pg_cron startup timeouts over the last 7 days (12Z: 17, 18Z: 47; measured 2026-08-29 23:5xZ).
--  (2) public_board_liveness_probe: c_max_age_min 480 -> 600. The new slots' widest gap is 11Z -> 20Z = 9 h; a 480-min window
--      would mark every board stale for the last hour of that gap by construction. 600 covers the gap with 1 h of slack and
--      still tolerates exactly ONE missed sweep, never two -- the property the constant was chosen for.
--      ⚠ The 05:08Z comment on this function calls raising this window "forbidden doctrine". That doctrine was written against
--      widening the window INSTEAD of fixing coverage; this migration fixes coverage (the slots) and widens only to the new
--      slots' geometry. A dark board is detected at worst ~2 h later than under 480 -- versus not at all for ~8 h/day today.
--      The comment is appended, not rewritten.
--
-- FALSIFIER (register it, do not assume): if the 11Z or 20Z sweeps truncate (cron.job_run_details duration >= 600 s, or
-- public_board_liveness_probe() reads probed < active after them) the hours were the wrong proxy -- move again from measured data.
--
-- REVERT:
--   SELECT cron.schedule('rpc-public-board-liveness-sweep', '28 */6 * * *', 'SET statement_timeout=''900s''; SELECT public.public_board_liveness_sweep(600000);');
--   SELECT cron.schedule('rpc-capture-board-liveness-history', '51 */6 * * *', 'SELECT public.capture_board_liveness_history()');
--   and re-create public_board_liveness_probe(integer) with c_max_age_min := 480 (the body below is otherwise verbatim).

DO $mig$
DECLARE v1 int; v2 int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 288 AND schedule = '28 */6 * * *' AND username = 'postgres') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: jobid 288 is not at 28 */6 as postgres';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = 290 AND schedule = '51 */6 * * *' AND username = 'postgres') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: jobid 290 is not at 51 */6 as postgres';
  END IF;
  v1 := cron.schedule('rpc-public-board-liveness-sweep', '28 0,6,11,20 * * *', 'SET statement_timeout=''900s''; SELECT public.public_board_liveness_sweep(600000);');
  v2 := cron.schedule('rpc-capture-board-liveness-history', '51 0,6,11,20 * * *', 'SELECT public.capture_board_liveness_history()');
  IF v1 <> 288 OR v2 <> 290 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: jobids changed (% , %) -- expected in-place 288/290', v1, v2;
  END IF;
END
$mig$;

-- anon-exec: intentional — same signature and ACLs as before; read-only probe consumed by rpc_trust_health_precompute_refresh Leg 8 (public_board_liveness_probe)
CREATE OR REPLACE FUNCTION public.public_board_liveness_probe(p_budget_ms integer DEFAULT 60000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  -- Sweeps run at 00/06/11/20Z (jobid 288). 600 min covers the widest gap (11Z -> 20Z, 9 h) with slack and still
  -- tolerates exactly ONE missed sweep, never two. Was 480 while the sweeps sat on */6 -- see 20260830 migration.
  c_max_age_min constant integer := 600;
  n_active  integer;
  n_probed  integer := 0;
  n_empty   integer := 0;
  n_slow    integer := 0;
  v_newest  timestamptz;
  v_stale   boolean;
BEGIN
  -- p_budget_ms is retained ONLY to keep the signature (and therefore the grants and the
  -- existing no-arg call in rpc_trust_health_precompute_refresh Leg 8) unchanged. This
  -- function no longer sweeps; public_board_liveness_sweep() does, on its own schedule.
  PERFORM p_budget_ms;

  SELECT count(*) INTO n_active
    FROM public.public_board_liveness_watchlist WHERE is_active;

  SELECT max(s.checked_at) INTO v_newest
    FROM public.public_board_liveness_state s
    JOIN public.public_board_liveness_watchlist w USING (view_name)
   WHERE w.is_active;

  SELECT
    count(*),
    count(*) FILTER (
      WHERE (s.err IS NOT NULL AND s.err NOT LIKE '57014%')
         OR (s.err IS NULL AND COALESCE(s.row_count, -1) < w.min_rows)),
    count(*) FILTER (
      WHERE (s.err LIKE '57014%')
         OR (s.err IS NULL AND COALESCE(s.elapsed_ms, 0) > w.max_ms))
    INTO n_probed, n_empty, n_slow
    FROM public.public_board_liveness_state s
    JOIN public.public_board_liveness_watchlist w USING (view_name)
   WHERE w.is_active
     AND s.checked_at > now() - make_interval(mins => c_max_age_min);

  -- A stale or partial sweep is INCONCLUSIVE, never green. The caller maps
  -- budget_exhausted -> 999 -> BREACH, so a dead sweep job is LOUD instead of silently
  -- re-serving its last good snapshot as if it were current.
  v_stale := v_newest IS NULL
          OR v_newest < now() - make_interval(mins => c_max_age_min)
          OR n_probed < n_active;

  RETURN jsonb_build_object(
    'probed', n_probed,
    'active', n_active,
    'empty_or_error', n_empty,
    'slow', n_slow,
    'budget_exhausted', v_stale,
    'source', 'public_board_liveness_state',
    'sweep_checked_at', v_newest,
    'sweep_age_min', CASE WHEN v_newest IS NULL THEN NULL
                          ELSE round(EXTRACT(epoch FROM now() - v_newest) / 60.0) END,
    'checked_at', now()
  );
END;
$fn$;

DO $mig$
DECLARE v_old text;
BEGIN
  v_old := obj_description('public.public_board_liveness_probe(integer)'::regprocedure, 'pg_proc');
  IF v_old IS NULL OR position('ALIASED TO THE HOUR' in v_old) = 0 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: the 20260829050847 comment is not present';
  END IF;
  EXECUTE format('COMMENT ON FUNCTION public.public_board_liveness_probe(integer) IS %L', v_old ||
'

=== 2026-08-30 00:1xZ (08-29 17:1x PT) -- THE SLOTS MOVED, AND THE WINDOW FOLLOWED THE SLOTS ===
jobid 288 now runs 28 0,6,11,20 * * * (was 28 */6); jobid 290 follows at :51. Hours 11 and 20 measured ZERO pg_cron startup
timeouts over 7 days; 14-day jobid 288 record by hour was avg 142 s @00Z / 423 s @06Z / 620 s @12Z / 658 s @18Z against the
600 s budget. c_max_age_min is 600 (was 480) ONLY because the widest new gap is 9 h; it still tolerates one missed sweep, not
two. The "forbidden doctrine" above was about widening INSTEAD of fixing coverage; this is coverage first, window to match.
FALSIFIER: a truncated 11Z or 20Z sweep (duration >= 600 s, or probed < active after it) means the hour proxy was wrong.');
END
$mig$;