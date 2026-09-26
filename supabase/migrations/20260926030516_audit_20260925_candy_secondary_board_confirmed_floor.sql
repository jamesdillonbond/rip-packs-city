-- audit_20260925_candy_secondary_board_confirmed_floor
--
-- The public /insights/candy-mlb board's "Floor ask" (floor_ask_usd) and listing
-- count read candy_listing_floor.floor_usd / listing_count, which count asks the
-- indexer has not seen for days (it never retires on absence). They now read the
-- CONFIRMED pair added by 20260926030328 (asks seen in the last 12 h). Same
-- columns, same names, same order and types — only those two expressions change.
-- Measured at apply: 5 of 124 editions differ (4 floors were set by an ask unseen
-- >12 h; 1 edition has only unseen asks and now shows no floor rather than a stale one).
--
-- Rollback: re-apply with `lf.floor_usd AS floor_ask_usd, lf.listing_count,`
-- (the body below with those two lines restored), then
-- ALTER VIEW public.candy_secondary_board SET (security_invoker = on).
CREATE OR REPLACE VIEW public.candy_secondary_board AS
 WITH cand AS (
         SELECT e.id,
            e.external_id,
            e.name AS edition_name,
            e.player_name,
            e.tier,
            e.circulation_count
           FROM editions e
          WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), sale_stats AS (
         SELECT s.edition_id,
            count(*) AS sales_all,
            count(*) FILTER (WHERE (s.sold_at > (now() - '24:00:00'::interval))) AS sales_24h,
            count(*) FILTER (WHERE (s.sold_at > (now() - '7 days'::interval))) AS sales_7d,
            max(s.sold_at) AS last_sale_at,
            (array_agg(s.price_usd ORDER BY s.sold_at DESC))[1] AS last_sale_usd,
            (array_agg(s.serial_number ORDER BY s.sold_at DESC))[1] AS last_sale_serial,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.price_usd)::double precision)))::numeric AS median_sale_usd
           FROM sales s
          WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (s.edition_id IS NOT NULL))
          GROUP BY s.edition_id
        )
 SELECT c.external_id,
    c.player_name,
    c.edition_name,
    (c.tier)::text AS tier,
    (c.tier = 'LEGENDARY'::tier_type) AS is_rainbow,
    c.circulation_count,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence,
    fc.computed_at AS fmv_computed_at,
    COALESCE(ss.sales_24h, (0)::bigint) AS sales_24h,
    COALESCE(ss.sales_7d, (0)::bigint) AS sales_7d,
    COALESCE(ss.sales_all, (0)::bigint) AS sales_all,
    ss.last_sale_at,
    ss.last_sale_usd,
    bo.best_offer_usd,
    bo.distinct_bidders AS offer_bidders,
    lf.confirmed_floor_usd AS floor_ask_usd,
    lf.confirmed_listing_count AS listing_count,
    COALESCE(lf.excluded_troll_count, (0)::bigint) AS excluded_troll_count,
    ss.last_sale_serial,
    ss.median_sale_usd
   FROM ((((cand c
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = c.id)))
     LEFT JOIN sale_stats ss ON ((ss.edition_id = c.id)))
     LEFT JOIN candy_best_offers bo ON ((bo.edition_id = c.id)))
     LEFT JOIN candy_listing_floor lf ON ((lf.edition_id = c.id)));

ALTER VIEW public.candy_secondary_board SET (security_invoker = on);
