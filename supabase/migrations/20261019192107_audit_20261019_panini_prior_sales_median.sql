-- audit_20261019_panini_prior_sales_median
--
-- 2026-10-19 (Cowork cloud; Trevor: "Keep going" on the Panini roadmap). Input for FMV engine
-- panini-1.3.1 (lib/chains/panini/ingest-normalize.ts toFmvRowV131): per edition id, the MEDIAN and
-- COUNT of its last <=3 realized NON-special sales sold MORE than 30 days ago — the sales just before
-- the 30-day window panini_recent_sales_fmv prices from.
--
-- WHY. A lone outlier sale became the price: Max Muncy BC 2021 Prizm Silver /199 sold for $1 at every
-- sale since 2023, then once for $770 (10-17); FMV $770, and the sniper and Overview published a $5
-- ask as "-99 %, +$765". Measured out of sample (panini_sales, 60 d of targets, 400 d of history):
--   when the newest sale was >= 5x the median of the 3-5 before it (n 284), the NEXT sale was within
--   ±25 % of that spike 5.6 % of the time (median ratio 7.60), of the prior median 51.4 % (ratio 1.00).
--   1.3.1's guard (30-day n = 1-2, price >= 5x this prior median with >= 3 priors -> price = prior
--   median, LOW): fires on 32 of 12,232 thin-window targets; within them ±25 % 15.6 % -> 31.3 %, median
--   error 312 % -> 50 %, p90 3,810 % -> 91 %; the other 12,200 are unchanged (59.0 % either way).
--   A blanket "last 3 at any age" for thin editions was measured too and REJECTED (n30=1: 59.7 -> 56.6 %).
--
-- anon-exec: revoked (panini_prior_sales_median) — REVOKE FROM PUBLIC, anon, authenticated below; service_role only (the ingest route).
-- Revert: DROP FUNCTION public.panini_prior_sales_median(text[]); and PANINI_FMV_ENGINE=1.3 (or git revert) on the route.

CREATE FUNCTION public.panini_prior_sales_median(p_edition_ids text[])
RETURNS TABLE (edition_id text, prior_median_usd numeric, n_prior integer)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT e.id,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY z.p))::numeric, 2),
         count(*)::int
    FROM panini_editions e
    CROSS JOIN LATERAL (
      SELECT s.amount_usd AS p
        FROM panini_sales s
       WHERE s.edition_external_id = e.external_id
         AND s.amount_usd > 0
         AND s.sold_at <= now() - interval '30 days'
         AND NOT EXISTS (SELECT 1 FROM panini_card_serials x WHERE x.sku = s.sku AND x.is_special)
       ORDER BY s.sold_at DESC
       LIMIT 3) z
   WHERE e.id = ANY (p_edition_ids)
   GROUP BY e.id
$$;

REVOKE ALL ON FUNCTION public.panini_prior_sales_median(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_prior_sales_median(text[]) TO service_role;
