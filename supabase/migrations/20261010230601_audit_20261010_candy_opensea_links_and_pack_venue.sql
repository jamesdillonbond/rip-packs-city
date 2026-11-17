-- 2026-10-10 — OpenSea asks carry OpenSea's OWN item link; pack asks carry a venue.
--
-- 1. candy_listings.venue_url — the item page OpenSea itself returns for the NFT
--    (`opensea_url` from GET /api/v2/chain/solana/contract/{contract}/nfts/{mint}),
--    fetched once per new OpenSea ask by /api/candy-opensea-listings-indexer.
--    OpenSea's Solana item-URL format could not be verified from the build
--    sandbox, so RPC stores the URL OpenSea hands back instead of building one.
--    NULL = no verified link (the market arm then omits the buy CTA). NULL for
--    every magic_eden row, whose link is built from the mint as before.
--    candy_market_board appends `venue_url` (last column; body otherwise the
--    live definition from 20261010222955, read immediately before this file).
--
-- 2. candy_pack_listings gains venue / venue_order_id / venue_url, mirroring
--    candy_listings: the OpenSea listings feed now writes sealed-PACK asks too,
--    and the Magic Eden sweep's delist/fill retirement of pack asks is scoped to
--    venue='magic_eden' in the same commit. Census 2026-10-10: 376 rows, all
--    written by the Magic Eden sweep, so the default is true for every one.
--
-- ⚠ security_invoker = on restated (CREATE OR REPLACE VIEW resets reloptions).
--
-- Revert: drop the new columns after `DROP VIEW public.candy_market_board` and
-- re-creating it from 20261010222955 (re-apply the 20260913001600 revokes);
-- delete venue <> 'magic_eden' rows from candy_pack_listings first.

ALTER TABLE public.candy_listings
  ADD COLUMN IF NOT EXISTS venue_url text;
COMMENT ON COLUMN public.candy_listings.venue_url IS
  'Item page URL as returned by the venue itself (OpenSea opensea_url) for venue=opensea rows; NULL when not fetched/verified and for magic_eden rows.';

ALTER TABLE public.candy_pack_listings
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'magic_eden',
  ADD COLUMN IF NOT EXISTS venue_order_id text,
  ADD COLUMN IF NOT EXISTS venue_url text;
ALTER TABLE public.candy_pack_listings
  DROP CONSTRAINT IF EXISTS candy_pack_listings_venue_check;
ALTER TABLE public.candy_pack_listings
  ADD CONSTRAINT candy_pack_listings_venue_check CHECK (venue IN ('magic_eden', 'opensea'));
COMMENT ON COLUMN public.candy_pack_listings.venue IS
  'Which feed reported this pack ask: magic_eden (/api/candy-listings-indexer) or opensea (/api/candy-opensea-listings-indexer).';

CREATE OR REPLACE VIEW public.candy_market_board
WITH (security_invoker = on) AS
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
    e.id AS edition_id,
    e.external_id,
    e.player_name,
    e.name AS edition_name,
    e.set_name,
    e.team_name,
    (e.tier)::text AS tier,
    e.circulation_count,
    e.thumbnail_url,
    w.serial_number,
    l.price_usd AS ask_usd,
    l.price_sol AS ask_sol,
    fc.fmv_usd,
    (fc.confidence)::text AS confidence,
    round((100.0 * ((1)::numeric - (l.price_usd / NULLIF(fc.fmv_usd, (0)::numeric)))), 1) AS discount_pct,
    l.seller,
    l.first_seen_at,
    l.last_seen_at,
    m.median_sale_usd,
    m.sales_count,
    l.venue,
    l.venue_url
   FROM ((((candy_listings l
     JOIN editions e ON ((e.id = l.edition_id)))
     JOIN candy_fmv_current fc ON ((fc.edition_id = l.edition_id)))
     LEFT JOIN med m ON ((m.edition_id = l.edition_id)))
     LEFT JOIN LATERAL ( SELECT wc.serial_number
           FROM wallet_moments_cache wc
          WHERE ((wc.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid) AND (wc.moment_id = l.token_mint))
          ORDER BY wc.last_seen_at DESC NULLS LAST, wc.wallet_address
         LIMIT 1) w ON (true))
  WHERE (l.is_active AND (l.price_usd IS NOT NULL) AND (l.price_usd > (0)::numeric));
