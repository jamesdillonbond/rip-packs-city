-- 2026-10-03 (PT) — Flowty storefront sales from 2023, recovered from Flow's public
-- execution-state checkpoints (no Dune), as an ARCHIVE table with honest sale WINDOWS.
--
-- WHY (Trevor: "do it all"). Flowty's NFTStorefrontV2 fork (0x3cdbb3d569211ff3) keeps a
-- purchased listing in the SELLER's storefront, flagged `purchased`, until someone cleans it
-- up. Flow publishes the full ledger at every spork root in
-- gs://flow-genesis-bootstrap/mainnet-NN-execution/. Streaming the 2023-01-18, 2023-02-22,
-- 2023-06-21 and 2023-11-08 checkpoints (scripts/flow-checkpoint/) recovers 8,225 distinct
-- purchased listings: seller, NFT, price, token, commission. Flowty's storefront first appears
-- in the 2023-02-22 snapshot (0 listings in the 2022-11-02 / 2023-01-18 roots).
--
-- WHAT IT IS NOT. The contract of that era does not record the BUYER, and a snapshot gives a
-- window, not a time: a sale happened after `sold_after` and by `sold_by`. So this is NOT
-- loaded into `sales` (every `sales` row carries a real `sold_at`; a window midpoint there
-- would be a fabricated value). Nothing reads this table yet; FMV use is a separate decision.
--
-- Data: docs/research/flowty-storefront-purchased-listings-2023-snapshots.csv (loaded by a
-- one-off pg_net fetch of the committed file, recorded in the ledger).
--
-- Revert: DROP TABLE flowty_archive.storefront_purchased_listings_2023;

CREATE TABLE IF NOT EXISTS flowty_archive.storefront_purchased_listings_2023 (
  seller           text    NOT NULL,
  nft_type         text,
  nft_id           bigint,
  nft_uuid         bigint,
  sale_price       numeric NOT NULL,
  payment_vault    text,
  commission       numeric,
  storefront_id    bigint,
  sold_after       date,
  sold_by          date    NOT NULL,
  snapshot_states  text,
  loaded_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seller, nft_uuid, storefront_id, sale_price)
);

COMMENT ON TABLE flowty_archive.storefront_purchased_listings_2023 IS
  'Flowty NFTStorefrontV2 listings flagged purchased in Flow spork-root checkpoints (2023-02-22..2023-11-08). Sale happened in (sold_after, sold_by]; buyer not recorded on-chain in this era. Not a sales feed: no sold_at by design.';

CREATE INDEX IF NOT EXISTS storefront_purchased_listings_2023_nft_idx
  ON flowty_archive.storefront_purchased_listings_2023 (nft_type, nft_id);

ALTER TABLE flowty_archive.storefront_purchased_listings_2023 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.storefront_purchased_listings_2023 FROM PUBLIC, anon, authenticated;
