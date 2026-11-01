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