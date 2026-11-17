-- Re-tag 4 REAL All Day purchases that backfill_cost_basis_from_ids tagged as
-- Top Shot (2026-11-01, #142).
--
-- Of the 168 sales_backfill rows priced from another collection's sale, 4 are
-- genuine: the sale's buyer_address IS the row's wallet, the wallet still holds
-- that All Day moment, and no All Day acquisition row exists for it. They were
-- right about everything except collection_id (the function defaulted it to Top
-- Shot). Re-tagging makes them the All Day cost basis they actually are. The
-- other 164 were never bought by the wallet; see
-- docs/pending/142-quarantine-run-in-sql-editor.sql (its WHERE no longer
-- matches these 4 once they carry the sale's collection).
--
-- Wallet 0x4ecf6aaa3a6bfe3a, All Day nft 6053347 / 8240141 / 7185591 / 10664021.
--
-- REVERT: UPDATE public.moment_acquisitions
--            SET collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--          WHERE id IN (<the four ids below>);
UPDATE public.moment_acquisitions
   SET collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
 WHERE id IN ('faf5bb34-d639-499d-a212-fb6375b3bf71',
              'e74a2beb-0e4f-40ff-853a-d80da1f60a3e',
              '1978eced-dcc6-4851-8c9c-b05f99bdecf9',
              '169a9103-1eae-46d5-9a09-6a35bf1f8225')
   AND source = 'sales_backfill'
   AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
