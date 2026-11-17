-- 2026-10-03 (PT) — drop the scratch objects from Trevor's Flowty export (2026-10-02/03).
-- They were one-off pg_net lanes (wallet walk, loan/listing flag bisection, Flowty-index pull,
-- on-chain re-verification, NFT-name lookup); all cron jobs were unscheduled when done. The
-- function bodies are preserved in scripts/flow-wallet-walk/scratch_functions.sql. The results
-- live in flowty_archive.storefront_purchased_listings_2023 and
-- flowty_archive.storefront_sales_2023_flowty_index (kept) and in local exports.
-- Revert: none needed (scratch data; re-creatable from the preserved functions).

DROP FUNCTION IF EXISTS flowty_archive.scratch_flag_req(bigint, bigint[], boolean);
DROP FUNCTION IF EXISTS flowty_archive.scratch_flag_script(bigint, boolean);
DROP FUNCTION IF EXISTS flowty_archive.scratch_fs_verify_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_fsv(jsonb);
DROP FUNCTION IF EXISTS flowty_archive.scratch_listing_req(bigint, text, bigint[]);
DROP FUNCTION IF EXISTS flowty_archive.scratch_listing_req(bigint, text, bigint[], text);
DROP FUNCTION IF EXISTS flowty_archive.scratch_listing_script(bigint, text);
DROP FUNCTION IF EXISTS flowty_archive.scratch_listing_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_loan_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_nft_meta_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_node(bigint);
DROP FUNCTION IF EXISTS flowty_archive.scratch_rental_req(bigint, bigint);
DROP FUNCTION IF EXISTS flowty_archive.scratch_snap_req(bigint);
DROP FUNCTION IF EXISTS flowty_archive.scratch_spork_end(bigint);
DROP FUNCTION IF EXISTS flowty_archive.scratch_walk_tick();

DROP TABLE IF EXISTS flowty_archive.scratch_20261002_listing_probe;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_loan_probe;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_trevor_ev;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_trevor_tx;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_walk_found;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_walk_iv;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_walk_point;
DROP TABLE IF EXISTS flowty_archive.scratch_20261002_walk_recheck;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_firestore_doc;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_firestore_flat;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_firestore_req;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_fs_verify;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_nft_meta;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_prefloor_funding;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_prefloor_req;
DROP TABLE IF EXISTS flowty_archive.scratch_20261003_probe;
