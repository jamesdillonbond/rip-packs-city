-- audit_20261026: the 2025 NFL rookie class on /insights/rookies (All Day ↔ Top Shot parity, pass 5).
--
-- Top Shot's Rookie Index (topshot_2025_rookie_index / _cohort_stats) has no All Day leg. Same columns here, so the
-- route and board read it as one more class (`class=nfl-2025`). Cohort = every player with a Rookie Mint-tagged edition
-- in All Day series 9 (the 2025 season; series 5 carries the "2023 Rookies" set, so odd series are the seasons):
-- 109 players / 342 editions on 10-26. A player's editions are read from badge_editions at series 9 or later, so a
-- veteran who shares a rookie's name never joins his line (a NAME is not a PERSON).
-- Differences from Top Shot's, on purpose:
--   * sales from sales_market (pack buybacks are not a collector's price);
--   * locked / burned / circulation are summed only over editions where both counts were read (unknown ≠ 0 %).
-- Plain security_invoker views: ~4.5k buffers / ~80 ms warm. Service-role only (the route reads it with the admin client).
--
-- Revert: DROP VIEW public.allday_2025_rookie_cohort_stats; DROP VIEW public.allday_2025_rookie_index;

CREATE VIEW public.allday_2025_rookie_index WITH (security_invoker = on) AS
WITH cohort AS (
  SELECT DISTINCT be.player_name
  FROM public.badge_editions be
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND be.series_number = 9
    AND be.set_play_tags @> '[{"title":"Rookie Mint"}]'::jsonb
    AND be.player_name IS NOT NULL
), player_editions AS (
  SELECT e.id, be.player_name, be.locked, be.burned, be.lock_rate_pct,
         COALESCE(e.circulation_count, be.circulation_count) AS circ
  FROM public.badge_editions be
  JOIN public.editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
  JOIN cohort c ON c.player_name = be.player_name
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND be.series_number >= 9
), sales_30d AS (
  SELECT pe.player_name,
         count(s.edition_id) AS sales_30d,
         sum(s.price_usd) AS gmv_30d,
         avg(s.price_usd) AS avg_price_30d,
         max(s.price_usd) AS max_sale_30d
  FROM player_editions pe
  LEFT JOIN public.sales_market s
    ON s.edition_id = pe.id
   AND s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
   AND s.sold_at >= now() - interval '30 days'
   AND s.price_usd > 0
  GROUP BY pe.player_name
), badge_agg AS (
  SELECT player_name,
         count(*)::integer AS edition_count,
         (sum(locked) FILTER (WHERE locked IS NOT NULL AND burned IS NOT NULL))::integer AS total_locked,
         (sum(burned) FILTER (WHERE locked IS NOT NULL AND burned IS NOT NULL))::integer AS total_burned,
         (sum(circ) FILTER (WHERE locked IS NOT NULL AND burned IS NOT NULL))::integer AS total_circ,
         avg(lock_rate_pct) AS avg_lock_rate_pct
  FROM player_editions
  GROUP BY player_name
), mint_one AS (
  SELECT pe.player_name,
         count(DISTINCT pe.id) FILTER (WHERE s.edition_id IS NOT NULL) AS mint_one_eds_with_history,
         max(s.price_usd) AS max_mint_one_sale
  FROM player_editions pe
  LEFT JOIN public.sales_market s
    ON s.edition_id = pe.id
   AND s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
   AND s.serial_number = 1
   AND s.price_usd > 0
  GROUP BY pe.player_name
)
SELECT c.player_name,
       ba.edition_count,
       COALESCE(s.sales_30d, 0)::integer AS sales_30d,
       round(COALESCE(s.gmv_30d, 0), 2) AS gmv_30d,
       round(COALESCE(s.avg_price_30d, 0), 2) AS avg_price_30d,
       round(COALESCE(s.max_sale_30d, 0), 2) AS max_sale_30d,
       ba.total_locked,
       ba.total_burned,
       ba.total_circ,
       round(100.0 * (ba.total_locked + ba.total_burned) / NULLIF(ba.total_circ, 0), 1) AS cohort_squeeze_pct,
       round(ba.avg_lock_rate_pct, 1) AS avg_lock_rate_pct,
       COALESCE(mo.mint_one_eds_with_history, 0) AS mint_one_eds_with_history,
       round(mo.max_mint_one_sale, 2) AS max_mint_one_sale_usd
FROM cohort c
LEFT JOIN badge_agg ba ON ba.player_name = c.player_name
LEFT JOIN sales_30d s ON s.player_name = c.player_name
LEFT JOIN mint_one mo ON mo.player_name = c.player_name;

CREATE VIEW public.allday_2025_rookie_cohort_stats WITH (security_invoker = on) AS
SELECT count(*) AS rookie_count,
       sum(sales_30d)::integer AS total_sales_30d,
       round(sum(gmv_30d), 0) AS total_gmv_30d,
       round(avg(NULLIF(avg_price_30d, 0)), 2) AS avg_price_active,
       count(*) FILTER (WHERE gmv_30d > 0) AS rookies_with_activity_30d,
       count(*) FILTER (WHERE max_mint_one_sale_usd > 0) AS rookies_with_mint_one_sale,
       max(max_mint_one_sale_usd) AS top_mint_one_sale,
       now() AS computed_at
FROM public.allday_2025_rookie_index;

REVOKE ALL ON public.allday_2025_rookie_index FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.allday_2025_rookie_cohort_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_2025_rookie_index TO service_role;
GRANT SELECT ON public.allday_2025_rookie_cohort_stats TO service_role;
