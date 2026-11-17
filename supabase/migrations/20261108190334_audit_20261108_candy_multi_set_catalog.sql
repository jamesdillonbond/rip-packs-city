-- audit_20261108_candy_multi_set_catalog
--
-- Candy ships each product line as its own Metaplex Core collection. RPC catalogued only
-- the first — 2026 MLB Base Series ICONs (125 editions, 25,375 ICONs) — so every All-Star,
-- Gold Series and Collection Quest ICON a collector holds was missing from their portfolio
-- and none of those markets was read. Discovered 2026-11-08 (Magic Eden public API, one
-- sample token per collection; updateAuthority = Core collection):
--   2026 MLB All-Star Game ICONs  YTAPbbkL…AvX  2026_mlb_allstar_game_icons_candy_digital
--     (third-party tracker: ~27.1k ICONs, 372 owners, 2,059 sales since 09-23)
--   2026 MLB Gold Series ICONs    8BvHMsQZ…x4K  gold_series_auction_1_candy_digital
--     (all six waves in one collection; $2,000+ reverse-auction packs; LEGENDARY 1/1s)
--   Collection Quest Rewards      BYSfa4LY…5G   base_series_collection_quests_candy_digital
-- Registry: lib/chains/solana/candy-sets.ts. This migration:
--   1. three `sets` rows (the editions ingest writes their set_id / set_name / tier);
--   2. candy_link_catalog(): gives every Candy edition a player_id (new players named like
--      the Base ones, 'candy-<slug>'), called by the ingest after each walk;
--   3. candy_sales_high_water(set_id): the Magic Eden sales cursor PER SET (the Base cursor
--      is unchanged — all 8,633 Candy ME sales are Base editions);
--   4. Base-Series-only models stay Base-only: the pack EV model, the Rainbow-vs-Core
--      premium and the sealed-supply scarcity board (treasury = the Base pack custodian)
--      gain `set_id = Base`;
--   5. "is_rainbow" no longer means tier LEGENDARY (a Gold Series Legendary is a 1/1, not a
--      Rainbow): candy_is_rainbow(badges) reads the Rainbow-colour badge, in the player,
--      offer-spread, special-serials, deals and secondary boards.
-- Every view keeps its column list; security_invoker restated.
--
-- anon-exec: intentional — new functions, REVOKEd from PUBLIC/anon/authenticated below (candy_is_rainbow, candy_link_catalog, candy_sales_high_water)
--
-- Rollback: re-apply the previous view bodies (20260724150000/150100 and the
--   20261027* Candy migrations; the matview from its creating migration), then
--   DROP FUNCTION candy_link_catalog(), candy_sales_high_water(uuid), candy_is_rainbow(text[]);
--   editions of the three new sets: DELETE needs rpc.allow_bulk_delete — prefer leaving them.

INSERT INTO public.sets (id, external_id, collection_id, name, series) VALUES
  ('8608ae96-10c5-4bf6-aedf-b0d4dc0bfe66', 'candy-mlb-allstar-icons-2026',      '209ade70-32c5-4470-bc7c-4793d660f713', '2026 MLB All-Star Game ICONs', 1),
  ('02fe803a-05b0-4af3-82b5-402e157d8d64', 'candy-mlb-gold-series-icons-2026',  '209ade70-32c5-4470-bc7c-4793d660f713', '2026 MLB Gold Series ICONs', 1),
  ('29417ac1-1fb9-4346-bb08-e50253b618c8', 'candy-mlb-base-quest-rewards-2026', '209ade70-32c5-4470-bc7c-4793d660f713', '2026 MLB Base Series Collection Quest Rewards', 1)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.candy_is_rainbow(p_badges text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT COALESCE((SELECT bool_or(b LIKE 'Rainbow (%') FROM unnest(p_badges) b), false);
$$;
REVOKE ALL ON FUNCTION public.candy_is_rainbow(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_is_rainbow(text[]) TO service_role;

-- Every Candy edition gets a player_id. Existing players match by name; a new name gets a
-- 'candy-<slug>' player named the way the Base Series ones are (lower case, spaces to '-',
-- other non-[a-z0-9-] characters dropped — 'Yandy Díaz' is 'candy-yandy-daz').
CREATE OR REPLACE FUNCTION public.candy_link_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_players integer;
  v_linked integer;
BEGIN
  INSERT INTO players (external_id, collection_id, collection, name, is_active)
  SELECT DISTINCT ON (slug) 'candy-' || slug, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid, 'candy_mlb', player_name, true
    FROM (
      SELECT e.player_name,
             trim(both '-' from regexp_replace(regexp_replace(replace(lower(e.player_name), ' ', '-'), '[^a-z0-9-]', '', 'g'), '-+', '-', 'g')) AS slug
        FROM editions e
       WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
         AND e.player_id IS NULL AND e.player_name IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM players p
                          WHERE p.collection_id = e.collection_id AND p.name = e.player_name)
    ) n
   WHERE slug <> ''
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_players = ROW_COUNT;

  UPDATE editions e
     SET player_id = p.id
    FROM players p
   WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND e.player_id IS NULL
     AND p.collection_id = e.collection_id
     AND p.name = e.player_name;
  GET DIAGNOSTICS v_linked = ROW_COUNT;

  RETURN jsonb_build_object('players_created', v_players, 'editions_linked', v_linked);
END;
$$;
REVOKE ALL ON FUNCTION public.candy_link_catalog() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_link_catalog() TO service_role;

-- Magic Eden sales cursor for one set: newest recorded ME sale of an edition in it.
CREATE OR REPLACE FUNCTION public.candy_sales_high_water(p_set_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT max(s.sold_at)
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
   WHERE s.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
     AND s.marketplace = 'magic_eden'
     AND e.set_id = p_set_id;
$$;
REVOKE ALL ON FUNCTION public.candy_sales_high_water(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_sales_high_water(uuid) TO service_role;

-- ── Boards: "is_rainbow" = a Rainbow-colour badge ────────────────────────────
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
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.player_name IS NOT NULL))
  GROUP BY e.player_name;

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
        END AS exec_spread_pct
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
    ls.last_sale_at
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
    round((100.0 * ((1)::numeric - (l.price_usd / NULLIF(m.median_sale_usd, (0)::numeric)))), 1) AS discount_vs_median_pct
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

CREATE OR REPLACE VIEW public.candy_secondary_board WITH (security_invoker = on) AS
 WITH cand AS (
         SELECT e.id,
            e.external_id,
            e.name AS edition_name,
            e.player_name,
            e.tier,
            e.circulation_count,
            e.badges
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
    ss.median_sale_usd
   FROM ((((cand c
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = c.id)))
     LEFT JOIN sale_stats ss ON ((ss.edition_id = c.id)))
     LEFT JOIN candy_best_offers bo ON ((bo.edition_id = c.id)))
     LEFT JOIN candy_listing_floor lf ON ((lf.edition_id = c.id)));

-- ── Base-Series-only models ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.candy_parallel_premium WITH (security_invoker = on) AS
 SELECT
        CASE
            WHEN (e.tier = 'LEGENDARY'::tier_type) THEN 'Rainbow'::text
            ELSE 'Core (ICON)'::text
        END AS parallel_group,
    (e.tier = 'LEGENDARY'::tier_type) AS is_rainbow,
    count(*) AS editions,
    count(fc.fmv_usd) AS priced,
    round(avg(fc.fmv_usd), 2) AS avg_fmv,
    round(min(fc.fmv_usd), 2) AS min_fmv,
    round(max(fc.fmv_usd), 2) AS max_fmv,
    sum(e.circulation_count) AS total_supply
   FROM (editions e
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.set_id = '381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid))
  GROUP BY (e.tier = 'LEGENDARY'::tier_type);

CREATE OR REPLACE VIEW public.candy_pack_ev_model WITH (security_invoker = on) AS
 WITH fc AS (
         SELECT DISTINCT ON (fmv_snapshots.edition_id) fmv_snapshots.edition_id,
            fmv_snapshots.fmv_usd,
            fmv_snapshots.confidence
           FROM fmv_snapshots
          WHERE (fmv_snapshots.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
          ORDER BY fmv_snapshots.edition_id, fmv_snapshots.computed_at DESC
        ), ed AS (
         SELECT e.tier,
            e.circulation_count AS circ,
            fc.fmv_usd AS fmv,
            fc.confidence AS conf
           FROM (editions e
             LEFT JOIN fc ON ((fc.edition_id = e.id)))
          WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.set_id = '381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid))
        ), agg AS (
         SELECT ed.tier,
            count(*) AS total,
            count(*) FILTER (WHERE ((ed.fmv IS NOT NULL) AND (ed.fmv > (0)::numeric))) AS priced,
            (sum((ed.fmv * (ed.circ)::numeric)) FILTER (WHERE (ed.fmv IS NOT NULL)) / (NULLIF(sum(ed.circ) FILTER (WHERE (ed.fmv IS NOT NULL)), 0))::numeric) AS sw_mean,
            (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((ed.fmv)::double precision)) FILTER (WHERE ((ed.fmv IS NOT NULL) AND (ed.fmv > (0)::numeric))))::numeric AS med
           FROM ed
          GROUP BY ed.tier
        ), p AS (
         SELECT max(agg.sw_mean) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_sw,
            max(agg.med) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_med,
            max(agg.total) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_total,
            max(agg.priced) FILTER (WHERE (agg.tier = 'COMMON'::tier_type)) AS common_priced,
            max(agg.sw_mean) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_sw,
            max(agg.med) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_med,
            max(agg.total) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_total,
            max(agg.priced) FILTER (WHERE (agg.tier = 'LEGENDARY'::tier_type)) AS rainbow_priced
           FROM agg
        ), cf AS (
         SELECT count(*) FILTER (WHERE (ed.conf IS NOT NULL)) AS conf_total,
            count(*) FILTER (WHERE (ed.conf = 'LOW'::fmv_confidence)) AS conf_low
           FROM ed
        )
 SELECT 10 AS icon_slots,
    0.15 AS rainbow_chance,
    (10)::numeric AS pack_cost_usd,
    round(p.common_sw, 2) AS common_slot_ev,
    round(p.common_med, 2) AS common_slot_typical,
    round(p.rainbow_sw, 2) AS rainbow_ev,
    p.common_total,
    p.common_priced,
    p.rainbow_total,
    p.rainbow_priced,
    round((((10)::numeric * p.common_sw) + (0.15 * COALESCE(p.rainbow_sw, (0)::numeric))), 2) AS actual_ev_usd,
    round(((10)::numeric * p.common_med), 2) AS typical_pull_ev_usd,
    ((((((((((((((('candy-pack-ev-0.2 · $10 pack = 10 ICONs + 15% Rainbow chance · supply-weighted · '::text || 'Actual EV = chase-inclusive MEAN; Typical Pull = 10 × median common (the median pack pulls no Rainbow) · '::text) || 'priced: Rainbow '::text) || COALESCE(p.rainbow_priced, (0)::bigint)) || '/'::text) || COALESCE(p.rainbow_total, (0)::bigint)) || ', commons '::text) || COALESCE(p.common_priced, (0)::bigint)) || '/'::text) || COALESCE(p.common_total, (0)::bigint)) || ' · FMV confidence: '::text) || cf.conf_low) || ' of '::text) || cf.conf_total) || ' LOW'::text) || ' · secondary market thin → indicative pull value, NOT liquidation value'::text) AS model_note
   FROM p,
    cf;

-- Sealed-supply scarcity: "sealed" = what the Base pack custodian still holds, so the board
-- describes the Base Series. A matview cannot be replaced in place; its one dependent view
-- (candy_scarcity_board) is recreated unchanged, ACLs restated as they were.
DROP MATERIALIZED VIEW public.mv_candy_scarcity_board CASCADE;
CREATE MATERIALIZED VIEW public.mv_candy_scarcity_board AS
 WITH wmc AS MATERIALIZED (
         SELECT wallet_moments_cache.edition_key,
            wallet_moments_cache.wallet_address
           FROM wallet_moments_cache
          WHERE (wallet_moments_cache.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
        ), treas AS MATERIALIZED (
         SELECT COALESCE(( SELECT candy_packs.owner
                   FROM candy_packs
                  WHERE (candy_packs.owner IS NOT NULL)
                  GROUP BY candy_packs.owner
                  ORDER BY (count(*)) DESC, candy_packs.owner
                 LIMIT 1), ( SELECT wmc_1.wallet_address
                   FROM wmc wmc_1
                  GROUP BY wmc_1.wallet_address
                  ORDER BY (count(*)) DESC
                 LIMIT 1)) AS wallet_address
        ), h AS (
         SELECT w.edition_key,
            count(*) FILTER (WHERE (w.wallet_address = ( SELECT treas.wallet_address
                   FROM treas))) AS sealed,
            count(*) FILTER (WHERE (w.wallet_address <> ( SELECT treas.wallet_address
                   FROM treas))) AS circulating,
            count(DISTINCT w.wallet_address) FILTER (WHERE (w.wallet_address <> ( SELECT treas.wallet_address
                   FROM treas))) AS holders
           FROM wmc w
          GROUP BY w.edition_key
        )
 SELECT e.external_id,
    e.player_name,
    e.name AS edition_name,
    (e.tier)::text AS tier,
    (e.tier = 'LEGENDARY'::tier_type) AS is_rainbow,
    e.circulation_count,
    COALESCE(h.sealed, (0)::bigint) AS sealed,
    COALESCE(h.circulating, (0)::bigint) AS circulating,
    round(((100.0 * (COALESCE(h.circulating, (0)::bigint))::numeric) / (NULLIF(e.circulation_count, 0))::numeric), 1) AS circulating_pct,
    COALESCE(h.holders, (0)::bigint) AS holders,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence
   FROM ((editions e
     LEFT JOIN h ON ((h.edition_key = (e.external_id)::text)))
     LEFT JOIN candy_fmv_current fc ON ((fc.edition_id = e.id)))
  WHERE ((e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (e.set_id = '381ae129-7dc7-47f4-9022-dd9e0fc21e39'::uuid));
CREATE UNIQUE INDEX mv_candy_scarcity_board_external_id_uidx ON public.mv_candy_scarcity_board USING btree (external_id);
REVOKE ALL ON public.mv_candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.mv_candy_scarcity_board TO service_role;
GRANT MAINTAIN ON public.mv_candy_scarcity_board TO anon, authenticated;

CREATE VIEW public.candy_scarcity_board WITH (security_invoker = on) AS
 SELECT external_id,
    player_name,
    edition_name,
    tier,
    is_rainbow,
    circulation_count,
    sealed,
    circulating,
    circulating_pct,
    holders,
    fmv_usd,
    confidence
   FROM mv_candy_scarcity_board;
REVOKE ALL ON public.candy_scarcity_board FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.candy_scarcity_board TO service_role;
