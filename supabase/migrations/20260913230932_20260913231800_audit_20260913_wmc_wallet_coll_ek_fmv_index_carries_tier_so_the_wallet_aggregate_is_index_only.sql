-- audit_20260913_wmc_wallet_coll_ek_fmv_index_carries_tier_so_the_wallet_aggregate_is_index_only
-- RECORD-ONLY: the index was built CONCURRENTLY by one-off pg_cron job 496 at 4:08 PM PT 2026-09-13 (28 s, 176 MB, indisvalid).
-- Full rationale and the revert path are in the committed file of the same name.
CREATE INDEX IF NOT EXISTS idx_wmc_wallet_coll_ek_fmv_tier
  ON public.wallet_moments_cache USING btree
  (wallet_address, collection_id, edition_key) INCLUDE (fmv_usd, tier);