
-- Monitoring queue for the (future, CC-built) Pinnacle sales-history backfill —
-- the Pinnacle analog of allday_sales_history_backfill_targets. Pinnacle native
-- sales are on-chain (pinnacle-sales-indexer, captured only since 2026-03-03);
-- this view surfaces renders with zero/few captured sales so the backfill's
-- progress is visible and the gap is quantified. Self-updating: captured_sales
-- rises as the backfill lands sales, editions fall in priority_rank. Internal
-- (service_role + authenticated only — anon explicitly revoked to avoid the
-- Supabase default-grant leak).
CREATE OR REPLACE VIEW public.pinnacle_sales_history_backfill_targets
WITH (security_invoker = on) AS
SELECT
  c.render_id,
  c.character_name,
  c.set_name,
  c.variant,
  c.total_minted,
  coalesce(s.captured_sales, 0) AS captured_sales,
  (coalesce(s.captured_sales, 0) = 0) AS zero_sales,
  row_number() OVER (
    ORDER BY coalesce(s.captured_sales, 0) ASC, c.total_minted DESC NULLS LAST
  ) AS priority_rank
FROM public.pinnacle_catalog c
LEFT JOIN (
  SELECT render_id, count(*) AS captured_sales
  FROM public.pinnacle_sales WHERE render_id IS NOT NULL
  GROUP BY render_id
) s ON s.render_id = c.render_id;

REVOKE ALL ON public.pinnacle_sales_history_backfill_targets FROM anon;
GRANT SELECT ON public.pinnacle_sales_history_backfill_targets TO service_role, authenticated;
