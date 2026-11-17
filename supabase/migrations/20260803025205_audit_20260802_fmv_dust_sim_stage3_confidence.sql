-- Stage 3: replicate lib/fmv-confidence.ts (computeConfidence + escalateConfidence)
-- per arm. Volume floor (MIN_SALES_30D_MEDIUM=5), then the serial-residual
-- dispersion gate at MIN_SALES_30D_HIGH=7: OLS of ln(price) on ln(serial),
-- population residual stddev sqrt(SSR/m) with SSR = Syy - Sxy^2/Sxx (single pass;
-- Sxx=0 => slope 0 => SSR=Syy, matching the JS guard). Falls back to the
-- population CV when fewer than 7 sales carry a usable serial.
-- HIGH_MAX_DISPERSION=0.2, MEDIUM_MAX_DISPERSION=0.35.
-- Ask-corroboration (LOW->MEDIUM on a live ask within +/-25%) is NOT replicated:
-- it depends on live asks and applies identically to both arms.
-- REVERT: DROP TABLE IF EXISTS public.fmv_dust_sim_conf_20260802;
DROP TABLE IF EXISTS public.fmv_dust_sim_conf_20260802;
CREATE TABLE public.fmv_dust_sim_conf_20260802 AS
WITH arms AS (
  SELECT a.name AS arm, s.edition_id, s.collection_id, s.price,
         CASE WHEN s.serial > 0 THEN ln(s.serial::numeric) END AS lns,
         ln(s.price) AS lnp
  FROM public.fmv_dust_sim_saleset_20260802 s
  CROSS JOIN (VALUES ('new'),('old')) a(name)
  WHERE (a.name = 'new' OR s.price >= 0.5) AND s.price > 0
),
agg AS (
  SELECT arm, edition_id, min(collection_id::text) AS cid, count(*) AS n,
         stddev_pop(price)/NULLIF(avg(price),0) AS cv,
         regr_count(lnp, lns)                    AS m_serial,
         regr_syy(lnp, lns)                      AS syy,
         regr_sxy(lnp, lns)                      AS sxy,
         regr_sxx(lnp, lns)                      AS sxx
  FROM arms GROUP BY 1,2
)
SELECT arm, edition_id, cid::uuid AS collection_id, n,
       CASE WHEN m_serial >= 7
            THEN sqrt(greatest(syy - CASE WHEN sxx > 0 THEN sxy*sxy/sxx ELSE 0 END, 0) / m_serial)
            ELSE cv END AS dispersion,
       CASE
         WHEN n >= 7 AND CASE WHEN m_serial >= 7
                              THEN sqrt(greatest(syy - CASE WHEN sxx > 0 THEN sxy*sxy/sxx ELSE 0 END,0)/m_serial)
                              ELSE cv END IS NULL THEN 'LOW'
         WHEN n >= 7 AND (CASE WHEN m_serial >= 7
                              THEN sqrt(greatest(syy - CASE WHEN sxx > 0 THEN sxy*sxy/sxx ELSE 0 END,0)/m_serial)
                              ELSE cv END) <  0.2  THEN 'HIGH'
         WHEN n >= 7 AND (CASE WHEN m_serial >= 7
                              THEN sqrt(greatest(syy - CASE WHEN sxx > 0 THEN sxy*sxy/sxx ELSE 0 END,0)/m_serial)
                              ELSE cv END) <  0.35 THEN 'MEDIUM'
         WHEN n >= 7 THEN 'LOW'
         WHEN n >= 5 THEN 'MEDIUM'
         ELSE 'LOW'
       END AS confidence
FROM agg;

CREATE INDEX ON public.fmv_dust_sim_conf_20260802 (edition_id, arm);
ALTER TABLE public.fmv_dust_sim_conf_20260802 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_dust_sim_conf_20260802 FROM anon, authenticated, PUBLIC;
GRANT ALL ON public.fmv_dust_sim_conf_20260802 TO service_role;