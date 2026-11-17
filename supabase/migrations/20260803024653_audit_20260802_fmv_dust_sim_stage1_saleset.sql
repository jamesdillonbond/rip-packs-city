-- Stage 1 of the pre-deploy simulation for the dust-floor removal.
-- Reproduces app/api/fmv-recalc/route.ts's input sale set exactly:
--   * 30d window, price_usd > 0, edition_id NOT NULL, Pinnacle excluded
--   * impossible-serial mis-key guard (serial > circulation -> dropped)
--   * Step 2a-quater 90d widening for thin editions, adopted only when strictly deeper
-- The widen test reads the PRE-dust raw count, so this stage is IDENTICAL for both
-- arms of the comparison — the dust floor is applied downstream in stage 2.
-- REVERT: DROP TABLE IF EXISTS public.fmv_dust_sim_saleset_20260802;
DROP TABLE IF EXISTS public.fmv_dust_sim_saleset_20260802;
CREATE TABLE public.fmv_dust_sim_saleset_20260802 AS
WITH meta AS (
  SELECT e.id, e.collection_id,
         NULLIF(e.circulation_count, 0) AS circ,
         NULLIF(e.jersey_number, 0)     AS jersey,
         upper(COALESCE(e.tier::text,'')) AS tier
  FROM public.editions e
  WHERE e.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
),
s30 AS (
  SELECT s.edition_id, s.collection_id, s.price_usd::numeric AS price, s.sold_at, s.serial_number::int AS serial
  FROM public.sales s JOIN meta m ON m.id = s.edition_id
  WHERE s.sold_at >= now() - interval '30 days' AND s.price_usd > 0
    AND NOT (m.circ IS NOT NULL AND s.serial_number IS NOT NULL AND s.serial_number > m.circ)
),
prem30 AS (
  SELECT s.edition_id, count(*) AS n,
         count(*) FILTER (WHERE NOT (
             s.serial IS NOT NULL AND (
               s.serial = 1
               OR (m.circ IS NOT NULL AND s.serial = m.circ)
               OR (m.jersey IS NOT NULL AND s.serial = m.jersey)
               OR s.serial <= CASE WHEN m.circ IS NULL THEN 15
                                   ELSE least(greatest(15, ceil(m.circ*0.1)), greatest(1, floor(m.circ*0.25))) END
             ))) AS typical_n
  FROM s30 s JOIN meta m ON m.id = s.edition_id GROUP BY 1
),
widen_ids AS (SELECT edition_id, n AS n30 FROM prem30 WHERE n < 5 OR typical_n < 3),
s90 AS (
  SELECT s.edition_id, s.collection_id, s.price_usd::numeric AS price, s.sold_at, s.serial_number::int AS serial
  FROM public.sales s JOIN widen_ids w ON w.edition_id = s.edition_id JOIN meta m ON m.id = s.edition_id
  WHERE s.sold_at >= now() - interval '90 days' AND s.price_usd > 0
    AND NOT (m.circ IS NOT NULL AND s.serial_number IS NOT NULL AND s.serial_number > m.circ)
),
adopt AS (
  SELECT s.edition_id FROM s90 s JOIN widen_ids w USING (edition_id)
  GROUP BY s.edition_id, w.n30 HAVING count(*) > w.n30
)
SELECT edition_id, collection_id, price, sold_at, serial, false AS widened FROM s30
WHERE edition_id NOT IN (SELECT edition_id FROM adopt)
UNION ALL
SELECT edition_id, collection_id, price, sold_at, serial, true FROM s90
WHERE edition_id IN (SELECT edition_id FROM adopt);

CREATE INDEX ON public.fmv_dust_sim_saleset_20260802 (edition_id);
ALTER TABLE public.fmv_dust_sim_saleset_20260802 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_dust_sim_saleset_20260802 FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.fmv_dust_sim_saleset_20260802 TO service_role;