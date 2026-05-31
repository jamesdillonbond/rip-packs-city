# Rip Packs City — Cron Schedule Reference

**Last verified:** May 30, 2026 (reconciled against `pipeline_runs` 48h activity — FMV Cold-Tail Drain and Pinnacle Listings Reconcile confirmed firing and promoted from Pending to Active)
**Platform:** cron-job.org (free tier, 30s hard timeout)

This is the authoritative inventory of every active cron-job.org entry firing into Rip Packs City. Use this when adding new crons (to find a quiet schedule slot), when something stops working (to confirm a cron is actually scheduled), and when triaging health-probe alerts.

## Schedule conflict rules

Avoid HH:00 and HH:30 entirely — those collide with the 6-hourly wallet-backfill fan-out at 00/06/12/18 UTC, saturating the 60-connection Supabase pool and producing `statement timeout` errors even on routes whose underlying RPC runs in <1ms.

For staggered scheduling, use these patterns (all proven quiet):
- **Every 30 min**: `7,37 * * * *`
- **Every 15 min**: `8,23,38,53 * * * *` or `4,19,34,49 * * * *` or `9,24,39,54 * * * *` (pick whichever doesn't already collide)
- **Hourly, offset clear of HH:00**: `3 * * * *`, `5 * * * *`, `6 * * * *`, `15 * * * *`

## Active crons

### Vercel route crons (https://www.rippackscity.com/api/*)

| Title | Path | Schedule | Auth |
|---|---|---|---|
| RPC AllDay FMV Populate | `/api/allday-fmv-populate` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Listing Cache | `/api/allday-listing-cache` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Listings Indexer | `/api/allday-listings-indexer` | `*/15` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Listings Retry | `/api/allday-listings-retry` | `8,23,38,53 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Pack Listings | `/api/allday-pack-listings` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Sales Indexer | `/api/allday-sales-indexer` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Analytics Smoke | `/api/admin/analytics-smoke` | `13,43 * * * *` | Bearer RPC_ADMIN_TOKEN |
| RPC Check Alerts | `/api/check-alerts` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Classify Acquisitions Multi-Collection | `/api/cron/classify-acquisitions-multicollection` | `6 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Compute Laliga Pack EV | `/api/cron/compute-laliga-pack-ev` | daily 22:00 UTC | Bearer INGEST_SECRET_TOKEN |
| RPC Daily Portfolio Snapshot | `/api/cron/daily-portfolio-snapshot` | `5 7 * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC FMV Cold-Tail Drain | `/api/admin/drain-fmv-cold-tail?collection=all&limit=200` | `17,47 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC FMV Recalc Force Stale | `/api/fmv-recalc?force=stale` | `3,13,23,33,43,53 * * * *` ⚡ | Bearer INGEST_SECRET_TOKEN |
| RPC FMV Thin-Sale Haircut | `/api/admin/apply-fmv-haircut?mode=live` | `30 6 * * *` | Bearer RPC_ADMIN_TOKEN |
| RPC Golazos Listing Cache | `/api/golazos-listing-cache` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Golazos Sales Indexer | `/api/golazos-sales-indexer` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC League Drift Detection | `/api/admin/cron/detect-league-drift` | weekly Sunday 07:00 | Bearer RPC_ADMIN_TOKEN |
| RPC Lock Check Batch | `/api/cron/lock-check-batch` | `8,38 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle Events Ingest | `/api/cron/pinnacle-events-ingest` | `4,19,34,49 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle Listing Cache | `/api/pinnacle-listing-cache` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle Listings Reconcile | `/api/cron/pinnacle-listings-reconcile` | `9,24,39,54 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle Sales Indexer | `/api/pinnacle-sales-indexer` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Pipeline | `/api/pipeline-trigger` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Populate Pinnacle WMC FMV | `/api/cron/populate-pi…` | `3 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Prune Pipeline Runs (daily) | `/api/admin/prune-pipeline-runs` | daily 23:00 PT | Bearer RPC_ADMIN_TOKEN |
| RPC Recalc Ultimate FMV | `/api/admin/recalc-ultimate-fmv` | daily 23:35 PT | Bearer RPC_ADMIN_TOKEN |
| RPC Refresh Error Triage | `/api/admin/cron/refresh-error-triage` | hourly | Bearer RPC_ADMIN_TOKEN |
| RPC Resolve Topshot Stubs | `/api/cron/resolve-topshot-stubs` | `*/30` | Bearer INGEST_SECRET_TOKEN |
| RPC Run Insider Detectors | `/api/cron/run-insider-detectors` | `15 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC Sales Indexer | `/api/sales-indexer` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Seed Wallet Refresh | `/api/seed-wallet-refresh` | every 6h | Bearer INGEST_SECRET_TOKEN |
| RPC Snapshot Institutional Wallets | `/api/cron/snapshot-institutional-wallets` | daily | Bearer INGEST_SECRET_TOKEN |
| RPC Top Shot Listing Cache | `/api/topshot-listing-cache` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC UFC Strike Pipeline | `/api/ufc-pipeline?t=…` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC Weekly Digest | `/api/send-digest` | weekly Mon 09:00 PT | Bearer INGEST_SECRET_TOKEN |
| RPC Weekly Support Report | `/api/support-report` | weekly Mon 07:00 PT | Bearer INGEST_SECRET_TOKEN |
| RPC wmc-fmv-populate (NEW) | `/api/wmc-fmv-populate` | `*/20` | Bearer INGEST_SECRET_TOKEN |

### Supabase edge function crons (https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/*)

| Title | Path | Schedule | Auth |
|---|---|---|---|
| RPC Compute Achievements | `/compute-achievements` | weekly | Bearer INGEST_SECRET_TOKEN |
| RPC Compute AllDay Pack EV | `/compute-allday-pack-ev` | hourly :30 | Bearer INGEST_SECRET_TOKEN |
| RPC Compute Topshot Pack FMV | `/compute-topshot-pack-fmv` | hourly :30 | Bearer INGEST_SECRET_TOKEN |
| RPC Hybrid Custody Events | `/hybrid-custody-events` | `*/20` | Bearer INGEST_SECRET_TOKEN |
| RPC NBA Player Name Matcher | `/nba-player-name-matcher` | daily 01:00 PT | Bearer INGEST_SECRET_TOKEN |
| RPC NBA Projections Sync | `/sync-nba-projections` | every 2h | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle NFT Resolver | `/pinnacle-nft-resolver` | `*/5` | Bearer INGEST_SECRET_TOKEN |
| RPC Pinnacle Owner Discovery Forward | `/pinnacle-owner-discovery-forward` | hourly :30 | Bearer INGEST_SECRET_TOKEN |
| RPC Pipeline Failure Alerts | `/pipeline-failure-alerts` | hourly :30 | Bearer INGEST_SECRET_TOKEN |
| RPC Pipeline Runs Cleanup | `/pipeline-runs-cleanup` | weekly | Service role |
| RPC Seed Topshot Pack Distribution | `/seed-topshot-pack-distribution` | every 4h | Bearer INGEST_SECRET_TOKEN |
| RPC UFC Stub Thumbnail Resolver | `/ufc-stub-thumbnail-resolver` | `12,42 * * * *` | Bearer INGEST_SECRET_TOKEN |
| RPC AllDay Pack Distributions | `/seed-allday-pack-distributions` | every 6h | Bearer INGEST_SECRET_TOKEN |
| RPC Golazos Pack Distributions | `/seed-golazos-pack-distributions` | every 6h | Bearer INGEST_SECRET_TOKEN |

### Known issues / watch-list

- ⚡ **`RPC FMV Recalc Force Stale`** temporarily on `3,13,23,33,43,53 * * * *` (every 10 min) 2026-05-24 to burn through the first full FMV-recalc sweep. **Dial back to `8,28,48 * * * *` (every 20 min) once that first sweep completes.**

## Recently deleted

- ❌ **RPC Badge Sync** — May 11. Route never existed; badge sync is a manual browser-console script (`scripts/topshot-badge-sync.js`).
- ❌ **RPC Classify Acquisitions** (legacy single-collection, 2 entries) — May 11. Replaced by `classify-acquisitions-multicollection`.
- ❌ **RPC wmc Edition Keys Drain** (legacy route) — May 11. Replaced by `migrate-wmc-edition-keys`.
- ❌ **RPC Migrate wmc Edition Keys** — May 24. Was corrupting `wallet_moments_cache.edition_key` (rewriting valid `set:play` keys to `editions.id` UUIDs). v3 SQL function neutralized to a no-op, ~200k rows repaired, route + script deleted. See `docs/audits/wmc-edition-key-corruption-2026-05-24.md`.
- ❌ **RPC Flowty TX Scanner** (`/api/flowty-tx-scanner`, `*/15`) — May 24. Flowty teardown.
- ❌ **RPC Sync Flowty Listings AllDay** (`/api/sync-flowty-listings`, `*/5`) — May 24. Flowty teardown.
- ❌ **RPC Flowty Loan Indexer** (edge fn `/flowty-loan-indexer`, `*/10`) — May 24. Flowty teardown.
- ❌ **RPC Flowty Analytics Refresh** (`/api/admin/refresh-flowty-analytics`, `*/20`) — May 24. Flowty teardown.
- ❌ **RPC Listing Divergence AllDay** (`/api/listing-divergence?collection=nfl_all_day`, `*/30`) — May 24. Flowty teardown (was already short-circuiting on the Flowty-offline guard).
- ❌ Any **extract-flowty-\*** / **prune-flowty-archive** entries — May 24. Flowty teardown.

Flowty's marketplace shut down ~2026-05-13. The external Flowty event indexer, `flowty_loans` / `flowty_loan_events` ingest, the Flowty analytics materialized views, the Flowty leg of the sniper feed, the `flowty-proxy` edge function, and all Flowty-sourced ASK/FMV inputs are now frozen.

## Pending cleanups

- _None. (The `wmc-fmv-populate` duplicate concern was verified not-an-issue on 2026-05-30: a single `*/20` Vercel-route source writes 5 rows per tick — one per collection — and no Supabase edge function by that name is deployed.)_

## Pending additions

_None. (Pinnacle Listings Reconcile and FMV Cold-Tail Drain were both wired and are now in Active above — confirmed firing in `pipeline_runs` over the trailing 48h: drain-fmv-cold-tail 89 runs all-ok, pinnacle-listings-reconcile 185 runs, as of 2026-05-30.)_
