-- 2026-10-10 — candy_offers carries the VENUE that reported each bid.
--
-- Companion to 20261010222955 (candy_listings.venue). /api/candy-opensea-offers-indexer
-- (same commit) writes OpenSea bids into this table. The Magic Eden offers sweep
-- (/api/ingest/candy-offers) retires bids by ABSENCE ("this sweep did not see
-- it"), which is evidence about Magic Eden bids only; without a venue column it
-- would retire every OpenSea bid on every tick. Both writers now pin `venue`.
--
--   candy_offers.venue           text NOT NULL DEFAULT 'magic_eden', CHECK-whitelisted.
--                                 TRUE for every existing row (census 2026-10-10:
--                                 641 rows, all written by the Magic Eden sweep).
--   candy_offers.venue_order_id  OpenSea Solana order id (creation_signature:order_state);
--                                 NULL for magic_eden. Used for the get-order
--                                 status check that retires an OpenSea bid.
--
-- No view changes: candy_best_offers / candy_offer_spread_board read named
-- columns, and a bid's venue does not change what they compute.
--
-- Revert (after deleting venue <> 'magic_eden' rows):
--   ALTER TABLE public.candy_offers DROP COLUMN venue_order_id, DROP COLUMN venue;

ALTER TABLE public.candy_offers
  ADD COLUMN IF NOT EXISTS venue text NOT NULL DEFAULT 'magic_eden',
  ADD COLUMN IF NOT EXISTS venue_order_id text;

ALTER TABLE public.candy_offers
  DROP CONSTRAINT IF EXISTS candy_offers_venue_check;
ALTER TABLE public.candy_offers
  ADD CONSTRAINT candy_offers_venue_check CHECK (venue IN ('magic_eden', 'opensea'));

COMMENT ON COLUMN public.candy_offers.venue IS
  'Which feed reported this bid: magic_eden (/api/ingest/candy-offers) or opensea (/api/candy-opensea-offers-indexer). Each feed retires only its own venue''s rows on its own evidence.';
COMMENT ON COLUMN public.candy_offers.venue_order_id IS
  'OpenSea Solana order id (creation_signature:order_state) for venue=opensea rows; NULL for magic_eden. pda_address holds order_state.';
