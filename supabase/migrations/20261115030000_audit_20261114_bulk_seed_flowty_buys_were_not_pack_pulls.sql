-- 2026-11-14 (~6:40 PM PT, Claude Code cloud). Trevor: "Take action on things you're 100% certain on and have
-- the facts to back it."
--
-- The 2026-04-12 `bulk_seed` import (wallet 0xbd94cade097e50ac only, 6,002 pack_pull rows) labelled 484 FLOWTY
-- PURCHASES as pack pulls. Each one has a `sales` row with buyer = this wallet, marketplace = flowty, price > 0,
-- sold within 1 hour of the row's acquired_date (exactly one such sale each), no pack-open record naming this
-- wallet as the opener, and no other acquisition row for the moment. Since 20261115013000 (pack pulls carry $0)
-- they read $0; they are marketplace buys at the sale price ($492.59 total).
--
-- Backup: flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114 (full rows before the update).
-- Revert:
--   UPDATE moment_acquisitions m SET acquisition_method=b.acquisition_method, buy_price=b.buy_price,
--     seller_address=b.seller_address, acquisition_confidence=b.acquisition_confidence, source=b.source
--   FROM flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114 b WHERE m.id=b.id;
-- (the pack_pull trigger sets the restored NULL-or-0 price back to $0.)

CREATE TABLE flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114 AS
SELECT a.*, s.price_usd AS sale_price_usd, s.seller_address AS sale_seller, s.sold_at AS sale_sold_at, s.transaction_hash AS sale_tx
FROM moment_acquisitions a
JOIN LATERAL (
  SELECT s.* FROM sales s
  WHERE s.nft_id = a.nft_id AND s.collection_id = a.collection_id AND s.buyer_address = a.wallet
    AND abs(extract(epoch FROM s.sold_at - a.acquired_date)) < 3600
  ORDER BY s.sold_at DESC LIMIT 1
) s ON true
WHERE a.wallet = '0xbd94cade097e50ac'
  AND a.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND a.acquisition_method = 'pack_pull'
  AND a.source = 'bulk_seed'
  AND s.price_usd > 0
  AND (SELECT count(*) FROM sales s2 WHERE s2.nft_id = a.nft_id AND s2.collection_id = a.collection_id
         AND s2.buyer_address = a.wallet AND abs(extract(epoch FROM s2.sold_at - a.acquired_date)) < 3600) = 1
  AND NOT EXISTS (SELECT 1 FROM pack_open_pulls o WHERE o.collection_id = a.collection_id AND o.nft_id = a.nft_id
                    AND o.opener_address = a.wallet)
  AND NOT EXISTS (SELECT 1 FROM moment_acquisitions a3 WHERE a3.wallet = a.wallet AND a3.collection_id = a.collection_id
                    AND a3.nft_id = a.nft_id AND a3.id <> a.id);
REVOKE ALL ON flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114 FROM PUBLIC, anon, authenticated;

DO $chk$
DECLARE n int; usd numeric;
BEGIN
  SELECT count(*), sum(sale_price_usd) INTO n, usd FROM flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114;
  IF n <> 484 OR usd <> 492.59 THEN RAISE EXCEPTION 'expected 484 / 492.59, got % / %', n, usd; END IF;
END $chk$;

UPDATE moment_acquisitions m
SET acquisition_method = 'marketplace', buy_price = b.sale_price_usd, seller_address = b.sale_seller,
    acquisition_confidence = 'verified', source = 'bulk_seed_flowty_reclass_20261114'
FROM flowty_archive.moment_acquisitions_bak_bulk_seed_flowty_buys_20261114 b
WHERE m.id = b.id AND m.acquisition_method = 'pack_pull';
