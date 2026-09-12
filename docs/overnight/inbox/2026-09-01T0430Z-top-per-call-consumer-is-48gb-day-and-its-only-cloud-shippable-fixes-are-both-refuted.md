> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T04:30Z — the instance's #1 per-call consumer is a ~48 GB/day scan whose only cloud-shippable fixes are both already refuted

Cloud-only pass, read origin/main `e2ba388`. Filed so the queued denormalization lever is not re-derived from scratch and the two dead ends are not re-attempted.

## Measured (post-ship diff, baseline 04:05:01Z)
`get_allday_unresolved_pulls(int)` (queryid -361858749265724328): **128,335 shared_blks_read/call, 9,815 ms/call**. Caller jobid 22 `9,39 * * * *` → 48×/day → **~48 GB/day** cold disk. Live `EXPLAIN (ANALYZE, BUFFERS)`:
- Parallel Seq Scan `pack_rips` — 96,814 blk read, filter (collection_id=AllDay AND block_height not null)
- Parallel Seq Scan `allday_pack_pull` — 31,456 blk read, filter edition_id IS NULL
- Parallel Hash Join → **586,890 rows** → top-N heapsort → LIMIT 300
- Execution 9,872 ms, 128,270 read buffers, 21,887 temp read.

## The two dead ends (DO NOT re-attempt — tabulated)
1. `idx_pack_rips_collection_block_height (collection_id, block_height DESC)`: built + measured + **reverted 08-13**. Nested-loop plan walks a huge prefix of already-resolved rips because the newest 20,000 AllDay rips have **zero** unresolved pulls; full-exec estimate 1.63M vs seq-scan 294k; a bounded probe over 250k rips blew a 50 s timeout.
2. Drop the `ORDER BY block_height DESC`: **refuted 08-13T1950Z**. It IS the forward-resolver — every row it resolves is 1–3 days old; dropping it feeds the job permanently-unresolvable historical rows every tick.

## Ruled out THIS pass
`allday_pack_pull` has `last_analyze/last_vacuum/last_autovacuum` all NULL (fits the never-ANALYZEd trap), but the live plan's row estimates are accurate (pack_rips est 1.66M/actual 1.41M; allday_pack_pull est 672k/actual 587k), so the seq-scan+top-N sort is correctly chosen. ANALYZE would not move the plan. No ship.

## The only untried lever (queued, needs Trevor)
Denormalize `block_height` onto `allday_pack_pull` + partial index `(block_height DESC) WHERE edition_id IS NULL AND opener_address IS NOT NULL`, so the ORDER BY+LIMIT is an index scan that stops after ~300 — no pack_rips seq scan, no 587k-row sort. Requires: ADD COLUMN (migration) + 1.47M-row backfill (one-off as postgres) + a trigger or ingest-path change to keep it fresh + the CIC. NOT clearly-safe unattended: schema+trigger on a hot ingest table, and the forward-resolver semantic is load-bearing — confirm an unresolved row's denormalized block_height is never bumped by a failed resolution attempt. Measure before/after on the diff; exit from the post-fix EXPLAIN.
