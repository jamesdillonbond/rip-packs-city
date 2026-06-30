# Handoff 2026-06-08 — retire legacy `pinnacle_fmv_snapshots` (PIN-FMV-REKEY final waves)

> ## ✅ COMPLETE — 2026-06-08 (Claude Code, commit `ab2e6f4`, deploy `dpl_QS1Lmn` READY)
> The full sequence below was executed and verified. Code: `pinnacle-listing-cache` + `pinnacle-ingest` no longer call the legacy writers (`pinnacle-listing-cache` now calls the relocated `pinnacle_refresh_editions_ask()` to keep the 20-min ASK cadence). DB: dropped `bridge_pinnacle_fmv_to_main`, `pinnacle_fmv_from_sales`, `pinnacle_fmv_from_listings`, `pinnacle_fmv_recalc_all`, and `TABLE pinnacle_fmv_snapshots` (pre-drop backup `public.pinnacle_fmv_snapshots_backup_20260608`, 427 rows). Migrations `pinnacle_fmv_retirement_backup_and_drop_dead_fns` + `pinnacle_fmv_retirement_drop_writers_and_table`. Post-drop verified: per-render `pinnacle_catalog` (1,797 priced), `pinnacle_editions.ask_price` (300), `get_pinnacle_edition_fmv_collapsed`, and `pinnacle_refresh_editions_ask` all healthy; zero user-facing change (nothing read the legacy table). Keeper: `pinnacle_fmv_recalc_render_all()`. Orphaned-but-harmless follow-up: `pinnacle_fmv_recalc(text)`. See ledger Shipped block for the full revert path. The original (pre-execution) handoff text follows for the record.

REVIEW-GATED (FMV pipeline + a table drop) — drafted by Cowork from a live dependency audit, NOT shipped. The render-FMV staleness was NOT the only blocker (corrected): the legacy table is still being ACTIVELY WRITTEN by a live cron. Exact remaining steps below.

## Live dependency audit (2026-06-08) — what actually still touches pinnacle_fmv_snapshots

Already cut over to per-render (NO action — their only reference is a comment documenting the swap): `get_wallet_moments_with_fmv` (reads pinnacle_catalog), `holdings_summary` (reads wmc.fmv_usd), `get_set_detail` (uses get_pinnacle_edition_fmv_collapsed). ✅

DEAD — zero callers (DB-side 0; no route refs): **`bridge_pinnacle_fmv_to_main`** (bridged legacy → main fmv_snapshots; obsolete — Pinnacle FMV lives in pinnacle_catalog now) and **`pinnacle_fmv_from_sales`**. Safe to DROP directly.

LIVE legacy WRITERS — still called, so the table is still being written (this is the real blocker):
- `pinnacle_fmv_from_listings` ← **app/api/pinnacle-listing-cache/route.ts** `runAskOnlyFmv()` (~L152). pinnacle-listing-cache is a LIVE cron-job.org job (~every 20min). Writes ASK_ONLY snapshots from listings.
- `pinnacle_fmv_recalc_all` ← **app/api/pinnacle-listing-cache/route.ts** `runSalesFmvRecalc()` (~L168) AND **app/api/pinnacle-ingest/route.ts** (~L146, behind a `recalc` flag). Deletes + recomputes from sales.
- (pinnacle-sync L71 + drain-fmv-cold-tail L10 reference these names in COMMENTS only — no active call; the drain-fmv-cold-tail comment is now stale and could be tidied.)

## Sequence to retire (each step review-gated; FMV prices are user-facing — eyeball after each)

1. **Confirm per-render coverage replaces the legacy writers' output.** `pinnacle_fmv_from_listings` wrote ASK_ONLY (floor) for editions with listings but no sales; `pinnacle_fmv_recalc_all` wrote sales-based FMV. The per-render engine now owns both: `pinnacle_catalog.fmv_*` (sales-based, via `pinnacle_fmv_recalc_render_all`) + `pinnacle_catalog.floor_ask` (listings). Verify no edition that today gets an FMV only via the legacy ASK_ONLY path goes dark when the legacy writers stop (compare pinnacle_catalog FMV+floor coverage vs the editions the legacy writers currently price). This is the live eyeball gate.
2. **Remove the legacy-writer route calls (CC):** delete `runAskOnlyFmv()` + `runSalesFmvRecalc()` (and their call sites) from app/api/pinnacle-listing-cache/route.ts — the route keeps its actual listing-cache job, just stops writing the legacy FMV table; and delete the `pinnacle_fmv_recalc_all` call in app/api/pinnacle-ingest/route.ts (~L146). After deploy, confirm pinnacle-listing-cache still logs ok and no new rows land in pinnacle_fmv_snapshots.
3. **Drop the 4 functions (Cowork, after step 2 deploys + writes stop):** `bridge_pinnacle_fmv_to_main`, `pinnacle_fmv_from_sales` (already dead — can drop now), then `pinnacle_fmv_from_listings`, `pinnacle_fmv_recalc_all` (only after their route calls are gone). Pre-drop: `SELECT count(*)` on the table + a `pg_dump`/CSV backup of pinnacle_fmv_snapshots (destructive-op rule).
4. **Drop the table:** `DROP TABLE public.pinnacle_fmv_snapshots;` once steps 2–3 confirm zero readers + zero writers. Also retire the `get_edition_fmv_history` legacy path if it still points here (it was the last reader per the ledger; the new `pinnacle_fmv_history` table is populated — 2,752 rows — so cut `get_edition_fmv_history` to it first if not already done).

## Revert / safety
Each function drop reverts by re-CREATE from the captured body; the table drop reverts only from the backup (hence the mandatory pre-drop dump). Do NOT drop the table while pinnacle-listing-cache still calls the writers — you'd get write errors on a live cron. Order matters: route-calls-removed → writers-stop → drop fns → drop table.

## Why not Cowork-shipped
Touches route code (CC) + an FMV-pipeline coverage judgment + a destructive table drop — all review-gated. This doc is the accurate inventory + sequence so the final waves can execute deliberately. CC's file inspection wins over this doc.
