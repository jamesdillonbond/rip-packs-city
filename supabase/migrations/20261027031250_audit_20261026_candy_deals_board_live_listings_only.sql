-- audit_20261026: candy_deals_board lists only LIVE listings (Candy parity, sixth pass).
--
-- The public /insights/candy-mlb Deals view kept every `is_active` listing. The 3-hourly whole-book sweep does
-- not always flip a listing it stopped seeing (2026-10-26: 108 of 1,498 active rows last re-seen 3+ days ago),
-- so a dead below-FMV ask could be published as a deal — the most expensive kind of stale row, since it is the
-- one a collector clicks. The board holds 0 rows today (Candy FMV is capped at the confirmed ask), so this is
-- the gate before the market moves, not a live repair. Same 12 h "re-seen" rule as candy_listing_floor's
-- confirmed_* columns, the market arm and the Spreads view (20261027023304). Columns unchanged.
--
-- Revert: re-apply the view from 20260920224013_audit_20260920_candy_boards_stop_fanning_out_on_wallet_moments_cache.sql
-- (no last_seen_at predicate), then ALTER VIEW ... SET (security_invoker = on).

CREATE OR REPLACE VIEW public.candy_deals_board AS
 WITH med AS (
         SELECT s.edition_id,
            count(*) AS sales_count,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (s.price_usd::double precision))::numeric AS median_sale_usd
           FROM sales s
          WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND s.price_usd IS NOT NULL AND s.price_usd > 0::numeric
          GROUP BY s.edition_id
        )
 SELECT l.pda_address,
    l.token_mint,
    e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.tier::text AS tier,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    e.circulation_count,
    w.serial_number,
    l.price_usd AS ask_usd,
    l.price_sol AS ask_sol,
    fc.fmv_usd,
    fc.confidence::text AS confidence,
    round(100.0 * (1::numeric - l.price_usd / NULLIF(fc.fmv_usd, 0::numeric)), 1) AS discount_pct,
    l.seller,
    l.last_seen_at,
    m.median_sale_usd,
    m.sales_count,
    round(100.0 * (1::numeric - l.price_usd / NULLIF(m.median_sale_usd, 0::numeric)), 1) AS discount_vs_median_pct
   FROM candy_listings l
     JOIN editions e ON e.id = l.edition_id
     JOIN candy_fmv_current fc ON fc.edition_id = l.edition_id
     LEFT JOIN med m ON m.edition_id = l.edition_id
     LEFT JOIN LATERAL ( SELECT wc.serial_number
           FROM wallet_moments_cache wc
          WHERE wc.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND wc.moment_id = l.token_mint
          ORDER BY wc.last_seen_at DESC NULLS LAST, wc.wallet_address
         LIMIT 1) w ON true
  WHERE l.is_active AND l.last_seen_at > (now() - '12:00:00'::interval) AND l.price_usd IS NOT NULL AND l.price_usd > 0::numeric AND fc.fmv_usd IS NOT NULL AND fc.fmv_usd > 0::numeric AND l.price_usd < fc.fmv_usd AND (m.median_sale_usd IS NULL OR l.price_usd < m.median_sale_usd);

ALTER VIEW public.candy_deals_board SET (security_invoker = on);
