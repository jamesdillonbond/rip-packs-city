-- RECOVERED 2026-08-09 by Claude Code (deep-audit D14). This migration was applied
-- to prod on 2026-08-09 but never committed, because the session that applied it
-- could not push. Body below is byte-identical to
-- supabase_migrations.schema_migrations.statements[1] for version 20260809203055 —
-- recovered from prod, not retyped. Re-running is safe: the DO block asserts its
-- preconditions and raises rather than acting on an unexpected state.

-- 2026-08-09 — cut the fifth hourly MV-refresh cron to every 2 hours: jobid for
-- `rpc-refresh-pack-reality-top-ev` (15 * * * * -> 15 */2 * * *).
--
-- WHY THIS WAS HELD BACK EARLIER, AND WHY IT IS NOW SAFE. The 08-09 cadence migration
-- (audit_20260809_halve_cadence_four_wasteful_hourly_mv_refreshes) deliberately excluded this job,
-- citing an unresolved conflation: its trust arm reads `topshot_pack_reality_top_ev`, which was
-- "not obviously the same object as `mv_topshot_pack_reality_top_ev`". Resolved by reading
-- pg_class.relkind: they are genuinely DIFFERENT objects — `v:topshot_pack_reality_top_ev` is a view
-- over `m:mv_topshot_pack_reality_top_ev` — but that does not matter, because the MV is itself
-- watchlisted in `board_mv_refresh_watchlist`, so the binding gate is the SAME
-- `board_mv_refresh_stale_hours` arm (breach 8) that governs the other four. At 2-hourly that is
-- 4 missed ticks of slack, and this job has 24/24 successes in 24h — the lowest-risk member of the set.
--
-- The other arm, `pack_ev_board_max_stale_days` (breach 2 DAYS), is NOT tightened by this: it
-- measures `max(now() - snapshotted_at)` — the age of the DATA, not the refresh cadence — so a
-- 1-hour-longer refresh interval adds at most 1h against a 48h threshold.
--
-- MEASURED (24h): 24 runs, 1,792 worker-seconds, 0 failures, avg 75s per successful run. Halving
-- returns ~900 worker-s/day. Modest next to the 6,201 wasted seconds the first cadence migration
-- addressed, but it is pure waste (a 48-hour tolerance refreshed hourly) and it further relieves the
-- worker-slot pressure behind the `job startup timeout` class that silently stops the uninstrumented
-- tier-B backfills from starting at all.
--
-- Command text deliberately unchanged — `board_mv_refresh_max_stale_hours()` matches jobs to boards
-- with `command ILIKE '%' || matview_name || '%'`, so editing it would silently blind the watchdog.
--
-- REVERT: select cron.alter_job(<jobid>, schedule => '15 * * * *');
--   then restore the watchlist note.

DO $mig$
DECLARE
  r record;
BEGIN
  SELECT jobid, jobname, schedule, active INTO r
    FROM cron.job WHERE jobname = 'rpc-refresh-pack-reality-top-ev';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: rpc-refresh-pack-reality-top-ev not found';
  END IF;
  IF NOT r.active THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: job % is not active', r.jobid;
  END IF;
  IF r.schedule <> '15 * * * *' THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: schedule is %, expected 15 * * * * — someone changed it; re-measure first', r.schedule;
  END IF;

  PERFORM cron.alter_job(r.jobid, schedule => '15 */2 * * *');

  SELECT jobid, schedule INTO r FROM cron.job WHERE jobname = 'rpc-refresh-pack-reality-top-ev';
  IF r.schedule <> '15 */2 * * *' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: schedule is %, expected 15 */2 * * *', r.schedule;
  END IF;
END
$mig$;

UPDATE public.board_mv_refresh_watchlist
   SET note = 'backs /insights/pack-reality top-EV ranker; pg_cron rpc-refresh-pack-reality-top-ev 15 */2 * * * (2-hourly since 2026-08-09, was hourly against a 48h data-age tolerance) -> the live gate is board_mv_refresh_stale_hours breach_at 8 = 4 missed ticks'
 WHERE matview_name = 'mv_topshot_pack_reality_top_ev';
