-- audit_20260727_drop_unused_indexes_retired_residue_tables
-- Performance advisor `unused_index`: of ~195 flagged unused indexes, the vast
-- majority are NOT genuine waste for this DB at this stage -- they sit on
-- empty-but-live pre-launch user tables (saved_wallets, watchlist, fmv_alerts,
-- raffle/redemptions, ...), deliberately-kept dormant planes (evm_nft_transfers_*),
-- pre-created partitions (sales_2027), or recent deliberate optimizations
-- (sales_*_nullseller_soldat, created 2026-07-24 for claim_sales_counterparty_batch)
-- whose idx_scan is 0 only because their infrequent driver hasn't run in the
-- ~45-day stat window. Dropping any of those would be actively wrong.
--
-- This migration drops ONLY the unambiguously-safe residue: 9 non-constraint
-- indexes on tables that are documented-RETIRED or one-off audit residue, each
-- with 0 live rows AND 0 lifetime writes since postmaster start:
--   storefront_audit_wallets -- RETIRED (Known issue #9, "de facto retired")
--   ts_listings              -- retired TS listings-indexer (2026-05-26)
--   audit_lt_user_top100 / audit_lt_livetoken_rows -- one-off LiveToken audit tables
--   debug_logs               -- transient debug table, never written
-- Applied live via Supabase MCP on 2026-07-27. security_invariants/anon_write [] after.
-- Revert (recreate each dropped index):
--   CREATE INDEX idx_audit_lt_ltrows_wallet  ON public.audit_lt_livetoken_rows USING btree (wallet);
--   CREATE INDEX idx_audit_lt_top100_wallet  ON public.audit_lt_user_top100    USING btree (wallet);
--   CREATE INDEX idx_debug_logs_route_created ON public.debug_logs             USING btree (route, created_at DESC);
--   CREATE INDEX idx_saw_cleanup_status ON public.storefront_audit_wallets USING btree (cleanup_status);
--   CREATE INDEX idx_saw_dapper_pending ON public.storefront_audit_wallets USING btree (cleanup_status) WHERE ((is_dapper = true) AND (cleanup_status = 'pending'::text));
--   CREATE INDEX idx_saw_expired   ON public.storefront_audit_wallets USING btree (expired_listings DESC) WHERE (expired_listings > 0);
--   CREATE INDEX idx_saw_unaudited ON public.storefront_audit_wallets USING btree (created_at) WHERE (last_scanned_at IS NULL);
--   CREATE INDEX ts_listings_flow_id_idx     ON public.ts_listings USING btree (flow_id);
--   CREATE INDEX ts_listings_ingested_at_idx ON public.ts_listings USING btree (ingested_at DESC);
DROP INDEX IF EXISTS public.idx_audit_lt_ltrows_wallet;
DROP INDEX IF EXISTS public.idx_audit_lt_top100_wallet;
DROP INDEX IF EXISTS public.idx_debug_logs_route_created;
DROP INDEX IF EXISTS public.idx_saw_cleanup_status;
DROP INDEX IF EXISTS public.idx_saw_dapper_pending;
DROP INDEX IF EXISTS public.idx_saw_expired;
DROP INDEX IF EXISTS public.idx_saw_unaudited;
DROP INDEX IF EXISTS public.ts_listings_flow_id_idx;
DROP INDEX IF EXISTS public.ts_listings_ingested_at_idx;
