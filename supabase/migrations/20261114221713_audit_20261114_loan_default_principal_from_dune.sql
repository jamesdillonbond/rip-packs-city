-- 2026-11-14 (~2:17 PM PT, Cowork cloud) — Trevor's rule (same day): a loan-default moment's cost is the
-- principal lent against it. RPC's Flowty index starts 2025-12-29, so older defaults were labelled gift /
-- unknown / challenge_reward with no cost. Using flowty_archive.loan_defaults_dune_20261114 (the latest
-- settlement per lender+moment, stablecoin principal only), for moments the lender STILL holds:
--   UPDATE the latest moment_acquisitions row when it has NO price and is gift / unknown /
--     challenge_reward / loan_default → loan_default, buy_price = loan_principal = principal,
--     source flowty_loan_settlement, confidence verified. A row that already carries a price is never
--     touched (it may be a later re-purchase). Every touched row is backed up first.
--   INSERT a loan_default row where the lender holds the moment and has no acquisition row at all
--     (transaction_hash 'flowty_settled:<collection>:<settled_block>' keeps the unique key honest).
-- Read back: 29 rows updated (backup table), 135 inserted. 0xbd94cade097e50ac: 36 loan-default moments,
-- $5,552 principal; get_wallet_summary cost_basis 113,123.13 → 117,558.63, moments_with_cost 6,628 → 6,656.
-- Revert:
--   UPDATE moment_acquisitions m SET acquisition_method = b.acquisition_method, buy_price = b.buy_price,
--     loan_principal = b.loan_principal, source = b.source, acquisition_confidence = b.acquisition_confidence
--   FROM flowty_archive.audit_20261114_loan_default_ma_backup b WHERE m.id = b.id;
--   DELETE FROM moment_acquisitions WHERE transaction_hash LIKE 'flowty_settled:%';
CREATE TABLE flowty_archive.audit_20261114_loan_default_ma_backup AS
WITH d AS (
  SELECT DISTINCT ON (lender, nft_id, collection) lender, nft_id, principal, settled_block, collection,
    CASE collection WHEN 'topshot' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid ELSE 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid END AS cid
  FROM flowty_archive.loan_defaults_dune_20261114
  WHERE payment_token <> 'A.1654653399040a61.FlowToken.Vault'
  ORDER BY lender, nft_id, collection, settled_block DESC
),
held AS (
  SELECT d.* FROM d JOIN wallet_moments_cache w ON w.wallet_address = d.lender AND w.moment_id = d.nft_id AND w.collection_id = d.cid
),
latest AS (
  SELECT DISTINCT ON (m.wallet, m.nft_id, m.collection_id) m.*
  FROM moment_acquisitions m JOIN held h ON m.wallet = h.lender AND m.nft_id = h.nft_id AND m.collection_id = h.cid
  ORDER BY m.wallet, m.nft_id, m.collection_id, m.created_at DESC
)
SELECT l.*, h.principal AS new_principal, h.settled_block
FROM latest l JOIN held h ON l.wallet = h.lender AND l.nft_id = h.nft_id AND l.collection_id = h.cid
WHERE l.buy_price IS NULL AND l.acquisition_method IN ('gift', 'unknown', 'challenge_reward', 'loan_default');

REVOKE ALL ON flowty_archive.audit_20261114_loan_default_ma_backup FROM PUBLIC, anon, authenticated;

UPDATE moment_acquisitions m
SET acquisition_method = 'loan_default', buy_price = b.new_principal, loan_principal = b.new_principal,
    source = 'flowty_loan_settlement', acquisition_confidence = 'verified'
FROM flowty_archive.audit_20261114_loan_default_ma_backup b
WHERE m.id = b.id;

INSERT INTO moment_acquisitions (nft_id, wallet, collection_id, buy_price, loan_principal, acquisition_method, source, acquisition_confidence, transaction_hash, acquired_type)
WITH d AS (
  SELECT DISTINCT ON (lender, nft_id, collection) lender, nft_id, principal, settled_block, collection,
    CASE collection WHEN 'topshot' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid ELSE 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid END AS cid
  FROM flowty_archive.loan_defaults_dune_20261114
  WHERE payment_token <> 'A.1654653399040a61.FlowToken.Vault'
  ORDER BY lender, nft_id, collection, settled_block DESC
)
SELECT d.nft_id, d.lender, d.cid, d.principal, d.principal, 'loan_default', 'flowty_loan_settlement', 'verified',
       'flowty_settled:' || d.collection || ':' || d.settled_block, 1
FROM d
JOIN wallet_moments_cache w ON w.wallet_address = d.lender AND w.moment_id = d.nft_id AND w.collection_id = d.cid
WHERE NOT EXISTS (SELECT 1 FROM moment_acquisitions m WHERE m.wallet = d.lender AND m.nft_id = d.nft_id AND m.collection_id = d.cid)
ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING;
