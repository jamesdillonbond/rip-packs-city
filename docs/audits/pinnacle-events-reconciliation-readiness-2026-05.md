# Pinnacle Events → Reconciliation Readiness — 2026-05-11

## Status

**Phase 2C (events → cached_listings reconciliation) is gated on event accumulation.**

Current accumulation as of 2026-05-11 15:42 UTC:

| Source | Count |
|---|---|
| `pinnacle_listing_events` total rows | 0 |
| `pinnacle_event_cursors` rows | 0 (cursor never initialized) |
| `pipeline_runs WHERE pipeline='pinnacle-events-ingest'` | 0 |

## Root cause

The `pinnacle-events-ingest` route at [app/api/cron/pinnacle-events-ingest/route.ts](../../app/api/cron/pinnacle-events-ingest/route.ts) is deployed and the worker (`pinnacle-events-proxy.tdillonbond.workers.dev`) is wired and authed. What's missing: **the cron-job.org schedule has not been created yet.** Round 10 shipped the route with the comment `Schedule (manual, cron-job.org): */15 minutes` — Trevor still needs to add the cron entry.

Until that cron runs at least once:

- `pinnacle_event_cursors` stays empty.
- First run will anchor the cursor at the current sealed tip with no backscan (matching `allday-listings-indexer`'s behavior).
- After that, every */15 tick walks up to 10,000 blocks and writes any matching Pinnacle `ListingAvailable` events.

## Expected accumulation rate

Pinnacle has materially lower marketplace velocity than Top Shot / AllDay. Rough order-of-magnitude expectations based on listing-cache observations:

| Collection | Approx live listings | Approx new listings/hour |
|---|---|---|
| Top Shot | ~60K | ~200-500 |
| AllDay | ~15K | ~50-150 |
| Pinnacle | ~10K | ~10-30 |

A reasonable "ready to ship Phase 2C" threshold is **≥10 ListingAvailable rows** sampled from at least one cron tick. At the lower bound of ~10 listings/hour that requires waiting ~30-60 minutes after the cron is wired. At a more conservative ~3 listings/hour it could take ~3 hours.

## Action

1. Trevor: create the cron-job.org entry — POST `https://www.rippackscity.com/api/cron/pinnacle-events-ingest` every 15 minutes with `Authorization: Bearer $INGEST_SECRET_TOKEN`. Recommended offset: `*/15 * * * *` starting at minute 7 to avoid collision with the existing `*/20` and `*/15` jobs.
2. After ≥3 successful runs with `pinnacle_listing_events.total_events >= 10`, Phase 2C goes back on the queue. The reconciliation RPC (`pinnacle_listings_reconcile()`) will:
   - Read the most recent `ListingAvailable` per `listing_resource_id`.
   - Join `pinnacle_nft_map.nft_id → pinnacle_editions.edition_key`.
   - Aggregate per-edition `MIN(price_usd)` for live listings (no subsequent `ListingCompleted` / `ListingRemoved`).
   - UPSERT into `pinnacle_cached_listings` with `extra.source='pinnacle_direct'` so we can quickly verify the $1-everything Flowty floor signal has been replaced with real upstream data.

## Verification queries (for use after cron wires up)

```sql
-- Step 1: confirm cron is running.
SELECT MAX(started_at), COUNT(*), SUM(rows_written)
FROM pipeline_runs WHERE pipeline = 'pinnacle-events-ingest'
  AND started_at > NOW() - INTERVAL '2 hours';

-- Step 2: confirm events are accumulating.
SELECT event_type, COUNT(*), MIN(listed_at), MAX(listed_at)
FROM pinnacle_listing_events
GROUP BY 1 ORDER BY 1;

-- Step 3 (gates Phase 2C ship): need >=10 ListingAvailable rows.
SELECT COUNT(*) FROM pinnacle_listing_events
WHERE event_type = 'A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable';
```
