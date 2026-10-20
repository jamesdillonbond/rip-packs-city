-- 2026-10-19 (PT) — v_insights_autographs: the public /insights/autographs board. One row per
-- SIGNED NBA Top Shot / NFL All Day edition (editions.autographed_at, from Atlas — 20261020030228)
-- with market FACTS only: the lowest live ask (Top Shot edition_offers / All Day
-- allday_edition_floor_ask), 90-day sales + median, the last sale, and the unsigned printing of
-- the same Moment with its own 90-day median.
--
-- ⛔ No FMV and no confidence column: most signed editions price LOW / ASK_ONLY (2026-10-19
-- research), and FMV confidence never reaches a user surface. The board states what traded and
-- what is listed, not what it is "worth".
-- `premium_x` (signed median ÷ unsigned median) is set only when BOTH sides have ≥ 3 sales in
-- 90 days; otherwise NULL, never a ratio of two thin medians.
-- Unsigned printing: for a "… Signature Edition" set, the same player's edition in the base set
-- of the same series; for a signed Top Shot parallel ("219:7408::18"), its Standard ("219:7408").
-- NULL when the Moment has no unsigned printing (Signature Series 1/1s, Top Script).
--
-- Cost (EXPLAIN ANALYZE 2026-10-19, 462 rows): ~17k buffers, 0.4 s cold; the page and route
-- cache it for an hour. security_invoker = on; every base table it reads is anon-SELECT with RLS.
-- Revert: DROP VIEW public.v_insights_autographs;

CREATE OR REPLACE VIEW public.v_insights_autographs
WITH (security_invoker = on) AS
SELECT e.id AS edition_id,
       e.external_id::text AS external_id,
       e.collection,
       e.collection_id,
       e.player_name,
       e.team_name,
       e.set_name,
       e.subedition_name AS parallel,
       e.tier::text AS tier,
       e.series,
       e.circulation_count,
       e.thumbnail_url,
       e.autographed_at,
       ask.low_ask,
       ask.ask_seen_at,
       coalesce(st.sales_90d, 0)::int AS sales_90d,
       st.median_90d,
       ls.price_usd AS last_sale_usd,
       ls.sold_at AS last_sale_at,
       cp.external_id::text AS unsigned_external_id,
       cp.subedition_name AS unsigned_parallel,
       cp.circulation_count AS unsigned_circulation,
       cst.sales_90d AS unsigned_sales_90d,
       cst.median_90d AS unsigned_median_90d,
       CASE WHEN coalesce(st.sales_90d, 0) >= 3 AND coalesce(cst.sales_90d, 0) >= 3 AND cst.median_90d > 0
            THEN round((st.median_90d / cst.median_90d)::numeric, 2) END AS premium_x
  FROM public.editions e
  LEFT JOIN LATERAL (
    SELECT eo.low_ask, eo.low_ask_confirmed_at AS ask_seen_at
      FROM public.edition_offers eo
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND eo.collection_id = e.collection_id AND eo.external_id = e.external_id::text AND eo.low_ask > 0
    UNION ALL
    SELECT af.floor_ask, af.floor_ask_listed_at
      FROM public.allday_edition_floor_ask af
     WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
       AND af.edition_id = e.id AND af.floor_ask > 0
     LIMIT 1
  ) ask ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS sales_90d, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.price_usd) AS median_90d
      FROM public.sales x
     WHERE x.edition_id = e.id AND x.price_usd > 0 AND x.sold_at > now() - interval '90 days'
  ) st ON true
  LEFT JOIN LATERAL (
    SELECT y.price_usd, y.sold_at
      FROM public.sales y
     WHERE y.edition_id = e.id AND y.price_usd > 0
     ORDER BY y.sold_at DESC
     LIMIT 1
  ) ls ON true
  LEFT JOIN LATERAL (
    SELECT b.id, b.external_id, b.subedition_name, b.circulation_count
      FROM public.editions b
     WHERE b.collection_id = e.collection_id
       AND b.autographed_at IS NULL
       AND ( (e.set_name ~* 'signature edition'
               AND b.player_id = e.player_id AND b.series = e.series
               AND b.set_name = trim(regexp_replace(e.set_name, '\s*(:|-)?\s*Signature Edition\s*$', '', 'i')))
          OR (e.set_name !~* 'signature edition'
               AND e.external_id::text LIKE '%::%'
               AND b.external_id::text = split_part(e.external_id::text, '::', 1)) )
     ORDER BY b.circulation_count ASC NULLS LAST, b.id
     LIMIT 1
  ) cp ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS sales_90d, percentile_cont(0.5) WITHIN GROUP (ORDER BY z.price_usd) AS median_90d
      FROM public.sales z
     WHERE cp.id IS NOT NULL AND z.edition_id = cp.id AND z.price_usd > 0 AND z.sold_at > now() - interval '90 days'
  ) cst ON true
 WHERE e.autographed_at IS NOT NULL
   AND e.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dee28451-5d62-409e-a1ad-a83f763ac070');

COMMENT ON VIEW public.v_insights_autographs IS
  'Public /insights/autographs board: one row per signed Top Shot / All Day edition with live ask, 90-day sales, last sale and the unsigned printing. No FMV or confidence by design.';
REVOKE ALL ON public.v_insights_autographs FROM anon, authenticated;
GRANT SELECT ON public.v_insights_autographs TO anon, authenticated;
