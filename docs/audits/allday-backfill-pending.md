# AllDay historical backfill — pending Trevor's run

**Status as of 2026-05-11 18:35 UTC (Round 12 re-check):** unchanged. The full `scripts/backfill-allday-listings-historical.mjs` run has still not been executed.

Latest `pipeline_runs WHERE pipeline = 'allday-listings-historical-backfill'` shows the same two test slices from 14:18 UTC on 2026-05-11 — no new rows in the ~4h since the Round 11 readiness check.

| started_at | blocks_scanned | events_resolved | duration_ms |
|---|---|---|---|
| 14:18:26 | 23,092 | 36 | 29.5s |
| 14:18:12 | 1,092 | 0 | 1.8s |

Both rows are dry-test slices. The full walk needs `blocks_scanned > 10_000_000` to be meaningful, per Round 12 Item 3's gating threshold.

Waiting on Trevor to run with no `--floor-block` override (or with `--floor-date=2025-11-22`). Once a row exists with `blocks_scanned` in the millions and a duration measured in hours, the post-backfill divergence measurement runs per the Round 11 Item 3 plan, and `docs/audits/listing-divergence-2026-05.md` gets the post-backfill section.

## When Trevor runs it

Re-run this re-check query and proceed with the audit if it passes the gate:

```sql
SELECT MAX(started_at), (extra->>'blocks_scanned')::bigint AS blocks_scanned,
       (extra->>'events_resolved')::int AS events_resolved,
       (extra->>'duration_ms')::int AS duration_ms
FROM pipeline_runs
WHERE pipeline = 'allday-listings-historical-backfill'
ORDER BY started_at DESC LIMIT 1;
-- Gate: blocks_scanned > 10_000_000 → write the audit; else re-defer.
```
