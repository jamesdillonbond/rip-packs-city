# Small fix — retire pinnacle-sync's dead Flowty legs (PIN-SYNC-FLOWTY)

## Symptom (from Trevor's cron-job.org test run, 2026-06-06 20:26Z)

`GET /api/cron/pinnacle-sync` returns `status:"partial"` with 20x `Edition parse error: Cannot read properties of undefined (reading 'traits')`, `editions_upserted:0`, `listings_upserted:0` — and the route logs `pipeline_runs ok=false`. Once the daily cron entry is saved, EVERY run will log ok=false and trip the ok=false monitors (daytime monitor, weekly check), masking real failures. Fix before (or right after) enabling the daily entry.

## Root cause

`lib/pinnacle/sync.ts` — `syncPinnacleEditions()` and `syncPinnacleListings()` both call `fetchPinnacleListings()` from `lib/pinnacle/flowty.ts` (Flowty's api2.flowty.io) and parse `listing.nftView.traits.traits`. Flowty shut down 2026-05-13; its residual payloads have no `nftView.traits`, so every listing throws. These two legs are dead-marketplace code.

Both are fully superseded:
- Editions/catalog → `pinnacle-catalog-backfill` (studio-platform GraphQL, 2,079/day, live + cron'd).
- Sales → `pinnacle-events-ingest` (on-chain) + the render_id stamping.
- (The route's three WORKING legs are untouched: `pinnacle_fmv_from_listings` — 30 asks updated in the same run — plus `pinnacle_fmv_recalc_all` 427 and `pinnacle_fmv_recalc_render_all` 1,789.)

## Fix (small)

In `app/api/cron/pinnacle-sync/route.ts`: remove the calls to `syncPinnacleEditions` / `syncPinnacleListings` (and their result fields from the response + the error aggregation). Keep: fmv_from_listings, fmv_recalc_all, fmv_recalc_render_all, and the route-level `log_pipeline_run` success/failure split. Delete the now-unreferenced functions in `lib/pinnacle/sync.ts` (and `lib/pinnacle/flowty.ts` if nothing else imports it — grep first; the flowty-teardown convention applies). Expected post-fix run: `status:"ok"`, `pipeline_runs ok=true`, no errors array noise.

## Verify

- `npx tsc --noEmit` clean; deploy READY.
- PowerShell: Invoke-RestMethod -Uri "https://www.rippackscity.com/api/cron/pinnacle-sync" -Headers @{Authorization="Bearer $env:INGEST_SECRET_TOKEN"} → ok status, all three FMV legs reporting, `SELECT ok FROM pipeline_runs WHERE pipeline='pinnacle-sync' ORDER BY finished_at DESC LIMIT 1` = true.
- Catalog freshness is unaffected (owned by pinnacle-catalog-backfill at 09:37 UTC; pinnacle-sync daily at 10:07 UTC stays purely FMV).

## Revert

git revert the commit. No DB change in this fix.
