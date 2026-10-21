-- audit_20261021: the overview's "Priced from Recent Sales" tile gets a real recent-sales share (known-issues #205).
--
-- Trevor 2026-10-21 ~12:05 PM PT, on #205: "Make it a real sales stat" — keep the label, change the number.
-- The tile rendered get_collection_stats().fmv_high_medium_pct (the HIGH/MEDIUM FMV-confidence share) under a
-- sales label, so /laliga-golazos read "Priced from Recent Sales 0%" while 84 of its 575 editions had a market
-- sale in the last 30 days. This view is that real share, per collection:
--
--   editions            the same denominator get_collection_stats uses (pinnacle_catalog renders for Pinnacle,
--                       `editions` rows of the collection otherwise)
--   editions_sold_30d   editions with >= 1 MARKET sale in the last 30 days, from each collection's own sale source:
--                         Flow + Candy: sales_market (the FMV's input; buyback-wallet sales excluded)
--                         Pinnacle:     pinnacle_sales, render grain, joined to pinnacle_catalog
--                         Panini:       panini_sales sale_kind = 'Marketplace', joined to its `editions` rows
--   recent_sale_pct     100 * editions_sold_30d / editions, one decimal
--
-- Measured 2026-10-21 before writing: Flow arm 3.5 s / ~100k buffers, Panini arm 2.6 s / ~150k, Pinnacle 0.1 s —
-- too heavy for every overview render, cheap hourly. Values then: Top Shot 8,561/14,528 · All Day 2,772/6,190 ·
-- Golazos 84/575 · Candy 108/125 · UFC 0/617 (closed market, a true zero).
--
-- get_collection_stats is NOT changed (fmv_high_medium_pct stays in the API for internal readers); the reader
-- (lib/collection-stats/read.ts) adds this row, age-gated, and the tile renders it.
--
-- anon-exec: revoked (refresh_collection_recent_sale_share) — new maintenance fn; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   select cron.unschedule('rpc-collection-recent-sale-share');
--   drop function public.refresh_collection_recent_sale_share();
--   drop materialized view public.mv_collection_recent_sale_share;

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_collection_recent_sale_share AS
WITH flow AS (
  SELECT e.collection_id,
         count(*)::int AS editions,
         count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM public.sales_market s
            WHERE s.edition_id = e.id AND s.collection_id = e.collection_id
              AND s.sold_at > now() - interval '30 days'))::int AS editions_sold_30d
    FROM public.editions e
    JOIN public.collections c ON c.id = e.collection_id
   WHERE c.slug NOT IN ('disney_pinnacle', 'panini_blockchain')
   GROUP BY e.collection_id
), pinnacle AS (
  SELECT c.id AS collection_id,
         (SELECT count(*) FROM public.pinnacle_catalog)::int AS editions,
         (SELECT count(DISTINCT ps.render_id)
            FROM public.pinnacle_sales ps
            JOIN public.pinnacle_catalog pc ON pc.render_id = ps.render_id
           WHERE ps.sold_at > now() - interval '30 days' AND ps.sale_price_usd > 0)::int AS editions_sold_30d
    FROM public.collections c WHERE c.slug = 'disney_pinnacle'
), panini AS (
  SELECT c.id AS collection_id,
         (SELECT count(*) FROM public.editions e WHERE e.collection_id = c.id)::int AS editions,
         (SELECT count(DISTINCT ps.edition_external_id)
            FROM public.panini_sales ps
            JOIN public.editions e ON e.external_id = ps.edition_external_id AND e.collection_id = c.id
           WHERE ps.sale_kind = 'Marketplace' AND ps.amount_usd > 0
             AND ps.sold_at > now() - interval '30 days')::int AS editions_sold_30d
    FROM public.collections c WHERE c.slug = 'panini_blockchain'
), allc AS (
  SELECT * FROM flow UNION ALL SELECT * FROM pinnacle UNION ALL SELECT * FROM panini
)
SELECT a.collection_id,
       c.slug,
       a.editions,
       a.editions_sold_30d,
       CASE WHEN a.editions > 0 THEN round(100.0 * a.editions_sold_30d / a.editions, 1) END AS recent_sale_pct,
       now() AS computed_at
  FROM allc a
  JOIN public.collections c ON c.id = a.collection_id;

CREATE UNIQUE INDEX IF NOT EXISTS mv_collection_recent_sale_share_cid
  ON public.mv_collection_recent_sale_share (collection_id);

REVOKE ALL ON public.mv_collection_recent_sale_share FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_collection_recent_sale_share TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_collection_recent_sale_share IS
  'known-issues #205: per collection, editions with >= 1 market sale in the last 30 days over the overview''s edition count. Feeds the overview "Priced from Recent Sales" tile via lib/collection-stats/read.ts. Refreshed hourly by refresh_collection_recent_sale_share(). audit_20261021.';

CREATE OR REPLACE FUNCTION public.refresh_collection_recent_sale_share()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_collection_recent_sale_share;
  SELECT count(*) INTO v_rows FROM public.mv_collection_recent_sale_share;
  PERFORM public.log_pipeline_run('collection-recent-sale-share', v_started, v_rows, v_rows, 0, v_rows > 0,
    CASE WHEN v_rows > 0 THEN NULL ELSE 'refresh produced no rows' END,
    NULL, NULL, NULL, jsonb_build_object('known_issue', 205));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('collection-recent-sale-share', v_started, 0, 0, 0, false, SQLERRM,
    NULL, NULL, NULL, jsonb_build_object('known_issue', 205, 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_collection_recent_sale_share() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_collection_recent_sale_share() TO postgres, service_role;

-- Hourly at :31 (one of the least-booked minutes, measured 10-21); the refresh is ~6 s.
SELECT cron.schedule('rpc-collection-recent-sale-share', '31 * * * *',
  $$select public.refresh_collection_recent_sale_share()$$);