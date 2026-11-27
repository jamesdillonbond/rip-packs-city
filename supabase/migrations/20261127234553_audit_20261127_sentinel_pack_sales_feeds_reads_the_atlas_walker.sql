-- audit_20261127_sentinel_pack_sales_feeds_reads_the_atlas_walker
--
-- 2026-11-27 (PT, ~4:05 PM; Claude Code cloud, autonomous pass).
--
-- WHY. The Sentinel "Pack Sales Ingest" arm judges a stale pack-sales mirror by asking whether OUR walker is
-- caught up with its source (clean walker + stale mirror = the source is behind -> judge the chain feed the
-- product reads; #218). sentinel_pack_sales_feeds() read the walker's latest run from pipelines
-- `topshot-pack-sales-ingest` / `allday-pack-sales-ingest`. Both were RETIRED 11-18 (Studio 530; their jobs
-- paused by 20261119080000) and replaced by the Atlas lane `atlas-pack-sales-ingest` (one run per minute,
-- extra.pages.{nba_head,nfl_head}). So `walker` has been NULL for both collections since 11-18, the arm can
-- never see a clean walker, and it falls back to the raw mirror age. Live 11-27 3:04 PM PT: "Newest allday
-- pack sale: 96.7h ago" (WARN), heading for CRITICAL at 168 h (~Mon 11-30 1:22 PM PT) -- while the Atlas
-- head page holds 200 All Day pack sales back to 10-04, ALL already stored (inserted 0), i.e. our walker is
-- caught up and All Day pack sales are just rare. The chain feed's newest All Day secondary sale is 11-26.
--
-- WHAT. `walker` now comes from the newest `atlas-pack-sales-ingest` run, shaped the way the route reads it
-- (app/api/sentinel/route.ts feedFor: ok, partial, started_at, error): ok = the run ok AND that product's
-- head page ok; partial = the head page NOT ok (a head page read in full is the definition of caught up);
-- head_new = the page's inserted count. Product map: topshot -> nba_head, allday -> nfl_head.
-- Everything else unchanged (chain_newest_sale_at). Base prosrc md5 asserted (2cadba6861f15905c238d3c396674599).
--
-- anon-exec: unchanged (sentinel_pack_sales_feeds) — CREATE OR REPLACE of an existing fn; ACL preserved.
-- REVERT: re-apply 20261118020242_audit_20261117_sentinel_pack_sales_feeds_carries_walker_error.sql.

SET LOCAL lock_timeout = '3s';

DO $mig$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.sentinel_pack_sales_feeds()'::regprocedure)
     IS DISTINCT FROM '2cadba6861f15905c238d3c396674599' THEN
    RAISE EXCEPTION 'base drifted: sentinel_pack_sales_feeds is not the 20261118020242 body';
  END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.sentinel_pack_sales_feeds()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH lanes(key, slug, page) AS (
    VALUES ('topshot', 'nba_top_shot', 'nba_head'),
           ('allday',  'nfl_all_day',  'nfl_head')
  ), walker AS (
    -- 2026-11-27: the Atlas lane replaced the retired Studio walkers on 11-18
    SELECT r.started_at, r.ok, r.error, r.extra
      FROM public.pipeline_runs r
     WHERE r.pipeline = 'atlas-pack-sales-ingest'
     ORDER BY r.started_at DESC LIMIT 1
  )
  SELECT jsonb_object_agg(l.key, jsonb_build_object(
    'chain_newest_sale_at',
      (SELECT max(p.sealed_at) FROM public.pack_purchases p
        WHERE p.event_kind = 'secondary_sale'
          AND p.collection_id = (SELECT c.id FROM public.collections c WHERE c.slug = l.slug)),
    'walker',
      (SELECT jsonb_build_object(
                'started_at', w.started_at,
                'ok', (w.ok AND coalesce((w.extra -> 'pages' -> l.page ->> 'ok')::boolean, false)),
                'partial', NOT coalesce((w.extra -> 'pages' -> l.page ->> 'ok')::boolean, false),
                'head_new', w.extra -> 'pages' -> l.page -> 'inserted',
                'source', 'atlas-pack-sales-ingest',
                'error', left(w.error, 200))
         FROM walker w)))
  FROM lanes l
$function$;
