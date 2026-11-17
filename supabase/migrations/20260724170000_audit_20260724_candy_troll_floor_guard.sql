-- Item 1 (HIGH, go-live blocker) — troll/moonshot asks were polluting the displayed Candy FLOOR.
-- candy_listing_floor computed floor_usd = raw min(price_usd) over active listings, so a single
-- $19,848 ask on a $5-FMV /250 COMMON (or a $3,305 no-sale Rainbow) rendered AS the floor on the
-- Market tab (candy_secondary_board.floor_ask_usd) and the Spread board (candy_offer_spread_board
-- .floor_usd / spread_usd / spread_pct). 28/218 active asks were >$100, 3 >$1,000. Same class as the
-- Top Shot NODATA troll-ask problem. The surface is GATED (candy_mlb is_active=false, /insights/candy*
-- behind proxy.ts) so this is a pre-launch visible-embarrassment fix, not a live incident.
--
-- Fix, at the source: exclude any active listing priced above a troll ceiling of
--   K * GREATEST(edition's own fmv_usd, its tier-median fmv_usd),  K = 10.
-- The tier-median leg covers the cold tail (null-FMV editions, mostly Rainbows). When an edition has
-- NO reference at all (own FMV null AND its tier has no median — cannot happen for Candy's two tiers
-- today, both have a median) the ceiling is NULL and every ask is kept (we can't judge). When EVERY
-- ask exceeds the ceiling the guarded floor becomes NULL (honest "—" instead of a fake $592 floor);
-- excluded_troll_count / floor_capped are exposed so the UI can footnote what was hidden.
-- listing_count now counts KEPT (non-troll) listings; excluded_troll_count is separate.
-- K=10 and the null-when-all-trolls behavior are the recommended defaults (handoff 2026-07-24);
-- K is the single tunable below.
--
-- candy_secondary_board / candy_offer_spread_board both already consume lf.floor_usd (NOT their own
-- min), so guarding candy_listing_floor fixes the floor on both boards automatically. The board
-- rewrites here only ADD an excluded_troll_count passthrough column (appended, so CREATE OR REPLACE
-- stays type-compatible). fmv_usd is left as-is (numeric(12,4) — its type can't be changed via
-- CREATE OR REPLACE); the Item-4 cosmetic (raw JSON showed $3.2500) is handled in the public API
-- route by rounding fmv_usd to 2 in JS. The deals board is unaffected (deals require ask < FMV;
-- trolls are ask >> FMV, so they never appear there) and is left untouched.
--
-- Applied live via MCP; this file is for repo/rebuild parity (re-applying is harmless).
-- Revert: restore the three view bodies from migrations 20260724160000 (candy_listing_floor) and
-- 20260724160400 (candy_offer_spread_board / candy_secondary_board).

-- ── 1. candy_listing_floor: troll-guarded floor (K=10) ──────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_listing_floor
WITH (security_invoker = true) AS
WITH tier_median AS (
  SELECT e.tier,
         (percentile_cont(0.5) WITHIN GROUP (ORDER BY fc.fmv_usd))::numeric AS tier_median_fmv
  FROM public.editions e
  JOIN public.fmv_current fc ON fc.edition_id = e.id
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
    -- K=10 troll ceiling; NULL means "no reference -> cannot judge -> keep the ask".
    NULLIF(10.0 * GREATEST(COALESCE(fc.fmv_usd::numeric, 0), COALESCE(tm.tier_median_fmv, 0)), 0) AS troll_ceiling
  FROM public.candy_listings l
  JOIN public.editions e          ON e.id = l.edition_id
  LEFT JOIN public.fmv_current fc  ON fc.edition_id = l.edition_id
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

-- ── 2. candy_offer_spread_board: guarded floor (via lf) + excluded_troll_count passthrough ──────
CREATE OR REPLACE VIEW public.candy_offer_spread_board
WITH (security_invoker = true) AS
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
LEFT JOIN public.fmv_current fc          ON fc.edition_id = e.id
WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  AND (lf.floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);
REVOKE ALL ON public.candy_offer_spread_board FROM anon, authenticated;
GRANT SELECT ON public.candy_offer_spread_board TO service_role;

-- ── 3. candy_secondary_board (Market tab): guarded floor_ask_usd (via lf) + excluded_troll_count ─
CREATE OR REPLACE VIEW public.candy_secondary_board
WITH (security_invoker = true) AS
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
LEFT JOIN public.fmv_current fc       ON fc.edition_id = c.id
LEFT JOIN sale_stats ss               ON ss.edition_id = c.id
LEFT JOIN public.candy_best_offers bo ON bo.edition_id = c.id
LEFT JOIN public.candy_listing_floor lf ON lf.edition_id = c.id;
REVOKE ALL ON public.candy_secondary_board FROM anon, authenticated;
GRANT SELECT ON public.candy_secondary_board TO service_role;
