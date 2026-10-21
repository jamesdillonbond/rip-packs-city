-- audit_20261020_autographs_board_ask_seen_at_is_a_check
--
-- 2026-10-20 (Claude Code cloud), ~6:30 PM PT. Same class as 20261021011120: v_insights_autographs.ask_seen_at
-- (returned by the public /api/public/insights/autographs) carried floor_ask_listed_at on its All Day arm, a
-- posting date under a "seen" name, while its Top Shot arm carries low_ask_confirmed_at (a check). The All Day
-- arm now reads allday_edition_floor_ask.floor_ask_verified_at (20261021003446). One token changed from
-- 20261020051112 (the only definition); security_invoker re-asserted; grants are kept by REPLACE.
-- REVERT: re-run the view block of 20261020051112.

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
    SELECT af.floor_ask, af.floor_ask_verified_at
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
