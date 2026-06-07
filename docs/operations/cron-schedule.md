# Rip Packs City — Cron Schedule Reference

**Last verified:** June 7, 2026 ~16:45 PT — read directly from the live cron-job.org dashboard (all 69 entries) after the full stagger pass, plus the GHA workflow changes (`306a7ed`, `c9b6a04`). This file was previously stale in both directions; if it disagrees with the dashboard again, the dashboard wins — update this file, never trust it blind.
**Platform:** cron-job.org (free tier, 30s hard client timeout) + GitHub Actions + 3 worker-target entries.

## Scheduling rules (post-stagger)

The 2026-06-07 stagger pass eliminated the :00/:20/:40 anchor pile-up (was ~15 jobs at :00 → connection-pool saturation, the I1 failure class). Rules going forward:

- NO new job on minutes 0, 1, 20, 21, 40, 41 (the rush class) or stacked on 06:00 UTC.
- cron-job.org rejects range-step syntax (`1-59/6`) in the grids — the crontab field accepts `*/N`; use explicit comma lists otherwise.
- Aim for ≤2-3 light jobs per minute. Current per-minute load is mapped below — pick an empty trio for anything new.
- Routes that can run >30s MUST return 202 + `after()` (cron-job.org marks >30s as failed and can auto-disable persistently-failing jobs — the silent-kill class).
- Console automation: stay on each job's COMMON tab only (Advanced holds auth secrets). See the cron memory for the working edit recipe.

## Active cron-job.org entries — Vercel routes (https://www.rippackscity.com/api/*)

All Bearer-auth in headers (the 2026-06-07 hygiene pass removed all `?token=` URLs).

| Title | Path | Schedule (minute anchors are timezone-invariant) |
|---|---|---|
| RPC All Day FMV Populate | /api/allday-fmv-populate | 2,22,42 |
| RPC All Day Listing Cache | /api/allday-listing-cache | 14,34,54 |
| RPC AllDay Listings Indexer | /api/allday-listings-indexer | 2,17,32,47 |
| RPC AllDay Listings Retry | /api/allday-listings-retry | 8,23,38,53 |
| RPC All Day Offers Indexer | /api/allday-offers-indexer | 7,27,47 |
| RPC All Day Pack Listings | /api/allday-pack-listings | 10,30,50 |
| RPC All Day Sales Indexer | /api/allday-sales-indexer | 16,36,56 |
| RPC Analytics Smoke ⚠ | /api/admin/analytics-smoke | 13,43 — FAILING (route >30s; 202-wrap pending, CC) |
| RPC Apply FMV Haircut | /api/admin/apply-fmv-haircut?mode=live | daily 06:30 UTC |
| RPC Backfill Pack Rip Metadata | /api/cron/backfill-pack-rip-metadata | hourly :53 |
| RPC Cadence Payer Balance Check | /api/cron/cadence-payer-balance-check | INACTIVE (paused by design, payer wallet empty) |
| RPC Check Alerts | /api/check-alerts | 15,35,55 |
| RPC Classify Acquisitions Multi-Collection | /api/cron/classify-acquisitions-multicollection | hourly :06 |
| RPC Compute Laliga Pack EV | /api/cron/compute-laliga-pack-ev | daily 05:00 UTC |
| RPC Daily Portfolio Snapshot | /api/cron/daily-portfolio-snapshot | daily 07:05 UTC |
| RPC Drain FMV Cold Tail | /api/admin/drain-fmv-cold-tail?collection=all&limit=200 | 17,47 |
| RPC EVM Transfers Ingest | /api/cron/evm-transfers-ingest | hourly :19 |
| RPC FMV Recalc Force Stale | /api/fmv-recalc?force_stale=true | 8,28,48 |
| RPC Golazos Listing Cache | /api/golazos-listing-cache | 6,26,46 |
| RPC Golazos Listings Indexer | /api/golazos-listings-indexer | 7,22,37,52 |
| RPC Golazos Sales Indexer | /api/golazos-sales-indexer | 11,31,51 |
| RPC League Drift Detection | /api/admin/cron/detect-league-drift | weekly Sun 14:00 UTC |
| RPC Lock Check Batch ⚠ | /api/cron/lock-check-batch | 8,38 — runs 17-33s, brushes the 30s cap (202-wrap pending, CC) |
| RPC Offers Sweep | /api/cron/offers-sweep | 2,22,42 |
| RPC Pack Pull Source Rip ID Backfill | /api/cron/backfill-pack-pull-source-rip-id | 11,41 |
| RPC Pinnacle Catalog Backfill | /api/admin/backfill-pinnacle-catalog | daily 09:37 UTC |
| RPC Pinnacle Events Ingest | /api/cron/pinnacle-events-ingest | 4,19,34,49 |
| RPC Pinnacle Listing Cache | /api/pinnacle-listing-cache | 17,37,57 |
| RPC Pinnacle Listings Indexer | /api/pinnacle-listings-indexer | 5,25,45 |
| RPC Pinnacle Listings Reconcile | /api/cron/pinnacle-listings-reconcile | 9,24,39,54 |
| RPC Pinnacle Listings Retry | /api/pinnacle-listings-retry | 3,18,33,48 |
| RPC Pinnacle Metadata Backfill | /api/cron/pinnacle-metadata-backfill | hourly :22 |
| RPC Pinnacle Sales Indexer | /api/pinnacle-sales-indexer | 4,24,44 |
| RPC Pinnacle Sync | /api/cron/pinnacle-sync | daily 10:07 UTC |
| RPC Populate Pinnacle WMC FMV | /api/cron/populate-pinnacle-wmc-fmv | hourly :03 |
| RPC Prune Log Tables | /api/cron/prune-logs | daily 04:23 UTC |
| RPC Prune Pipeline Runs (daily) | /api/admin/prune-pipeline-runs | daily 06:00 UTC |
| RPC Recalc Ultimate FMV | /api/admin/recalc-ultimate-fmv | daily 06:35 UTC |
| RPC Refresh Error Triage | /api/admin/cron/refresh-error-triage | 14,44 |
| RPC Refresh Pack Grail Metrics MV | /api/cron/refresh-pack-grail-metrics-mv | hourly :23 |
| RPC Resolve Topshot Stubs | /api/cron/resolve-topshot-stubs | 9,39 |
| RPC Run Insider Detectors | /api/cron/run-insider-detectors | hourly :26 |
| RPC Seed Wallet Refresh | /api/seed-wallet-refresh | 45 */6 UTC (00:45/06:45/12:45/18:45 — the 6-hourly fan-out, finally off HH:00) |
| RPC Snapshot Institutional Wallets | /api/cron/snapshot-institutional-wallets | daily 06:37 UTC |
| RPC TopShot FMV Populate | /api/topshot-fmv-populate | 50 0,6,12,18 UTC |
| RPC Top Shot Offers Indexer | /api/topshot-offers-indexer | 12,32,52 |
| RPC TopShot Sales Indexer | /api/sales-indexer | 3,23,43 |
| RPC UFC Listings Indexer | /api/ufc-listings-indexer | 12,27,42,57 |
| RPC UFC Strike Pipeline | /api/ufc-pipeline | 18,38,58 |
| RPC wmc Render-id Remap | /api/cron/pinnacle-wmc-render-id | hourly :37 |
| RPC wmc-fmv-populate | /api/wmc-fmv-populate?limit=5000 | 3,8,13,18,23,28,33,38,43,48,53,58 |
| RPC Weekly Digest | /api/send-digest | weekly Mon 16:00 UTC |
| RPC Weekly Support Report | /api/support-report?days=7&format=html | weekly Mon 14:00 UTC |

## Active cron-job.org entries — Supabase edge functions

| Title | Function | Schedule |
|---|---|---|
| RPC Compute Achievements | compute-achievements | weekly Mon 15:00 UTC |
| RPC Compute AllDay Pack EV | compute-allday-pack-ev | 7,37 |
| RPC Compute Topshot Pack EV | compute-topshot-pack-ev | 1,7,13,19,25,31,37,43,49,55 (10/hr × batch 4 — the throughput design; do NOT change batch) |
| RPC Hybrid Custody Events | hybrid-custody-events | 13,33,53 |
| RPC NBA Player Name Matcher | match-topshot-players | daily 08:00 UTC |
| RPC NBA Projections Sync | sync-nba-projections | 07 every 3h |
| RPC Pinnacle NFT Resolver | pinnacle-nft-resolver | 6,11,16,21,26,31,36,41,46,51,56 |
| RPC Pinnacle Owner Discovery Forward | pinnacle-owner-discovery-forward | 27,57 |
| RPC Pipeline Failure Alerts | pipeline-failure-alerts | 16,46 |
| RPC Pipeline Runs Cleanup ⚠ | rest/v1/rpc/run_weekly_db_maintenance | weekly Sat 8 PM PT — fn FIXED 2026-06-07 (wallet-scoped wmc delete; was timing out every run); WATCH next Saturday: if it still fails, the job's stored apikey is anon (fn is service_role-only) → fold the call into /api/cron/prune-logs (CC) and delete this entry |
| RPC Seed Topshot Pack Distribution | seed-topshot-pack-distributions | 13 every 4h |
| RPC UFC Stub Thumbnail Resolver | ufc-stub-thumbnail-resolver | 12,42 |

## Active cron-job.org entries — workers

| Title | Target | Schedule |
|---|---|---|
| RPC Pack Events Ingest TopShot | pack-events-ingest.tdillonbond.workers.dev/ | 9,24,39,54 |
| RPC Pack Events Ingest Backfill TopShot | pack-events-ingest.tdillonbond.workers.dev/backfill | 1,16,31,46 |
| RPC Topshot Moments Hydrator | topshot-moments-hydrator.tdillonbond.workers.dev/ | 2,12,22,32,42,52 |

## GitHub Actions schedules (.github/workflows/, staggered `306a7ed` + trimmed `c9b6a04`)

| Workflow | Schedule | Notes |
|---|---|---|
| rpc-pipeline.yml (RPC Data Pipeline) | 5,25,45 | Steps: ingest, fmv-recalc, fmv-backfill, backfill-player-names, topshot-listing-cache (GHA-ONLY trigger — do not remove), backfill, price-snapshots. The 5 cron-job.org-duplicated steps (3 sales indexers + allday/golazos listing caches) and the dead Flowty listing-cache step were removed 2026-06-07. |
| allday-ingest.yml | 10,30,50 | /api/allday-ingest only |
| pinnacle-owner-discovery.yml | 6,26,46 | |
| ops-monitor.yml | 13,43 + daily 06:41 UTC | |
| allow-list-reconcile.yml | hourly :14 | |
| pipeline-sentinel.yml | hourly :34 | red while TS-UUID-48h sentinel >250 (DUPE1 roll-off; expected clear ~2026-06-08) |
| smoke-tests.yml | daily 12:11 UTC + every push | |
| badge-sync.yml | 15 every 6h | |
| alert-checker.yml | DELETED 2026-06-07 | /api/check-alerts is owned by the cron-job.org entry |

## Known issues / watch-list

- ⚠ **RPC Analytics Smoke** — fails every run on the cron 30s cap; route needs the 202+after() pattern + a `pipeline_runs` log (it currently logs nothing). Queued for CC (docs/handoff-2026-06-07-cron-followups.md).
- ⚠ **RPC Lock Check Batch** — succeeds server-side every run (`pipeline_runs` ok=true, 17-20s typical) but spiked 33.5s once on 2026-06-07; same 202-wrap queued so the cron view stops lying.
- ⚠ **RPC Pipeline Runs Cleanup** — see edge-fn table note; fn fixed + manually run 2026-06-07 (purged 5,972 pipeline_runs / 1,300 smoke results / 91 debug logs); verdict on the job's auth comes from next Saturday's run.

## Recently changed (2026-06-07 stagger pass — Cowork via Chrome + Trevor + CC)

Every */20-class job moved off :00/:20/:40 to a unique comma-trio; */15-class to offset quads; hourly singles off :00/:20/:30; seed-wallet fan-out to :45; GHA all staggered + dedup-trimmed. Verified job-by-job against the dashboard's "next execution" column. Earlier same day: FMV Recalc Force Stale dialed back to 8,28,48; wmc-fmv-populate to the +3 five-minute list; Pinnacle NFT Resolver to the +6 list; Snapshot Institutional Wallets to 06:37 UTC; all `?token=` URLs migrated to Bearer headers; AllDay/Golazos pack-distribution entries deleted (already gone).

## Pending additions

_None._
