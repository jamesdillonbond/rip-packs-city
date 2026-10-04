-- 2026-10-03 (PT) — Every PURCHASED Flowty NFTStorefrontV2 listing, read from the CHAIN
-- (A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted, purchased=true), mainnet24 root
-- (block 65,264,619, 2023-11-08) through the mainnet28 floor (block 137,390,145, 2025-12-29).
--
-- WHY. flowty_archive.flowty_index_sales (20261004014121) is Flowty's OWN record of its
-- sales. Before any of it reaches `sales` it is verified against an independent reader: this
-- table is a full block-range walk of Flowty's storefront contract on the Flow history nodes
-- (access-001.mainnet24..27, /v1/events, 250-block windows — the node maximum), so it
--   * verifies the index row-for-row (same tx, listing id, nft id, price), and
--   * catches sales the index never recorded (the walk is complete over its block span;
--     coverage is proved by flowty_archive.scratch_20261004_walk: every window answered 200).
-- Flowty's fork of the contract emits `buyer` and `storefrontAddress` (seller) in the event
-- itself, so a row here carries the whole sale; no other read is needed to build a sales row.
--
-- One row per event (tx_hash, event_index). block_ts is the block's own timestamp from the
-- node response. Only purchased=true events are kept (purchased=false = delisted/expired).
--
-- Revert: DROP TABLE flowty_archive.flowty_chain_listing_completed;

CREATE TABLE IF NOT EXISTS flowty_archive.flowty_chain_listing_completed (
  tx_hash                text        NOT NULL,
  event_index            integer     NOT NULL,
  block_height           bigint      NOT NULL,
  block_ts               timestamptz NOT NULL,
  listing_resource_id    text        NOT NULL,
  storefront_resource_id text,
  seller                 text,
  buyer                  text,
  nft_type               text,
  nft_id                 text,
  nft_uuid               text,
  collection_id          uuid,
  price                  numeric,
  payment_vault          text,
  commission_amount      numeric,
  commission_receiver    text,
  custom_id              text,
  expiry                 bigint,
  loaded_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, event_index)
);

COMMENT ON TABLE flowty_archive.flowty_chain_listing_completed IS
  'Flowty NFTStorefrontV2 ListingCompleted(purchased=true) events read from Flow history nodes, blocks 65,264,619..137,390,145 (2023-11-08..2025-12-29). Chain truth used to verify flowty_index_sales and to build sales source flowty_chain_v1. Migration 20261004020500.';

CREATE INDEX IF NOT EXISTS flowty_chain_lc_listing_idx ON flowty_archive.flowty_chain_listing_completed (listing_resource_id);
CREATE INDEX IF NOT EXISTS flowty_chain_lc_coll_ts_idx ON flowty_archive.flowty_chain_listing_completed (collection_id, block_ts);

ALTER TABLE flowty_archive.flowty_chain_listing_completed ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.flowty_chain_listing_completed FROM PUBLIC, anon, authenticated;
