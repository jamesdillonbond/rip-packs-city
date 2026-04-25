-- Reverts pinnacle_unresolved_with_owner to the original snapshot-only form.
-- The buyer-first variant (20260425220153) routed every Cadence script call
-- to the Pinnacle contract address itself: every captured buyer_address turned
-- out to be 0xedf9df96c92f4595, not the real buyer. Net resolution: 0%.
-- Snapshot-only is stale (~12% resolution) but at least targets real wallets.

CREATE OR REPLACE VIEW pinnacle_unresolved_with_owner AS
 SELECT DISTINCT nft_id,
    owner
   FROM pinnacle_ownership_snapshots o
  WHERE (EXISTS ( SELECT 1
           FROM pinnacle_sales s
          WHERE s.nft_id = o.nft_id AND s.edition_id IS NULL));

COMMENT ON VIEW pinnacle_unresolved_with_owner IS
  'Resolver input queue. Returns the snapshot owner for each unresolved nft_id. Snapshot data is often stale (lags 6-24h behind sales-indexer) which gives ~12% resolution rate. Better than the buyer-first variant attempted on 2026-04-25 which hit 0% because every captured buyer_address was the Pinnacle contract address rather than the real buyer.';
