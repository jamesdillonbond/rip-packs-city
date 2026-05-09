# CRON_SCHEDULE.md — cron-job.org dependency inventory

Authoritative-ish list of every cron-job.org schedule the production stack depends on. Created 2026-05-08 after two pipelines silently died on cron-job.org without the rest of the platform noticing (`pinnacle-resolve-buyers` 18h silence, `snapshot-institutional-wallets` 45h silence). Snapshot of state at audit time so the next silent failure has something to diff against.

**This file is descriptive, not authoritative.** The truth lives in the cron-job.org dashboard. When this file disagrees with the dashboard, fix this file.

Statuses:
- **HEALTHY** — observed running on schedule in `pipeline_runs`.
- **BROKEN** — was firing, has stopped, needs Trevor to recreate the cron-job.org job.
- **CHAINED** — no longer needs a top-level cron; fires from another pipeline. Original cron-job.org entry (if any) can be deleted.
- **UNKNOWN** — route exists, cadence unconfirmed in `pipeline_runs` (route may not call `log_pipeline_run`, or cron-job.org entry may be missing).

## Top-level cron-job.org schedules

All requests authenticate via `Authorization: Bearer ${INGEST_SECRET_TOKEN}` (some routes also accept `?token=...` query string for browser-fired triggers). Base URL: `https://www.rippackscity.com`.

### Sales indexers (every 20 min)

| Route | Cadence | Status | Notes |
|---|---|---|---|
| `/api/ingest` | `*/20` | HEALTHY | TopShot ingest. Chains → `/api/sales-indexer` → `/api/fmv-recalc` → `/api/listing-cache`. |
| `/api/allday-sales-indexer` | `*/20` | HEALTHY | Chains → `allday-unmapped-resolver` (Supabase edge fn) + `/api/fmv-recalc`. |
| `/api/golazos-sales-indexer` | `*/20` | HEALTHY | Chains → `/api/fmv-recalc`. |
| `/api/pinnacle-sales-indexer` | `*/20` (assumed) | UNKNOWN-but-firing | Cursor `event_cursor.pinnacle_sales` advances on schedule, but route doesn't call `log_pipeline_run` so it doesn't appear in `pipeline_runs`. As of 2026-05-08 also chains → `/api/pinnacle/resolve-buyers`. |
| `/api/ufc-sales-indexer` | `*/20` | HEALTHY | |

### Listing caches (every 20 min)

These have their own cron entries and also chain together (`fireNextPipelineStep("/api/listing-cache?collection=…")`). The chain handles the multi-collection sweep within one tick; the cron is the entry point.

| Route | Cadence | Status |
|---|---|---|
| `/api/listing-cache` (TopShot, AllDay, Golazos, UFC, Pinnacle variants) | `*/20` | HEALTHY |

### Pipeline + alert orchestrators

| Route | Cadence | Status | Notes |
|---|---|---|---|
| `/api/check-alerts` | `*/20` | HEALTHY | Calls `get_pipeline_alerts()` → fires Telegram + email on critical/high. 60-min debounce. |
| `/api/admin/prune-pipeline-runs` | daily | HEALTHY | Keeps `pipeline_runs` ~9.5K rows. Bearer `INGEST_SECRET_TOKEN`. |
| `/api/seed-wallet-refresh` | every 6h | HEALTHY | Orchestrator. Drives the wallet-backfill family. |
| `/api/wmc-fmv-populate` | `*/20` | NEW (2026-05-08) | Multi-collection sweep. NULL-only chunked path — each tick processes up to `?limit=50000` (default) wmc rows where `fmv_usd IS NULL` per collection, looking up the latest `fmv_snapshots` row per `(edition_key, collection_id)` via the `fmv_snapshots_*_edition_id_computed_at_idx` index. With ~1.09M NULL rows in TopShot at launch, the backlog drains over several ticks and then settles into steady state. `?force=true` runs the full sweep (heavy, only for ad-hoc remediation). Logs one `pipeline_runs` row per collection (pipeline=`wmc-fmv-populate`). Pinnacle is included but is a no-op until pinnacle FMV ingestion ships. |

### Wallet backfills (6-hour waves)

Each fires at 00 / 06 / 12 / 18 UTC. Watchlist alerts at 7h grace.

| Route | Cadence | Status |
|---|---|---|
| `/api/wallet-backfill` (TopShot) | every 6h | HEALTHY |
| `/api/wallet-backfill-allday` | every 6h | HEALTHY |
| `/api/wallet-backfill-golazos` | every 6h | HEALTHY |
| `/api/wallet-backfill-pinnacle` | every 6h | HEALTHY |
| `/api/wallet-backfill-ufc` | every 6h | HEALTHY |

### Sports / odds

| Route | Cadence | Status |
|---|---|---|
| `/api/sync-nba-games` | varies (off-season) | HEALTHY-low |
| `/api/sync-nba-odds` | hourly during 22:00–06:00 UTC | HEALTHY-low |
| `/api/sync-nba-projections` | every ~5h | HEALTHY |

### Long-cadence misc

| Route | Cadence | Status | Notes |
|---|---|---|---|
| `/api/match-topshot-players` | low (~daily) | HEALTHY |
| `/api/resolve-topshot-username` | low (~weekly) | HEALTHY |
| `/api/weekly-db-maintenance` | weekly | HEALTHY |
| `/api/ingest-external-announcements` | low (~daily) | HEALTHY |
| `/api/cron/snapshot-institutional-wallets` | **daily 06:00 UTC** | **BROKEN** | Silent for 45h as of 2026-05-08. Trevor needs to recreate the cron-job.org job — see "Recreate" block below. |

### Supabase edge functions on cron-job.org

These hit `https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/<name>` with `Authorization: Bearer ${INGEST_SECRET_TOKEN}`. `verify_jwt` is `false` on each.

| Function | Cadence | Status |
|---|---|---|
| `compute-topshot-pack-ev` | every 4h | HEALTHY (v14 deployed 2026-05-08, 00:23 UTC tick will validate post-deploy) |
| `compute-allday-pack-ev` | every 4h | HEALTHY |
| `pinnacle-owner-discovery` | varying | HEALTHY |
| `pinnacle-owner-discovery-forward` | every ~30min | HEALTHY |
| `pinnacle-nft-resolver` | every ~30min | HEALTHY |
| `hybrid-custody-events` | hourly (was `*/20`) | HEALTHY |

## Chained pipelines (no cron-job.org needed)

These do NOT need their own cron-job.org entries. They fire as side effects of other pipelines.

| Route | Triggered by | Notes |
|---|---|---|
| `/api/sales-indexer` | `/api/ingest` | TopShot scan. |
| `/api/fmv-recalc` | sales-indexers (TopShot, AllDay, Golazos) | |
| `/api/listing-cache?collection=…` | `/api/fmv-recalc` + self-chain across collections | |
| `/api/pinnacle/resolve-buyers` | `/api/pinnacle-sales-indexer` (added 2026-05-08, commit pending) | **CHAINED** — cron-job.org entry for this URL can be deleted; the chain unconditionally fires every indexer tick. Resolver has internal batch limit (`BATCH_LIMIT=50`) and idempotency, so empty drains are no-ops. |
| `allday-unmapped-resolver` (Supabase edge fn) | `/api/allday-sales-indexer` | |
| `promote_unmapped_sales` (RPC) | post-write hook from sales-indexers | |
| `editions-hydrate-at-insert` (DB trigger) | INSERT on editions | Not a cron — DB-side. |

## What Trevor needs to recreate at cron-job.org

### snapshot-institutional-wallets (BROKEN since 2026-05-07 ~01:30 UTC)

```
URL:      https://www.rippackscity.com/api/cron/snapshot-institutional-wallets
Method:   GET (or POST — route accepts both)
Schedule: daily at 06:00 UTC
Headers:  Authorization: Bearer <INGEST_SECRET_TOKEN>
Timeout:  30s
```

Cadence watchlist already covers this — alerts at 30h silence. If the new cron entry succeeds, the alert clears automatically. If it fails or is misconfigured, Telegram fires within ~30h.

### pinnacle-resolve-buyers (formerly broken — now CHAINED)

If a cron-job.org entry still exists for `/api/pinnacle/resolve-buyers`, it can be deleted. The new chain from `/api/pinnacle-sales-indexer` (commit 2026-05-08) fires it on every indexer tick. The resolver is idempotent and self-batches, so leaving the cron entry as belt-and-suspenders is safe but unnecessary.

## SUSPECTED_SILENT_DEATH from 2026-05-08 audit

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

| Pipeline | Last run | Runs 7d | Runs 24h | Status |
|---|---|---|---|---|
| `pinnacle-resolve-buyers` | 2026-05-08 05:04 UTC | 122 | 30 | SUSPECTED_SILENT_DEATH — **CHAINED, fixed pending merge** |

`snapshot-institutional-wallets` was NOT flagged by this audit because its 1-run-per-day cadence falls below the historical-volume threshold (`> 20 runs in days 1–6 of the 7d window`). Daily-or-rarer jobs need the cadence watchlist to detect silence — which it now does (entry added 2026-05-08, alerts at 30h grace).

## Maintenance

When you add a new cron-job.org schedule:
1. Add a row to the appropriate table above.
2. Add a row to `pipeline_cadence_watchlist` with `max_silent_minutes` set to ~3× the cadence (gives 3 missed runs of grace).
3. Confirm the pipeline writes to `pipeline_runs` via `log_pipeline_run` so the audit query catches it.

When you remove a cron-job.org schedule:
1. Remove the row from this file.
2. Either remove the row from `pipeline_cadence_watchlist`, or set `is_active=false` with a note.
