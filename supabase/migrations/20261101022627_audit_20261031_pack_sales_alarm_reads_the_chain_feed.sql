-- audit_20261031_pack_sales_alarm_reads_the_chain_feed
--
-- 2026-10-31 ~8:30 PM PT (Claude Code cloud; Trevor: "fix whatever is causing these failures and
-- alerts"). Since 10-29 the sentinel has read WARN on `Pack Sales Ingest (Top Shot)`,
-- `Pack Sales Ingest (All Day)` and `Edge Lane Observability`, all three because Dapper Studio's
-- `searchPackMarketplaceHistory` stopped returning anything new (#218; probed 10-31 via pg_net:
-- newest row 10-29 7:50 AM PT). Our walkers are healthy — 96/96 and 192/192 runs ok in 48 h,
-- head_new 0, partial false: they are caught up with a frozen source.
--
-- WHAT THE PRODUCT READS. Pack sale numbers come from the CHAIN (`pack_purchases`
-- secondary_sale, written by the pack-events-ingest worker): pack_market_sales_stats uses the
-- Studio mirror only for sales before 2026-04-10 (TS) / 04-24 (AD), and get_wallet_pack_history
-- ranks the chain row first. The chain feed was current the whole time (TS newest 10-31 5:15 PM PT).
--
-- So the alarm keeps its job — catch OUR pack-sales lanes dying (the 09-13 six-day latch) — and
-- stops paging on an upstream freeze it cannot act on:
--   · sentinel_pack_sales_feeds(): per lane, the chain feed's newest secondary sale and the Studio
--     walker's latest run (ok / partial / head_new / newest block_time). One jsonb, ~90 buffers.
--     The route: mirror fresh → ok as before; mirror stale AND our walker NOT clean → our failure,
--     unchanged severity; mirror stale AND the walker clean → upstream behind, severity from the
--     chain feed the product reads, the mirror's age stated in the detail.
--   · edge_lane_watch: the TS and AD Studio lanes move to `observed_via = 'pipeline_runs'` (their
--     own run logs, which the head-first walker writes since 09-23) — the Golazos lane's
--     precedent, whose note gives the same reason: an upstream's freshness is not the lane's health.
--   · pipeline_cadence_watchlist: `atlas-pack-market` (the Atlas pack book lane, 20261101022135).
--
-- anon-exec: revoked (sentinel_pack_sales_feeds) — new reader for the service-role sentinel; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- REVERT: DROP FUNCTION public.sentinel_pack_sales_feeds();
--   UPDATE public.edge_lane_watch SET observed_via = 'outcome_freshness', pipeline_name = NULL
--    WHERE jobname IN ('rpc-topshot-pack-sales-backfill', 'rpc-allday-pack-sales-backfill');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'atlas-pack-market';

CREATE OR REPLACE FUNCTION public.sentinel_pack_sales_feeds()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH lanes(key, slug, walker) AS (
    VALUES ('topshot', 'nba_top_shot', 'topshot-pack-sales-ingest'),
           ('allday',  'nfl_all_day',  'allday-pack-sales-ingest')
  )
  SELECT jsonb_object_agg(l.key, jsonb_build_object(
    'chain_newest_sale_at',
      (SELECT max(p.sealed_at) FROM public.pack_purchases p
        WHERE p.event_kind = 'secondary_sale'
          AND p.collection_id = (SELECT c.id FROM public.collections c WHERE c.slug = l.slug)),
    'walker',
      (SELECT jsonb_build_object('started_at', r.started_at, 'ok', r.ok,
                                 'partial', r.extra -> 'partial', 'head_new', r.extra -> 'head_new',
                                 'newest_block_time', r.extra ->> 'newest_block_time')
         FROM public.pipeline_runs r
        WHERE r.pipeline = l.walker
        ORDER BY r.started_at DESC LIMIT 1)))
  FROM lanes l
$function$;

REVOKE ALL ON FUNCTION public.sentinel_pack_sales_feeds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sentinel_pack_sales_feeds() TO service_role;

UPDATE public.edge_lane_watch
   SET observed_via = 'pipeline_runs',
       pipeline_name = CASE jobname WHEN 'rpc-topshot-pack-sales-backfill' THEN 'topshot-pack-sales-ingest'
                                    ELSE 'allday-pack-sales-ingest' END,
       note = note || ' · 2026-10-31 (#218): observed by its own run log, the Golazos precedent — Dapper''s pack-sales index froze 10-29 and the table''s block_time measured the UPSTREAM, not this lane. Data freshness vs the chain is the sentinel arm "Pack Sales Ingest".'
 WHERE jobname IN ('rpc-topshot-pack-sales-backfill', 'rpc-allday-pack-sales-backfill');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, severity, notes, is_active)
VALUES ('atlas-pack-market', 30, 'medium',
        'Atlas DistributionService pack book (nba + nfl), pg_cron every minute; logs only on ticks that drained a page. The fallback ask book while Dapper Studio''s pack index is frozen (#218).',
        true)
ON CONFLICT (pipeline) DO NOTHING;
