# Staged 2026-11-09 — two DB changes built and tested but NOT applied

`apply_migration` raised a confirmation question (Supabase MCP) that went unanswered within the tool's
60 s, so nothing below is in production. Both are ready to apply as-is.

| File | What | Then |
|---|---|---|
| `rip-metadata-eligibility-precomputed-STAGED.sql` | #242: `backfill_pack_rip_metadata`'s two whole-set eligibility legs (~19 s fixed cost/call; 6 of 15 hourly runs timed out 11-09) move to `pack_rip_backfill_eligible`, refreshed every 2 h by `refresh_pack_rip_backfill_eligible()`; queued rows re-checked per call. Base verified (live md5 `4eea6213…` = 20261102201245). | Rename into `supabase/migrations/<applied version>_audit_20261109_rip_metadata_eligibility_is_precomputed.sql`; copy `rip-metadata-eligibility-precomputed-PIN-STAGED.sql.txt` over `supabase/tests/backfill_pack_rip_metadata.sql` (set its header pointer to that version); in `__tests__/db-invariants-drift-guard.test.ts` re-point the `backfill_pack_rip_metadata` PIN and add one for `refresh_pack_rip_backfill_eligible` (same test file). Pin passed on local Postgres (PGTZ=UTC); 2 planted defects red. |
| `wmc-selfheal-skips-candy-STAGED.sql` | daytime filing 2211Z: `rpc_wmc_selfheal_recent` skips Candy (owned by the label-fill) on the editions side and writes only fillable rows (388 ms vs a 110 s timeout); pg_cron 818 gets a 300 s statement_timeout. Base: LIVE prosrc md5 `de2a5ae6…` (R118 batch). | Rename into `supabase/migrations/<applied version>_audit_20261109_wmc_selfheal_skips_candy_and_writes_only_what_it_can_fill.sql`. No pin exists for either function. |
