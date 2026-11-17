# 45 scheduled pipelines skipped 66 ticks inside one two-hour band, and no alert on this platform could fire

> 🟠 **PARTLY RESOLVED 2026-09-03 (late PT) — the CALIBRATION SERIES this filing said it lacked now exists; the ARM still does not.** Migration `20260904024810`: `pipeline_gap_hourly` + `rollup_pipeline_gaps(3)` on pg_cron jobid 443 (`7 * * * *`) persists, hourly, exactly the derivation in §Reproducing it (the p90/p10 ≤ 1.25 scheduled population, derived; skipped = round(gap/median) − 1 above 1.5× median), per-pipeline rows where something happened plus a `_all_` row every hour. First run: 99 scheduled, ~320 ticks/h expected, 1 skipped/h (`pinnacle-nft-resolver`), 0 silent — the boring baseline. ⛔ Do not write the arm off the first few days; the filing's own point is that one event cannot place the line. Ledger 2026-09-03.

**Filed 2026-09-03 ~03:00Z (2026-09-02 PT) by Claude Code. Measured, not inherited.**
**Status: MEASUREMENT ONLY — no code shipped for this. The remedy is argued below, not built.**

---

## ⛔ CORRECTION BUILT IN: two earlier readings of this same data were WRONG, and both are recorded

I am putting the retractions above the finding because both are the shapes this repo keeps paying
for, and the finding is only worth anything because the controls killed the first two versions.

**v1 — "a fleet-wide one-hour OUTAGE."** Refuted by an adjacent-day volume control:
`pipeline_runs` rows in 04:30–06:40Z on 2026-09-01 were **1,093**, against **1,114** in the same
window 24 h earlier and **1,166** 24 h later — a 2–6 % dip, not an outage. And `cron.job_run_details`
ticked **366 vs 372**, so the DB-side scheduler was untouched. *Nothing stopped.*

**v2 — "118 pipelines missed 11,504 ticks."** That number is garbage and the mechanism is worth
recording: the detector took each pipeline's MEDIAN inter-run gap as its schedule, and for
**event-driven** pipelines (`wallet-backfill` is per-wallet, not per-tick) the median gap is
seconds, so `gap / median` explodes into thousands of phantom "missed ticks". ⭐ **A gap is only a
missed tick for something that is actually on a clock**, and nothing in `pipeline_runs` says which
rows those are.

---

## The measurement that survives

Restrict to pipelines that are demonstrably **on a schedule** — ≥ 20 recorded gaps and a tight gap
distribution (**p90/p10 ≤ 1.25**), which is a property of the data rather than a curated list. That
leaves **94 of the ~128 pipelines** with rows in the retained window.

Missed ticks per UTC hour, over the whole 73 h `pipeline_runs` retains:

| hour (UTC) | scheduled pipelines missing ≥1 tick | ticks missed |
|---|---|---|
| **2026-09-01 04:00** | **28** | **43** |
| **2026-09-01 05:00** | **16** | **23** |
| 2026-08-31 20:00 | 5 | 5 |
| 2026-09-02 10:00 | 3 | 4 |
| 2026-08-31 15:00 | 3 | 3 |
| *(every other hour)* | ≤ 3 | ≤ 6 |

**The 04:00–06:00Z band on 2026-09-01 is ~6× the worst other hour in three days.** Within it:

- **45 gap events across those pipelines, 66 ticks missed**
- first missed tick **2026-09-01 04:06:19Z**, everything recovered by **06:37:07Z**
- longest single gap **120 min**
- **20 of the affected pipelines are on the active `pipeline_cadence_watchlist`**
- 🚨 **`would_have_alerted` = 0.** Every gap was SHORTER than that pipeline's own
  `max_silent_minutes`, so not one of them tripped `cron_silent` or `detect_stalled_pipelines()`.

⚠ Note how the two controls fit together rather than contradicting: total row volume barely moved
**because the misses land on LOW-FREQUENCY pipelines**, whose ticks are a rounding error in a count
dominated by the 10- and 15-minute jobs. A volume check structurally cannot see this; a per-pipeline
gap check can. That is the whole reason v1 read "no outage" and this reads "a real correlated event".

⛔ **The cause is NOT established.** No deploy landed in the window (`git log` over
2026-09-01 03:00–08:00Z is empty), pg_cron was unaffected, and only ~5 rows in the window carry
`ok=false` — so the ticks were not *failing*, they were *not arriving*. That points at the HTTP
scheduling side (cron-job.org / the platform in front of the routes) rather than at any route, but
**I have not confirmed it and this filing does not claim it.**

---

## Why it is worth a register row

`get_pipeline_alerts_core` already has an arm for exactly this SHAPE on the other scheduler:
`pgcron_startup_timeout` fires at **≥ 5 correlated pg_cron launch failures in a rolling 30 min**,
precisely because a lone one is noise and a cluster is an incident. Its own comment says so.

**There is no equivalent on the HTTP-scheduled side.** Every arm there is per-pipeline
(`cron_silent`, `failure_rate`, `running_but_not_succeeding`), and a per-pipeline silence window can
only see an outage LONGER than one pipeline's own tolerance. A correlated dip that touches 28
pipelines for 40 minutes each is invisible to all of them at once — which is what 2026-09-01
demonstrates with `would_have_alerted = 0`.

**Sketch of the arm, deliberately NOT shipped here:** count scheduled pipelines (the p90/p10 ≤ 1.25
population, derived — never a list) whose newest gap exceeds 1.5× their own median inside a rolling
window, and fire at a threshold calibrated on the table above. ⚠ **The threshold needs a proper
calibration pass**, not the one sample in this filing: three days of data with one event in it can
tell you 28 is an outlier and cannot tell you where the line goes. And ⚠ **`pipeline_runs` retains
only ~73 h**, so a calibration has to be assembled over time or read from `pipeline_runs_daily`,
which is six-hourly and cannot resolve a 40-minute band at all.

## Reproducing it

Everything above comes from `pipeline_runs` alone, in one statement per number, via
`mcp__Supabase__execute_sql`. The scheduled-population filter is the load-bearing part:

    prof AS (SELECT pipeline, count(*) n,
                    percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_min) p50,
                    percentile_cont(0.1) WITHIN GROUP (ORDER BY gap_min) p10,
                    percentile_cont(0.9) WITHIN GROUP (ORDER BY gap_min) p90
             FROM gaps GROUP BY 1),
    sched AS (SELECT * FROM prof WHERE n >= 20 AND p10 > 0 AND p90 / p10 <= 1.25)

Drop that filter and you get v2's 11,504.
