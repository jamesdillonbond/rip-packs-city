# Flowty Teardown — Inventory & Plan

**Date:** 2026-05-23
**Author:** Claude (Cowork session)
**Scope:** A complete inventory of Flowty-dependent infrastructure and a sequenced, risk-rated plan to retire it.
**Context:** Flowty shut down its NFT marketplace ~2026-05-13. `flowty_loan_events` went cold 2026-05-11. UFC Strike also left Flow for Aptos. All Flowty-derived data is now frozen by design — this is `CLAUDE.md` Prioritized Next Action #4.

---

## 1. Already done

- **`api_harvest_20260512`** (the 9.9 GB Flowty archive harvest table) has already been pruned — total DB went 13.8 GB → 6.5 GB.
- **`listing-divergence-snapshot`** got a Flowty-offline guard this session (commit `6e37a79`) — it no longer fails ~80% of runs or burns 75–135s of DB time comparing against a dead feed.

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

`flowty-proxy` (Flowty blocked Vercel IPs; this proxied around it — now moot)

### `lib/`

`lib/flowty/` (directory), `flowty-flags.ts`, `flowty-market-truth.ts`, `flowty-tx-classifier.ts`, `flowty-username.ts`

### GitHub Actions

`rpc-pipeline.yml` carries 3 dead Flowty steps: **"Flowty Sales"**, **"Flowty Enrich"**, **"Flowty Listings"** (all `continue-on-error`, all hitting now-dead endpoints).

### Database objects

| Object | Type | Size | Disposition |
|---|---|---:|---|
| `unmapped_sales` | table | **1.4 GB** | ~1.97M rows are `flowty_archive_extractor` source that structurally never resolve (May 20 audit) — the one real space win |
| `flowty_loan_events` | table | 23 MB | Historical — keep or export+drop |
| `flowty_transactions` | table | 11 MB | Historical — keep or export+drop |
| `flowty_loans` | table | 5.4 MB | Historical — keep or export+drop |
| `unmapped_sales_resolution_failures` | table | 552 KB | Drop with the prune |
| `mv_flowty_first_activations` | mat. view | 256 KB | Drop |
| `mv_flowty_sales_daily` | mat. view | 96 KB | Drop |
| `mv_flowty_loans_daily` | mat. view | 64 KB | Drop |
| `flowty_scanner_state` | table | 56 KB | Drop |
| `flowty_excluded_addresses` | table | 32 KB | Keep (tiny, may be reusable) |

Plus the `refresh_flowty_analytics()` function and 5 `flowty_top_*` RPCs.

### Frontend

**46 `.tsx` files** reference Flowty — the Sniper feed, the Market tab, `/admin/flowty-analytics`, and assorted badges/labels. This is the largest surface and overlaps the roadmap's "decide the marketplace messaging" decision.

## 3. Teardown plan — sequenced & risk-rated

### Phase 0 — stop the bleeding · low risk

- Delete the cron-job.org entries: `RPC Flowty Loan Indexer`, `RPC Flowty Analytics Refresh`, `sync-flowty-listings`, `flowty-harvester`, `flowty-tx-scanner`, and the `extract-flowty-*` jobs. *(Requires the cron-job.org dashboard — Trevor.)*
- Remove the 3 dead Flowty steps from `.github/workflows/rpc-pipeline.yml`. *(Scoped, reversible — but it edits the critical data-pipeline workflow, so do it deliberately with the rest of Phase 0, not as a drive-by.)*

### Phase 1 — reclaim database space · medium risk, needs a retention decision

- **`unmapped_sales`:** prune the ~1.97M `flowty_archive_extractor` rows → reclaims **~1.4 GB**, the single biggest remaining DB lever. Decide first: hard delete, or move to a cold/exported archive.
- Drop `mv_flowty_sales_daily`, `mv_flowty_loans_daily`, `mv_flowty_first_activations`, the `refresh_flowty_analytics()` function, and the 5 `flowty_top_*` RPCs.
- `flowty_loan_events` / `flowty_transactions` / `flowty_loans` total only ~40 MB — cheap to keep as a historical record; export + drop only if you want a clean schema.

### Phase 2 — code removal · larger, after Phases 0–1 settle

- Delete the 10 `flowty-*` API routes, the `flowty-proxy` edge function, and `lib/flowty*`.
- Work through the 46 `.tsx` files. This is where the teardown meets the **roadmap's strategic fork**: Market/Sniper should be reframed as "FMV + historical + outbound buy links" rather than a live Flowty feed. Treat this as the marketing-messaging change, not just a code delete.

### Phase 3 — reframe, don't delete

- Keep `/admin/flowty-analytics` as a historical view; relabel it so it doesn't read as a live feed.

## 4. What was / wasn't done autonomously

- **Done:** the `listing-divergence-snapshot` Flowty-offline guard (shipped, commit `6e37a79`).
- **Not done autonomously, by design:** route deletions, table/MV drops, the `unmapped_sales` prune, and cron removal. These are irreversible and/or need the cron-job.org dashboard, and the roadmap explicitly frames the teardown as a deliberate decision. A teardown should be **one planned sweep**, not piecemeal edits that risk colliding with the larger marketplace-messaging change. This document is that plan.

## 5. The decision that gates Phase 2

Per `docs/roadmap-2026-05.md`, the open fork: **is live buy / cart / snipe still a product goal?** If the answer is "intelligence-first," Phase 2 simplifies dramatically — Market/Sniper collapse to FMV + outbound links and most of the 46 `.tsx` touch-points get reframed in one pass. Settle that decision before starting Phase 2.
