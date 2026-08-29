-- audit_20260829_leaderboard_fix_is_real_but_not_sufficient_under_a_ten_wide_sweep
--
-- METADATA ONLY. No behaviour change: no signature change, no grant change, no view,
-- no data. Attaches the first COMMENT to public.analytics_sales_leaderboard(...).
--
-- WHY THE DB AND NOT A DOC: MEMORY.md is truncating on load (27.1 KB against a 24.4 KB
-- threshold, Trevor 2026-08-29) and the next session reads the catalog, not last night's
-- handoff. The 2026-08-28 22:40Z handoff already caused one wrong claim by being read
-- instead of the catalog.
--
-- GUARDED: RAISEs rather than clobbering an existing comment.
--
-- REVERT (restores the exact pre-migration state -- the function carried NO comment):
--   COMMENT ON FUNCTION public.analytics_sales_leaderboard(
--     text, timestamptz, timestamptz, text[], integer, numeric, boolean) IS NULL;

DO $mig$
DECLARE
  v_oid oid;
  v_existing text;
BEGIN
  SELECT p.oid INTO v_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'analytics_sales_leaderboard';

  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'anchor missing: public.analytics_sales_leaderboard not found';
  END IF;

  SELECT obj_description(v_oid, 'pg_proc') INTO v_existing;
  IF v_existing IS NOT NULL THEN
    RAISE EXCEPTION 'refusing to clobber an existing comment (% chars) on analytics_sales_leaderboard', length(v_existing);
  END IF;

  EXECUTE format('COMMENT ON FUNCTION public.analytics_sales_leaderboard(text, timestamptz, timestamptz, text[], integer, numeric, boolean) IS %L', $note$READ BEFORE DECLARING THIS ROUTE FIXED. Sole caller: /api/analytics/sales/leaderboard; components/analytics/SalesDashboard.tsx fires buyer+seller in ONE Promise.all per collection tab, so a tab cycle is 10 uncached calls.

2026-08-29 09:22Z (Cowork pass). THE c26ae1981 STALE-VISIBILITY-MAP FIX IS REAL BUT IS NOT SUFFICIENT, and "verified holding" was read off an 8h window that contained exactly ONE sweep. Vercel production, 24h to 09:06Z: 30 x 500 and 10 x 200 = 75% failing. All TEN requests of the 07:22:14-07:22:38Z sweep (5 collections x 2 roles) returned 500, on "canceling statement due to statement timeout" and "rpc analytics_sales_leaderboard timed out after 45000ms with no response".

THE FUNCTION ITSELF IS NOT REGRESSED -- do not re-open the visibility map on this evidence. Measured SERIALLY 09:12-09:15Z: topshot buyer 4,914 ms (cold) / seller 2,815 ms; pinnacle 1,378; golazos 931; ufc 226. sales_2026 relallvisible read 95.7% at 08:59Z (ANALYZE-anchored 07:04Z) and the 07:05Z shape-matched probe read Heap Fetches 3,363, well under the ~10,000 falsifier registered with jobid 380.

WHAT DIFFERS BETWEEN THE TWO SWEEPS IS LOAD SHAPE, NOT PLAN. The 10 calls land inside 24 s, all cache=MISS, on a dense :20-:22 pg_cron convergence: rpc-refresh-wmc-fmv-changed 363 s (07:17-07:23Z), promote_unmapped_sales 239 s, allday-price-recover 150 s, rpc-refresh-challenge-costs 102 s, sales-counterparty-backfill 88 s. Ten concurrent copies of a ~29k-buffer scan on an IO-bound instance is the WORKING HYPOTHESIS; it is NOT proven -- no concurrency positive control has been run, and running one loads prod.

THE FILED RATIONALE FOR NOT SHIPPING THE COLLECTION PUSH-DOWN IS REFUTED. ledger 2026-08-28 filed it as "not shipped, deliberately" because "the vacuum alone already gives 2.3 s against a 30 s service_role timeout". That headroom argument assumes SERIAL execution; under the real 10-wide sweep the route fails 10 of 10. The push-down (measured 28,928 -> 13,835 buffers) is now the live lever. It needs analytics_sales to expose the RAW long-form collection: the view maps nba_top_shot->topshot etc. through a CASE, so collection = ANY(ARRAY[topshot]) can never become an Index Cond on idx_sales_2026_pulse_window, which leads on the LONG form. The reverse map is unambiguous as of 09:18Z -- sales.collection since 2025-01-01 holds only nba_top_shot (1,514,727), nfl_all_day (244,245), ufc_strike (25,245), candy_mlb (6,425), laliga_golazos (791). Note analytics_sales has a dependent view analytics_sales_resolved; a trailing-column CREATE OR REPLACE must be checked against it.

INSTRUMENT TRAPS, each one measured here. (1) pg_stat_statements for the PostgREST wrapper reads 42 calls / mean 13,670 ms / max 29,020 ms -- stats_reset is 2026-08-12, so that mean is a 17-day cumulative dominated by the pre-fix era. Do NOT quote it as a current latency. (2) A failures-only Vercel query reads 100% failing; carry the denominator and group by requestPath. (3) Two different timeout strings describe the SAME event: the route gives up at 45,000 ms, above the DB statement_timeout, so which string you see is a race.

STILL CLOSED, do not revive: materialising this leaderboard (Trevor, explicit); the prior_addrs correlated-EXISTS rewrite (measured 16.3 -> 13.1 s while the agg leg alone cost 13.8 s -- refuted).$note$);
END
$mig$;