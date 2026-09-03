# The per-route wall map exists now, and its first fleet sweep diagnoses its own mapping errors

**Filed 2026-09-03 ~01:20 PT (08:30Z) by Claude Code. The MODULE is shipped (`lib/pipeline/route-walls.ts`
+ 9 tests); the fleet sweep below is a MEASUREMENT, and no pipeline was changed because of it.**

## 0. What this unblocks

Two hours earlier, `2026-09-03T0800Z-a-killed-tick-can-carry-a-clean-heartbeat-correlation.md` recorded
that `classifyKillRecord` scores a tick `killed` only when no terminal row correlates — and that a tick
the platform killed can still carry one, because the terminal write races the wall and sometimes wins.
The discriminator was always `duration_ms` against the **route's own** `maxDuration`, and the blocker
was that **no per-route wall existed in code**. That is step 1 of the three the filing specified.

## 1. The map

Walks `app/api/**/route.ts` with comments stripped, taking `export const maxDuration` and the pipeline
name from the three shapes actually in use (`const PIPELINE = "…"`, a CONFIG object's `pipelineName:`,
the RPC's own `p_pipeline:`). **116 (pipeline, wall) pairs.**

⚠ **A route whose name cannot be extracted is RETURNED as unmapped, never dropped** — the same rule the
paged-read guard states: a partial result that cannot be distinguished from a complete one is the
defect.

## 2. ⭐ THE FIRST SWEEP DIAGNOSES ITSELF, and that is the finding

`max(duration_ms)` over the 73 h `pipeline_runs` retains, as a fraction of each pipeline's mapped wall:

| pipeline | wall | max | frac | reading |
|---|---:|---:|---:|---|
| `topshot-active-listings-ingest` | 60 s | 1,303,432 ms | **21.7** | ⛔ map wrong |
| `refresh-pack-grail-metrics-mv` | 60 s | 163,382 ms | **2.7** | ⛔ map wrong |
| `snapshot-institutional-wallets` | 30 s | 73,528 ms | **2.5** | ⛔ map wrong |
| `allday-badge-ingest` | 60 s | 112,689 ms | **1.9** | ⛔ map wrong |
| `fmv-recalc` | 300 s | 317,457 ms | 1.058 | ⚠ write raced the wall |
| `evm-transfers-ingest` | 60 s | 60,464 ms | 1.008 | ⚠ **confirmed kill** |
| `resolve-topshot-stubs` | 30 s | 29,313 ms | 0.977 | censored max |
| `allday-lock-refresh` | 300 s | 292,225 ms | 0.974 | censored max |
| `wallet-backfill` | 300 s | 267,725 ms | 0.892 | censored max |
| `check-alerts` | 60 s | 49,175 ms | 0.820 | |
| `lock-check-batch` | 300 s | 241,221 ms | 0.804 | |

🚨 **A route cannot record a run much longer than its own wall — the platform terminates it. So a
fraction far above 1 says the mapped route is NOT what writes those rows.**

⭐ **Confirmed, not inferred.** `refresh-pack-grail-metrics-mv` reads 2.7× because migration
**`20260829235752_audit_20260829_grail_mv_refresh_moves_to_pg_cron_with_catchable_terminal_row.sql`**
says by name that the refresh moved to pg_cron on 2026-08-29. The Vercel route's wall stopped being
that pipeline's ceiling that day, and the sweep spotted it without being told.

⚠ **The interesting band is just ABOVE 1, not far above it.** `evm-transfers-ingest` at 1.008 is the
tick with independent Vercel confirmation (`Task timed out after 60 seconds` on that exact invocation),
and `fmv-recalc` at 1.058 is the same shape unconfirmed.

⚠ **And just BELOW 1 is the censored-maximum band.** Those maxima cannot exceed the ceiling however
often it is hit, so 0.977 and 0.974 are *at least* that close, never *at most*.

## 3. ⛔ What this map is NOT

It answers *"what is this route's ceiling"*. It does **not** answer *"is this route the writer"* — the
repo's standing **name the caller** rule, which needs `pg_proc`, `pg_views`, `cron.job.command`, the
edge fleet and a repo grep, not a regex over one file. Four rows above are exactly that gap showing up.

## 4. What is left of the filed three-step

- **Step 1 — per-route walls: DONE** (`lib/pipeline/route-walls.ts`, 9 tests, mutation-relevant cases
  pinning the three walls that refuted the round-number shortcut).
- **Step 2 — carry `duration_ms` through `PipelineRunRow` → `KillTick`: not done.**
- **Step 3 — report `wallClipped` as a SEPARATE counter, never by redefining `killed`:** not done, and
  the reason to keep it separate is unchanged — the recovery test's null rate depends on `killed`
  meaning what it means today.

⚠ **Before step 2, decide what a pipeline with a wrong map should do.** Silently comparing against the
wrong wall would manufacture four `wallClipped` pipelines out of thin air, which is a worse instrument
than none. The candidate rule is in the module: **above ~1.2 of its wall, report the pipeline as
UNMAPPABLE rather than clipped.**
