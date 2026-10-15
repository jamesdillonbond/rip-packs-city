-- audit_20261015_pending_sql_drain_golazos_permanent_and_scratch_drops
-- Drains four docs/pending-sql files in ONE apply (one PGRST002 burst, not four). Every precondition
-- re-derived live 2026-10-15 ~12:58 PM PT: golazos cursor = 137390146, parent lane 8/8 ok in 24 h;
-- v1 Pack Reality MVs 0 dependents / 0 cron / 0 fn bodies / 0 repo refs; the 4 market functions 0 callers
-- in pg_proc, cron.job and app/lib/supabase/functions/scripts; signatures read from pg_proc.

DO $pre$
DECLARE v_block bigint; v_ok int; v_runs int;
BEGIN
  SELECT last_processed_block INTO v_block FROM public.event_cursor WHERE id = 'golazos_sales_v1_backfill';
  IF v_block IS DISTINCT FROM 137390146 THEN
    RAISE EXCEPTION 'precondition false: golazos_sales_v1_backfill cursor is %, not the floor 137390146', v_block;
  END IF;
  SELECT count(*) FILTER (WHERE ok), count(*) INTO v_ok, v_runs FROM public.pipeline_runs
   WHERE pipeline = 'golazos-sales-history-backfill' AND started_at > now() - interval '24 hours';
  IF v_runs = 0 OR v_ok <> v_runs THEN
    RAISE EXCEPTION 'precondition false: parent lane golazos-sales-history-backfill % ok of % runs in 24 h', v_ok, v_runs;
  END IF;
END
$pre$;

-- 1. golazos_sales_v1_backfill suppression made permanent (the 20260914153000 row's own lapse instruction).
--    REVERT: UPDATE public.pipeline_alert_suppression SET expires_at = '2026-10-15 00:00:00+00' WHERE pipeline = 'golazos_sales_v1_backfill';
UPDATE public.pipeline_alert_suppression
   SET expires_at = NULL,
       reason = 'Parked at the spork retention floor 137,390,146 because the walk FINISHED there, '
         || 'verified on lapse, not assumed. RE-DERIVED 2026-10-14 ~6:50 PM PT and again 2026-10-15 ~12:58 PM PT, after the bounded row (20260914153000) lapsed: '
         || 'event_cursor.last_processed_block = 137,390,146 = SPORK_FLOOR_HINT (app/api/cron/golazos-sales-history-backfill/route.ts), '
         || 'reached 2026-09-30 5:34 PM PT, the ETA that row predicted from 320,000 blocks/day. '
         || 'The parent lane golazos-sales-history-backfill ran 8/8 ok every day 09-27 -> 10-15 and every run in retention logs rows 0, '
         || 'note "reached_spork_floor_hint", next "deeper history (<2025-12-29) needs spork-proxy": V1 history below the floor is pruned from public Flow REST, '
         || 'so this backward cursor never moves again by design. The 09-14 row named this as the case to make permanent. '
         || 'WHAT STILL WATCHES THE LANE: pipeline_cadence_watchlist golazos-sales-history-backfill (a total stop) and the failure_rate arm (hyphenated name); '
         || 'the LIVE Golazos sales cursor is golazos_sales, unaffected. '
         || 'IF THIS CURSOR EVER MOVES (a spork-proxy walk, a manual reset), re-read it: check_suppression_parked_claim_drift() flags a cursor above the floor this reason claims. '
         || 'Migration audit_20261015_pending_sql_drain_golazos_permanent_and_scratch_drops.'
 WHERE pipeline = 'golazos_sales_v1_backfill';

-- 2. Scratch probes from 10-14 (select 1, 0 callers). REVERT: n/a.
DROP FUNCTION IF EXISTS public.zz_probe_20261014();
DROP FUNCTION IF EXISTS public.zz_probe2_20261014();

-- 3. Pack Reality v1 MVs, superseded by _v2 in 20261015015411. No CASCADE on purpose.
--    REVERT: re-create from the v1 definitions in migration history (git log -S 'mv_topshot_pack_reality_stats').
DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_stats;
DROP MATERIALIZED VIEW IF EXISTS public.mv_topshot_pack_reality_dist;

-- 4. Market functions superseded by get_market_filter_options / the _v3 RPCs. KEEP get_topshot_sniper_deals (v1).
--    REVERT: re-run the creating migrations 20261015020243 (team options), 20261010085932's lineage (AD v1), 20261015033610 (both _v2).
DROP FUNCTION IF EXISTS public.get_market_team_options(uuid);
DROP FUNCTION IF EXISTS public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric);
DROP FUNCTION IF EXISTS public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);
DROP FUNCTION IF EXISTS public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);

DO $post$
DECLARE v_n int; v_drift jsonb; v_left int;
BEGIN
  SELECT count(*) INTO v_n FROM public.pipeline_alert_suppression
   WHERE pipeline = 'golazos_sales_v1_backfill' AND expires_at IS NULL;
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected the golazos row to be permanent, found %', v_n; END IF;
  v_drift := public.check_suppression_parked_claim_drift();
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_drift) e WHERE e->>'pipeline' = 'golazos_sales_v1_backfill') THEN
    RAISE EXCEPTION 'parked-claim guard disagrees: %', v_drift;
  END IF;
  SELECT count(*) INTO v_left FROM pg_proc WHERE proname IN ('zz_probe_20261014','zz_probe2_20261014','get_market_team_options',
    'get_allday_market_editions','get_allday_market_editions_v2','get_topshot_sniper_deals_v2');
  IF v_left <> 0 THEN RAISE EXCEPTION 'expected 0 dropped functions to remain, found %', v_left; END IF;
  IF EXISTS (SELECT 1 FROM pg_matviews WHERE matviewname IN ('mv_topshot_pack_reality_stats','mv_topshot_pack_reality_dist')) THEN
    RAISE EXCEPTION 'v1 Pack Reality MVs still present';
  END IF;
END
$post$;
