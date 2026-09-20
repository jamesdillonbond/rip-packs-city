-- Register #131. Both Candy boards returned the SAME listing more than once.
--
-- CAUSE (170 of 172 duplicates on candy_market_board, and all 49 on
-- candy_deals_board): the `LEFT JOIN wallet_moments_cache w ON w.moment_id =
-- l.token_mint` fans out. 297 Candy mints carry more than one cache row (worst:
-- 3), and nothing in either view deduped it, so every extra cache row repeated
-- the whole listing. Measured before this migration:
--   candy_market_board 2,144 rows / 1,972 distinct token_mint  (172 dupes)
--   candy_deals_board    300 rows /   251 distinct token_mint  ( 49 dupes)
-- Measured after: 1,974 / 1,972 (2 left — the ingest ones below) and 251 / 251.
--
-- That join supplies exactly ONE column — `w.serial_number` — so it is replaced
-- by a bounded LATERAL that takes one row. The pick is unambiguous, verified
-- rather than assumed: of the 297 mints with multiple cache rows, 0 disagree
-- on serial_number and none mixes a NULL with a value, so any row yields the
-- same serial. ORDER BY last_seen_at DESC NULLS LAST, wallet_address keeps it
-- deterministic anyway, so the view cannot start flapping if that changes.
--
-- NOT FIXED HERE, DELIBERATELY: the remaining 2 duplicates on
-- candy_market_board are `candy_listings` itself holding TWO ACTIVE ROWS for one
-- token_mint (1,974 active rows over 1,972 mints) — two distinct `pda_address`
-- listing accounts, i.e. a stale listing that was never deactivated. That is an
-- INGEST defect and a view-side dedupe would only hide it. #131 keeps it open.
--
-- `security_invoker = on` IS RE-STATED EXPLICITLY. CREATE OR REPLACE VIEW
-- RESETS reloptions, and both of these carried it — dropping it would silently
-- convert two public-facing boards to definer rights. CLAUDE.md names this trap
-- by name. Column names and order are unchanged (a reorder is 42P16).
-- Re-verified after apply: pg_class.reloptions = {security_invoker=on} on both.

CREATE OR REPLACE VIEW public.candy_market_board
WITH (security_invoker = on) AS
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
    e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.set_name,
    e.team_name,
    e.tier::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    w.serial_number,
    l.price_usd AS ask_usd,
    l.price_sol AS ask_sol,
    fc.fmv_usd,
    fc.confidence::text AS confidence,
    round(100.0 * (1::numeric - l.price_usd / NULLIF(fc.fmv_usd, 0::numeric)), 1) AS discount_pct,
    l.seller,
    l.first_seen_at,
    l.last_seen_at,
    m.median_sale_usd,
    m.sales_count
   FROM candy_listings l
     JOIN editions e ON e.id = l.edition_id
     JOIN candy_fmv_current fc ON fc.edition_id = l.edition_id
     LEFT JOIN med m ON m.edition_id = l.edition_id
     LEFT JOIN LATERAL (
       SELECT wc.serial_number
         FROM wallet_moments_cache wc
        WHERE wc.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          AND wc.moment_id = l.token_mint
        ORDER BY wc.last_seen_at DESC NULLS LAST, wc.wallet_address
        LIMIT 1
     ) w ON true
  WHERE l.is_active AND l.price_usd IS NOT NULL AND l.price_usd > 0::numeric;

CREATE OR REPLACE VIEW public.candy_deals_board
WITH (security_invoker = on) AS
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
     LEFT JOIN LATERAL (
       SELECT wc.serial_number
         FROM wallet_moments_cache wc
        WHERE wc.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
          AND wc.moment_id = l.token_mint
        ORDER BY wc.last_seen_at DESC NULLS LAST, wc.wallet_address
        LIMIT 1
     ) w ON true
  WHERE l.is_active AND l.price_usd IS NOT NULL AND l.price_usd > 0::numeric AND fc.fmv_usd IS NOT NULL AND fc.fmv_usd > 0::numeric AND l.price_usd < fc.fmv_usd AND (m.median_sale_usd IS NULL OR l.price_usd < m.median_sale_usd);
