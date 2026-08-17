# `candy-editions-ingest` — the runtime is unbounded on fixed work, and the maxDuration lever is exhausted

**Filed 2026-08-17 00:30Z (2026-08-16 17:30 PT), Claude Code interactive. Nothing shipped for this item; the heartbeat that shipped alongside it makes the failure *visible*, not *fixed*.**

## What is established

The route's work is **fixed and unchanging**, and its runtime is not. `pipeline_runs_daily` over 17 days, `rows_found` **27,876** and `rows_written` **28,483** on *every single run*:

| day | duration | | day | duration |
|---|---|---|---|---|
| 07-30 | 68.5 s | | 08-08 | 139.4 s |
| 07-31 | 61.4 s | | 08-09 | 87.5 s |
| 08-01 | 71.4 s | | 08-10 | 216.9 s |
| 08-02 | 197.4 s | | 08-11 | **475.0 s** |
| **08-03** | **no row** | | 08-12 | 73.4 s |
| 08-04 | 89.3 s | | 08-13 | 84.0 s |
| 08-05 | 280.6 s | | 08-14 | **461.6 s** |
| 08-06 | 227.4 s | | 08-15 | **507.6 s** |
| 08-07 | 81.2 s | | **08-16** | **no row** |

Identical input, an **8×** spread in runtime, and two days with no terminal row. This is the platform-wide disk-IO contention documented in CLAUDE.md, not data growth.

## Why the obvious lever is gone

`maxDuration` was already raised **300 → 800 on 2026-08-04** for exactly this failure. **800 s is the hard Vercel Pro ceiling**, and the route header records that breaching it sends the deploy to ERROR *invisibly* (build logs read "Compiled successfully"). So there is no clock left to buy. This matches CLAUDE.md's standing rule for the analogous `fmv-recalc` case: **the lever is the WORK, never the clock** — and a longer run holds a pooled connection longer on the very instance whose saturation caused the timeout.

## ⚠ Do not start from "it was killed" — that is NOT established

A first pass diagnosed 08-16 as a kill at the wall and **that was refuted the same session**. The walk's last write (`wallet_moments_cache`) landed 130 ms after the `editions` write used as evidence, so **the walk completed**. Three mechanisms remain consistent and indistinguishable:

1. killed during the post-walk `wmc` metadata denorm,
2. killed during `logRun`,
3. **the run finished normally and `logRun`'s RPC failed, swallowed by its deliberately non-fatal catch.**

(3) means the pipeline is healthy and only telemetry was lost — the opposite operational conclusion. **Establish which before optimising anything**; a throughput fix aimed at a telemetry failure would be wasted work.

## Cheapest next step (not taken)

A **post-walk phase marker** — one extra `pipeline_runs` row (or an `extra.phase` update) written between the end of the walk and `logRun`. That single row separates (1) from (2)/(3) immediately, and a **retry on the logging call** separates (3) from (2). Both are small; neither was in scope for the heartbeat ship.

## If it does turn out to be throughput

The work is a full re-upsert of ~28.5k rows daily against a catalogue that has not changed in 17 days. Candidates, in order of how much they respect the "lever is the work" rule:

- **Incremental upsert** — skip assets whose DAS payload is unchanged since `last_seen_at`. Biggest win, most design.
- **Smaller `UPSERT_CHUNK`** (currently 500) — ⚠ CLAUDE.md records that this exact remedy was already tried and *measured as refuted* on `fmv-recalc` (`corr(rows_written, duration_ms) = 0.103`). **Read that first**; do not re-apply a remedy this repo has already disproved on a sibling.
- **Split the walk across invocations** with a cursor, as the sales indexers do.

## Impact bound, stated honestly

User-facing impact is **low**: the catalogue is static, so a missed refresh changes nothing a collector sees. The cost is that the arm cries wolf and a real Candy catalogue change (Drop 3) could be delayed by up to a day. The reason to fix it is that a pipeline nobody can trust the telemetry of is one nobody checks.
