# Flowty Teardown — Inventory & Plan

**Date:** 2026-05-23 (updated 2026-05-24)
**Author:** Claude (Cowork session)
**Scope:** A complete inventory of Flowty-dependent infrastructure and a sequenced, risk-rated plan to retire it.
**Context:** Flowty shut down its NFT marketplace ~2026-05-13. `flowty_loan_events` went cold 2026-05-11. UFC Strike also left Flow for Aptos. All Flowty-derived data is now frozen by design.

---

## 1. Already done

- **`api_harvest_20260512`** (the 9.9 GB Flowty archive harvest table) was pruned earlier — total DB went 13.8 GB to 6.5 GB.
- **`listing-divergence-snapshot`** got a Flowty-offline guard (commit `6e37a79`) — it no longer fails ~80% of runs.

### Update 2026-05-24 — Phase 0 + Phase 1 executed

- **Retention decisions settled (Trevor):** (1) hard-delete the `unmapped_sales` archive rows; (2) keep all Flowty *history* — loan/transaction tables, the 3 MVs, the `flowty_top_*`/`flowty_analytics_*` RPCs, and `/admin/flowty-analytics` — frozen as a historical record (Phase 3 reframe path, not the drop path).
- **Phase 0 (workflow):** the 3 dead Flowty steps (`Flowty Sales`, `Flowty Enrich`, `Flowty Listings`) removed from `.github/workflows/rpc-pipeline.yml`. cron-job.org entries still need deleting by Trevor (see Phase 0 list below).
- **Phase 1 (DB prune):** all 1,973,983 `flowty_archive_extractor` rows hard-deleted from `unmapped_sales` + `VACUUM FULL` — table went 1,432 MB to 2.8 MB, database total ~6.5 GB to 5.05 GB. 4,582 genuine on-chain unmapped rows retained. The MVs / RPCs / loan tables were kept per the retention decision.

## 2. Inventory of what remains

### Cron pipelines still running (cron-job.org + GitHub Actions)

| Pipeline | Trigger | State |
|---|---|---|
| `sync-flowty-listings` | cron-job.org | Running, low-rate errors, no useful output |
| `extract-flowty-purchases` | chained | Running, no new data |
| `extract-flowty-offers` | chained | Running, no new data |
| `flowty-harvester` | cron-job.org | Running, no new data |
| `flowty-tx-scanner` | cron-job.org */5 | Running, low-rate errors |
| `flowty-loan-indexer` (edge fn) | cron-job.org */10 | Cold since 2026-05-11 |
| `refresh-flowty` (analytics MV refresh) | cron-job.org */20 | Running, refreshes empty MVs |

### API routes (10) — `app/api/`

`flowty-enrich`, `flowty-harvester`, `flowty-listings`, `flowty-loans`, `flowty-monitor`, `flowty-offers`, `flowty-sales`, `flowty-tx-scanner`, `sync-flowty-listings`, `wallet-enrich-flowty`

### Supabase edge function

`flowty-proxy` (Flowty blocked Vercel IPs; this proxied around it — now moot). `flowty-loan-indexer` (cold since 2026-05-11).

### lib/

`lib/flowty/` (directory), `flowty-flags.ts`, `flowty-market-truth.ts`, `flowty-tx-classifier.ts`, `flowty-username.ts`

### GitHub Actions

`rpc-pipeline.yml` carried 3 dead Flowty steps: "Flowty Sales", "Flowty Enrich", "Flowty Listings" — all hitting now-dead endpoints. Removed 2026-05-24 (see Phase 0).

### Database objects

| Object | Type | Size | Disposition |
|---|---|---:|---|
| `unmapped_sales` | table | 1.4 GB | ~1.97M `flowty_archive_extractor` rows pruned 2026-05-24 |
| `flowty_loan_events` | table | 23 MB | Historical — KEPT (retention decision) |
| `flowty_transactions` | table | 11 MB | Historical — KEPT (retention decision) |
| `flowty_loans` | table | 5.4 MB | Historical — KEPT (retention decision) |
| `unmapped_sales_resolution_failures` | table | 552 KB | Candidate drop (Phase 2) |
| `mv_flowty_first_activations` | mat. view | 256 KB | KEPT — backs /admin/flowty-analytics |
| `mv_flowty_sales_daily` | mat. view | 96 KB | KEPT — backs /admin/flowty-analytics |
| `mv_flowty_loans_daily` | mat. view | 64 KB | KEPT — backs /admin/flowty-analytics |
| `flowty_scanner_state` | table | 56 KB | Candidate drop (Phase 2) |
| `flowty_excluded_addresses` | table | 32 KB | Keep (tiny, may be reusable) |

Plus `refresh_flowty_analytics()` and 5 `flowty_top_*` RPCs — KEPT (retention decision).

### Frontend

46 `.tsx` files reference Flowty. The Market/Sniper buy-leg was already reframed to outbound links (commit `b19d8f2`); the remaining surface is the analytics dashboards + status components, which get *relabelled* as historical, not deleted.

## 3. Teardown plan — sequenced & risk-rated

### Phase 0 — stop the bleeding · low risk

- DONE 2026-05-24: removed the 3 dead Flowty steps from `.github/workflows/rpc-pipeline.yml`.
- TREVOR — cron-job.org dashboard: delete the entries `sync-flowty-listings`, `flowty-harvester`, `flowty-tx-scanner`, `extract-flowty-offers`, `extract-flowty-purchases`, `RPC Flowty Loan Indexer`, `RPC Flowty Analytics Refresh` (MV refresh). Also retire `prune-flowty-archive-api-harvest` — its target table is already gone.

### Phase 1 — reclaim database space · DONE 2026-05-24

- DONE: `unmapped_sales` pruned — 1,973,983 `flowty_archive_extractor` rows hard-deleted + `VACUUM FULL`. Table 1,432 MB to 2.8 MB; DB total ~6.5 GB to 5.05 GB. 4,582 genuine on-chain unmapped rows kept.
- Not done, by decision: the MVs, `refresh_flowty_analytics()`, and the 5 `flowty_top_*` RPCs are kept — the retention decision is keep-frozen-historical, so they back `/admin/flowty-analytics`. The refresh simply stops once its cron is deleted (Phase 0).
- `flowty_loan_events` / `flowty_transactions` / `flowty_loans` (~40 MB) kept as the historical record.

### Phase 2 — code removal · NEXT — larger, focused pass

Scope is narrowed by two settled facts: (a) the Market/Sniper frontend reframe to outbound "View Listing" links already shipped (commit `b19d8f2`, 2026-05-23); (b) the retention decision is keep-frozen-historical, so reader code stays.

- Delete only the dead *ingest* surface: the `flowty-*` API routes that the now-deleted crons fired (`sync-flowty-listings`, `flowty-harvester`, `flowty-tx-scanner`, `flowty-offers`, `flowty-sales`, `flowty-enrich`/`wallet-enrich-flowty`, `flowty-monitor`). Verify each is ingest-only (not read by the frontend) before deleting.
- Keep reader routes/RPCs that back `/admin/flowty-analytics` and the historical analytics dashboards — relabel, don't delete.
- Investigate first: `/api/listing-cache` + `/api/topshot-listing-cache` / `allday` / `golazos` (the 4 "via flowty-proxy" steps still in `rpc-pipeline.yml`) — confirm whether they hit the dead Flowty API or live per-collection APIs before touching them.
- Relabel the remaining `.tsx` touch-points (analytics dashboards, marketplace-status components, badges) as "historical — Flowty closed May 2026".

### Phase 3 — reframe, don't delete

- Keep `/admin/flowty-analytics` as a historical view; relabel it so it doesn't read as a live feed.

## 4. What was / wasn't done autonomously

- Done: the `listing-divergence-snapshot` Flowty-offline guard (commit `6e37a79`); Phase 0 workflow edit + Phase 1 DB prune (2026-05-24).
- Gated on a decision, by design: the `unmapped_sales` prune and the keep-vs-drop call on the historical tables/MVs/analytics were surfaced to Trevor before execution — they are irreversible. cron removal still needs the cron-job.org dashboard (Trevor).

## 5. The strategic fork — SETTLED

The gating decision (live buy / cart / snipe as a product goal) is settled: intelligence-first. Cart is shelved; Market/Sniper reframed to FMV + outbound links (shipped `b19d8f2`). Phase 2 is the narrowed pass described in section 3 — no further strategic decision needed to proceed.
