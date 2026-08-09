-- 2026-08-09 — cut four hourly MV-refresh crons to every 2 hours.
--
-- Applied to prod via Supabase MCP as migration 20260809145945 (Cowork cannot push; this file
-- is the repo record — commit it to close the prod/repo drift window).
--
-- MEASURED over the last 24h of cron.job_run_details (worker-seconds = sum of run wall time,
-- i.e. how long each job squats a pg_cron background-worker slot):
--
--   job                              runs  worker_s  wasted_s(on failures)  ok/24  avg_ok_s
--   rpc-refresh-market-index-daily     24     5,268                 2,407   20      143
--   rpc-refresh-perfect-mint-premiums  24     4,896                 2,576   20      116
--   rpc-refresh-pack-reality-dist      24     2,857                   600   23       98
--   rpc-refresh-pack-reality-stats     24     2,923                   618   22      105
--                                          -------                 -----
--                                           15,944                 6,201
--
-- The shape that matters: a SUCCESSFUL refresh of any of these costs only 98-143s, but a
-- contended one runs into the job's own `SET statement_timeout='600s'` and is killed having
-- produced nothing. ~6,200 worker-seconds/day — 1.7 hours of DB worker time — is spent on runs
-- that write no rows. That waste is ALSO the mechanism behind the `job startup timeout` class
-- (9 distinct jobs in 24h, overwhelmingly the uninstrumented tier-B backfills): a doomed run
-- holds a worker slot for a full 10 minutes and pg_cron then cannot start other jobs at all.
--
-- WHY EXACTLY 2 HOURS — this is the ledger's own verdict, not a fresh guess. The 2026-08-08
-- entry "the #1 cron waster is a 163-row, 128 kB MV burning 2,417 s/day" tabulated the cadence
-- options for jobid 236 against its measured 16.7% failure rate and the public board's
-- `board_mv_refresh_stale_hours` breach at 8:
--
--   hourly (was)  1 failure -> 2h   2 consecutive -> 3h    safe; ~2,417 s/day wasted
--   EVERY 2 H     1 failure -> 4h   2 consecutive -> 6h    SAFE, ~50% saved   <-- shipped here
--   every 3 h     1 failure -> 6h   2 consecutive -> 9h    BREACH; marginal
--   every 6 h     1 failure -> 12h                        BREACH; unsafe
--
-- The later "cadence-cutting stays unsafe" line in the ledger refers to the 6h -> 12h row, not
-- to this one. Three consecutive failures at 2-hourly reach the 8h edge; at 16.7% that is
-- p=0.46% per cycle, well inside the tolerance the same table called marginal at 2.8%. The
-- other three jobs fail less often (4, 1 and 2 times in 24 runs), so their margin is wider.
-- This closes the "2h-cadence lever is still open — do not close it" item from
-- docs/overnight/inbox/2026-08-08T1945Z.md.
--
-- VERIFIED BEFORE SHIPPING, by reading the gate rather than assuming it:
-- `board_mv_refresh_max_stale_hours()` returns max(hours since the last SUCCEEDED run of any
-- active cron whose COMMAND TEXT contains the matview name) across active watchlist rows, and
-- it IGNORES the watchlist's own `max_stale_hours` column entirely — that column has no
-- consumer anywhere in the DB or the app. Noted, not changed.
--
-- COMMAND TEXT IS DELIBERATELY UNCHANGED. Because the watchdog matches jobs to boards with
-- `j.command ILIKE '%' || w.matview_name || '%'`, editing a command would silently blind it.
-- cron.alter_job changes only the schedule and keeps the jobid. Post-ship the arm read 0.82h,
-- proving the match survived.
--
-- NOT TOUCHED, deliberately: `rpc-refresh-pack-reality-top-ev` (15 * * * *) is also a large
-- over-refresh against its own 2-DAY tolerance, but it has 24/24 successes and 0 wasted
-- seconds, and its arm reads `topshot_pack_reality_top_ev` — not obviously the same object as
-- `mv_topshot_pack_reality_top_ev`. Small win, unresolved conflation risk; left until the
-- object identity is settled.
--
-- STILL THE BIGGER LEVER, unchanged and NOT shipped here: split the 180-day `ed_med` median
-- into its own daily/6-hourly MV and have the perfect-mint board join it. That removes work
-- instead of doing it less often, and per the 2026-08-08 measurement it is output-equivalent
-- by construction (both final joins are INNER).
--
-- REVERT: select cron.alter_job(235,'7 * * * *'); and likewise 236 '17 * * * *',
--   237 '27 * * * *', 240 '12 * * * *'; then restore the four watchlist notes.

DO $mig$
DECLARE
  r record;
  v_expect jsonb := jsonb_build_object(
    '235', '7 * * * *',
    '236', '17 * * * *',
    '237', '27 * * * *',
    '240', '12 * * * *'
  );
  v_new jsonb := jsonb_build_object(
    '235', '7 */2 * * *',
    '236', '17 */2 * * *',
    '237', '27 */2 * * *',
    '240', '12 */2 * * *'
  );
  k text;
BEGIN
  -- Pre-conditions: every jobid must exist, be active, and still carry the schedule we measured.
  FOR k IN SELECT jsonb_object_keys(v_expect) LOOP
    SELECT jobid, jobname, schedule, active INTO r
      FROM cron.job WHERE jobid = k::bigint;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: cron jobid % not found', k;
    END IF;
    IF NOT r.active THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: cron jobid % (%) is not active', k, r.jobname;
    END IF;
    IF r.schedule <> (v_expect ->> k) THEN
      RAISE EXCEPTION 'PRECONDITION FAILED: jobid % (%) schedule is %, expected % — someone changed it; re-measure before altering',
        k, r.jobname, r.schedule, (v_expect ->> k);
    END IF;
  END LOOP;

  FOR k IN SELECT jsonb_object_keys(v_new) LOOP
    PERFORM cron.alter_job(k::bigint, schedule => (v_new ->> k));
  END LOOP;

  -- Post-condition: all four now carry the new schedule.
  FOR k IN SELECT jsonb_object_keys(v_new) LOOP
    SELECT jobid, jobname, schedule INTO r FROM cron.job WHERE jobid = k::bigint;
    IF r.schedule <> (v_new ->> k) THEN
      RAISE EXCEPTION 'POSTCONDITION FAILED: jobid % (%) schedule is %, expected %',
        k, r.jobname, r.schedule, (v_new ->> k);
    END IF;
  END LOOP;
END
$mig$;

-- Keep the watchlist notes truthful about cadence (house rule: re-state a cadence wherever it
-- is documented when you change it). max_stale_hours is left alone — it has no consumer.
UPDATE public.board_mv_refresh_watchlist
   SET note = 'backs /insights/market; pg_cron rpc-refresh-market-index-daily 7 */2 * * * (2-hourly since 2026-08-09, was hourly and burned 2,407 wasted worker-s/day on 600s timeout kills) -> the live gate is board_mv_refresh_stale_hours breach_at 8 = 4 missed ticks'
 WHERE matview_name = 'mv_topshot_market_index_daily';

UPDATE public.board_mv_refresh_watchlist
   SET note = 'backs /insights/perfect-mint-premiums; pg_cron rpc-refresh-perfect-mint-premiums 17 */2 * * * (2-hourly since 2026-08-09, was hourly; biggest single waster at 2,576 wasted worker-s/day) -> the live gate is board_mv_refresh_stale_hours breach_at 8 = 4 missed ticks'
 WHERE matview_name = 'mv_topshot_perfect_mint_premiums_board';

UPDATE public.board_mv_refresh_watchlist
   SET note = 'backs /insights/pack-reality; pg_cron rpc-refresh-pack-reality-dist 27 */2 * * * (2-hourly since 2026-08-09, was hourly) -> the live gate is board_mv_refresh_stale_hours breach_at 8 = 4 missed ticks'
 WHERE matview_name = 'mv_topshot_pack_reality_dist';

UPDATE public.board_mv_refresh_watchlist
   SET note = 'backs /insights/pack-reality KPI strip; pg_cron rpc-refresh-pack-reality-stats 12 */2 * * * (2-hourly since 2026-08-09, was hourly) -> the live gate is board_mv_refresh_stale_hours breach_at 8 = 4 missed ticks'
 WHERE matview_name = 'mv_topshot_pack_reality_stats';
