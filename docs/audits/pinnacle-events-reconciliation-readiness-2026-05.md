# Pinnacle Events → Reconciliation Readiness — 2026-05-11

## Status (Round 12 re-check)

**Phase 2C (events → cached_listings reconciliation) remains gated on event accumulation.**

Current accumulation as of 2026-05-11 18:34 UTC:

| Source | Count |
|---|---|
| `pinnacle_listing_events` total rows | **0** |
| `pinnacle-events-ingest` runs in last 2h | 2 (one OK, one FAILED) |

## What changed since the Round 11 readiness doc

The cron-job.org schedule is now live. Cadence: `4,19,34,49 * * * *` (offset from neighboring `*/20` jobs).

| Run | started_at | ok | rows_written | Notes |
|---|---|---|---|---|
| First | 2026-05-11 18:24:01 UTC | true | 0 | Cursor anchored at block 151,205,668. No matching events in the first window. |
| Second | 2026-05-11 18:34:07 UTC | **false** | 0 | `proxy HTTP 404: <!DOCTYPE html>…` — `pinnacle-events-proxy` worker returned an HTML 404 page. |

The 18:34 failure surfaces a NEW issue independent of Phase 2C: the chain-events proxy is intermittently returning 404 HTML. This needs to be investigated before Phase 2C can reliably accumulate events. Hypotheses to check next session:

1. The worker route pattern doesn't cover the path the cron is calling (404 from CF router).
2. The worker is up but a downstream Flow REST endpoint returned 404 and we're surfacing it verbatim.
3. The cron URL was misconfigured at cron-job.org and is hitting a non-route.

Pull the worker logs (`wrangler tail pinnacle-events-proxy`) at the next */15 tick to disambiguate.

## Gate criteria (unchanged from Round 11 readiness doc)

Phase 2C ship requires **≥10 `ListingAvailable` rows** in `pinnacle_listing_events`. Pinnacle marketplace velocity is roughly ~10-30 new listings/hour (vs ~50-150 AllDay, ~200-500 Top Shot), so at the lower bound this could take ~30-60 min once ingest is healthy, and several hours if velocity is at the conservative end.

## Action — next round

1. **Diagnose the 18:34 proxy 404.** This blocks any further accumulation. Either fix the worker route pattern or correct the cron URL.
2. After ≥3 consecutive successful runs with `pinnacle_listing_events.total_events >= 10`, ship `pinnacle_listings_reconcile()` per the Round 11 Item 2 spec.

## Verification queries

```sql
-- Run health
SELECT pipeline, MAX(started_at), COUNT(*) FILTER (WHERE ok) AS ok_runs,
       COUNT(*) FILTER (WHERE NOT ok) AS bad_runs, SUM(rows_written) AS total_written
FROM pipeline_runs
WHERE pipeline = 'pinnacle-events-ingest'
  AND started_at > NOW() - INTERVAL '24 hours'
GROUP BY 1;

-- Event accumulation
SELECT event_type, COUNT(*), MIN(listed_at), MAX(listed_at)
FROM pinnacle_listing_events
GROUP BY 1 ORDER BY 1;

-- Gate for Phase 2C ship: need >=10
SELECT COUNT(*) FROM pinnacle_listing_events
WHERE event_type LIKE '%ListingAvailable%';
```

## Queued for Round 13+

- Phase 2C reconciliation RPC + */15 cron (offset 9,24,39,54) — ship after proxy is healthy and accumulation crosses 10 events.
