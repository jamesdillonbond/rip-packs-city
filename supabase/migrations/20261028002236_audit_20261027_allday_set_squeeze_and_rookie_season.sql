-- audit_20261027: NFL All Day leg for /insights/set-squeeze, and the 2025 NFL rookie cohort keyed on the SEASON
-- (All Day ↔ Top Shot parity, pass 7).
--
-- 1. allday_set_squeeze_board — topshot_set_squeeze_board's columns and rules (sets with ≥ 5 editions, grouped by
--    sets.id) over allday_squeeze_board. 177 All Day sets qualify (10-27). security_invoker, service-role only.
-- 2. allday_2025_rookie_index — the cohort was "a Rookie Mint edition in series 9". collection_series says the 2025
--    season is series 9 AND 10 (re-read 10-27 ~5:30 PM PT), so a rookie whose first Rookie Mint lands in series 10
--    would have been left out. The cohort is now a Rookie Mint edition in any series whose season is '2025'; a
--    player's editions are read from the season's first series on. Same 109 players today (no series-10 Rookie
--    Mint yet). CREATE OR REPLACE resets reloptions, so security_invoker is restated; columns unchanged.
--
-- Revert: DROP VIEW public.allday_set_squeeze_board;
--         re-apply 20261027054051_audit_20261026_allday_2025_rookie_index.sql's view body (series_number = 9).

CREATE VIEW public.allday_set_squeeze_board WITH (security_invoker = on) AS
SELECT s.id AS set_id,
       s.name AS set_name,
       s.series,
       s.tier::text AS set_tier,
       count(*) AS editions_covered,
       round(avg(b.squeeze_pct), 1) AS avg_squeeze_pct,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY b.squeeze_pct::double precision))::numeric, 1) AS median_squeeze_pct,
       round(max(b.squeeze_pct), 1) AS max_squeeze_pct,
       round(min(b.squeeze_pct), 1) AS min_squeeze_pct,
       sum(b.circulation)::integer AS total_circ,
       sum(b.locked)::integer AS total_locked,
       sum(b.burned)::integer AS total_burned,
       sum(b.effectively_buyable)::integer AS total_buyable,
       round(avg(b.fmv_usd) FILTER (WHERE b.fmv_usd IS NOT NULL), 2) AS avg_fmv_usd,
       count(*) FILTER (WHERE b.fmv_usd IS NOT NULL) AS fmv_covered_editions
FROM public.allday_squeeze_board b
JOIN public.sets s ON s.id = b.set_id
WHERE s.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
GROUP BY s.id, s.name, s.series, s.tier
HAVING count(*) >= 5;

REVOKE ALL ON public.allday_set_squeeze_board FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.allday_set_squeeze_board TO service_role;

CREATE OR REPLACE VIEW public.allday_2025_rookie_index WITH (security_invoker = on) AS
WITH season AS (
  SELECT cs.series_number
  FROM public.collection_series cs
  WHERE cs.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND cs.season = '2025'
), cohort AS (
  SELECT DISTINCT be.player_name
  FROM public.badge_editions be
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND be.series_number IN (SELECT series_number FROM season)
    AND be.set_play_tags @> '[{"title":"Rookie Mint"}]'::jsonb
    AND be.player_name IS NOT NULL
), player_editions AS (
  SELECT e.id, be.player_name, be.locked, be.burned, be.lock_rate_pct,
         COALESCE(e.circulation_count, be.circulation_count) AS circ
  FROM public.badge_editions be
  JOIN public.editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
  JOIN cohort c ON c.player_name = be.player_name
  WHERE be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    AND be.series_number >= (SELECT min(series_number) FROM season)
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
