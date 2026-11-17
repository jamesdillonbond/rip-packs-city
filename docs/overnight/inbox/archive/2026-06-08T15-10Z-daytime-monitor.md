# Daytime monitor — 2026-06-08T15:10Z

Read-only sweep. Platform GREEN at sweep time (0 pipeline fails 14:00–15:10Z, security 0/0, all deploys READY bar the known-superseded ERROR, sentinel green). One new low-risk candidate below; everything else observed was already in the ledger/inbox or owned by an active task (corroboration block at the bottom so the night pass doesn't double-count).

## New candidate

### DBSAT-0911 — daytime DB-saturation window 09:00–11:00Z (LOW · watch · refines I1)
- **Source:** `pipeline_runs` hourly distribution. Fails/hour ran 7 (08Z) → 37 (09Z) → 39 (10Z) → 39 (11Z) → 10 (12Z, the :00 rush, 1,285 runs) → 2 (13Z) → **0 (14Z) → 0 (15Z)**. ~115 fails over the 09–11Z window (~22% of ~170 runs/hr there) vs the night baseline ~0.76%/24h. All "canceling statement due to statement timeout" across the DB-read-heavy set: compute-topshot-pack-ev (27/6h), pinnacle-nft-resolver (27), topshot-moments-hydrator (19, `v_moments_needing_hydration` candidate_read), pinnacle-listings-reconcile (13), wmc-fmv-populate (7).
- **Risk read:** LOW / already recovered — every heavy pipeline has `last_ok > last_fail` and 0 fails in the last hour; no logic bug, pure statement-timeout/connection-pool (I1 rush-saturation family). BUT the window was **sustained for ~3h and not aligned to a :00 dispatch storm**, and it overlaps the broken cross-collection refresh (`refresh_cross_collection_cohort_step1` per-wallet FOR-LOOP doing ~144 × 1.59M-row aggregation scans) that Cowork only fixed at **14:55Z** — i.e. a heavy DB-load source was live + failing through the whole saturation window and went away right before the platform went clean.
- **Suggested action (no code change implied):** when the I1 stagger histogram-verify runs this evening, treat all pre-14:55Z daytime saturation as **confounded** by that broken cross-collection refresh — don't conclude the cron stagger is insufficient off today's numbers. Re-baseline daytime fail-rate over a full clean day (06-09) now that the per-wallet loops are set-oriented + the `idx_wmc_cohort_cover` index is in. If 06-09 still shows a sustained mid-morning saturation window, *then* it's a real residual and worth escalating.

## Corroborated / already-owned — NOT new candidates (logged so the night pass sees the monitor checked them)
- **Pinnacle per-render FMV stale ~29h** — `pinnacle_catalog.fmv_computed_at` max = 06-07 10:07Z; `pinnacle-sync` `pinnacle_fmv_recalc_render_all()` canceled (statement timeout) on the 10:07Z tick. Already flagged by the 15:05Z Cowork session (#4) and owned by the `pinnacle-sync-tick-verify-jun8` task; blocks the legacy `pinnacle_fmv_snapshots` drop. Artifacts that read it (scarcity board, insights) still render — data is stale, not broken.
- **LISTCACHE family** — `topshot-listing-cache-v2` stalled 978m (last 06-07 22:48Z), the only `detect_stalled_pipelines()` entry; primary recovered (last_ok 14:21Z, 1 run/3h, under its 360m threshold). Already queued (LISTCACHE-CRON-DROP) + the 15:05Z Cowork session recommends retiring redundant -v2.
- **NEXTJS-1H** (smoke: edition page Recent Sales) — 1 event 05:03Z, no recurrence, assertion-class. Already queued (SMOKE-EDITION-TIMEOUT).
- **DB size 6597 MB** (+115/7h) — faster than the night creep but largely the one-time 14:55Z `idx_wmc_cohort_cover` covering-index build (wmc ~1.58M rows); watch-only.
- **DUPE1 sentinel** — TS-UUID-48h dropped 542 (08:15Z) → 43; the CC-owned merge gate (`<250 and falling`) is now met. CC-owned — not pre-empted, noted only.

## Clean (no action)
Security 0/0 (RLS-off [], anon/auth-write-on-RLS-off []). FMV flat-to-improving (TS HIGH+MED 2954 / NO_DATA 5142↓; AllDay 495/527). Latest prod `d425998` (FCL account-proof security bind) READY; whole 06-08 daytime wave READY except superseded ERROR `76b6c2e` (CRON-30S, rollback-candidate false). 15/15 artifacts' backing queries execute (AF1 view 20 rows, no 57014). unmapped_sales 183.
