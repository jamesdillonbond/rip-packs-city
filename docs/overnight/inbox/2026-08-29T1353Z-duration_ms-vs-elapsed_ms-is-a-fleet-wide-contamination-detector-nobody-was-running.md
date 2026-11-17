# `duration_ms` vs `extra.elapsed_ms` is a fleet-wide contamination detector, and nobody was running it

**Filed 2026-08-29 (PT) by Claude Code, autonomous pass.** Generalises the `allday-sales-indexer` finding shipped the same morning: rather than reading three routes, ask the whole fleet the same question in one query.

## The instrument

`pipeline_runs.duration_ms` is GENERATED over `(finished_at - started_at)`, and `log_pipeline_run` stamps `finished_at` at INSERT time while the caller supplies `p_started_at` at its own entry. **So everything awaited in between is billed to that pipeline, whether or not it is that pipeline's work.**

Many routes independently record their own honest timing as `extra.elapsed_ms`. **The difference between the two is the contamination, and it is already sitting in every row.**

```sql
select pipeline, count(*) as runs,
       round(avg(duration_ms))                                    as avg_recorded,
       round(avg((extra->>'elapsed_ms')::int))                    as avg_true,
       round(avg(duration_ms - (extra->>'elapsed_ms')::int))      as avg_inflation,
       max(duration_ms - (extra->>'elapsed_ms')::int)             as max_inflation
from pipeline_runs
where started_at >= now() - interval '24 hours'
  and extra ? 'elapsed_ms' and duration_ms is not null
  and (extra->>'elapsed_ms') ~ '^[0-9]+$'
group by 1
having avg(duration_ms - (extra->>'elapsed_ms')::int) > 500
order by avg_inflation desc;
```

⚠ The `~ '^[0-9]+$'` guard is not decoration — `extra` is free-form jsonb and a non-numeric `elapsed_ms` anywhere in the window aborts the whole aggregate.

## What it found — 24 h to 2026-08-29 13:50Z, 16 pipelines over the 500 ms threshold

| pipeline | runs | recorded | true | inflation | % foreign |
|---|---:|---:|---:|---:|---:|
| `allday-sales-indexer` | 73 | 50,114 | 6,155 | **43,959** | **87.7%** |
| `wallet-backfill-pinnacle` | 781 | 159,336 | 145,563 | 13,773 | 8.6% |
| `wallet-backfill-allday` | 801 | 171,879 | 159,350 | 12,529 | 7.3% |
| `wallet-backfill-ufc` | 577 | 89,684 | 77,960 | 11,724 | 13.1% |
| `wallet-backfill` | 453 | 122,199 | 113,837 | 8,362 | 6.8% |
| `golazos-sales-indexer` | 73 | 7,168 | 3,248 | **3,921** | **54.7%** |
| `wallet-backfill-golazos` | 374 | 29,523 | 25,644 | 3,879 | 13.1% |
| `ufc-stub-thumbnail-resolver` | 48 | 2,110 | 978 | 1,132 | **53.6%** |
| …8 more | | | | 689–1,213 | 3.5–9.6% |

## ⭐ The class splits in two, and the percentage picks the wrong winner

1. **Foreign WORK billed to the pipeline** — `allday-sales-indexer` and `golazos-sales-indexer`, which awaited `promote_unmapped_sales` (up to 297 s) before their own log write. **Fixed the same morning** by reordering; guarded by `__tests__/indexers-log-before-promote-ratchet.test.ts`.
2. **Terminal-write latency** — everything else. The wallet-backfill family's 6.8–13.1% with `max_inflation` around 57–61 s is the `log_pipeline_run` round trip queueing under contention, which CLAUDE.md already records as "duration_ms absorbs terminal-write queueing".

⛔ **`ufc-stub-thumbnail-resolver` looks like class 1 at 53.6% and is NOT.** Its `logPipelineRun` computes `elapsed_ms` inline at the call, so the gap is purely the write round trip — it only reads as half the duration because the job itself is 978 ms. ⭐ **The discriminator is ABSOLUTE inflation, not the percentage: a high percentage on a short pipeline is contention; tens of seconds of inflation is foreign work.** Ranking by `pct_foreign` would have sent someone to rewrite a one-second resolver.

⚠ **`ufc-sales-indexer` does not appear at all — it logs no `elapsed_ms`.** It has the identical promote-before-log structure and was reordered for that structural reason, unmeasured. **The instrument's blind spot is exactly the pipelines that never recorded their own honest number**, and there is no way to size those from `pipeline_runs` alone.

## 👉 What to do with it

- **Run it after any change to a route's tail.** It is one query, needs no code reading, and would have caught the indexer ordering the day it was written.
- ⛔ **Do not "fix" class 2.** The write latency is real time the invocation spent; the row is not lying, it is measuring something slightly wider than the work. Removing it would need `log_pipeline_run` to accept `p_finished_at`, which it does not — and that is the same missing parameter `lib/pipeline/heartbeat.ts` bypasses the RPC entirely to work around.
- 👉 **A cheap improvement to the instrument itself: get more routes to record `elapsed_ms`.** Coverage is the limit here, not the arithmetic.

## ⛔ Not established

- **Whether class 2's 6–13% matters to anything.** No board, arm or audit was checked for whether it reads these durations at a resolution where 8 seconds on 160 changes a decision.
- **How many routes are invisible to this** (no `elapsed_ms`). Not counted — it needs a code walk, not a query.
- ⚠ **Single 24-hour window, spanning the daytime IO band and two backfill waves.** Class 2 is contention-driven and will move with load; **re-measure in a quiet window before quoting any of these numbers as a baseline.**
