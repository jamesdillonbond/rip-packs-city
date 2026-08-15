# `fmv-recalc` is not running less — it is being KILLED at maxDuration, and nothing watches that

**Filed 2026-08-15 16:00Z / 09:00 PT (Claude Code, interactive).** Diagnosis complete; the two remedies below
need a lane I stayed out of (FMV pipeline tuning + a DB alarm consumer).

---

## The finding

CLAUDE.md records the 08-14 `fmv-recalc` anomaly as **two** regressions, and calls the second one unexplained:

> runs/day **HALVED (93 → 41)** … ⚠ the halved run count is the more alarming half and is **NOT** explained by
> the failure rate — fewer runs were *started*, so look at the scheduler and the 800 s lambda ceiling.

**That inference was wrong, and the correction is the point: `pipeline_runs` counts SURVIVORS, not invocations.**
`fmv-recalc` writes its terminal row at the END of the run, so a run killed at the 300 s cap writes nothing —
it does not appear as a failure, it disappears entirely.

The route already carries the instrument that proves this: a **`fmv-recalc-heartbeat`** marker inserted at
`after()` entry (added 2026-06-11), detectable as a kill by the NOT-EXISTS correlation documented in its own
comment. Running that correlation:

| day | terminal rows | **killed at maxDuration** | total invocations | **% killed** | rows written |
|---|---|---|---|---|---|
| 08-12 | 87 | 54 | 141 | 38.3% | 41,617 |
| 08-13 | 93 | 69 | 162 | 42.6% | 45,054 |
| **08-14** | **41** | **124** | **165** | **75.2%** | **10,684** |
| 08-15 (partial) | 40 | 69 | 109 | 63.3% | 18,720 |

**Total invocations are flat (141 → 162 → 165). The scheduler never changed. What collapsed is the COMPLETION
rate** — on 08-14 three of every four invocations were killed before writing a terminal row. So there is one
regression, not two, and it is the saturation already documented: runs that used to fit inside 300 s no longer do.

⚠ **Each kill still did real work** (the heartbeat comment records this from the 06-10 incident: killed runs
"did real work per Vercel logs but wrote no pipeline_runs row"). So `rows_written` in `pipeline_runs_daily`
**undercounts actual FMV throughput by roughly the kill rate** — the 10,684 figure is the survivors' output only.
Do not read it as total repricing.

## Why nobody noticed

**The kill-detection query exists only as a COMMENT.** Nothing executes it — not the sentinel, not
`v_rpc_trust_health`, not `detect_stalled_pipelines` (which watches cadence, and cadence is perfect here: the
cron fires reliably; it is the work inside that dies). A 75% kill rate is invisible to every instrument on the
platform, and the one visible symptom — the run count halving — reads as a *scheduling* problem, which is
exactly the wrong place to look.

This is the same shape as the `refresh-insights-cache` finding from earlier today: **a per-tick outcome cannot
express a cumulative quantity**, and here it cannot even express its own existence.

## Remedies — NOT taken

1. **Make the kill rate observable.** Cheapest honest version is a TRACK-only metric over the existing
   correlation (it is index-served on `pipeline_runs_pipeline_started_idx`), promoted to a trust arm once a
   baseline exists. ⚠ Calibrate on the kill rate, **not** on run count — the run count is the misleading
   symptom. ⚠ And note the correlation needs `started_at < now() - 10 min` or in-flight runs count as kills.
2. **Make runs fit inside 300 s.** The lever is `edition_limit` / page size per invocation — FMV pipeline
   tuning, which changes repricing cadence and is not a change I should make unilaterally. A smaller page
   completing is strictly better than a larger page being killed, since a killed run's work is not recorded and
   its cursor does not advance.

⚠ **Do not "fix" this by raising `maxDuration`.** Vercel Pro's hard cap is 800 s and CLAUDE.md records that
exceeding it sends the deploy to ERROR **invisibly**; and a longer run holds a pooled connection longer on the
2 GB instance that is already the bottleneck, which feeds the saturation causing the kills.

## Shipped alongside (safe, telemetry only)

Both start-marker writers omitted `finished_at`. Since `duration_ms` is `GENERATED ALWAYS AS
(finished_at - started_at)` and `finished_at` is `NOT NULL DEFAULT now()`, every unfinished marker was
publishing **the latency of its own INSERT** as the run's duration — 514 `fmv-recalc-heartbeat` rows spanning
42 ms–56 s, and drain-conflated-subeditions' 147/176/185 ms.

⚠ **That number already caused a wrong diagnosis**: deep-audit run 2 read those 147–176 ms as the drain route
"dying instantly", when it is running to its 300 s ceiling and being killed — the opposite conclusion, pointing
at a different fix. Both markers now pin `finished_at = started_at`, so `duration_ms` is a hard **0**: an
obvious sentinel that cannot be misread as a measurement. Guarded by
`__tests__/pipeline-start-marker-duration-is-not-a-measurement.test.ts`, which scans for the marker pattern
rather than naming files, so a new marker writer is covered the day it lands.

⚠ One deliberate loss: the 56 s marker-insert outlier was incidental evidence of connection-acquire saturation.
It was **not labelled as such and was indistinguishable from a run duration**, which is the whole harm. If
insert latency is wanted, measure it deliberately into `extra`.

## Correction to a claim in CLAUDE.md

CLAUDE.md says `fmv-recalc`'s `extra` carries no `cursor_before`/`cursor_after` keys, which is true, but it was
written in a way that implies cursor progress cannot be measured. **It can** — those are real COLUMNS on
`pipeline_runs`, populated on 201/201 and 194/201 `fmv-recalc` rows, with 157 showing an advance. Read the
columns, not `extra`.
