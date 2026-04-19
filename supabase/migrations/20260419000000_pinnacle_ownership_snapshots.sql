-- Disney Pinnacle ownership snapshots + companion resolver scan progress row.
--
-- Background: the Pinnacle sales indexer captures trade events from
-- NFTStorefrontV2, but the storefront payload only exposes the commission
-- receiver (usually the Pinnacle contract itself) — not the buyer or seller
-- addresses. Without an owner address we cannot borrow the NFT to resolve its
-- edition_key, so ~757 Pinnacle sales sit with edition_id = NULL.
--
-- This migration introduces a best-effort "most-recent-known holder" map that
-- is populated by the `pinnacle-owner-discovery` edge function. That function
-- scans A.edf9df96c92f4595.Pinnacle.Deposit events backward from the current
-- Flow sealed head, and because we scan newest-first every row insert uses
-- ON CONFLICT (nft_id) DO NOTHING — the first write wins, which is also the
-- most recent ownership we observed.
--
-- The `pinnacle-nft-resolver` edge function joins this table against
-- pinnacle_sales rows with edition_id IS NULL, runs resolve-pinnacle-nft.cdc
-- against (nft_id, owner) at the Flow Access API, and upserts the resulting
-- edition_key into pinnacle_nft_map via the pinnacle_upsert_nft_map() RPC,
-- then calls backfill_pinnacle_sale_editions() to promote the mapping into
-- pinnacle_sales.edition_id.

CREATE TABLE IF NOT EXISTS pinnacle_ownership_snapshots (
  nft_id                text PRIMARY KEY,
  owner                 text NOT NULL,
  deposit_block_height  bigint NOT NULL,
  observed_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pinnacle_ownership_snapshots_owner_idx
  ON pinnacle_ownership_snapshots (owner);

COMMENT ON TABLE pinnacle_ownership_snapshots IS
  'Populated by the pinnacle-owner-discovery edge function. Best-effort '
  'mapping of Pinnacle nft_id → most-recent-known holder, derived by scanning '
  'A.edf9df96c92f4595.Pinnacle.Deposit events from the Flow Access API '
  'backward from the sealed head. First-seen-wins semantics (ON CONFLICT '
  'DO NOTHING) — because the scanner walks newest-first, the first observed '
  'Deposit for an nft_id is the most recent one. Feeds the companion '
  'pinnacle-nft-resolver edge function, which uses (nft_id, owner) to borrow '
  'the NFT and reconstruct its edition_key.';

-- Seed a dedicated progress row for the Pinnacle Deposit scan. The existing
-- `singleton` row in flow_backfill_progress is used by scripts/flow-backfill.ts
-- for an unrelated scan — this row is independent.
INSERT INTO flow_backfill_progress (id, last_processed_height, total_events_found, total_inserted, total_skipped)
VALUES ('pinnacle-deposit-scan', 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

-- Convenience view: distinct (nft_id, owner) pairs that we have a snapshot for
-- AND that still have at least one pinnacle_sales row with edition_id IS NULL.
-- The resolver edge function pulls its work from this view.
CREATE OR REPLACE VIEW pinnacle_unresolved_with_owner AS
SELECT DISTINCT
  o.nft_id,
  o.owner
FROM pinnacle_ownership_snapshots o
WHERE EXISTS (
  SELECT 1
  FROM pinnacle_sales s
  WHERE s.nft_id = o.nft_id
    AND s.edition_id IS NULL
);

COMMENT ON VIEW pinnacle_unresolved_with_owner IS
  'Work queue for the pinnacle-nft-resolver edge function: (nft_id, owner) '
  'pairs where we have a snapshot AND there is at least one pinnacle_sales '
  'row still missing edition_id.';
