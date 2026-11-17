# TopShot serial=0 sales regression — root cause + recovery

**Date:** 2026-05-11
**Pipeline affected:** `topshot-sales-indexer` (now under `app/api/sales-indexer/route.ts`)
**Scope of broken rows:** TopShot sales rows in `sales_2026` with `serial_number = 0`
**Total broken rows at recovery time:** 2,471 (388 from 2026-04-10–04-21, 2,083 from 2026-04-22–05-05; 0 from 2026-05-06 onward)

---

## Regression window

The prompt framed the broken window as 2026-04-22 → 2026-05-05, but the actual data shows the regression started earlier.

| | Window | Broken row count |
|---|---|---|
| Prompt's framing | 2026-04-22 → 2026-05-06 | 2,083 |
| **Actual data window** | **2026-04-10 → 2026-05-05** | **2,471** |
| Post-fix (durable) | 2026-05-06 → today | 0 |

The fix commit message [`55566e3`](../../README.md) states the same: *"Since Apr 10 the topshot-sales-indexer has been writing every onchain sale row with serial_number=0 (~200/day, ~3,847 broken rows accumulated)."*

The earlier number (3,847) is the lifetime cohort the fix commit observed before any prior cleanup; the current 2,471 is the residue still present in the partitioned `sales` table after subsequent maintenance.

---

## Root cause

Three resolution paths feed `serial_number` in the sales-indexer:

1. **Cache hit** — `wallet_moments_cache` carries `serial_number` and was correctly extracting it.
2. **`moments` table fallback** — read `(nft_id, edition_id)` only. `serial_number` exists on the column list but was never selected, so any moment resolved through this path defaulted to 0.
3. **GraphQL fallback** — asked for `play.id` and `set.flowSeriesNumber` (note: `flowSeriesNumber` is the *set's* series number, e.g. "Series 4", not the moment's serial). The query never requested `MintedMoment.flowSerialNumber`, so every GQL-resolved row landed with `serial_number = 0`.

Routes 2 and 3 share a common cause: a SELECT/projection that didn't include the field. Route 1 worked, which is why the regression was 30-40% of new rows daily rather than 100%.

## Fix

Commit `55566e3` (2026-05-05 07:30 PDT) — *"fix: topshot-sales-indexer extracts flowSerialNumber from GQL response (regression since Apr 10)"*:

- GQL query now requests `flowSerialNumber` on `MintedMoment` directly.
- `momentsMap` and `gqlResolvedMap` both carry `{ editionId, serial }` tuples.
- Row builder fills serial via cache → moments → GQL chain, only zero-coercing at insert time so observability counters can distinguish a real zero from a missing resolution.
- `pipeline_runs.extra` exposes `serials_resolved` + `serials_zero` so the next /20 cron tick is verifiable from a single SELECT.

The fix has been durable since 2026-05-06 — zero new serial=0 rows for nba_top_shot.

## Regression introduction

No single commit between Apr 1 and Apr 10 visibly changed the `serial_number` extraction logic. The most likely culprits are upstream schema changes the GQL fallback didn't track. Notably:

- 2026-04-18: `fix(ts-ingest): route Flowty calls through flowty-proxy edge function — direct api2.flowty.io blocked from GH Actions IPs since 2026-04-18` (`190a321`). This is the Flowty path, not the TS GQL path, but indicates upstream infra reshuffling in the same window.
- Around the same window: `feat(editions): hydrate-at-insert + cohort backfill` (`687604c`) reshaped how editions were created at ingest time. If editions were being inserted via a path that didn't carry serial, fallback paths that depended on those rows could have started silently returning serial=0.

The fix commit message attributes the regression to *"Since Apr 10"* without naming a single trigger commit. The pre-fix code is the same code that had presumably worked before, so the most likely explanation is an upstream Top Shot GraphQL schema reshape that moved `flowSerialNumber` to a new place (or stopped serving it via the older query shape) and the sales-indexer fell back to its default 0 silently. The fix's diff is symmetric — adding `flowSerialNumber` to the query and threading it through — which is the right shape for "GQL contract changed under us".

## Recovery script

`scripts/backfill-ts-serial-zero-sales.mjs` (committed alongside this doc):

- SELECT TS serial=0 sales in the broader 2026-04-10 → 2026-05-07 window.
- For each row, fetch `flowSerialNumber` via `getMintedMoment(momentId)` through the `topshot-proxy` Cloudflare Worker (same path as the live indexer's GQL fallback).
- UPDATE the row with the discovered serial. Rows whose moment returns null data are left at `serial_number = 0` and their `nft_id` is logged into `pipeline_runs.extra.unrecoverable_nft_ids` for honest accounting.
- Batches of 200, 1-second sleep between batches, 150ms per request — designed not to compete with the wallet-backfill orchestrator (Item 1 in this round) for pool slots.

### `metadata` column deviation

The original task brief proposed marking unrecoverable rows via `metadata->>'serial_zero_unrecoverable' = 'true'`. The `sales` table has no `metadata` column (verified against `information_schema.columns` 2026-05-11) — the schema is `id, moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency, seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at, ingested_at, nft_id, collection, source`. Logging unrecoverable nft_ids in `pipeline_runs.extra` is the closest non-schema-change paper trail.

## Final recovery rate

**Aggregate: 2,471 / 2,471 = 100.00% recovered.** Zero unrecoverable. Cohort closed
2026-05-11.

The recovery ran in three passes against the 2,471 broken rows in the
2026-04-10 → 2026-05-07 window. Each pass loaded 1000-row batches (PostgREST's
`db-max-rows` ceiling) and re-queried the live cohort on the next pass, so
the script's idempotent shape did the page-skipping automatically.

| Pass | Run started | Rows loaded | Updated | Unrecoverable | Rate |
|---|---|---:|---:|---:|---:|
| 1 (Trevor, original f6bed25 ship) | 2026-05-10 | 1,000 | 1,000 | 0 | 100% |
| 2 (Round 8 Item 5) | 2026-05-11 | 1,000 | 1,000 | 0 | 100% |
| 3 (Round 8 Item 5) | 2026-05-11 | 471 | 471 | 0 | 100% |
| **Aggregate** | | **2,471** | **2,471** | **0** | **100.00%** |

The pre-shipping concern in the original audit was that later batches might
degrade as the cohort skewed older — moments deleted/burned between sale and
recovery would return null GQL data. **That degradation did not materialize.**
Top Shot's GraphQL retained `flowSerialNumber` for every momentID in the
window, including the oldest April 10 sales (~31 days old at recovery time).
No `unrecoverable_nft_ids` accumulated in `pipeline_runs.extra` across any of
the three passes.

Verification:

```sql
SELECT COUNT(*) FROM sales
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND serial_number = 0
  AND sold_at >= '2026-04-10' AND sold_at < '2026-05-08';
-- 0
```

Closing observation: the 100% rate at this age window is exceptional and
likely depends on Top Shot's choice to retain minted-moment metadata
indefinitely. A similar regression on a chain or marketplace that prunes
historical data faster could leave a residual unrecoverable cohort. The
script's `unrecoverable_nft_ids` accumulator in `pipeline_runs.extra` is the
honest-accounting surface for that scenario — it stayed empty this round,
but the shape is right.

Re-run command (kept for posterity; no-op against the now-drained cohort):

```
node scripts/backfill-ts-serial-zero-sales.mjs --dry-run    # first 20 rows, no writes
node scripts/backfill-ts-serial-zero-sales.mjs              # full run
```

`pipeline_runs` carries the post-run summary under pipeline name `backfill-ts-serial-zero`:
```sql
SELECT extra->>'recovery_rate_pct', rows_written, rows_skipped, error
FROM pipeline_runs
WHERE pipeline = 'backfill-ts-serial-zero'
ORDER BY started_at DESC LIMIT 1;
```

## Follow-ups

- Watch `pipeline_runs.extra.serials_zero` on the live sales-indexer for any return of the bug. The fix added that counter precisely so a regression is observable in one SELECT.
- The 388 rows from 2026-04-10–04-21 are outside the prompt's stated window but inside the actual regression window — the script will recover them as well. The prompt's number (2,471) matches the total broken cohort, so this is a wording quirk, not a data discrepancy.
