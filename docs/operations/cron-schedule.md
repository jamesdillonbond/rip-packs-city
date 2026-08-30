# Rip Packs City — Cron Schedule Reference

**Last verified:** July 21, 2026 — cron-job.org read live from the console (**86 entries: 79 active, 7 inactive** after `RPC Pipeline Runs Cleanup` was deleted); pg_cron from `cron.job` (64 active); GHA from `.github/workflows/` (16). Supersedes the 2026-06-07 regen (69 entries / pg_cron 34).
**Platform:** cron-job.org (free tier, 30s hard client timeout) + Supabase edge functions + workers + GitHub Actions + pg_cron.

> **Provenance of schedules:** unchanged jobs carry their exact anchors from the 06-07 dashboard read. Jobs marked **⟨exec-derived⟩** are NEW or MOVED since 06-07 — their anchors are *derived from the live execution times* (last + next) observed on the dashboard on 07-21, not read from the edit grid. They're dashboard-sourced; confirm on the grid if treating as canonical. **If this file disagrees with the dashboard, the dashboard wins — update this file, never trust it blind.**

## Scheduling rules (post-stagger)

The 2026-06-07 stagger pass eliminated the :00/:20/:40 anchor pile-up (was ~15 jobs at :00 → connection-pool saturation, the I1 failure class). Rules going forward:

- NO new job on minutes 0, 1, 20, 21, 40, 41 (the rush class) or stacked on 06:00 UTC.
- cron-job.org rejects range-step syntax (`1-59/6`) in the grids — the crontab field accepts `*/N`; use explicit comma lists otherwise.
- Aim for ≤2-3 light jobs per minute. Current per-minute load is mapped below — pick an empty trio for anything new.
- Routes that can run >30s MUST return 202 + `after()` (cron-job.org marks >30s as failed and can auto-disable persistently-failing jobs — the silent-kill class).
- Console automation: stay on each job's COMMON tab only (Advanced holds auth secrets). See the cron memory for the working edit recipe.

## Active cron-job.org — Vercel routes (https://www.rippackscity.com/api/*)  ·  64 active

All Bearer-auth in headers (the 2026-06-07 hygiene pass removed all `?token=` URLs).

| Title | Path | Schedule |
|---|---|---|
| RPC Analytics Smoke | /api/admin/analytics-smoke | 13,43 — ✅ FIXED (was >30s failing) |
| RPC Apply FMV Haircut | /api/admin/apply-fmv-haircut?mode=live | daily 22:35 UTC — moved from 06:30 on 2026-08-28 (deep-audit R54: the TS leg died on `upstream request timeout` 6 of 8 days inside the degraded band; 22:35 is a measured-free minute in the healthy 20:00–00:00Z window). Falsifier: if the TS leg still times out at 22:35Z, the band was not the cause — split the leg |
| RPC Pinnacle Catalog Backfill | /api/admin/backfill-pinnacle-catalog | daily 09:37 UTC — ⚠ also in vercel.json as `?floors_only=1` (45 1,7,13,19) |
| RPC Backfill TopShot Buyers (TEMP) | /api/admin/backfill-topshot-buyers | 4,34 ⟨exec-derived⟩ — **TEMP; do NOT retire yet (buyer coverage 66.79%, 230k NULL)** |
| RPC Backfill TopShot Buyers Historical | /api/admin/backfill-topshot-buyers?mode=historical | 12,42 ⟨exec-derived⟩ — TEMP sibling |
| RPC TopShot Onchain Art Backfill | /api/admin/backfill-topshot-onchain-art | daily 09:49 UTC ⟨exec-derived⟩ — ⚠ also in vercel.json as `?limit=300` (22 */3) |
| RPC League Drift Detection | /api/admin/cron/detect-league-drift | weekly Sun 14:00 UTC |
| RPC Refresh Error Triage | /api/admin/cron/refresh-error-triage | 14,44 |
| RPC Drain FMV Cold Tail | /api/admin/drain-fmv-cold-tail?collection=all&limit=200 | 17,47 |
| RPC Prune Pipeline Runs (daily) | /api/admin/prune-pipeline-runs | daily 06:00 UTC |
| RPC Recalc Ultimate FMV | /api/admin/recalc-ultimate-fmv | daily 06:35 UTC |
| RPC V1-Dapper Recovery | /api/admin/recover-v1-budget-exhausted | 43 */3 ⟨exec-derived⟩ — was daily `43 5` at 06-07 (moved) |
| RPC All Day Listing Cache | /api/allday-listing-cache | 14,34,54 |
| RPC AllDay Listings Indexer | /api/allday-listings-indexer | 2,17,32,47 |
| RPC AllDay Listings Retry | /api/allday-listings-retry | 8,23,38,53 |
| RPC All Day Offers Indexer | /api/allday-offers-indexer | 7,27,47 |
| RPC All Day Pack Listings | /api/allday-pack-listings | 10,30,50 |
| RPC All Day Sales Indexer | /api/allday-sales-indexer | 16,36,56 |
| RPC Check Alerts | /api/check-alerts | 15,35,55 |
| RPC Alerts Dispatch | /api/cron/alerts-dispatch | 14,29,44,59 ⟨exec-derived⟩ — NEW (alert pipeline split) |
| RPC Alerts Send | /api/cron/alerts-send | 4,14,24,34,44,54 ⟨exec-derived⟩ — NEW |
| RPC Pack Pull Source Rip ID Backfill | /api/cron/backfill-pack-pull-source-rip-id | 11,41 |
| RPC Backfill Pack Rip Metadata | /api/cron/backfill-pack-rip-metadata | hourly :53 |
| RPC Classify Acquisitions Multi-Collection | /api/cron/classify-acquisitions-multicollection | hourly :06 |
| RPC Compute Laliga Pack EV | /api/cron/compute-laliga-pack-ev | daily 05:00 UTC — ⚠ **double-fire** w/ vercel.json (30 5 = 05:30) |
| RPC Daily Portfolio Snapshot | /api/cron/daily-portfolio-snapshot | daily 07:05 UTC |
| RPC EVM Transfers Ingest | /api/cron/evm-transfers-ingest | hourly :19 |
| RPC Lock Check Batch | /api/cron/lock-check-batch | 8,38 — ✅ FIXED (was brushing 30s cap) |
| RPC Offers Sweep | /api/cron/offers-sweep | 2,22,42 | ⚠ dead host (public-api.nbatopshot.com 530 since 08-28); kept ACTIVE behind the upstream circuit breaker (c8ac905). |
| RPC Ownership On-chain Walk | /api/cron/ownership-onchain-walk | daily 13:30 UTC ⟨exec-derived⟩ — NEW |
| RPC Pinnacle Events Ingest | /api/cron/pinnacle-events-ingest | 4,19,34,49 |
| RPC Pinnacle Metadata Backfill | /api/cron/pinnacle-metadata-backfill | hourly :22 |
| RPC Pinnacle Sync | /api/cron/pinnacle-sync | daily 10:07 UTC — ⚠ **double-fire** w/ vercel.json (0 6 = 06:00); backstop kept deliberately (dropout history) |
| RPC wmc Render-id Remap | /api/cron/pinnacle-wmc-render-id | hourly :37 |
| RPC Populate Pinnacle WMC FMV | /api/cron/populate-pinnacle-wmc-fmv | hourly :03  ⚠ 2026-08-30: the RPC returns early (`catalog_unchanged`) unless `pinnacle_catalog.fmv_computed_at` moved past its watermark (migration 20260830153801); the ~4 working ticks after a catalog recompute need > the route's 125 s under daytime IO — `cron_heavy` now has EXECUTE (20260830154447) → ✅ 2026-08-30 16:17Z MOVED: pg_cron jobid 408 `rpc-populate-pinnacle-wmc-fmv` (cron_heavy, `9 * * * *`, wrapper `run_populate_pinnacle_wmc_fmv_job` writes the same terminal row + catches cancels; migration 20260830161744). **This cron-job.org entry is INACTIVE since 16:4xZ (console)** — jobid 408 is the only scheduler now; the route stays deployed as the manual/revert path. |
| RPC Prune Log Tables | /api/cron/prune-logs | daily 04:23 UTC |
| RPC Refresh Conflated Editions | /api/cron/refresh-conflated-editions | daily 15:17 UTC ⟨exec-derived⟩ — NEW |
| RPC Refresh Pack Grail Metrics MV | /api/cron/refresh-pack-grail-metrics-mv | ~~hourly :23~~ **INACTIVE 2026-08-29** — refresh moved to pg_cron jobid 384 `rpc-refresh-pack-grail-metrics-mv` (`cron_heavy`, `23 * * * *`, migration 20260829235752): the 60 s lambda killed 13 of 24 ticks while the DB refresh committed. Route stays deployed as the revert (re-enable entry 7619844). |
| RPC Resolve Topshot Stubs | /api/cron/resolve-topshot-stubs | 9,39 |
| RPC Resolve Wallet Usernames | /api/cron/resolve-wallet-usernames | 8,38 ⟨exec-derived⟩ — NEW |
| RPC Run Insider Detectors | /api/cron/run-insider-detectors | hourly :26 |
| RPC Snapshot Institutional Wallets | /api/cron/snapshot-institutional-wallets | daily 10:07 UTC ⟨exec-derived⟩ — moved from 06:37 |
| RPC Pack Sniper Ask Snapshot | /api/cron/snapshot-pack-asks | 3,8,13,…,58 (every 5m) ⟨exec-derived⟩ — NEW |
| RPC TopShot ownership sync (Dune) | /api/cron/sync-topshot-ownership-dune | weekly Mon ~11:40 UTC ⟨exec-derived⟩ — NEW |
| RPC TopShot Deal Floor Serials | /api/cron/topshot-deal-floor-serials | ~~hourly :37~~ **INACTIVE 2026-08-30 16:4xZ** — dead host public-api.nbatopshot.com (530/1033 since 08-28); every tick resolved 0 of 10 editions on 10 fetch errors. Disabled in the console (Common tab → Enable job off); re-enable there when the host returns. The `topshot-deal-floor-serials` alert suppression (20260830155543) can then be dropped. |
| RPC UFC Enrichment Drain | /api/cron/ufc-enrichment-drain | 7,37 |
| RPC FMV Recalc Force Stale | /api/fmv-recalc?force_stale=true | 8,28,48 |
| RPC Golazos Listing Cache | /api/golazos-listing-cache | 6,26,46 |
| RPC Golazos Listings Indexer | /api/golazos-listings-indexer | 7,22,37,52 |
| RPC Golazos Sales Indexer | /api/golazos-sales-indexer | 11,31,51 |
| RPC Pinnacle Listings Indexer | /api/pinnacle-listings-indexer | 5,25,45 |
| RPC Pinnacle Listings Retry | /api/pinnacle-listings-retry | 3,18,33,48 |
| RPC Pinnacle Sales Indexer | /api/pinnacle-sales-indexer | 4,24,44 |
| RPC TopShot Sales Indexer | /api/sales-indexer | 3,23,43 |
| RPC Seed Wallet Refresh cohort 0/4 | /api/seed-wallet-refresh?cohort=0&of=4 | 45 0,6,12,18 UTC (12h in-route gate) |
| RPC Seed Wallet Refresh cohort 1/4 | /api/seed-wallet-refresh?cohort=1&of=4 | 59 0,6,12,18 UTC |
| RPC Seed Wallet Refresh cohort 2/4 | /api/seed-wallet-refresh?cohort=2&of=4 | 13 1,7,13,19 UTC |
| RPC Seed Wallet Refresh cohort 3/4 | /api/seed-wallet-refresh?cohort=3&of=4 | 27 1,7,13,19 UTC |
| RPC TopShot FMV Populate | /api/topshot-fmv-populate | 50 0,6,12,18 UTC | **INACTIVE 2026-08-30** — dead host public-api.nbatopshot.com (530/1033 since 08-28), 0 rows in 24 h; paused by Trevor's ask, not retired. Re-enable when the host answers non-5xx twice (migration 20260830034312 header).
| RPC Top Shot Offers Indexer | /api/topshot-offers-indexer | 12,32,52 |
| RPC wmc-fmv-populate | /api/wmc-fmv-populate?limit=5000 | 3,8,13,…,58 (every 5m) |
| RPC Smoke Concierge Daily | /api/smoke-test?concierge=1 | daily 09:08 UTC ⟨exec-derived⟩ — NEW (~17s runtime; concierge API cost) |
| RPC Weekly Digest | /api/send-digest | weekly Mon 16:00 UTC |
| RPC Weekly Support Report | /api/support-report?days=7&format=html | weekly Mon 14:00 UTC |

> **⚠ 2026-08-30: forced (backstop, `?force=1`) waves now skip any wallet walked within `SEED_REFRESH_BACKSTOP_FRESH_HOURS` (default 3 h) by its per-collection stamp.** The GHA backstop drifts hours late and landed at 13:58Z on top of the finished 12/13Z primary wave, re-dispatching 120 wallets; with the gate it dispatches only what a dead cohort left stale. `complete` rows carry `backstop_fresh_skipped`.

> **⚠ Seed-wallet-refresh EFFECTIVE cadence is 12h, not 6h (2026-07-18 Phase 2 cost lever).** The 4 cohort entries above still FIRE 4×/day, but `/api/seed-wallet-refresh` carries a gate that executes only the `hour % 12 < 2` waves (hours 0/1 and 12/13) and no-ops the 6/7 and 18/19 waves in <1s. Rationale: the wallet-backfill fan-out was both the #1 Vercel Fluid driver and the #1 DB-IOPS driver; halving it at ~2× wallet staleness. It lives in code (not the console) so it is revertible with `git revert`. **To make it permanent and remove the drift:** set the entries to `45 */12`, `59 */12`, `13 1,13`, `27 1,13` and delete the gate from the route. **To disable the gate without a deploy:** set `SEED_WALLET_REFRESH_EVERY_WAVE=1` in Vercel.

## Active cron-job.org — Supabase edge functions  ·  12 active

| Title | Function | Schedule |
|---|---|---|
| RPC AllDay Listing Serial Backfill | backfill-allday-listing-serials | 34 */3 ⟨exec-derived⟩ — NEW |
| RPC Compute Achievements | compute-achievements | weekly Mon 15:00 UTC |
| RPC Compute AllDay Pack EV | compute-allday-pack-ev | 7,37 |
| RPC Compute Topshot Pack EV | compute-topshot-pack-ev | 1,7,13,…,55 (10/hr × batch 4 — the throughput design; do NOT change batch) | **INACTIVE 2026-08-30** — dead host public-api.nbatopshot.com (530/1033 since 08-28), 0 rows in 24 h; paused by Trevor's ask, not retired. Re-enable when the host answers non-5xx twice (migration 20260830034312 header).
| RPC Hybrid Custody Events | hybrid-custody-events | 13,33,53 |
| RPC NBA Player Name Matcher | match-topshot-players | daily 08:00 UTC |
| RPC NBA Projections Sync | sync-nba-projections | 07 every 3h |
| RPC Pinnacle NFT Resolver | pinnacle-nft-resolver | 6,11,16,…,56 |
| RPC Pinnacle Owner Discovery Forward | pinnacle-owner-discovery-forward | 27,57 |
| RPC Pipeline Failure Alerts | pipeline-failure-alerts | 16,46 |
| RPC Seed Topshot Pack Distribution | seed-topshot-pack-distributions | 13 every 4h |
| RPC UFC Stub Thumbnail Resolver | ufc-stub-thumbnail-resolver | 12,42 |

## Active cron-job.org — workers  ·  3 active

| Title | Target | Schedule |
|---|---|---|
| RPC Pack Events Ingest TopShot | pack-events-ingest.tdillonbond.workers.dev/ | 9,24,39,54 |
| RPC Pack Events Ingest Backfill TopShot | pack-events-ingest.tdillonbond.workers.dev/backfill | 1,16,31,46 |
| RPC Topshot Moments Hydrator | topshot-moments-hydrator.tdillonbond.workers.dev/ | 2,12,22,32,42,52 | **INACTIVE 2026-08-30** — dead host public-api.nbatopshot.com (530/1033 since 08-28), 0 rows in 24 h; paused by Trevor's ask, not retired. Re-enable when the host answers non-5xx twice (migration 20260830034312 header).

## Inactive cron-job.org entries  ·  7 (intentionally off)

Backfill Offer-Fill Sales · All Day FMV Populate · Cadence Payer Balance Check (payer wallet empty by design) · Pinnacle Listings Reconcile (⚠ newly inactive since 06-07 — confirm intended) · Refresh Special Serial Owners MV · UFC Listings Indexer · UFC Strike Pipeline.

(`RPC Pipeline Runs Cleanup` was **deleted 2026-07-21** — its work was never dark; `run_weekly_db_maintenance()` is a wrapper around `run_weekly_log_purges()`, which runs on pg_cron jobid 198 `rpc-weekly-log-purges` daily **11:46 UTC** (moved off 09:54Z on 2026-08-30 — that hour carried 191 startup timeouts in 7 days; migration 20260830000048). A `pipeline_cadence_watchlist` row (`weekly-db-maintenance`) now monitors it — `audit_20260721_watchlist_weekly_db_maintenance`. This closes the long-open 🔴 "Pipeline Runs Cleanup failing every weekly run" item from the 2026-07-11 audit.)

## pg_cron  ·  64 active (authoritative: `cron.job`; health: `check_pgcron_recent_failures()`)

Grew 34 → 64 since 06-07. Highest-frequency: `pinnacle-mints-backfill` (2m), `allday/topshot-pack-sales-backfill` (3m), `allday-dist-opened-backfill` (4m), `backfill-pack-pool` (5m), `refresh-mv-pack-ev-latest` (10m). Weekly FMV compute cluster (7 jobs) Sun 11:00–12:00 UTC. Full functional grouping in `claude/scheduler-map-2026-07-20.md`.

**`cron_heavy` maintenance jobs (2026-08-29/30).** `cron_heavy` carries `statement_timeout=600s` and MAINTAIN on `sales_2026`, `fmv_snapshots_2026`, `wallet_moments_cache`; `postgres` inherits the cluster 120 s and never finished a VACUUM (jobid 380, 0 completions). Jobs are keyed on (jobname, username): unschedule with `SET ROLE cron_heavy` first.

| Job | jobid | Schedule | Command | Notes |
|---|---|---|---|---|
| maint-vacuum-sales-hot-partition | 383 | `53 10,20 * * *` | `VACUUM (ANALYZE) public.sales_2026` | Re-own of 380 (20260829235254). |
| rpc-refresh-candy-treasury-wallet | 404 | `39 * * * *` | `refresh_candy_treasury_wallet()` (as `postgres`) | 20260830135550: the `candy_treasury_wallet` view now reads `candy_treasury_wallet_cache` (security_invoker) instead of recomputing per request (−94 % buffers on the candy boards). Revert: `SELECT cron.unschedule('rpc-refresh-candy-treasury-wallet');` and restore the prior view body from the migration header. |
| rpc-allday-nem-from-sales-backfill | 215 | `37 3,7,11,15,19,23 * * *` (was hourly; `*/30` before 08-17) | `backfill_nft_edition_map_from_sales(allday, 5000); promote_unmapped_sales(allday, 1000)` as `cron_heavy` | 20260830151821: 227 s/run probing 80k unresolved nft_ids against every sales partition for 1–30 historical mappings an hour (0 of the last 24 h's AllDay sales came via promotion). Re-measure inserts/day before any further cut; revert = same block with `37 * * * *`. |
| rpc-populate-pinnacle-wmc-fmv | 408 | `9 * * * *` | `run_populate_pinnacle_wmc_fmv_job()` as `cron_heavy` | 20260830161744: the hourly Pinnacle wallet-FMV sync now runs here (600 s budget, no PostgREST gateway); wrapper writes the route's exact `populate-pinnacle-wmc-fmv` terminal row and catches cancels. The cron-job.org :03 entry was disabled in the console at 16:4xZ; the route stays deployed as the manual/revert path. |
| tmp-reindex-wmc-budget-open / -close | 409 / 410 | one-off 08-31 `0 2` / `3 4` (as `postgres`) | `ALTER ROLE cron_heavy SET statement_timeout = 1800s` / back to `600s` + self-unschedule | 20260830164048: the budget window for the wave below. If `-close` ever fails, restore `600s` by hand (NEVER RESET — that drops cron_heavy to the cluster 120 s). |
| tmp-reindex-wmc-2 / -3 / -4 / -verify | 411–414 | one-off 08-31 `3 2`, `43 2`, `23 3`, `6 4` | `REINDEX INDEX CONCURRENTLY` idx_wmc_coll_ek_serial_cover / idx_wmc_moment_collection_cover / wallet_moments_cache_wallet_collection_moment_key; then `run_wmc_reindex_verify()` + self-unschedule | 20260830164048: second wave in the quietest hours (02–03Z = 519–596 cron-s/h vs >3× at 08Z) with 40-min stagger. Verify writes `pipeline_runs` `wmc-reindex-verify`; expect ok=true ≥60 % on all four. |
| (done) tmp-reindex-wmc-1 … -4 | 397–400 | one-off 08-30 `9 8`, `33 8`, `9 10`, `33 10` | `REINDEX INDEX CONCURRENTLY` idx_wmc_cohort_cover / idx_wmc_coll_ek_serial_cover / idx_wmc_moment_collection_cover / wallet_moments_cache_wallet_collection_moment_key | ONE-OFF (20260830030951), **outcome:** 397 and 398 both hit the 600 s `cron_heavy` statement_timeout; 397 finished its swap first — `idx_wmc_cohort_cover` is now 166 MB @ 81 % (was 614 MB @ 22.5 %). 398 left `idx_wmc_coll_ek_serial_cover_ccnew` INVALID — dropped by jobid 402 (09:12Z); 403 dropped the `_ccold` leftover (09:14Z). 399/400 never ran (unscheduled by 401). The 08:33–08:43Z build coincided with the day's worst pool-exhaustion window. The remaining three targets (28 / 42 / 49 % leaf density) need a slot longer than 600 s — decision for Trevor (a longer-timeout role, or an off-peak monthly window). |
| (done) tmp-reindex-wmc-verify | 401 | one-off 08-30 `49 10` | `run_wmc_reindex_verify()` + self-unschedule of all `tmp-reindex-wmc-%` | Ran 10:49Z, wrote `pipeline_runs` `wmc-reindex-verify` ok=false (three targets still bloated), then unscheduled the rest — zero `tmp-reindex-wmc-%` rows and zero INVALID indexes DB-wide at 13:0xZ. Nothing recurs. |
| (done) tmp-vacuum-fmv-snapshots-2026 | 396 | one-off 02:29Z | `VACUUM (ANALYZE) public.fmv_snapshots_2026` | 9 s, succeeded, unscheduled. Falsified the heap-fetch hypothesis (ledger 08-29 late). |

**Notable finite pack-opens backfills** (migrated off cron-job.org onto pg_cron 2026-07-11 — retire the pg_cron job + set the `pipeline_cadence_watchlist` row `is_active=false` once the pipeline logs `done:true`; confirm both still exist in `cron.job` before relying on them):

| Job | jobid | Schedule | Target | Notes |
|---|---|---|---|---|
| rpc-topshot-pack-opens-history | 56 | `9,24,39,54 * * * *` | `ingest-topshot-pack-opens-history?mode=backfill&key=…tsopenhist` (120s timeout) | Successor to deleted cron-job.org job 8070439 (failed every tick at the 30s client cap while the fn succeeded server-side). pg_cron has no cap. Cursor descending toward spork floor 27341470. Revert: `SELECT cron.unschedule('rpc-topshot-pack-opens-history');` |
| rpc-allday-pack-opens-backfill | 55 | `6,16,26,36,46,56 * * * *` | `ingest-allday-pack-opens?mode=backfill&key=…alldayopen` (90s timeout) | Successor to unscheduled pg_cron jobid 21. No cron-job.org entry exists for this fn. Cursor descending toward AllDay genesis (floor 35000000), spork-routed below 137390146. Revert: `SELECT cron.unschedule('rpc-allday-pack-opens-backfill');` |

## GitHub Actions  ·  16 (verified 2026-07-21)

| Workflow | Schedule | Notes |
|---|---|---|
| rpc-pipeline.yml | 5,25,45 | Steps: ingest, fmv-recalc, fmv-backfill, backfill-player-names, topshot-listing-cache (GHA-ONLY trigger — do not remove), backfill, price-snapshots. |
| allday-ingest.yml | 10,30,50 | /api/allday-ingest only |
| pinnacle-owner-discovery.yml | 6,26,46 | |
| topshot-listing-cache.yml | ~~15,35,55~~ **dispatch-only** | ⚠ **MOVED TO VERCEL CRON 2026-08-01, same minutes (15,35,55).** GHA fired only **10–13 runs/day against the 72/day** this schedule implies (measured from GHA run history 07-27→08-01, so not a DB/`after()` artifact) — ~83% silent tick loss on the feed behind `cached_listings` → `badge_editions.low_ask` → ASK-derived FMV. Its watchlist row (`max_silent_minutes` 360) could never see it: even at ~17% delivery it still fired about every 2h, so it never breached 6h. **A cadence watchlist keyed on SILENCE cannot detect partial tick loss.** rpc-pipeline.yml step #5 remains a real caller — do not remove it. |
| topshot-sales-history-backfill.yml | 7,22,37,52 | |
| offer-fill-backfill.yml | 9,24,39,54 | |
| allow-list-reconcile.yml | ~~hourly :14~~ **dispatch-only** | ⚠ **MOVED TO VERCEL CRON 2026-08-01, same minute (:14).** GHA delivered only ~9 of 24 daily ticks (~60% loss) and this pipeline had **no `pipeline_cadence_watchlist` row at all**, so the loss was entirely invisible; a row was added in the same change (`audit_20260801_watchlist_allow_list_reconcile`, 240m / info). |
| ops-monitor.yml | 13,43 + daily 06:41 UTC | |
| pipeline-sentinel.yml | hourly :34 | |
| sales-indexers-backstop.yml | 18,48 | Redundant backstop for all 4 watchlisted on-chain sales indexers (TS + AllDay + Golazos + UFC). cron-job.org stays primary; this dual-triggers so a silent auto-disable can't kill sales ingest. Routes are fire-and-forget + tx_hash-idempotent → safe to double-fire. |
| wallet-backfill-backstop.yml | 38 of 02/08/14/20 | Passes `&force=1` to bypass the 12h seed-wallet gate — load-bearing, do not drop |
| snapshot-institutional-wallets-backstop.yml | daily 07:29 UTC | ✅ MOVED 2026-07-26 (was 07:07 — :07 is the heaviest minute, 11 jobs). ⚠ Its primary moved 06:37→10:07, so this backstop now LEADS the primary by ~2h38m instead of trailing it — still idempotent + lock-guarded, but re-trailing it is an open cadence call. |
| badge-sync.yml | 15 */6 + :45 of 02/08/14/20 | ⚠ 2026-08-30: both jobs now `needs: upstream-probe` — a 15 s POST to public-api.nbatopshot.com/graphql; a 52x/530 or connection failure SKIPS the tick (warning annotation), anything else runs it. Self-resumes when the host returns; no re-enable step. |
| topshot-active-listings-ingest.yml | 29 */3 | ✅ MOVED 2026-07-26 (was 13 */3; :13 is the 2nd-heaviest minute, 9 jobs, and this is a 15–18 min Atlas sweep). |
| smoke-tests.yml | daily 12:11 UTC + every push | |
| ci.yml | event-driven only (push/PR) | |

## Known issues / watch-list (2026-07-21)

- **2026-08-30 — pg_cron jobid 16 `rpc-backfill-pack-pool` is PAUSED** (`cron.alter_job(16, active => false)`, migration `20260830021817`): its target `public-api.nbatopshot.com` has been 530/1033 since 08-28 ~17Z; 277 runs/day were paying a 9.6 s / 1,565-disk-read `get_topshot_pool_backfill_targets()` each before failing. No watchlist row covers it, so the pause is silent by construction. **Re-enable** (`cron.alter_job(16, active => true)`) when the host answers non-5xx on two consecutive probes or the function is ported to Studio.

- ✅ **Analytics Smoke** / **Lock Check Batch** — both previously ⚠ (>30s); now clean. Resolved.
- ✅ **Weekly DB maintenance** — was NOT dark (see the inactive-table note); the broken `Pipeline Runs Cleanup` external entry is deleted, and `weekly-db-maintenance` is now watchlisted. Closes the 🔴 item carried since the 2026-07-11 audit.
- ♻️ **Double-fires (OPEN — needs intended-primary decision):** `pinnacle-sync` (cron-job.org 10:07 UTC + vercel.json 06:00) and `compute-laliga-pack-ev` (cron-job.org 05:00 + vercel.json 05:30). `pinnacle-sync`'s dual schedule is a deliberate dropout backstop — likely keep both. `compute-laliga` — decide primary; if de-duping, keep the Vercel-native leg (cron-job.org is the dropout-prone side) and remove the cron-job.org entry.
- 🧹 **`(TEMP)` buyer backfills** — keep running; buyer coverage is 66.79% (230k NULL), not complete.

## Changes since the 2026-06-07 regen

Count 69 → 86 (79 active, 7 inactive). NEW (~13): alerts-dispatch, alerts-send (alert pipeline split), ownership-onchain-walk, refresh-conflated-editions, resolve-wallet-usernames, snapshot-pack-asks, topshot-deal-floor-serials, sync-topshot-ownership-dune, smoke-concierge-daily, backfill-topshot-buyers (TEMP ×2), backfill-topshot-onchain-art, backfill-allday-listing-serials. Fixed: Analytics Smoke, Lock Check. Deleted: Pipeline Runs Cleanup. → inactive: Pinnacle Listings Reconcile. Moved: Snapshot Institutional Wallets (06:37→10:07 UTC), V1-Dapper Recovery (daily→3h). pg_cron 34 → 64.

## Pending additions

- **RPC UFC Enrichment Drain** → `POST https://www.rippackscity.com/api/cron/ufc-enrichment-drain` — schedule `7,37 * * * *`, `Authorization: Bearer <INGEST_SECRET_TOKEN>` header, expect **202**. Drains the UFC-WMC-NULLKEY backlog (shipped 2026-06-13 `fb2fbac`): enriches NULL-`edition_key` UFC wmc rows directly on-chain (250/tick), logs `pipeline_runs` pipeline=`ufc-enrichment-drain`. **(WIRED 2026-06-13, cron-job.org job 7804392 — now live at 7,37 in the Vercel-routes table above.)**

- **RPC V1-Dapper Recovery** (ALLDAY-V1-UNMAPPED-DRIFT) → `POST https://www.rippackscity.com/api/admin/recover-v1-budget-exhausted` — `Authorization: Bearer <INGEST_SECRET_TOKEN>` header, expect **200** `{ok:true,queued:true}` (work runs in `after()`, result lands in Vercel runtime logs only — no `pipeline_runs` row). Re-decodes AllDay V1-Dapper sales parked in `unmapped_sales` with `resolution_hint->>'price_extraction' = 'v1_tx_decode_budget_exhausted'` (price_usd=0): patches the real DUC price, strips the marker so the next `promote_unmapped_sales` sweep promotes them, and fixes already-promoted price_usd=0 `sales` rows in place. Multi-NFT V1 txs (gross DUC unsplittable) are skipped by design and reported in the log summary (`multi_nft_tx_total_unsplittable`) — the genuinely-uncertain residual, not a bug. **(WIRED 2026-06-13 — cron-job.org job 7818270; MOVED daily→`43 */3` since 06-07, now live in the Vercel-routes table above. First run patched the price-uncertain backlog 236 → 34 = the multi-NFT unsplittable floor. Revert: delete cron-job.org job 7818270.)**

## Retired schedules

- **2026-07-28 — `sync-sales-ingest-dune` (Vercel cron `11 */2 * * *`) REMOVED from `vercel.json`.** It had **36 runs / 0 successes — not one, ever**, every tick throwing `HTTP 402 … would exceed your configured datapoint limit per billing cycle` on the same window (`2021-12-30..2022-01-01`). `sales_ingest_state.cursor_end` has been frozen at `2022-01-01` since 2026-07-25 17:29Z against `floor_date=2019-01-01` / `window_days=2` — ~548 windows left to walk and it cannot walk one. That was 12 guaranteed-failing invocations/day. This is the concrete evidence behind the 2026-07-26 roadmap's "retire Dune to audit-only" call.
  - **The route and `sales_ingest_state` are KEPT** (schedule-only retirement, mirroring `drain-base-parallel-probe` on 2026-07-26), so the lane is revivable the moment the datapoint budget resets or is raised: re-add `{"path": "/api/cron/sync-sales-ingest-dune", "schedule": "11 */2 * * *"}` to `vercel.json`.
  - ⚠ **Do NOT retire the sibling `sync-sales-seller-recovery-dune` (`47 * * * *`) — it is HEALTHY.** Its last 16 consecutive runs are `ok=true`; its query is small enough to fit under the remaining cap. (Its lifetime 42/74 includes older 402s from before the window shrank — judge it on recent runs, not the lifetime ratio.)

## Known incidents

- **2026-07-10 ~22:40 PT — cron-job.org dropout (~10.5h)**: All Vercel-route cron jobs went silent from ~10:40 PM PT to ~9:00 AM PT the next day. Supabase edge function jobs (compute-topshot-pack-ev, wmc-fmv-populate) were unaffected. GHA backstops kept sales ingest alive; fmv-recalc was dark ~6.5h. Self-healed without operator action. Root cause unknown (cron-job.org service issue or account-level transient).
  - **Dashboard audit 2026-07-11 ~12:30 PM PT (via Chrome):** confirmed no jobs were auto-disabled by cron-job.org during the dropout. The jobs showing "last run failed" all last ran inside the dropout window and self-healed on their next scheduled run (no action).
