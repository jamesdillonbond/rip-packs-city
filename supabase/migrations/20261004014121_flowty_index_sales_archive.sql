-- 2026-10-03 (PT) — Every marketplace sale in Flowty's own event index, all users, as a
-- permanent ARCHIVE + VERIFICATION table: the staging ground for incorporating Flowty's
-- third-party-venue history into `sales`.
--
-- WHY (Trevor: "We should be verifying transactions and incorporating them ... native sites
-- won't show third party marketplace transaction data like Flowty"). Measured 2026-10-03:
-- `sales` holds Flowty-venue rows only from 2025-12-29 (the spork the forward indexer starts
-- at; 240,693 rows) plus 588 All Day/UFC rows from the 05-12 extractor. Flowty's event index
-- (Firestore `flowty-prod`, storefrontEvents; docs/reference/apis-and-cadence.md "Flowty's own
-- event index") is still publicly readable and holds 2,727,802 STOREFRONT_PURCHASED +
-- 152,562 STOREFRONT_OFFER_ACCEPTED documents back to 2023-01-21, each with tx hash, block
-- time, NFT, price, token, buyer and seller.
--
-- ROW = one index document (doc_id is Flowty's: <listing|offer resource id>_<TYPE>).
-- Columns are the document's own fields, typed; nothing derived except collection_id (from
-- nft_type via flowty_collection_id_from_nft_type) and the verify_* columns, which are this
-- platform's checks and say which check passed:
--   verify_status  NULL               = not checked yet
--                  'rpc_chain_match'  = same tx + nft already in `sales` from our own chain
--                                       ingest (an independent reader of the same chain)
--                  'chain_sealed'     = re-read on a Flow history node: Sealed, no error, and
--                                       a *ListingCompleted / OfferCompleted event carrying
--                                       this listing/offer id
--                  'chain_mismatch'   = re-read, and the tx does NOT carry that event/id
--                  'unverifiable_pre_floor' = before 2023-11-08 16:07:03Z (mainnet24 root,
--                                       block 65,264,619): no public node serves that era,
--                                       so this is Flowty's record, not a chain receipt
-- `sales` rows promoted from here carry source 'flowty_index_v1' and keep this doc_id
-- reachable via (transaction_hash, nft_id).
--
-- Data: harvested by pg_net from Firestore runQuery pages (projection mask, cursor on
-- __name__, partitioned by doc-id prefix); the per-partition server count is asserted against
-- the rows landed (flowty_archive.flowty_index_harvest). Harvest + verify functions are
-- one-off scratch (scripts/flowty-export/index_harvest.sql); the Firestore web key is never
-- stored in the repo.
--
-- Revert: DROP TABLE flowty_archive.flowty_index_sales; DROP TABLE flowty_archive.flowty_index_harvest;

CREATE TABLE IF NOT EXISTS flowty_archive.flowty_index_sales (
  doc_id                 text        PRIMARY KEY,
  event_type             text        NOT NULL CHECK (event_type IN ('STOREFRONT_PURCHASED','STOREFRONT_OFFER_ACCEPTED')),
  chain_event            text,
  tx_hash                text,
  block_ts               timestamptz NOT NULL,
  nft_type               text,
  nft_id                 text,
  nft_uuid               text,
  collection_id          uuid,
  price                  numeric,
  usd_value              numeric,
  payment_vault          text,
  buyer                  text,
  seller                 text,
  account_address        text,
  listing_resource_id    text,
  storefront_resource_id text,
  commission_amount      numeric,
  commission_receiver    text,
  custom_id              text,
  extra                  jsonb,
  verify_status          text CHECK (verify_status IN ('rpc_chain_match','chain_sealed','chain_mismatch','unverifiable_pre_floor')),
  verify_detail          jsonb,
  verified_at            timestamptz,
  harvested_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowty_archive.flowty_index_sales IS
  'Every STOREFRONT_PURCHASED / STOREFRONT_OFFER_ACCEPTED document in Flowty''s event index (Firestore flowty-prod), all users, 2023-01-21 onward, with this platform''s verification verdict. Staging for sales source flowty_index_v1. Migration 20261004014038.';

CREATE INDEX IF NOT EXISTS flowty_index_sales_tx_idx ON flowty_archive.flowty_index_sales (tx_hash);
CREATE INDEX IF NOT EXISTS flowty_index_sales_coll_ts_idx ON flowty_archive.flowty_index_sales (collection_id, block_ts);
CREATE INDEX IF NOT EXISTS flowty_index_sales_unverified_idx ON flowty_archive.flowty_index_sales (block_ts) WHERE verify_status IS NULL;

CREATE TABLE IF NOT EXISTS flowty_archive.flowty_index_harvest (
  part          text        PRIMARY KEY,
  lo            text        NOT NULL,
  hi            text        NOT NULL,
  server_count  integer,
  cursor_name   text,
  pages         integer     NOT NULL DEFAULT 0,
  rows_landed   integer     NOT NULL DEFAULT 0,
  pending_req   bigint,
  last_status   integer,
  done          boolean     NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE flowty_archive.flowty_index_harvest IS
  'Per-partition cursor state for the flowty_index_sales harvest; done only when rows_landed reconciles with server_count. Migration 20261004014038.';

ALTER TABLE flowty_archive.flowty_index_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE flowty_archive.flowty_index_harvest ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.flowty_index_sales FROM PUBLIC, anon, authenticated;
REVOKE ALL ON flowty_archive.flowty_index_harvest FROM PUBLIC, anon, authenticated;
