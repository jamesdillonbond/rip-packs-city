-- audit_20261126_ufc_fmv_capped_at_aptos_ask_now
--
-- 2026-11-26 ~10:30 AM PT (Claude Code cloud; Trevor: "Do it all"). Follow-up to 20261126174033, which installed
-- fmv_snapshots_cap_ufc_to_aptos_ask. UFC snapshots are written about weekly (fmv-recalc 1.8.3 / cold-tail, last
-- 2026-11-23), so without this the cap would wait for the next pass. This inserts ONE fresh snapshot per UFC edition
-- whose newest snapshot (≤45 days) is above its live single Rarible ask, copying that snapshot's fields with
-- computed_at = now(); the BEFORE INSERT trigger performs the cap (fmv_usd -> ask, algo_version + '_aptoscap').
-- Measured just before: 350 of the 438 editions with a live single listing; summed edition FMV $1,819.87 -> $921.31
-- at APT $0.3728. History is kept (insert only, no update, no delete); edition_fmv_current picks the new rows up on its
-- hourly incremental refresh (they carry the newest computed_at).
--
-- Revert: DELETE FROM public.fmv_snapshots WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
--           AND algo_version LIKE '%\_aptoscap' AND computed_at >= '2026-11-26 18:00:00+00' AND computed_at < '2026-11-26 19:30:00+00';
--         then SELECT refresh_edition_fmv_current(); (the cache re-reads the newest remaining snapshot).

WITH latest AS (
  SELECT DISTINCT ON (s.edition_id) s.*
    FROM public.fmv_snapshots s
   WHERE s.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
     AND s.computed_at > now() - interval '45 days'
   ORDER BY s.edition_id, s.computed_at DESC),
fl AS (
  SELECT l.edition_id, min(l.price_apt) ask_apt
    FROM public.ufc_aptos_listings l
   WHERE l.kind = 'single' AND l.price_apt > 0 AND l.last_checked_at > now() - interval '3 days'
   GROUP BY l.edition_id),
apt AS (
  SELECT d.usd FROM public.apt_usd_daily d WHERE d.usd > 0 ORDER BY d.day DESC LIMIT 1)
INSERT INTO public.fmv_snapshots (
  edition_id, collection_id, fmv_usd, floor_price_usd, asp_usd, confidence, top_shot_ask, flowty_ask, cross_market_ask,
  sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count, days_since_sale, velocity_factor,
  utility_factor, loan_factor, algo_version, computed_at, collection, liquidity_rating, asp_without_outliers,
  ask_proxy_fmv, basis_days_since_sale)
SELECT
  l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.asp_usd, l.confidence, l.top_shot_ask, l.flowty_ask, l.cross_market_ask,
  l.sales_count_7d, l.sales_count_30d, l.unique_buyers_30d, l.offer_count, l.listing_count, l.days_since_sale, l.velocity_factor,
  l.utility_factor, l.loan_factor, l.algo_version, now(), l.collection, l.liquidity_rating, l.asp_without_outliers,
  l.ask_proxy_fmv, l.basis_days_since_sale
  FROM latest l
  JOIN fl USING (edition_id)
 WHERE l.confidence <> 'NO_DATA'
   AND l.fmv_usd > round(fl.ask_apt * (SELECT usd FROM apt), 2);
