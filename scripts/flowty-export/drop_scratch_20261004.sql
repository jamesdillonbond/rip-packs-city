-- 2026-10-04 (PT) — drop the scratch objects of the Flowty / Dapper incorporation (2026-10-03/04).
-- Every pg_cron job that called them (693–700) is unscheduled; verified 2026-10-04 ~8:15 AM PT that no
-- cron.job command references flowty_archive scratch objects. The function bodies are preserved in
-- scripts/flowty-export/index_harvest.sql, chain_walk.sql and promote_tick.sql. The results live in
-- public.sales (sources flowty_chain_v1 / flowty_chain_tx_v1 / dapper_chain_tx_v1) and the kept archive
-- tables (flowty_index_sales, flowty_chain_listing_completed, flowty_chain_walk_coverage,
-- dapper_tx_candidates, mint_walk_coverage) — none of which this file touches.
-- scratch_20261004_cfg holds the Firestore web key used by the harvest; dropping it removes it.
-- Revert: none needed (scratch state; re-creatable from the preserved bodies).

DROP FUNCTION IF EXISTS flowty_archive.scratch_dapper_candidates_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_fcw_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_fih_body(text, text, text);
DROP FUNCTION IF EXISTS flowty_archive.scratch_fih_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_dapper_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_tx_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_stamp_rpc_match_tick();

DROP TABLE IF EXISTS flowty_archive.scratch_20261004_cfg;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_dapper;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_tx;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_tx2;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_walk;
