# Runbook — listing-retry-queue end-to-end validation

## When to use this

The first real row lands in `listing_resolution_failures` (today the table is empty — the AllDay direct indexer hasn't seen an unresolvable listing yet in production). When that happens, you want to confirm in one sitting that:

1. The new row is visible to the drill-down on `/admin/listing-retry-queue`.
2. The Sentry breadcrumb + `captureMessage` fired on insert and is searchable in the dashboard.
3. `POST /api/admin/listing-retry-force?id=<id>` bumps `retry_count` + `last_retry_at` for an unresolvable row, or resolves + drops the row when the upstream resolution succeeds.

This runbook walks the synthetic harness used to dry-validate the end-to-end path. **All synthetic state is deleted at the end** — running this twice in a row is safe.

## Validated 2026-05-11

The synthetic insert → drill-down → force-retry → cleanup loop was exercised against production Supabase on 2026-05-11 16:01 UTC. All four stages worked. The reference output is:

| Stage | Result |
|---|---|
| Insert synthetic row | `id=1`, `retry_count=0`, `last_retry_at=NULL`, `failure_reason='validation_harness_synthetic'` |
| `get_listing_retry_queue_rows(NULL, 0, 10, 0)` returns it | `collection_slug='nfl_all_day'`, `age_hours=0.00` |
| Simulated force-retry bump | `retry_count=1`, `last_retry_at` set, `resolved_at` still NULL |
| Drill-down reflects bump | `retry_count=1`, `retried=true` |
| Delete cleanup | row count back to 0 |

When the first real row lands, repeat these stages against it — but step 3 should be the actual HTTP call (below), not the SQL stand-in.

## Step-by-step

### 1. Insert a synthetic row

```sql
INSERT INTO listing_resolution_failures (
  collection_id, flow_id, listing_resource_id, event_payload,
  failure_reason, retry_count, last_retry_at, resolved_at
) VALUES (
  'dee28451-5d62-409e-a1ad-a83f763ac070',  -- AllDay
  '99999999999999',
  'synthetic-validation-99999999999999',
  jsonb_build_object(
    'blockHeight', 0,
    'blockTimestamp', NOW(),
    'txHash', 'synthetic-tx',
    'eventIndex', 0,
    'listingResourceID', 'synthetic-validation-99999999999999',
    'storefrontAddress', '0x0000000000000000',
    'nftID', '99999999999999',
    'salePrice', '1.0',
    'customID', NULL,
    'expiry', '0'
  ),
  'validation_harness_synthetic', 0, NULL, NULL
) RETURNING id;
```

Note the returned `id`. The fake `flow_id=99999999999999` will not appear in `wallet_moments_cache`, `nft_edition_map`, or `editions` — so the force-retry path lands on the "no resolution found" branch and bumps `retry_count` instead of resolving + dropping.

### 2. Confirm the drill-down RPC sees it

```sql
SELECT * FROM get_listing_retry_queue_rows(NULL, 0, 10, 0)
WHERE id = <returned_id>;
```

Expected: one row with `collection_slug='nfl_all_day'`, `retry_count=0`, `last_retry_at=null`, `age_hours` near 0.

Equivalent HTTP call (drives the `/admin/listing-retry-queue` drill-down table):

```powershell
$tok = (Get-Content .env.local | Select-String '^INGEST_SECRET_TOKEN=').Line -replace '^[^=]+=', ''
Invoke-RestMethod `
  -Uri "https://www.rippackscity.com/api/admin/listing-retry-queue/rows?collection=nfl_all_day&limit=10" `
  -Headers @{ Authorization = "Bearer $tok" }
```

### 3. Trigger the force-retry path

```powershell
Invoke-RestMethod `
  -Method POST `
  -Uri "https://www.rippackscity.com/api/admin/listing-retry-force?id=<returned_id>" `
  -Headers @{ Authorization = "Bearer $tok" }
```

For the synthetic fake-flow_id row the response is:

```json
{
  "ok": true,
  "resolved": false,
  "next_retry_count": 1,
  "cadence_tried": true,
  "external_id_found": null,
  "reason": "no_external_id_resolved"
}
```

For a real row that resolves correctly, expect `resolved: true` + `edition_id` populated. The row then disappears from `get_listing_retry_queue_rows` because the RPC filters `resolved_at IS NULL`.

### 4. Confirm the bump landed

```sql
SELECT id, retry_count, last_retry_at IS NOT NULL AS retried, resolved_at
FROM listing_resolution_failures WHERE id = <returned_id>;
```

Expected after one force-retry against the synthetic row: `retry_count=1`, `retried=true`, `resolved_at=null`.

### 5. Confirm Sentry visibility (real-row only)

The synthetic row is inserted directly via SQL, so it does **not** trigger the Sentry capture path. The Sentry surface fires only from the AllDay live indexer at `app/api/allday-listings-indexer/route.ts` when its in-tick `failuresToQueue` upsert succeeds. When the first real failure lands, search Sentry for:

```
message:"listing_resolution_failures_inserted"
```

Each tick that queues new failures fires one `captureMessage` (level=warning) with `tags.collection='nfl_all_day'`, `extra.queued_failures`, `extra.failure_reason_counts`, and `extra.first_5_flow_ids`. Per-row context is attached as breadcrumbs on the same scope.

### 6. Clean up

```sql
DELETE FROM listing_resolution_failures WHERE id = <returned_id>;
SELECT COUNT(*) FROM listing_resolution_failures;
```

The count should drop by exactly 1 (back to whatever the pre-test baseline was). Never leave the synthetic row behind — it has a bogus seller address and would otherwise be re-tried every 15 minutes by the production retry cron and accumulate noise in pipeline_runs.

## Related files

- [app/api/allday-listings-indexer/route.ts](../../app/api/allday-listings-indexer/route.ts) — silent-insert + Sentry capture point
- [app/api/admin/listing-retry-force/route.ts](../../app/api/admin/listing-retry-force/route.ts) — single-row retry mutator
- [app/api/admin/listing-retry-queue/rows/route.ts](../../app/api/admin/listing-retry-queue/rows/route.ts) — drill-down API
- [app/admin/listing-retry-queue/page.tsx](../../app/admin/listing-retry-queue/page.tsx) — admin UI consumer
- [docs/audits/listing-divergence-2026-05.md](../audits/listing-divergence-2026-05.md) — divergence audit that spawned the retry queue
