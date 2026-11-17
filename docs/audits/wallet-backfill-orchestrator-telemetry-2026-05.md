# Wallet-backfill orchestrator telemetry — retry verification log

## Round 13 Item 1 — verification deferred (2026-05-11 19:50 UTC)

**Deploy:** [`ebef24c`](https://github.com/jamesdillonbond/rip-packs-city/commit/ebef24c) READY 2026-05-11 18:33:50 UTC.

### Why verification cannot run yet

The Round 13 prompt asks for verification at "the next 6h tick after deploy."
The deploy went READY at 18:33:50 UTC May 11. The most recent 6h tick fired
at 18:00:38 UTC May 11 — 33 minutes **before** the deploy — and emitted the
old pipeline names (`wallet-backfill-multicollection` /
`wallet-backfill-multicollection-final`). The renamed pipelines
(`-dispatch` / `-complete`) have not fired yet.

```sql
-- Run at 19:50 UTC May 11 (1h17m post-deploy)
SELECT pipeline, COUNT(*), MAX(started_at)
FROM pipeline_runs
WHERE pipeline IN (
  'wallet-backfill-multicollection-dispatch',
  'wallet-backfill-multicollection-complete'
);
-- → 0 rows.
```

The next 6h tick of seed-wallet-refresh is 00:00 UTC May 12 — about 4
hours after this audit entry is being written. That is the first opportunity
to observe the renamed pipelines.

### Re-run instructions

After 00:00 UTC May 12 (or 06:00 UTC May 12 if 00:00 was skipped), execute
the verification query from the Round 13 Item 1 prompt:

```sql
SELECT
  pipeline,
  COUNT(*) AS rows,
  COUNT(DISTINCT extra->>'wallet_address') AS wallets,
  AVG(duration_ms)::int AS avg_ms,
  COUNT(*) FILTER (WHERE ok=false) AS failures
FROM pipeline_runs
WHERE pipeline IN (
  'wallet-backfill-multicollection-dispatch',
  'wallet-backfill-multicollection-complete'
)
  AND started_at >= '2026-05-12 00:00:00+00'::timestamptz
  AND started_at <  '2026-05-12 00:30:00+00'::timestamptz
GROUP BY 1;
```

Outcome table from the Round 13 prompt (verbatim):

| dispatch rows | Outcome | Interpretation |
|---|---|---|
| ≈ 240 (matches wallets_targeted), complete ≤ dispatch | **a** | Invariant holds. Retry helper succeeded. Telemetry is now load-bearing. |
| ≥ 200 but < 240 | **b** | Retry helper partial. Some writes still silently dropping. Round 14 follow-up: staggered write timing OR parent-side dispatch write. |
| ≈ 119 (~50%) | **c** | Retry helper not catching the failure mode. Writes likely bypassing `logPipelineRunWithRetry` entirely. Audit route for bare `await supabaseAdmin.rpc(...)` calls. |

### Baseline (pre-rename, Round 11 telemetry)

For comparison when the post-rename data arrives. Round 11 baseline at the
18:00 UTC May 11 tick was the trigger for ebef24c:

- `wallet-backfill-multicollection-final` (pre-rename "complete"): 240 rows
- `wallet-backfill-multicollection` (pre-rename "dispatch"): 121 rows
- Implied 119-row silent drop in the dispatch write — the gap ebef24c targets.

### Status

**DEFERRED.** Re-run at 00:00 UTC May 12 or later and append the verdict
below this section. Do not commit a "verification passed" claim until the
SQL above returns the expected pattern.

---

## Round 13 Item 1 — verdict (pending)

_Append outcome (a/b/c) here after the first post-deploy 6h tick fires._
