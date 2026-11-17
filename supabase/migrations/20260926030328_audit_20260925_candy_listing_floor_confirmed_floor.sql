-- audit_20260925_candy_listing_floor_confirmed_floor
--
-- candy_listing_floor.floor_usd is the troll-capped min over EVERY is_active ask,
-- and the indexer (correctly) never retires an ask on absence — so an ask can sit
-- "active" long after it stopped being seen. Sold-since-seen asks are now retired
-- (20260926020528), but asks with no sale evidence remain: measured 2026-09-25,
-- 86 card asks unseen >12 h, setting the floor of 4 editions (the confirmed floor
-- averaged 1.24x higher). The Set Tracker's cost-to-finish read that floor.
--
-- APPENDS two columns (CREATE OR REPLACE VIEW can only add at the end, so every
-- existing column and its meaning is unchanged for candy_secondary_board and
-- candy_offer_spread_board):
--   confirmed_floor_usd      troll-capped min over asks seen in the last 12 h
--   confirmed_listing_count  how many such asks
-- 12 h = four missed sweeps of the 3-hourly /api/candy-listings-indexer.
--
-- Rollback: CREATE OR REPLACE VIEW cannot drop columns, and DROP VIEW ... CASCADE
-- would take candy_secondary_board and candy_offer_spread_board with it. The two
-- appended columns are inert to every other reader, so the rollback is to stop
-- reading them (revert the paired code commit) and leave the view as is.
CREATE OR REPLACE VIEW public.candy_listing_floor AS
 WITH tier_median AS (
         SELECT e.tier,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((fc.fmv_usd)::double precision)))::numeric AS tier_median_fmv
           FROM (editions e
             JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
          WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (fc.fmv_usd IS NOT NULL) AND (fc.fmv_usd > (0)::numeric))
          GROUP BY e.tier
        ), scored AS (
         SELECT l.edition_id,
            l.price_sol,
            l.price_usd,
            l.seller,
            l.last_seen_at,
            NULLIF((10.0 * GREATEST(COALESCE((fc.fmv_usd)::numeric, (0)::numeric), COALESCE(tm.tier_median_fmv, (0)::numeric))), (0)::numeric) AS troll_ceiling
           FROM (((candy_listings l
             JOIN editions e ON ((e.id = l.edition_id)))
             LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = l.edition_id)))
             LEFT JOIN tier_median tm ON ((tm.tier = e.tier)))
          WHERE (l.is_active AND (l.edition_id IS NOT NULL) AND (l.price_usd IS NOT NULL) AND (l.price_usd > (0)::numeric))
        )
 SELECT edition_id,
    min(price_sol) FILTER (WHERE ((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling))) AS floor_sol,
    min(price_usd) FILTER (WHERE ((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling))) AS floor_usd,
    count(*) FILTER (WHERE ((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling))) AS listing_count,
    count(DISTINCT seller) FILTER (WHERE ((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling))) AS distinct_sellers,
    max(last_seen_at) AS last_seen_at,
    count(*) FILTER (WHERE ((troll_ceiling IS NOT NULL) AND (price_usd > troll_ceiling))) AS excluded_troll_count,
    (count(*) FILTER (WHERE ((troll_ceiling IS NOT NULL) AND (price_usd > troll_ceiling))) > 0) AS floor_capped,
    min(price_usd) FILTER (WHERE (((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling)) AND (last_seen_at > (now() - '12:00:00'::interval)))) AS confirmed_floor_usd,
    count(*) FILTER (WHERE (((troll_ceiling IS NULL) OR (price_usd <= troll_ceiling)) AND (last_seen_at > (now() - '12:00:00'::interval)))) AS confirmed_listing_count
   FROM scored
  GROUP BY edition_id;

ALTER VIEW public.candy_listing_floor SET (security_invoker = on);
