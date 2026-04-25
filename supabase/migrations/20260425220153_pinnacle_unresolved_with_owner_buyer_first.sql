-- Resolver was sending Cadence script calls to stale snapshot owners. Diagnosis:
-- 821 of 1,345 unresolved sales had a buyer_address from the sales-indexer, but
-- zero of those buyers matched the snapshot owner — every snapshot was stale,
-- so the resolver was scripting against sellers who had already transferred.
-- Fix: prefer the latest unresolved sale's buyer_address over the snapshot.

CREATE OR REPLACE VIEW pinnacle_unresolved_with_owner AS
 WITH latest_buyer AS (
         SELECT DISTINCT ON (pinnacle_sales.nft_id) pinnacle_sales.nft_id,
            pinnacle_sales.buyer_address
           FROM pinnacle_sales
          WHERE pinnacle_sales.edition_id IS NULL AND pinnacle_sales.buyer_address IS NOT NULL
          ORDER BY pinnacle_sales.nft_id, pinnacle_sales.sold_at DESC
        ), candidates AS (
         SELECT DISTINCT s.nft_id,
            COALESCE(lb.buyer_address, ows.owner) AS owner
           FROM pinnacle_sales s
             LEFT JOIN latest_buyer lb ON lb.nft_id = s.nft_id
             LEFT JOIN pinnacle_ownership_snapshots ows ON ows.nft_id = s.nft_id
          WHERE s.edition_id IS NULL
        )
 SELECT nft_id,
    owner
   FROM candidates
  WHERE owner IS NOT NULL;

COMMENT ON VIEW pinnacle_unresolved_with_owner IS
  'Resolver input queue. Prefers buyer_address from latest unresolved sale over the (often stale) snapshot owner. The pinnacle_ownership_snapshots pipeline lags behind sales-indexer, so trusting it for recently-sold NFTs sends Cadence script calls to the wrong account.';
