-- audit_20261026: candy_offer_spread_board prices the CONFIRMED floor (Candy parity, fifth pass).
--
-- The public /insights/candy-mlb "Spreads" view read candy_listing_floor.floor_usd / listing_count —
-- the min / count over every `is_active` listing. The 3-hourly whole-book sweep does not always flip a
-- listing it stopped seeing (measured 2026-10-26: 108 of 1,498 active rows last re-seen 3+ days ago), so 5 of
-- 124 editions showed a floor no live listing carries, 4 had NO live listing at all, and 34 listing counts
-- were inflated. The same view already carries confirmed_floor_usd / confirmed_listing_count (re-seen in 12 h),
-- which the edition page's "% Listed", the floor CTA and the market-history lane use; this view now uses them,
-- and its floor-copy CTE picks the copy from listings re-seen in 12 h. Column names / order / types unchanged
-- (CREATE OR REPLACE VIEW), security_invoker re-set.
--
-- Revert: re-apply the CREATE OR REPLACE VIEW in 20260829001636_audit_20260828_candy_boards_join_the_scoped_fmv_view.sql
-- (floor_usd / listing_count from candy_listing_floor's unconfirmed columns, floor_mint over every is_active
-- listing), then ALTER VIEW ... SET (security_invoker = on).

CREATE OR REPLACE VIEW public.candy_offer_spread_board AS
 WITH top_offer AS (
         SELECT DISTINCT ON (o.edition_id) o.edition_id,
            o.token_mint AS best_offer_mint
           FROM candy_offers o
          WHERE o.is_active AND (o.expiry IS NULL OR o.expiry > now())
          ORDER BY o.edition_id, o.price_usd DESC, o.token_mint
        ), floor_mint AS (
         SELECT DISTINCT ON (l.edition_id) l.edition_id,
            l.token_mint AS floor_mint
           FROM candy_listings l
             JOIN candy_listing_floor lf_1 ON lf_1.edition_id = l.edition_id AND l.price_usd = lf_1.confirmed_floor_usd
          WHERE l.is_active AND l.last_seen_at > (now() - '12:00:00'::interval)
          ORDER BY l.edition_id, l.token_mint
        ), floor_copy_bid AS (
         SELECT fm_1.edition_id,
            max(o.price_usd) AS floor_copy_bid_usd
           FROM floor_mint fm_1
             JOIN candy_offers o ON o.token_mint = fm_1.floor_mint AND o.is_active AND (o.expiry IS NULL OR o.expiry > now())
          GROUP BY fm_1.edition_id
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.tier::text AS tier,
    e.tier = 'LEGENDARY'::tier_type AS is_rainbow,
    e.circulation_count,
    lf.confirmed_floor_usd AS floor_usd,
    lf.confirmed_listing_count AS listing_count,
    bo.best_offer_usd,
    bo.distinct_bidders,
    fc.fmv_usd,
    fm.floor_mint,
    t.best_offer_mint,
        CASE
            WHEN fm.floor_mint IS NOT NULL AND t.best_offer_mint IS NOT NULL THEN fm.floor_mint = t.best_offer_mint
            ELSE NULL::boolean
        END AS same_copy,
    fcb.floor_copy_bid_usd,
        CASE
            WHEN lf.confirmed_floor_usd IS NOT NULL AND fcb.floor_copy_bid_usd IS NOT NULL THEN round(lf.confirmed_floor_usd - fcb.floor_copy_bid_usd, 2)
            ELSE NULL::numeric
        END AS exec_spread_usd,
        CASE
            WHEN lf.confirmed_floor_usd IS NOT NULL AND lf.confirmed_floor_usd > 0::numeric AND fcb.floor_copy_bid_usd IS NOT NULL THEN round(100.0 * (lf.confirmed_floor_usd - fcb.floor_copy_bid_usd) / lf.confirmed_floor_usd, 1)
            ELSE NULL::numeric
        END AS exec_spread_pct
   FROM editions e
     LEFT JOIN candy_listing_floor lf ON lf.edition_id = e.id
     LEFT JOIN candy_best_offers bo ON bo.edition_id = e.id
     LEFT JOIN candy_fmv_current fc ON fc.edition_id = e.id
     LEFT JOIN floor_mint fm ON fm.edition_id = e.id
     LEFT JOIN top_offer t ON t.edition_id = e.id
     LEFT JOIN floor_copy_bid fcb ON fcb.edition_id = e.id
  WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid AND (lf.confirmed_floor_usd IS NOT NULL OR bo.best_offer_usd IS NOT NULL);

ALTER VIEW public.candy_offer_spread_board SET (security_invoker = on);
