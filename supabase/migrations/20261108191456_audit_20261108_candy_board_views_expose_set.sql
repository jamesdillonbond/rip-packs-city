-- audit_20261108_candy_board_views_expose_set
--
-- /insights/candy-mlb is the Base Series board (Rainbow filter, pack EV, sealed-supply
-- scarcity, "2026 MLB Base Series ICONs" in its copy, OG card and public API). After
-- 20261108190334 the shared Candy board views carry every Candy set, so tonight's census
-- would mix All-Star / Gold / Quest rows into it (a Gold Legendary 1/1 under "Rainbows").
-- The four edition-grain board views gain a trailing `set_id` column (CREATE OR REPLACE
-- may append) so the board reads `set_id = Base`; the Market tab, /insights/deals and the
-- concierge keep reading every set. candy_player_board (read only by this board) is
-- scoped to the Base set in the view. Bodies otherwise identical to 20261108190334.
--
-- Rollback: re-apply the four bodies and candy_player_board from 20261108190334
--   (a column cannot be dropped by CREATE OR REPLACE: DROP VIEW … then re-create; candy_deals_board
--   feeds mv_cross_collection_deals, so prefer leaving the extra column).

CREATE OR REPLACE VIEW public.candy_secondary_board WITH (security_invoker = on) AS
 WITH cand AS (
         SELECT e.id,
            e.external_id,
            e.name AS edition_name,
            e.player_name,
            e.tier,
            e.circulation_count,
            e.badges,
            e.set_id
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
    public.candy_is_rainbow(c.badges) AS is_rainbow,
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
    ss.median_sale_usd,
    c.set_id
   FROM ((((cand c
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = c.id)))
     LEFT JOIN sale_stats ss ON ((ss.edition_id = c.id)))
     LEFT JOIN candy_best_offers bo ON ((bo.edition_id = c.id)))
     LEFT JOIN candy_listing_floor lf ON ((lf.edition_id = c.id)));

CREATE OR REPLACE VIEW public.candy_offer_spread_board WITH (security_invoker = on) AS
 WITH top_offer AS (
         SELECT DISTINCT ON (o.edition_id) o.edition_id,
            o.token_mint AS best_offer_mint
           FROM candy_offers o
          WHERE (o.is_active AND ((o.expiry IS NULL) OR (o.expiry > now())))
          ORDER BY o.edition_id, o.price_usd DESC, o.token_mint
        ), floor_mint AS (
         SELECT DISTINCT ON (l.edition_id) l.edition_id,
            l.token_mint AS floor_mint
           FROM (candy_listings l
             JOIN candy_listing_floor lf_1 ON (((lf_1.edition_id = l.edition_id) AND (l.price_usd = lf_1.confirmed_floor_usd))))
          WHERE (l.is_active AND (l.last_seen_at > (now() - '12:00:00'::interval)))
          ORDER BY l.edition_id, l.token_mint
        ), floor_copy_bid AS (
         SELECT fm_1.edition_id,
            max(o.price_usd) AS floor_copy_bid_usd
           FROM (floor_mint fm_1
             JOIN candy_offers o ON (((o.token_mint = fm_1.floor_mint) AND o.is_active AND ((o.expiry IS NULL) OR (o.expiry > now())))))
          GROUP BY fm_1.edition_id
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    public.candy_is_rainbow(e.badges) AS is_rainbow,
    e.circulation_count,
    lf.confirmed_floor_usd AS floor_usd,
    lf.confirmed_listing_count AS listing_count,
    bo.best_offer_usd,
    bo.distinct_bidders,
    fc.fmv_usd,
    fm.floor_mint,
    t.best_offer_mint,
        CASE
            WHEN ((fm.floor_mint IS NOT NULL) AND (t.best_offer_mint IS NOT NULL)) THEN (fm.floor_mint = t.best_offer_mint)
            ELSE NULL::boolean
        END AS same_copy,
    fcb.floor_copy_bid_usd,
        CASE
            WHEN ((lf.confirmed_floor_usd IS NOT NULL) AND (fcb.floor_copy_bid_usd IS NOT NULL)) THEN round((lf.confirmed_floor_usd - fcb.floor_copy_bid_usd), 2)
            ELSE NULL::numeric
        END AS exec_spread_usd,
        CASE
            WHEN ((lf.confirmed_floor_usd IS NOT NULL) AND (lf.confirmed_floor_usd > (0)::numeric) AND (fcb.floor_copy_bid_usd IS NOT NULL)) THEN round(((100.0 * (lf.confirmed_floor_usd - fcb.floor_copy_bid_usd)) / lf.confirmed_floor_usd), 1)
            ELSE NULL::numeric
        END AS exec_spread_pct,
    e.set_id
   FROM ((((((editions e
     LEFT JOIN candy_listing_floor lf ON ((lf.edition_id = e.id)))
     LEFT JOIN candy_best_offers bo ON ((bo.edition_id = e.id)))
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
     LEFT JOIN floor_mint fm ON ((fm.edition_id = e.id)))
     LEFT JOIN top_offer t ON ((t.edition_id = e.id)))
     LEFT JOIN floor_copy_bid fcb ON ((fcb.edition_id = e.id)))
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND ((lf.confirmed_floor_usd IS NOT NULL) OR (bo.best_offer_usd IS NOT NULL)));

CREATE OR REPLACE VIEW public.candy_special_serials_board WITH (security_invoker = on) AS
 WITH treas AS (
         SELECT candy_treasury_wallet.wallet_address
           FROM candy_treasury_wallet
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    public.candy_is_rainbow(e.badges) AS is_rainbow,
    e.circulation_count,
    w.serial_number,
        CASE
            WHEN (w.serial_number = 1) THEN 'first_mint'::text
            WHEN (w.serial_number = e.circulation_count) THEN 'last_mint'::text
            WHEN (w.serial_number <= 3) THEN 'low_serial'::text
            ELSE 'jersey_match'::text
        END AS kind,
    w.wallet_address AS owner,
    (w.wallet_address = ( SELECT treas.wallet_address
           FROM treas)) AS is_treasury,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence,
    ls.last_sale_usd,
    ls.last_sale_at,
    e.set_id
   FROM (((editions e
     CROSS JOIN LATERAL ( SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (m.serial_number <= 3))
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (m.serial_number = e.circulation_count))
        UNION
         SELECT m.serial_number,
            m.wallet_address
           FROM wallet_moments_cache m
          WHERE ((m.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (m.edition_key = (e.external_id)::text) AND (e.jersey_number IS NOT NULL) AND (e.jersey_number > 0) AND (m.serial_number = e.jersey_number))) w)
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
     LEFT JOIN LATERAL ( SELECT s.price_usd AS last_sale_usd,
            s.sold_at AS last_sale_at
           FROM sales s
          WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (s.edition_id = e.id) AND (s.serial_number = w.serial_number) AND (s.sold_at >= '2026-01-01 00:00:00+00'::timestamp with time zone))
          ORDER BY s.sold_at DESC
         LIMIT 1) ls ON (true))
  WHERE (e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid);

CREATE OR REPLACE VIEW public.candy_deals_board WITH (security_invoker = on) AS
 WITH med AS (
         SELECT s.edition_id,
            count(*) AS sales_count,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((s.price_usd)::double precision)))::numeric AS median_sale_usd
           FROM sales s
          WHERE ((s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (s.price_usd IS NOT NULL) AND (s.price_usd > (0)::numeric))
          GROUP BY s.edition_id
        )
 SELECT l.pda_address,
    l.token_mint,
    e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    public.candy_is_rainbow(e.badges) AS is_rainbow,
    e.circulation_count,
    w.serial_number,
    l.price_usd AS ask_usd,
    l.price_sol AS ask_sol,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence,
    round((100.0 * ((1)::numeric - (l.price_usd / NULLIF(fc.fmv_usd, (0)::numeric)))), 1) AS discount_pct,
    l.seller,
    l.last_seen_at,
    m.median_sale_usd,
    m.sales_count,
    round((100.0 * ((1)::numeric - (l.price_usd / NULLIF(m.median_sale_usd, (0)::numeric)))), 1) AS discount_vs_median_pct,
    e.set_id
   FROM ((((candy_listings l
     JOIN editions e ON ((e.id = l.edition_id)))
     JOIN candy_fmv_current fc ON ((fc.edition_id = l.edition_id)))
     LEFT JOIN med m ON ((m.edition_id = l.edition_id)))
     LEFT JOIN LATERAL ( SELECT wc.serial_number
           FROM wallet_moments_cache wc
          WHERE ((wc.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (wc.moment_id = l.token_mint))
          ORDER BY wc.last_seen_at DESC NULLS LAST, wc.wallet_address
         LIMIT 1) w ON (true))
  WHERE (l.is_active AND (l.last_seen_at > (now() - '12:00:00'::interval)) AND (l.price_usd IS NOT NULL) AND (l.price_usd > (0)::numeric) AND (fc.fmv_usd IS NOT NULL) AND (fc.fmv_usd > (0)::numeric) AND (l.price_usd < fc.fmv_usd) AND ((m.median_sale_usd IS NULL) OR (l.price_usd < m.median_sale_usd)));

CREATE OR REPLACE VIEW public.candy_player_board WITH (security_invoker = on) AS
 WITH sale_ct AS (
         SELECT sales.edition_id,
            count(*) AS sales_all
           FROM sales
          WHERE ((sales.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (sales.edition_id IS NOT NULL))
          GROUP BY sales.edition_id
        )
 SELECT e.player_name,
    max(e.team_name) AS team_name,
    count(*) AS editions,
    count(*) FILTER (WHERE public.candy_is_rainbow(e.badges)) AS rainbow_editions,
    sum(e.circulation_count) AS total_supply,
    count(fc.fmv_usd) AS priced,
    round(avg(fc.fmv_usd), 2) AS avg_fmv,
    round(max(fc.fmv_usd), 2) AS top_fmv,
    COALESCE(sum(sc.sales_all), (0)::numeric) AS sales_all
   FROM ((editions e
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
     LEFT JOIN sale_ct sc ON ((sc.edition_id = e.id)))
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.player_name IS NOT NULL) AND (e.set_id = '381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid))
  GROUP BY e.player_name;
