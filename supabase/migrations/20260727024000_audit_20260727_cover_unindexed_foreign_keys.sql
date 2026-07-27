-- audit_20260727_cover_unindexed_foreign_keys
-- Performance advisor `unindexed_foreign_keys`: add covering indexes for 6 FKs
-- (suboptimal joins + slow cascade deletes). All on small, low-traffic
-- rewards/raffle/alerts tables, so a plain CREATE INDEX (brief lock) is fine.
-- Applied live via Supabase MCP on 2026-07-27.
-- Revert: DROP INDEX IF EXISTS <each index below>;
CREATE INDEX IF NOT EXISTS idx_allday_pack_pull_edition_id  ON public.allday_pack_pull (edition_id);
CREATE INDEX IF NOT EXISTS idx_fmv_alerts_collection_id     ON public.fmv_alerts (collection_id);
CREATE INDEX IF NOT EXISTS idx_raffle_draws_shop_item_id    ON public.raffle_draws (shop_item_id);
CREATE INDEX IF NOT EXISTS idx_raffle_entries_ledger_id     ON public.raffle_entries (ledger_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_ledger_id        ON public.redemptions (ledger_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_shop_item_id     ON public.redemptions (shop_item_id);
