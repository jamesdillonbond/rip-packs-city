-- audit_20260924_panini_squeeze_totals_sale_backed_under_fmv_1_1_0
-- FMV engine panini-1.1.0 (2026-09-24) changed what confidence means: HIGH/MEDIUM = priced from sales in
-- the last 30 days, LOW = lifetime average of older sales. pct_sealed_usd_sale_backed counted HIGH+MEDIUM,
-- so the public "X% from editions a real sale stands behind" would have fallen 69.6% -> 16.7% with no
-- change in evidence. Redefined as HIGH+MEDIUM+LOW (any real sale; 89.4% after the switch) and added
-- pct_sealed_usd_recent_sale_backed(_hc) = HIGH+MEDIUM (16.7% / 18.5%), which the page now also states.
-- Columns keep their order; two are appended. Revert: re-apply 20260919181331/20260920* view body.

CREATE OR REPLACE VIEW public.panini_squeeze_totals WITH (security_invoker = true) AS
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), (0)::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE (mint_cap <= 25)) AS chases_lte_25,
    COALESCE(sum(still_in_packs), (0)::bigint) AS sealed_copies,
    count(*) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))) AS editions_hc,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)) AS sealed_fmv_exposure_usd_hc,
    COALESCE(sum(still_in_packs) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::bigint) AS sealed_copies_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['heavily_biased'::text, 'listing_gated'::text]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_from_biased_sets,
    count(*) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)) AS editions_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)), (0)::numeric)) AS sealed_fmv_exposure_usd_ask_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = 'ASK_ONLY'::fmv_confidence)), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_from_asks_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_sale_backed,
    count(*) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))) AS editions_hc_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))), (0)::numeric)) AS sealed_fmv_exposure_usd_hc_ask_only,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = 'ASK_ONLY'::fmv_confidence))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_from_asks_only_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence, 'LOW'::fmv_confidence])))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_sale_backed_hc,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence]))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd), (0)::numeric)), 1) AS pct_sealed_usd_recent_sale_backed,
    round(((100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE ((coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AND (fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])))), (0)::numeric)) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE (coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]))), (0)::numeric)), 1) AS pct_sealed_usd_recent_sale_backed_hc
   FROM panini_squeeze_board
  WHERE (fmv_usd IS NOT NULL);

COMMENT ON VIEW public.panini_squeeze_totals IS
  'Squeeze headline totals + composition. 2026-09-24 (FMV engine panini-1.1.0): confidence now means RECENT evidence — HIGH/MEDIUM = priced from sales in the last 30 days, LOW = lifetime average of older sales, ASK_ONLY = floor ask x 0.50. pct_sealed_usd_sale_backed(_hc) therefore now counts HIGH+MEDIUM+LOW ("a real sale stands behind it", which is what the page says), and the new pct_sealed_usd_recent_sale_backed(_hc) counts HIGH+MEDIUM. Left at HIGH+MEDIUM, the published sale-backed share would have dropped 69.6% -> 16.7% with no change in underlying evidence.';
