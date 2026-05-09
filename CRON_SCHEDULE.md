# CRON_SCHEDULE.md — cron-job.org dependency inventory

Authoritative-ish list of every cron-job.org schedule the production stack depends on. Created 2026-05-08, rewritten 2026-05-09 against the actual dashboard after several entries in the v1 file proved to be wrong (claimed 5 wallet-backfill crons that were really 1 orchestrator + fanout; missed 16 jobs that exist; documented 7 that don't).

**This file is descriptive, not authoritative.** The truth lives in the cron-job.org dashboard. When this file disagrees with the dashboard, the dashboard wins and this file gets fixed.

Statuses:
- **HEALTHY** — observed running on schedule in `pipeline_runs` AND visible firing in dashboard.
- **BROKEN** — dashboard shows failure, OR pipeline silent past `max_silent_minutes`.
- **CHAINED** — fires from another pipeline; no top-level cron required.
- **UNKNOWN** — route exists, dashboard entry exists, but doesn't write `pipeline_runs` so we can't verify cadence from inside the DB.

All requests authenticate via `Authorization: Bearer ${INGEST_SECRET_TOKEN}`. Base URL: `https://www.rippackscity.com` for app routes, `https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/<name>` for edge functions.

## Top-level cron-job.org schedules

### Every 5 minutes

| Dashboard label | URL | Status | Notes |
|---|---|---|---|
| Flowty TX Scanner | `/api/flowty-tx-scanner` | HEALTHY | Doesn't write `pipeline_runs`. UNKNOWN cadence-from-DB but dashboard confirms. |
| RPC Pinnacle NFT Resolver | edge fn `pinnacle-nft-resolver` | HEALTHY | 297 runs/24h confirms. |

### Every 20 minutes

App routes:

| Dashboard label | URL | Status |
|---|---|---|
| RPC Pipeline | `/api/pipeline-trigger` | HEALTHY |
| RPC Sales Indexer | `/api/sales-indexer-…` (TopShot) | HEALTHY |
| RPC All Day Sales Indexer | `/api/allday-sales-indexer` | HEALTHY |
| RPC Golazos Sales Indexer | `/api/golazos-sales-indexer` | HEALTHY |
| RPC Pinnacle Sales Indexer | `/api/pinnacle-sales-indexer` | HEALTHY (UNKNOWN-but-firing in DB) |
| RPC UFC Strike Pipeline | `/api/ufc-pipeline?...` | HEALTHY |
| RPC Top Shot Listing Cache | `/api/topshot-listing-cache` | HEALTHY |
| RPC All Day Listing Cache | `/api/allday-listing-cache` | HEALTHY |
| RPC Golazos Listing Cache | `/api/golazos-listing-cache` | HEALTHY |
| RPC Pinnacle Listing Cache | `/api/pinnacle-listing-cache` | HEALTHY |
| RPC All Day Pack Listings | `/api/allday-pack-listings` | HEALTHY |
| RPC All Day FMV Populate | `/api/allday-fmv-populate` | HEALTHY-but-stuck. Cron fires; cursor stuck since 2026-03-23 (`cursor_before == cursor_after`, `editions_fetched=0`). Stall-detection + reset switch shipped 2026-05-09 (commit 62db96f). Upstream `ALLDAY_PROXY_URL` env var still misconfigured — fetch returns GQL 403 after reset. Trevor open item. |
| RPC wmc-fmv-populate | `/api/wmc-fmv-populate?limit=5000` | HEALTHY (NEW 2026-05-09) | Multi-collection sweep. NULL-only chunked path, `?limit=5000` keeps each tick under 30s during backlog burns. ~1.09M TS NULL rows at launch; drains in ~69h then settles into subsecond steady state. Logs one `pipeline_runs` row per collection. Pinnacle is a no-op until Pinnacle FMV pipeline ships. |
| RPC Check Alerts | `/api/check-alerts` | HEALTHY |
| RPC Flowty Analytics Refresh | `/api/admin/refresh-flowty` | HEALTHY |

Edge functions:

| Dashboard label | URL | Status |
|---|---|---|
| RPC Hybrid Custody Events | edge fn `hybrid-custody-events` | HEALTHY (was hourly before 2026-05-08) |

### Every 30 minutes

| Dashboard label | URL | Status |
|---|---|---|
| RPC Pinnacle Owner Discovery Forward | edge fn `pinnacle-owner-discovery-forward` | HEALTHY |
| RPC Pipeline Failure Alerts | edge fn `pipeline-failure-alerts` | HEALTHY |

### Every hour

| Dashboard label | URL | Status |
|---|---|---|
| RPC Classify Acquisitions | edge fn `classify-acquisitions` | HEALTHY |

### Every 10 minutes

| Dashboard label | URL | Status |
|---|---|---|
| RPC Flowty Loan Indexer | edge fn `flowty-loan-indexer` | HEALTHY |

### Every 4 hours

| Dashboard label | URL | Status |
|---|---|---|
| RPC Compute AllDay Pack EV | edge fn `compute-allday-pack-ev` | HEALTHY |
| RPC Compute Topshot Pack FMV | edge fn `compute-topshot-pack-ev` (label says "FMV" — verify) | HEALTHY |
| RPC Seed Topshot Pack Distribution | edge fn `seed-topshot-pack-distribution` | UNKNOWN (doesn't write `pipeline_runs`) |

### Every 6 hours

| Dashboard label | URL | Status |
|---|---|---|
| RPC Seed Wallet Refresh | `/api/seed-wallet-refresh` | HEALTHY | 
| RPC FMV Recalc Force Stale | `/api/fmv-recalc?force=stale` | HEALTHY |
| RPC AllDay Pack Distributions | edge fn `allday-pack-distributions` | UNKNOWN (doesn't write `pipeline_runs`) |
| RPC Golazos Pack Distributions | edge fn `golazos-pack-distributions` | UNKNOWN (doesn't write `pipeline_runs`) |

### Daily

| Dashboard label | URL | Status | Notes |
|---|---|---|---|
| RPC Refresh Error Triage | `/api/admin/cron/refresh-error-triage` | NEVER-RUN | Dashboard shows Last Execution `-`. New entry, hasn't fired yet. Next at 10 PM PDT (05:00 UTC). Confirm at first run. |
| RPC Snapshot Institutional Wallets | `/api/cron/snapshot-institutional-wallets` | RECREATED-NOT-VERIFIED | Dashboard shows Last Execution `-` (recreated post-audit; one historical run in `pipeline_runs` at 23:29 UTC May 8 may be from old config). Next at 11 PM PDT (06:00 UTC). Verify at first run. |
| RPC Prune Pipeline Runs | `/api/admin/prune-pipeline-runs` | HEALTHY |
| RPC Analytics Smoke | `/api/admin/analytics-smoke` | HEALTHY |
| RPC NBA Player Name Matcher | edge fn `nba-player-name-matcher` | HEALTHY |
| RPC NBA Projections Sync | edge fn `nba-projections-sync` | HEALTHY |
| RPC Pipeline Runs Cleanup | edge fn `pipeline-runs-cleanup` | **BROKEN** | Dashboard shows `Failed (timeout) (30s)` last Saturday. Same 30s-cap issue we hit on `wmc-fmv-populate`. Needs chunked rewrite. See "Open issues" below. |

### Weekly

| Dashboard label | URL | Status |
|---|---|---|
| RPC Compute Achievements | edge fn `compute-achievements` | HEALTHY (Mondays) |
| RPC Badge Sync | `/api/badge-sync` | HEALTHY (Sundays) |
| RPC Weekly Digest | `/api/send-digest` | HEALTHY (Mondays) |
| RPC Weekly Support Report | `/api/support-report` | HEALTHY (Mondays) |

## Chained pipelines (no cron-job.org entry needed)

These do NOT have their own cron entries. They fire as side effects of other pipelines.

| Pipeline | Triggered by | Notes |
|---|---|---|
| `/api/wallet-backfill` (TopShot) | `RPC Seed Wallet Refresh` (every 6h) | All 5 wallet-backfill children fan out from the orchestrator. Confirmed by all 5 starting within ~3s of each other every 6h. |
| `/api/wallet-backfill-allday` | `RPC Seed Wallet Refresh` | Also fires from chains downstream of `allday-sales-indexer` → `allday-unmapped-resolver` (per-wallet bursts). |
| `/api/wallet-backfill-pinnacle` | `RPC Seed Wallet Refresh` | Also fires from chains downstream of `pinnacle-sales-indexer` → `pinnacle-nft-resolver`. |
| `/api/wallet-backfill-golazos` | `RPC Seed Wallet Refresh` | |
| `/api/wallet-backfill-ufc` | `RPC Seed Wallet Refresh` | |
| `/api/sales-indexer` | `/api/pipeline-trigger` (TopShot) | |
| `/api/fmv-recalc` | sales-indexers (TopShot, AllDay, Golazos) | |
| `/api/listing-cache?collection=…` | `/api/fmv-recalc` + self-chain across collections | |
| `/api/pinnacle/resolve-buyers` | `/api/pinnacle-sales-indexer` (since 2026-05-08) | If a cron entry still exists for this URL, it can be deleted. The chain fires it on every indexer tick. Idempotent + self-batches. |
| `allday-unmapped-resolver` (edge fn) | `/api/allday-sales-indexer` | |
| `promote_unmapped_sales` (RPC) | post-write hook from sales-indexers | |
| `editions-hydrate-at-insert` (DB trigger) | INSERT on editions | DB-side, not cron. |
| `/api/cron/allow-list-reconcile` | GitHub Actions (`.github/workflows/allow-list-reconcile.yml`) hourly | Outside cron-job.org. Workflow file shipped commit 1e8fbbc; first auto-fire pending. Manual trigger via `gh workflow run` works. |

## Open issues

### RPC Pipeline Runs Cleanup — BROKEN

Dashboard shows `Failed (timeout) (30s)` on the last run (last Saturday). Edge function exceeds the 30s ceiling on cron-job.org's free tier. Same root cause as the `wmc-fmv-populate` test failure — needs a chunked NULL-only fast path or per-chunk LIMIT param. Until fixed, `pipeline_runs` table grows unbounded between manual prunes (`/api/admin/prune-pipeline-runs` daily covers most of the cleanup, but the edge function does additional cleanup that's now stalled).

### RPC All Day FMV Populate — HEALTHY-but-stuck

The route fires every 20 min and returns 200, but the underlying `allday-fmv-populate` Supabase function has been stuck on cursor `7a7fc7e5-6b06-495b-aa85-512ec7cd8557, 2026-03-23T04:33:17` since deployment. Stall-detection + reset shipped 2026-05-09 (commit 62db96f). Cursor now resets. Upstream blocker: `ALLDAY_PROXY_URL` env var on Vercel needs to point at the AllDay GQL worker (currently misconfigured, returning 403). After env fix, this should drain.

### ingest-external-announcements

Last `pipeline_runs` row 2026-05-07 13:00 UTC (~40h silent). No matching dashboard entry visible in the screenshots. Either:
- Cron entry exists but is in a folder/view I didn't see — verify in dashboard.
- Cron entry was deleted; needs recreating with same daily cadence.

If recreating: same pattern as Snapshot Institutional Wallets — `/api/ingest-external-announcements`, daily, Bearer auth, 30s timeout.

### Cron entries claimed by old MD that don't exist

These were in v1 of CRON_SCHEDULE.md but aren't in the dashboard. Either they never had crons (claims were aspirational), or the crons were deleted, or they're in a folder/view not captured. Worth confirming:

- `/api/sync-nba-games` — varies, off-season; pipeline_runs shows ~70h silent
- `/api/sync-nba-odds` — claimed hourly 22:00–06:00 UTC; pipeline_runs shows 8h silent (could be normal for current time-of-day)
- `/api/match-topshot-players` — claimed daily; **NBA Player Name Matcher edge fn** likely does this work instead
- `/api/resolve-topshot-username` — claimed weekly; `pipeline_runs` shows 53h silent (within weekly tolerance)
- `/api/weekly-db-maintenance` — claimed weekly; `pipeline_runs` shows 158 min ago, so it IS firing — just not visible in screenshots
- `/api/ingest-external-announcements` — see above

## Audit query

```sql
SELECT pipeline, MAX(started_at) AS last_run,
       COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days') AS runs_7d,
       COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '24 hours') AS runs_24h,
       CASE WHEN MAX(started_at) < NOW() - INTERVAL '6 hours'
              AND COUNT(*) FILTER (WHERE started_at BETWEEN NOW() - INTERVAL '7 days'
                                                         AND NOW() - INTERVAL '24 hours') > 20
            THEN 'SUSPECTED_SILENT_DEATH' ELSE 'ok' END AS status
FROM pipeline_runs GROUP BY pipeline
HAVING COUNT(*) FILTER (WHERE started_at > NOW() - INTERVAL '7 days') > 0
ORDER BY status DESC, last_run ASC;
```

This catches anything firing >20 times/week that's gone silent. Daily-or-rarer jobs need the `pipeline_cadence_watchlist` to detect silence.

## Maintenance

When you add a new cron-job.org schedule:
1. Add a row to the appropriate cadence section above.
2. Add a row to `pipeline_cadence_watchlist` with `max_silent_minutes` set to ~3× the cadence.
3. Confirm the route writes to `pipeline_runs` via `log_pipeline_run`. If it doesn't, mark UNKNOWN here and rely on dashboard observation.

When you remove a cron-job.org schedule:
1. Remove or update the row here.
2. Either remove the row from `pipeline_cadence_watchlist`, or set `is_active=false` with a note.

When the dashboard and this file disagree:
1. The dashboard wins.
2. Fix this file.
3. If the dashboard entry is unfamiliar to you, search the codebase for the route name before deleting — it may be intentional and undocumented.