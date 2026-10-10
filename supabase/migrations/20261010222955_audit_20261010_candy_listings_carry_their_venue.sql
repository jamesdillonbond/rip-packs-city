-- 2026-10-10 — candy_listings carries the VENUE that reported each ask.
--
-- WHY. Every Candy ask in candy_listings came from ONE feed (Magic Eden's
-- /v2/collections/<symbol>/listings), so nothing needed to say where an ask
-- lives. OpenSea added Solana NFT trading ~2026-08-31 with Candy Digital as a
-- named launch partner; /api/candy-opensea-listings-indexer (same commit) is the
-- second feed. Without a venue column an OpenSea ask would be indistinguishable
-- from a Magic Eden one, and every reader that hardcodes a Magic Eden link or
-- label (app/api/market candy arm: `source: "magic_eden"`, magiceden.io buy_url)
-- would send a buyer to a venue the ask is not on.
--
-- WHAT.
--   1. candy_listings.venue  text NOT NULL DEFAULT 'magic_eden', CHECK-whitelisted.
--      The default is TRUE for every existing row: all of them were written by the
--      Magic Eden indexer (census 2026-10-10: 8,001 rows, one auction_house).
--   2. candy_listings.venue_order_id  text NULL — OpenSea's Solana order id
--      (`creation_signature:order_state`), which its get-order endpoint takes. The
--      OpenSea indexer needs it to fetch POSITIVE evidence (status FULFILLED /
--      CANCELLED / EXPIRED / INACTIVE) before retiring an ask. NULL for ME rows.
--   3. candy_market_board re-created with `venue` APPENDED as its last column (the
--      only shape CREATE OR REPLACE VIEW accepts — 42P16 otherwise). Body is the
--      live definition read 2026-10-10 immediately before this file, unchanged
--      except the appended column.
--
-- ⚠ `security_invoker = on` IS RE-STATED: CREATE OR REPLACE VIEW without it resets
-- reloptions. Grants survive a replace (the 20260913001600 anon/authenticated
-- revoke stays in force).
--
-- Revert: CREATE OR REPLACE cannot DROP a column, so re-create the view from
-- 20260920224013 after `DROP VIEW public.candy_market_board` (re-apply the
-- 20260913001600 revokes), then
--   ALTER TABLE public.candy_listings DROP COLUMN venue_order_id, DROP COLUMN venue;
-- Only do that after deleting venue <> 'magic_eden' rows.

ALTER TABLE public.candy_listings
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'magic_eden',
  ADD COLUMN IF NOT EXISTS venue_order_id text;

ALTER TABLE public.candy_listings
  DROP CONSTRAINT IF EXISTS candy_listings_venue_check;
ALTER TABLE public.candy_listings
  ADD CONSTRAINT candy_listings_venue_check CHECK (venue IN ('magic_eden', 'opensea'));

COMMENT ON COLUMN public.candy_listings.venue IS
  'Which feed reported this ask: magic_eden (/api/candy-listings-indexer) or opensea (/api/candy-opensea-listings-indexer). Decides the buy link and which indexer may retire the row on its own evidence.';
COMMENT ON COLUMN public.candy_listings.venue_order_id IS
  'OpenSea Solana order id (creation_signature:order_state) for venue=opensea rows; NULL for magic_eden. pda_address holds order_state.';

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
    l.venue
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
