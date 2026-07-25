-- Item 1 (HIGH, go-live PERF blocker) — the FMV-heavy Candy boards did full-warehouse FMV scans.
-- Every candy board read "latest FMV per edition" from the GLOBAL `fmv_current` view
-- (SELECT DISTINCT ON (edition_id) … FROM fmv_snapshots ORDER BY edition_id, computed_at DESC —
-- NO collection filter), which materializes the whole ~896,700-row fmv_snapshots_2026 partition
-- each render. The 2026-07-24 troll-floor fix added `fmv_current` joins INSIDE candy_listing_floor
-- (its tier_median + scored CTEs), and candy_secondary_board / candy_offer_spread_board join both
-- candy_listing_floor AND fmv_current, so the 896k scan happened 2–3× per render. Measured EXPLAIN
-- total cost: secondary 163,303 · spread 163,199 · special_serials 71,059 · deals 54,324 — several
-- of them TIMED OUT (>60s) cold / under IOPS pressure, blowing the public-route budget (anon 3s /
-- service 30s) and intermittently rendering the plausible-empty state no health check catches.
--
-- Fix: a CANDY-SCOPED latest-FMV view. fmv_snapshots_2026 has
-- `(collection_id, edition_id, computed_at DESC) INCLUDE (fmv_usd)`, so a `WHERE collection_id = candy`
-- DISTINCT ON index-scans ONLY candy's few-thousand FMV rows instead of all 896k. Output is identical
-- (candy editions only have candy FMV rows) — purely a scan-scoping change. Every `fmv_current`
-- reference in the five candy views is repointed to `candy_fmv_current`.
-- Grants/RLS mirror the other candy views: security_invoker=on, anon/authenticated REVOKED,
-- service_role only (passes check_public_security_invariants).
--
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: repoint the five views back to `fmv_current` (defs from migrations 20260724160000 /
-- 20260724160400 / 20260724170000 / the special-serials + deals-spread migrations) and
-- `DROP VIEW public.candy_fmv_current;`.

-- ── 0. candy-scoped latest FMV ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_fmv_current
WITH (security_invoker = on) AS
SELECT DISTINCT ON (edition_id)
  edition_id,
  fmv_usd,
  confidence,
  computed_at
FROM public.fmv_snapshots
WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
ORDER BY edition_id, computed_at DESC;

REVOKE ALL ON public.candy_fmv_current FROM anon, authenticated;
GRANT SELECT ON public.candy_fmv_current TO service_role;

-- ── 1. candy_listing_floor (2 fmv refs: tier_median + scored) ───────────────────────────────────
CREATE OR REPLACE VIEW public.candy_listing_floor
WITH (security_invoker = on) AS
WITH tier_median AS (
  SELECT e.tier,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY fc.fmv_usd))::numeric AS tier_median_fmv
  FROM public.editions e
  JOIN public.candy_fmv_current fc ON fc.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND fc.fmv_usd IS NOT NULL AND fc.fmv_usd > 0
  GROUP BY e.tier
),
scored AS (
  SELECT
    l.edition_id,
    l.price_sol,
    l.price_usd,
    l.seller,
    l.last_seen_at,
    NULLIF(10.0 * GREATEST(COALESCE(fc.fmv_usd::numeric, 0), COALESCE(tm.tier_median_fmv, 0)), 0) AS troll_ceiling
  FROM public.candy_listings l
  JOIN public.editions e          ON e.id = l.edition_id
  LEFT JOIN public.candy_fmv_current fc ON fc.edition_id = l.edition_id
  LEFT JOIN tier_median tm         ON tm.tier = e.tier
  WHERE l.is_active AND l.edition_id IS NOT NULL AND l.price_usd IS NOT NULL AND l.price_usd > 0
)
SELECT
  edition_id,
  min(price_sol) FILTER (WHERE troll_ceiling IS NULL OR price_usd <= troll_ceiling)          AS floor_sol,
  min(price_usd) FILTER (WHERE troll_ceiling IS NULL OR price_usd <= troll_ceiling)          AS floor_usd,
  count(*)       FILTER (WHERE troll_ceiling IS NULL OR price_usd <= troll_ceiling)          AS listing_count,
  count(DISTINCT seller) FILTER (WHERE troll_ceiling IS NULL OR price_usd <= troll_ceiling)  AS distinct_sellers,
  max(last_seen_at)                                                                          AS last_seen_at,
  count(*) FILTER (WHERE troll_ceiling IS NOT NULL AND price_usd > troll_ceiling)            AS excluded_troll_count,
  (count(*) FILTER (WHERE troll_ceiling IS NOT NULL AND price_usd > troll_ceiling) > 0)      AS floor_capped
FROM scored
GROUP BY edition_id;

REVOKE ALL ON public.candy_listing_floor FROM anon, authenticated;
GRANT SELECT ON public.candy_listing_floor TO service_role;

-- ── 2. candy_deals_board ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_deals_board
WITH (security_invoker = on) AS
SELECT
  l.pda_address,
  l.token_mint,
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  w.serial_number,
  l.price_usd                              AS ask_usd,
  l.price_sol                              AS ask_sol,
  fc.fmv_usd,
  fc.confidence::text                      AS confidence,
  round(100.0 * (1 - l.price_usd / NULLIF(fc.fmv_usd, 0)), 1) AS discount_pct,
  l.seller,
  l.last_seen_at
FROM public.candy_listings l
JOIN public.editions e          ON e.id = l.edition_id
JOIN public.candy_fmv_current fc ON fc.edition_id = l.edition_id
LEFT JOIN public.wallet_moments_cache w
  ON w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
 AND w.moment_id = l.token_mint
WHERE l.is_active
  AND l.price_usd IS NOT NULL AND l.price_usd > 0
  AND fc.fmv_usd  IS NOT NULL AND fc.fmv_usd  > 0
  AND l.price_usd < fc.fmv_usd;
REVOKE ALL ON public.candy_deals_board FROM anon, authenticated;
GRANT SELECT ON public.candy_deals_board TO service_role;

-- ── 3. candy_offer_spread_board ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_offer_spread_board
WITH (security_invoker = on) AS
SELECT
  e.external_id,
  e.player_name,
  e.name                                   AS edition_name,
  e.tier::text                             AS tier,
  (e.tier = 'LEGENDARY')                   AS is_rainbow,
  e.circulation_count,
  lf.floor_usd,
  lf.listing_count,
  bo.best_offer_usd,
  bo.distinct_bidders,
  fc.fmv_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND bo.best_offer_usd IS NOT NULL
       THEN round(lf.floor_usd - bo.best_offer_usd, 2) END AS spread_usd,
  CASE WHEN lf.floor_usd IS NOT NULL AND bo.best_offer_usd IS NOT NULL AND bo.best_offer_usd > 0
       THEN round(100.0 * (lf.floor_usd - bo.best_offer_usd) / bo.best_offer_usd, 1) END AS spread_pct,
  COALESCE(lf.excluded_troll_count, 0)     AS excluded_troll_count
FROM public.editions e
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = e.id
LEFT JOIN public.candy_best_offers bo    ON bo.edition_id = e.id
LEFT JOIN public.candy_fmv_current fc    ON fc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND (lf.floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);
REVOKE ALL ON public.candy_offer_spread_board FROM anon, authenticated;
GRANT SELECT ON public.candy_offer_spread_board TO service_role;

-- ── 4. candy_secondary_board (Market tab) ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_secondary_board
WITH (security_invoker = on) AS
WITH cand AS (
  SELECT e.id, e.external_id, e.name AS edition_name, e.player_name, e.tier, e.circulation_count
  FROM public.editions e
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
),
sale_stats AS (
  SELECT s.edition_id,
         count(*) AS sales_all,
         count(*) FILTER (WHERE s.sold_at > now() - interval '24 hours') AS sales_24h,
         count(*) FILTER (WHERE s.sold_at > now() - interval '7 days')  AS sales_7d,
         max(s.sold_at) AS last_sale_at,
         (array_agg(s.price_usd ORDER BY s.sold_at DESC))[1] AS last_sale_usd
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND s.edition_id IS NOT NULL
  GROUP BY s.edition_id
)
SELECT
  c.external_id,
  c.player_name,
  c.edition_name,
  c.tier::text                              AS tier,
  (c.tier = 'LEGENDARY')                    AS is_rainbow,
  c.circulation_count,
  fc.fmv_usd,
  fc.confidence::text                       AS confidence,
  fc.computed_at                            AS fmv_computed_at,
  COALESCE(ss.sales_24h, 0)                 AS sales_24h,
  COALESCE(ss.sales_7d, 0)                  AS sales_7d,
  COALESCE(ss.sales_all, 0)                 AS sales_all,
  ss.last_sale_at,
  ss.last_sale_usd,
  bo.best_offer_usd,
  bo.distinct_bidders                       AS offer_bidders,
  lf.floor_usd                              AS floor_ask_usd,
  lf.listing_count,
  COALESCE(lf.excluded_troll_count, 0)      AS excluded_troll_count
FROM cand c
LEFT JOIN public.candy_fmv_current fc  ON fc.edition_id = c.id
LEFT JOIN sale_stats ss                ON ss.edition_id = c.id
LEFT JOIN public.candy_best_offers bo  ON bo.edition_id = c.id
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = c.id;
REVOKE ALL ON public.candy_secondary_board FROM anon, authenticated;
GRANT SELECT ON public.candy_secondary_board TO service_role;

-- ── 5. candy_special_serials_board ───────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_special_serials_board
WITH (security_invoker = on) AS
WITH treas AS (
  SELECT wallet_address FROM public.candy_treasury_wallet
)
SELECT
  e.external_id,
  e.player_name,
  e.name                                    AS edition_name,
  e.tier::text                              AS tier,
  (e.tier = 'LEGENDARY'::tier_type)         AS is_rainbow,
  e.circulation_count,
  w.serial_number,
  CASE
    WHEN w.serial_number = 1 THEN 'first_mint'::text
    WHEN w.serial_number = e.circulation_count THEN 'last_mint'::text
    ELSE 'low_serial'::text
  END                                       AS kind,
  w.wallet_address                          AS owner,
  w.wallet_address = (SELECT treas.wallet_address FROM treas) AS is_treasury,
  fc.fmv_usd,
  fc.confidence::text                       AS confidence,
  ls.last_sale_usd,
  ls.last_sale_at
FROM public.wallet_moments_cache w
JOIN public.editions e
  ON e.external_id::text = w.edition_key
 AND e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
LEFT JOIN public.candy_fmv_current fc ON fc.edition_id = e.id
LEFT JOIN LATERAL (
  SELECT s.price_usd AS last_sale_usd, s.sold_at AS last_sale_at
  FROM public.sales s
  WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    AND s.edition_id = e.id AND s.serial_number = w.serial_number
  ORDER BY s.sold_at DESC
  LIMIT 1
) ls ON true
WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND w.serial_number IS NOT NULL
  AND (w.serial_number = 1 OR w.serial_number = e.circulation_count OR w.serial_number <= 3);
REVOKE ALL ON public.candy_special_serials_board FROM anon, authenticated;
GRANT SELECT ON public.candy_special_serials_board TO service_role;
