
-- Prioritized work queue for an AllDay sales-history backfill (mirror of the TS
-- topshot-sales-history-backfill). Self-updating: as the backfill captures sales,
-- captured_sales rises and editions fall in priority, so the route just drains by
-- priority_rank each pass with no manual status tracking. Purpose: populate the
-- Recent Sales table + FMV history chart on AllDay moment/edition pages (the
-- product value), independent of FMV-confidence. Read-only view; internal (no anon).
CREATE OR REPLACE VIEW public.allday_sales_history_backfill_targets
WITH (security_invoker = on) AS
SELECT
  e.id AS edition_id,
  e.external_id,
  e.player_name,
  e.set_name,
  e.tier::text AS tier,
  e.circulation_count,
  coalesce(sc.captured_sales, 0) AS captured_sales,
  (coalesce(sc.captured_sales, 0) = 0) AS zero_sales,
  row_number() OVER (
    ORDER BY coalesce(sc.captured_sales, 0) ASC, e.circulation_count DESC NULLS LAST
  ) AS priority_rank
FROM public.editions e
LEFT JOIN (
  SELECT edition_id, count(*) AS captured_sales
  FROM public.sales WHERE collection = 'nfl_all_day'
  GROUP BY edition_id
) sc ON sc.edition_id = e.id
WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';

GRANT SELECT ON public.allday_sales_history_backfill_targets TO service_role, authenticated;
