-- 2026-10-03 (PT) — Flowty storefront sales before 2023-11-08 with BUYER, exact TIME and TX
-- hash, from Flowty's own event index, as an ARCHIVE table beside the snapshot one.
--
-- WHY (Trevor: "don't stop until ... nothing left unresolved"). The snapshot archive
-- (flowty_archive.storefront_purchased_listings_2023, 8,225 rows) has no buyer and only a
-- sale WINDOW, because Flow's history nodes for that era are offline. Flowty's web client read
-- its event index from Firestore project `flowty-prod`, and that index is still publicly
-- readable (docs/reference/apis-and-cadence.md, "Flowty's own event index"). Its
-- storefrontEvents/STOREFRONT_PURCHASED documents carry buyer, seller, NFT, price, token,
-- commission, blockTimestamp and transactionId. Query: type == STOREFRONT_PURCHASED and
-- blockTimestamp < 2023-11-08T16:07:03Z (mainnet24 root, block 65,264,619) = 9,272 events,
-- 2023-01-21 .. 2023-11-08, all on Flowty's NFTStorefrontV2 (0x3cdbb3d569211ff3).
--
-- CONTROLS. All 8,225 snapshot rows match an index event on (seller, nft_uuid, sale_price);
-- the index adds 1,047 sales whose listing was cleaned up before the next snapshot. For one
-- wallet the index reproduced 17/17 pre-floor loans to the second against the checkpoint, and
-- post-floor its trade events re-checked 821/821 sealed on chain with matching ids.
--
-- WHAT IT IS NOT. The tx hashes in this era cannot be re-read on chain (nodes offline), so
-- this is Flowty's record, not a chain receipt. Not loaded into `sales`; whether 2023 Flowty
-- sales feed FMV is a separate decision. Nothing reads this table yet.
--
-- Data: loaded by a one-off INSERT from the pg_net responses of that query (ledger
-- 2026-10-03 "Flowty index").
--
-- Revert: DROP TABLE flowty_archive.storefront_sales_2023_flowty_index;

CREATE TABLE IF NOT EXISTS flowty_archive.storefront_sales_2023_flowty_index (
  listing_resource_id    bigint      PRIMARY KEY,
  seller                 text        NOT NULL,
  buyer                  text,
  nft_type               text,
  nft_id                 bigint,
  nft_uuid               bigint,
  sale_price             numeric     NOT NULL,
  payment_vault          text,
  commission             numeric,
  commission_receiver    text,
  storefront_resource_id bigint,
  sold_at                timestamptz NOT NULL,
  tx_hash                text,
  flowty_doc_id          text        NOT NULL,
  loaded_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowty_archive.storefront_sales_2023_flowty_index IS
  'Flowty NFTStorefrontV2 sales 2023-01-21..2023-11-08 from Flowty''s own event index (Firestore flowty-prod, storefrontEvents/STOREFRONT_PURCHASED): buyer, sold_at, tx. Flowty''s record; tx not re-readable on chain for this era. Superset of storefront_purchased_listings_2023 (8,225/8,225 matched). Not a sales feed by design.';

CREATE INDEX IF NOT EXISTS storefront_sales_2023_flowty_index_nft_idx
  ON flowty_archive.storefront_sales_2023_flowty_index (nft_type, nft_id);

ALTER TABLE flowty_archive.storefront_sales_2023_flowty_index ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.storefront_sales_2023_flowty_index FROM PUBLIC, anon, authenticated;
