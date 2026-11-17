-- 2026-11-14 (~4:10 PM PT, Cowork cloud). Prices Trevor's (0xbd94cade097e50ac) Top Shot moments that the
-- cache-refresh lane had stubbed as acquisition_method='unknown'/'gift' with no buy_price
-- (transaction_hash 'cache-refresh:<id>', acquired_date = first-seen, not the real deposit).
-- Source: flowty_archive.deposit_tx_prices_dune_20261114 (Dune execution 01M7E4B8YQE9GQ866EY4GXVHPM): the
-- purchase event in the SAME transaction that deposited the moment into this wallet.
-- Preview (same session): 252 USD-denominated rows → 252 live rows, all buy_price NULL, all
-- source='cache_refresh' confidence='heuristic', $2,432.86 total. The 7 FlowUtilityToken (FLOW) purchases
-- are left unpriced on purpose (FLOW is not 1:1 with USD).
-- Writes: buy_price, acquisition_method (OffersV2 → offer_accepted, else marketplace), the real
-- transaction_hash, acquired_date (only moved EARLIER, to the deposit block date), source, confidence.
-- The cache-refresh writer only inserts when NO row exists for (wallet, collection, nft_id), so it will not
-- re-stub these; the pack-events-ingest placeholder sweep keys on 'cache-refresh:%', which these no longer match.
-- Revert:
--   UPDATE moment_acquisitions m SET buy_price=b.buy_price, acquisition_method=b.acquisition_method,
--     transaction_hash=b.transaction_hash, acquired_date=b.acquired_date, source=b.source,
--     acquisition_confidence=b.acquisition_confidence
--   FROM flowty_archive.moment_acquisitions_bak_deposit_tx_20261114 b WHERE m.id=b.id;
CREATE TABLE IF NOT EXISTS flowty_archive.moment_acquisitions_bak_deposit_tx_20261114 AS
SELECT m.* FROM moment_acquisitions m
JOIN flowty_archive.deposit_tx_prices_dune_20261114 d ON d.nft_id = m.nft_id
WHERE m.wallet = '0xbd94cade097e50ac'
  AND m.collection_id = (SELECT id FROM collections WHERE slug = 'nba_top_shot')
  AND d.payment_token NOT LIKE '%FlowUtilityToken%'
  AND m.buy_price IS NULL AND m.acquisition_method IN ('gift','unknown');
REVOKE ALL ON flowty_archive.moment_acquisitions_bak_deposit_tx_20261114 FROM PUBLIC, anon, authenticated;

UPDATE moment_acquisitions m SET
  buy_price = d.price,
  acquisition_method = CASE WHEN d.venue = 'offer' THEN 'offer_accepted' ELSE 'marketplace' END,
  transaction_hash = d.transaction_hash,
  acquired_date = LEAST(m.acquired_date, d.block_date::timestamptz),
  source = 'dune_deposit_tx',
  acquisition_confidence = 'verified'
FROM flowty_archive.deposit_tx_prices_dune_20261114 d, flowty_archive.moment_acquisitions_bak_deposit_tx_20261114 b
WHERE b.id = m.id AND d.nft_id = m.nft_id
  AND d.payment_token NOT LIKE '%FlowUtilityToken%'
  AND m.buy_price IS NULL AND m.acquisition_method IN ('gift','unknown');

DO $$ DECLARE n int; s numeric; BEGIN
  SELECT count(*), sum(buy_price) INTO n, s FROM moment_acquisitions m
  WHERE m.id IN (SELECT id FROM flowty_archive.moment_acquisitions_bak_deposit_tx_20261114) AND m.source = 'dune_deposit_tx';
  IF n <> 252 OR s <> 2432.86 THEN RAISE EXCEPTION 'deposit-tx price apply: expected 252 rows / 2432.86, got % / %', n, s; END IF;
END $$;
