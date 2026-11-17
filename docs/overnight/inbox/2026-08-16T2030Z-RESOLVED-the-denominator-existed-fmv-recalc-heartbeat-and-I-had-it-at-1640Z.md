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

---

## ⛔ CORRECTION #4 (20:40Z) — the sweep RECOVERED UNAIDED at 20:15:36Z, fifteen minutes before I filed "the cursor has not advanced"

**Nothing was shipped. Nobody touched it. It cleared itself.**

| | 20:30Z (this filing) | 20:40Z (measured) |
|---|---|---|
| `fmv_sweep_wedge_hours` | 13.40 vs breach 3 | **0.04** |
| cursor | "not advanced since 06:48:06Z" | **2000 and advancing** |
| last 40 min | — | **4 ok, 1 fail** |

```
20:08:07  ok=false  0    -> 0      500 found,    0 written   38.2s  step1b_refetch_empty
20:15:36  ok=TRUE   0    -> 500   1629 found, 1627 written  262.3s   <-- broke through
20:28:05  ok=true   500  -> 1000   500 found,  499 written  113.8s
20:33:25  ok=true   1000 -> 1500   499 found,  498 written  124.8s
20:35:35  ok=true   1500 -> 2000   498 found,  497 written  133.0s
```

**The mechanism, and it is the one thing all four passes were circling.** At 06:48:06Z the sweep finished the catalogue and **wrapped to offset 0**. Page 0 of a fresh pass is not a normal page: it carries the accumulated 90d catch-up seeds and thin-edition widening, so it is **1,629 editions of work against a normal page's ~500** — roughly 3×. Every attempt for 13.5 h either fast-failed in the sales refetch (`step1b_refetch_empty`, a **load-sensitive** statement timeout) or ran past the 300 s wall. At 20:15:36Z one invocation caught a quiet enough IO window to push the oversized page through in **262.3 s — 38 seconds of headroom**. Once past it, pages are normal and clear in ~120 s.

⚠ **So my FIRST read (16:40Z, "saturation") was closer than my confident correction of it (20:15Z, "deterministic page-0 poison, load-invariant").** The failures really were load-sensitive; what the poison hypothesis got right was that page 0 was special, and what it got wrong was *why*. **I swung to a single-cause story twice.** The truth needs both: the wrap makes page 0 abnormally expensive, and saturation decides whether any given attempt clears it.

⚠ **And this filing asserted "the cursor has not advanced" at 20:30Z when it had advanced at 20:15:36Z** — the row was in `pipeline_runs` ten minutes before I wrote the sentence. I carried a cursor reading forward from the 20:15Z pass instead of re-reading it. **The exact "a countdown, not a state" error I criticised two files earlier in this same thread.** Re-measure the live number in the pass that publishes it.

ⓘ Reading trap for whoever checks next: **`cursor_after` is TEXT**, so `max(cursor_after)` is lexical — `'500' > '1000' > '11500'`. Cast to int.

## What this changes for the remedy

- ⛔ **There is no live outage. Do not open one, and do not page on the 13.40 reading** — it is stale by ~14 hours.
- **Resumability (write `cursor_after` before the wall) is still the right structural fix, but it is NOT urgent.** The fragility is real and **will recur at every wrap**: an oversized page-0 that can only clear by winning an IO lottery is a ~13 h coverage stall every time the catalogue completes. Worth fixing on merit, on a normal schedule.
- **The heartbeat lesson is untouched and is the durable one.** `pipeline_runs` remains a fast-fail census for this route — 47 invocations vs 18 terminal rows in the last 6 h — and `fmv-recalc-heartbeat` remains the denominator.
- **`fmv_sweep_stall_pct_24h`** is a 24 h trailing window, so it will stay elevated for the rest of the day on the strength of an outage that has ended. **Expected, not a new signal.**
