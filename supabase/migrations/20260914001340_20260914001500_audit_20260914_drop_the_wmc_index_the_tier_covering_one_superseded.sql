-- audit_20260914_drop_the_wmc_index_the_tier_covering_one_superseded
-- RECORD-ONLY: dropped CONCURRENTLY by one-off pg_cron job 498 at 5:13 PM PT 2026-09-13 (0 s, "DROP INDEX").
-- Rationale and revert path in the committed file of the same name.
DROP INDEX IF EXISTS public.idx_wmc_wallet_coll_ek_fmv;