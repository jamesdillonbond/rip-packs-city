-- Stage 2: price each edition twice off the identical stage-1 sale set.
--   arm 'old' = shipped behaviour (absolute $0.50 dust floor applied first)
--   arm 'new' = Option A (no absolute floor)
-- Replicates route.ts: isPremiumSerial typical-serial selection with the
-- TYPICAL_SERIAL_MIN=3 fallback, then wapWithoutOutliers (0.2x/5x median band,
-- recency weights 3.0/2.0/1.0), rounded to 2dp as the route does.
-- NOT replicated (identical in both arms, so they cancel): wash-trade cluster
-- filter and dampenGrailSpike steps 2-4 (<=1.58% TS / 1.02% AllDay of sales).
-- REVERT: DROP TABLE IF EXISTS public.fmv_dust_sim_arms_20260802;
DROP TABLE IF EXISTS public.fmv_dust_sim_arms_20260802;
CREATE TABLE public.fmv_dust_sim_arms_20260802 AS
WITH meta AS (
  SELECT e.id, NULLIF(e.circulation_count,0) AS circ, NULLIF(e.jersey_number,0) AS jersey
  FROM public.editions e
),
armed AS (
  SELECT s.edition_id, s.collection_id, s.price,
         (s.serial IS NOT NULL AND (
            s.serial = 1
            OR (m.circ IS NOT NULL AND s.serial = m.circ)
            OR (m.jersey IS NOT NULL AND s.serial = m.jersey)
            OR s.serial <= CASE WHEN m.circ IS NULL THEN 15
                                ELSE least(greatest(15, ceil(m.circ*0.1)), greatest(1, floor(m.circ*0.25))) END
         )) AS is_premium,
         CASE WHEN extract(epoch FROM (now()-s.sold_at))/86400 <= 7 THEN 3.0
              WHEN extract(epoch FROM (now()-s.sold_at))/86400 <= 14 THEN 2.0
              ELSE 1.0 END AS w
  FROM public.fmv_dust_sim_saleset_20260802 s JOIN meta m ON m.id = s.edition_id
),
arms AS (
  SELECT a.*, arm.name AS arm FROM armed a CROSS JOIN (VALUES ('new'),('old')) arm(name)
  WHERE arm.name = 'new' OR a.price >= 0.5
),
counts AS (
  SELECT arm, edition_id, min(collection_id::text) AS cid, count(*) AS n,
         count(*) FILTER (WHERE NOT is_premium) AS typ_n
  FROM arms GROUP BY 1,2
),
value_sales AS (
  SELECT a.arm, a.edition_id, a.price, a.w
  FROM arms a JOIN counts c ON c.arm = a.arm AND c.edition_id = a.edition_id
  WHERE (c.typ_n >= 3 AND NOT a.is_premium) OR c.typ_n < 3
),
med AS (
  SELECT arm, edition_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS m
  FROM value_sales GROUP BY 1,2
),
wap AS (
  SELECT v.arm, v.edition_id,
         sum(v.price*v.w) FILTER (WHERE v.price >= md.m*0.2 AND v.price <= md.m*5)
           / NULLIF(sum(v.w) FILTER (WHERE v.price >= md.m*0.2 AND v.price <= md.m*5),0) AS wap_filtered,
         sum(v.price*v.w)/NULLIF(sum(v.w),0) AS wap_all
  FROM value_sales v JOIN med md ON md.arm = v.arm AND md.edition_id = v.edition_id
  GROUP BY 1,2
)
SELECT w.arm, w.edition_id, c.cid::uuid AS collection_id, c.n AS sales_count,
       c.typ_n AS typical_count,
       round(COALESCE(w.wap_filtered, w.wap_all)::numeric, 2) AS fmv
FROM wap w JOIN counts c ON c.arm = w.arm AND c.edition_id = w.edition_id;

CREATE INDEX ON public.fmv_dust_sim_arms_20260802 (edition_id, arm);
ALTER TABLE public.fmv_dust_sim_arms_20260802 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_dust_sim_arms_20260802 FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.fmv_dust_sim_arms_20260802 TO service_role;