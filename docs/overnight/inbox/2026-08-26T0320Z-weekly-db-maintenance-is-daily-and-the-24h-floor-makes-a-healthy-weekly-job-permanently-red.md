# ⭐ SHIPPED — `weekly-db-maintenance` is DAILY, and the 24h floor was marking a perfectly healthy WEEKLY job red ~6 days in 7

- **When:** 2026-08-26 ~03:20Z (2026-08-25 20:20 PT), Claude Code interactive.
- **How it was found:** applying the [dispatch/landing discriminator](2026-08-26T0210Z-the-golazos-scheduler-skip-is-refuted-22pct-of-all-pg-net-dispatches-time-out.md) to the **live** `detect_stalled_pipelines()` alert set instead of to golazos alone.

## 1. The live alert set, classified

`detect_stalled_pipelines()` was reporting three. Applying the discriminator:

| pipeline | verdict | evidence |
|---|---|---|
| **`weekly-db-maintenance`** | 🚨 **TRUE POSITIVE** | jobid 198 `40 9 * * *` — **failed 3 of the last 5 days with `job startup timeout`** |
| `allday-pack-opens-backfill` | ⓘ known FALSE POSITIVE | its finite walk is done — [standing filing](2026-08-24T1507Z-allday-pack-opens-cron-silent-arm-is-a-false-positive-now-the-finite-walk-is-done.md) |
| `candy-listings-indexer` | ⓘ not classified here | last ran 08-25 06:35Z; left for a separate pass |

⭐ **The nightly pass's own falsifier has FIRED.** Its 08-25 handoff said *"weekly-db-maintenance … missed its 08-24 daily tick, self-heals 09:40Z — **watch for a second miss**"*. `cron.job_run_details` for jobid 198: 08-21 **failed**, 08-22 succeeded, 08-23 succeeded, 08-24 **failed**, 08-25 **failed** — all three failures `job startup timeout`, the `max_worker_processes`=6 vs `cron.max_running_jobs`=32 starvation class.

⚠ **This also SHARPENS the discriminator:** worker starvation produces **either** no `job_run_details` row at all (the jobid 288 case) **or** a row with `status='failed'` and `return_message='job startup timeout'`. Both mean *never started*; only the second is greppable.

## 2. ⛔ The consequence I expected is FALSE — measured, not assumed

`run_weekly_log_purges()` calls `purge_old_pipeline_runs()`, so the obvious inference is that `pipeline_runs` retention has been unenforced for two days. **It has not.** Oldest row is **74.0 h**, exactly on the documented ~73 h. The reason: **`prune_pipeline_runs()` has its OWN active cron** — `rpc-prune-pipeline-runs @ 41 */6 * * *` — and *that* is what holds retention. Three different functions delete from `pipeline_runs`; only one is scheduled directly.

**The real consequence is the OTHER purges** (`debug_logs`, `smoke_test_results`, `usage_events`, `support_conversations`, the failure tables) and it is **minor**: ~30 MB total, largest `smoke_test_results` at 20 MB / 110k rows. **Not urgent.**

## 3. ⭐ TWO instrument bugs found while confirming the cadence — both SHIPPED

### (a) The name is vestigial, and its twin proves you must read the schedule

`app/api/admin/pipeline-health/route.ts` declared:

```ts
"weekly-db-maintenance": 60 * 24 * 7,   // ⛔ 7 days — but jobid 198 is `40 9 * * *` = DAILY
"weekly-wmc-prune":      60 * 24 * 8,   // ✅ 8 days — jobid 199 is `20 10 * * 0` = WEEKLY (Sun)
```

**Two entries, identical shape, identical naming convention, and only one was right.** Nothing but `cron.job.schedule` separates them — the repo's *"never infer the callee from the name"* rule, with a matched pair as the illustration. Fixed to `60 * 24`.

### (b) 🚨 The 24h floor silently overrode EVERY long-cadence expectation

`classify()` ran `if (minutesSince > 24 * 60) return red` **before** the 2×/5× multiples, unconditionally. Consequences:

- For any entry with `expectedMin >= 720`, the **yellow branch is unreachable** (2× is already ≥ 24 h) — the declared cadence was **inert**.
- A genuinely **weekly** pipeline read **RED from 24 h after each run until the next one** — **~6 days in every 7, by construction, while running perfectly.**
- ⚠ **Measured, not theorised:** `weekly-wmc-prune` ran exactly on schedule on Sunday 08-23 10:20Z and reads **RED** ~65 h later.
- For every entry with `expectedMin <= 288` the floor was **already redundant** (5× is under 24 h, so the multiple fires first). **It only ever changed the answer where it was wrong.**

**A permanently-red instrument is indistinguishable from a broken one at a glance** — this repo's own named failure class, and the reason a real outage gets skimmed past. Now scoped: `if (expectedMin <= 24 * 60 && minutesSince > 24 * 60)`.

⚠ **And I had this wrong first.** I initially concluded pipeline-health *"reports weekly-db-maintenance green while the cadence arm alerts"*. **False** — the unconditional floor already reds it. **Reading `classify()` rather than publishing the tidy story is what caught it**, and the real defect turned out to be the more interesting one.

## 4. The tests are a PAIR, and both directions were run

- Unconditional floor (the original) → **the weekly case goes red**.
- Floor **deleted outright** (the naive over-fix) → **the daily control goes red**, plus the pre-existing tier test.
- Correct scoping → **9/9 green**.

**A fix that simply removed the floor passes the first test and fails the second**, which is exactly what the control is for. The pre-existing assertion (`weekly-db-maintenance` → red at 2000 m) **still holds unchanged** — only its comment, which asserted the wrong *reason*, was corrected.

## 5. Still open

- ⛔ **The starvation itself is NOT fixed.** jobid 198 will keep failing ~60% of days until `max_worker_processes` / `cron.max_running_jobs` is addressed. **That is a platform-capacity decision, not a code fix** — filed, not shipped.
- ⓘ `compute-golazos-pack-ev` and `compute-pinnacle-pack-ev` are **absent from `EXPECTED_INTERVAL_MIN` entirely**, so pipeline-health is silent about both. Adding them is a behaviour change that would light up golazos while its cause is unresolved — **flagged, deliberately not shipped.**
- ⓘ `candy-listings-indexer` unclassified.
