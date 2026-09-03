# A killed tick can carry a CLEAN heartbeat correlation — measured 90 minutes after converting the route

**Filed 2026-09-03 ~01:00 PT (08:00Z) by Claude Code. Doc corrections shipped; the instrument change is
NOT shipped and is described below.**

## The observation, one tick, both sides

`app/api/cron/evm-transfers-ingest` was given an invocation marker at ~07:01Z tonight. At **07:34:26Z**:

| source | says |
|---|---|
| Vercel | `GET /api/cron/evm-transfers-ingest 200 [error]` — **`Vercel Runtime Timeout Error: Task timed out after 60 seconds`** |
| `pipeline_runs` | marker `evm-transfers-ingest-heartbeat` at 07:34:26.210Z; terminal row same start, **`ok = true`**, **`duration_ms = 60,464`** against a **60,000 ms** wall |

⭐ **The platform killed that invocation and the correlation is clean.** The terminal write raced the
wall and won, so `lib/pipeline/kill-rate.ts` scores the tick as healthy.

## What that narrows

`lib/pipeline/heartbeat.ts` said `heartbeat + terminal row -> ran to completion`. **Too strong.** The
test answers *"did a terminal row land"*, never *"did the invocation survive"* — and those coincide only
when the row is written well before the wall, which is the common case and not the interesting one.
Both headers now say so, with this tick as the evidence.

⚠ **The under-count is SILENT**, which is what makes it worth a filing rather than a footnote: a
`healthy` verdict from `classifyKillRecord` now has a known failure mode and nothing surfaces it.

## The fix, named rather than half-done

The discriminator is already in the row: **`duration_ms` at or beyond the route's own `maxDuration`.**
It is not wired into the classifier because that module **has no per-route wall to compare against** —
the walls live in `export const maxDuration` in each route file. A fleet-wide constant would misclassify
every short-wall route (walls in use: 30 s, 60 s, 120 s, 300 s, 800 s), so the work is:

1. read `maxDuration` per route from source, keyed by the route's pipeline name(s);
2. carry `duration_ms` through `PipelineRunRow` → `KillTick`;
3. report `wallClipped` as a **separate counter**, not by redefining `killed` — the existing semantics
   are load-bearing for the recovery test and should not shift under it.

⚠ Step 1 is the hard half: the pipeline name is a string constant in the route and the mapping is not
recorded anywhere machine-readable today.

## ⓘ A SECOND question this turned up, deliberately not answered

That tick ran **60.4 s** while the route's own `BUDGET_MS` is **25 s** — and **every** neighbouring tick
in the preceding three hours ran **25.1–25.6 s** (12 consecutive, `topshot_bridged_flow_evm`). So one
tick took 2.4× its internal budget and nothing inside stopped it.

⛔ **n = 1. Not a finding.** The candidates are an unbounded await inside the budget loop, a single
upstream call that hung, or instance contention. The cheap next step is to catch another one:
`duration_ms > 30000` on that pipeline is currently a one-row query.

## ⭐ And it is the censored-maximum point from the other side

That route was selected for conversion on a measured `max(duration_ms)` of **26,195 ms** — the true tail
was hidden precisely because killed ticks wrote nothing. **The first hour of observation after the
marker landed produced a tick at the wall.** The selection rule was right and its own input was
understated, which is what "censored by construction" means in practice.
