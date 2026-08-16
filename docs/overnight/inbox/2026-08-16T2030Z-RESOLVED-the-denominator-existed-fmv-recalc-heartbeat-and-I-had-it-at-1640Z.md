# ✅ RESOLVED — the denominator existed all along: `fmv-recalc-heartbeat`. It was in my own 16:40Z query output and I read it as noise.

Cowork **cloud** session, 2026-08-16 20:30Z / 13:30 PT. **Closes the three-pass thread.** Nothing shipped.

> ⚠ **Scope line.** NO-PUSH is specific to **this cloud Cowork session**. Trevor's machine and Claude Code push normally. **Commit as usual.**

## The answer

| pipeline | last 45 min | last 8 h | failures 8 h |
|---|---:|---:|---:|
| `fmv-recalc` (logs conditionally) | 3 | **22** | 20 |
| **`fmv-recalc-heartbeat`** (logs at `after()` entry) | **6** | **62** | 0 |

**Positive control: the heartbeat's 6-in-45-min matches Vercel's 6 invocations in the same window exactly.** The heartbeat *is* the true invocation counter.

👉 **True failure rate is ~32% (20 of 62), not 100%.** Roughly two-thirds of invocations do real work and die at the **300 s `maxDuration` wall** without advancing the cursor.

## What I got wrong, in order

| pass | claim | verdict |
|---|---|---|
| 16:40Z | "13/13 failed, 0 rows in 8 h — total outage; a saturation casualty" | rate wrong; cause wrong (I trusted the route's own `(saturation-class)` label) |
| 20:15Z | "21/21 across a 10× load swing — deterministic page-0 poison, load-invariant" | **selection artifact.** 21 of ~62, drawn from the fast-fail subset |
| 20:20Z | "`pipeline_runs` is blind to 5 of 6 — the DB cannot reveal this" | true about the route, **false about the platform** — see below |

## ⛔ The actual lesson, and it is worse than a wrong number

**This was diagnosed, documented and MITIGATED two months before I started.** `app/api/fmv-recalc/route.ts` line ~192:

> *"2026-06-11 (Item 3): maxDuration hard-kill heartbeat. fmv-recalc's only failure-visibility is the end-of-run `log_pipeline_run`; a run killed at the 300s cap (the 21:28/21:30Z 06-10 saturation kills, **which did real work per Vercel logs but wrote no pipeline_runs row**) dies before any terminal log and is invisible. Drop a 'started' marker at `after()` entry into a SEPARATE pipeline name…"*

Same failure, same evidence type, same conclusion — and the fix shipped. **I rediscovered it from scratch across three passes and eight hours.**

⚠ **And I had the answer in my hands at 16:40Z.** My own FMV-pipeline survey that morning printed `fmv-recalc-heartbeat — 61 runs, 61 ok, rows_written 0`. **I read "0 rows written" as an idle monitoring no-op and moved on.** It was the denominator.

**How to apply:**
- ⛔ **A pipeline named `<x>-heartbeat` sitting beside the `<x>` you are diagnosing is a DENOMINATOR, not noise.** `rows_written = 0` is what a heartbeat is *supposed* to look like.
- ⛔ **Grep the route's own comments before diagnosing its behaviour.** This repo annotates its scars in-code; line 192 would have ended the investigation in one read. The standing "grep docs/ before designing an experiment" rule extends to **source comments**, which are where the mitigations live.
- ⚠ **My 20:20Z generalisation was itself over-broad** — I wrote that nothing inside the DB could reveal the blindness. **False:** the heartbeat is inside the DB, keyed under a different name. The honest statement is *"`pipeline_runs` filtered to one pipeline name is a sample"*, not *"the DB is blind."* A correction held to a lower bar than the original is how the next error gets in.

## What still stands, unchanged

- **The cursor has not advanced since 06:48:06Z.** `fmv_sweep_wedge_hours` **13.40** vs breach 3 is correct and still climbing. The sweep is genuinely not progressing through the catalogue — **not because everything fails, but because almost nothing finishes.**
- **`fmv_sweep_stall_pct_24h` 53.6 (fired)** — correct, and now known to be computed over the conditional-logging sample.
- **Coverage outage, not an FMV outage.** `refresh_wmc_fmv_changed` keeps repricing anything that trades; the cold tail is what is frozen.
- **The remedy is unchanged and is now better supported: resumability, not budget.** A pass that seeds 1,129 catch-up editions, processes 1,629 and widens 1,233 thin ones cannot finish in 300 s under current IO. **Write `cursor_after` before the wall.** Same conclusion the `refresh_wmc_fmv_drift_active` finding reached today from the opposite direction.

## Structural note — the class is broader than this route

Static survey of the clone: **98 routes call `log_pipeline_run`; 34 of them carry `maxDuration >= 300`; 10 call it exactly once.** ⚠ Heuristic, not proof — a count of call sites does not tell you which exit paths are covered.

**But the sharpest data point argues the count is irrelevant:** `fmv-recalc` has **nine** `log_pipeline_run` sites — more than any other route in the repo, covering success, early exits and error paths — and still lost ~two-thirds of its invocations. **A `maxDuration` kill is not a code path.** No `catch`, no `finally`, no amount of instrumentation density runs after the process is killed. The only thing that works is what 06-11 already did: **write a marker at entry, under a name of its own.**

👉 **Worth checking which of the other 33 long-running routes have a heartbeat sibling, and which are being measured by a sample nobody knows is a sample.** That is a real piece of work, not a five-minute check.
