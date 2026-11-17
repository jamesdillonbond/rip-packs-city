-- 2026-10-04 (PT) — drop the scratch objects of the Flowty / Dapper incorporation (2026-10-03/04),
-- including the #171 re-key probes, the sale-block read lane and the UFC chain-naming lane.
-- ⚠ RUN ONLY AFTER the re-promotion ticks are unscheduled (pg_cron 707–712, all unscheduled 2026-10-04 ~5:55 PM PT): this file
-- refuses to run while any cron.job command still references a flowty_archive scratch object.
-- The function bodies are preserved in scripts/flowty-export/index_harvest.sql, chain_walk.sql and
-- promote_tick.sql. The results live in public.sales (sources flowty_chain_v1 / flowty_chain_tx_v1 /
-- dapper_chain_tx_v1), public.ufc_chain_set_editions, public.checkpoint_nft_meta and the kept archive tables
-- (flowty_index_sales, flowty_chain_listing_completed, flowty_chain_walk_coverage, dapper_tx_candidates,
-- mint_walk_coverage, sale_block_read_candidates, ufc_chain_named_promoted) — none of which this file touches.
-- scratch_20261004_cfg holds the Firestore web key used by the harvest; dropping it removes it.
-- Revert: none needed (scratch state; re-creatable from the preserved bodies).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE command ILIKE '%flowty_archive.scratch%') THEN
    RAISE EXCEPTION 'a pg_cron job still calls a flowty_archive scratch object — unschedule it first';
  END IF;
END $$;

DROP FUNCTION IF EXISTS flowty_archive.scratch_dapper_candidates_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_fcw_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_fih_body(text, text, text);
DROP FUNCTION IF EXISTS flowty_archive.scratch_fih_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_dapper_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_tick_dir(boolean);
DROP FUNCTION IF EXISTS flowty_archive.scratch_promote_tx_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_sbr_candidates_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_stamp_rpc_match_tick();
DROP FUNCTION IF EXISTS flowty_archive.scratch_ufc_promote_tick();

DROP TABLE IF EXISTS flowty_archive.scratch_20261004_171_cand;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_171_probe;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_171_truth;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_cfg;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_dapper;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_tx;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_promoted_tx2;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_sbr_absent_probe;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_sbr_baseline;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_sbr_lat;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_sbr_probe;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_sbr_slices;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_ufc_sets;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_ufc_sets_req;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_ufc_sets_req2;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_ufc_slices;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_ufc_unres;
DROP TABLE IF EXISTS flowty_archive.scratch_20261004_walk;
