# ⚙️ `cron.max_running_jobs` is **32** on a box with `max_worker_processes` = **6** — a 5× overcommit, and it is the `job startup timeout` class — 2026-09-19T12:45Z (05:45 AM PT)

*Cowork cloud, 5:45 AM PT 09-19. **READ-ONLY on this item — nothing shipped for it.** Filed because it is un-owned: the sentinel's `pg_cron Failures (6h)` arm already NAMES `max_worker_processes = 6` in its detail string, but nothing anywhere measures or mentions the `cron.max_running_jobs` side of the pair, and that is the half that is misconfigured.*

## 📏 Measured 2026-09-19 (a dated sample — re-run, do not quote)

```sql
select name, setting, source from pg_settings
where name in ('max_worker_processes','cron.max_running_jobs','max_parallel_workers');
```

| setting | value | source |
|---|---|---|
| `cron.max_running_jobs` | **32** | **default** |
| `max_worker_processes` | **6** | configuration file |
| `max_parallel_workers` | 2 | configuration file |

⭐ **pg_cron will attempt to launch up to 32 concurrent background workers on an instance that has 6 worker processes in total** — and those 6 are shared with parallel workers and other bgworkers. `cron.max_running_jobs` is at its stock default; nobody chose 32 for this box. **The Small compute tier's worker budget was never reflected into pg_cron's concurrency limit.**

## 🔎 The failure it produces, and why it is NOT the same thing as a statement timeout

A `job startup timeout` means pg_cron could not obtain a worker slot. ⛔ **The job NEVER RAN** — its body never executed, so `log_pipeline_run` never fired and `pipeline_runs` has no record of it at all. That is categorically different from `canceling statement due to statement timeout`, where the job ran and was cut at its budget.

📏 **Over the 30 h to 12:00Z:** 37 `job startup timeout` runs, every one a distinct job. They are **bursty, not diffuse** — 0 in most hours, then 5–7 in a single hour.

📏 **And they cluster on colliding minutes**, which is the actionable part:

| minute of hour | starved runs |
|---|---:|
| **:10** | **15** |
| :30 | 9 |
| :20 | 7 |
| :39 | 7 |
| :51 | 6 |

⇒ **Jobs scheduled on the same round minute contend for the 6 slots and the losers never run.** Several were observed sharing an identical `start_time` to the microsecond (e.g. `2026-09-19 04:39:00.000321` across `rpc-topshot-moments-hydrate-chain`, `rpc-atlas-editions-drain`, `rpc-allday-pack-sales-backfill`, `rpc-refresh-candy-treasury-wallet`, `rpc-allday-pack-opens-forward`).

## 👉 Two candidate levers — ⛔ NEITHER SHIPPED, and the first is NOT the obvious one

1. **STAGGER the colliding minutes.** Move jobs off `:10`, `:30`, `:20`, `:39`, `:51` onto neighbouring odd minutes. ✅ Low risk, no config change, one `cron.alter_job` each, individually revertible. ⚠ **But check each job's own schedule semantics first** — the 09-18 `rpc-ccm-step2-retry` incident showed a schedule change is **not local**: an age-guarded follower silently changed meaning when its producer moved. **Grep for age-guarded followers before moving any producer.**

2. **Lower `cron.max_running_jobs` toward the real worker budget.** ⚠ **Do NOT ship this without thinking it through, and it may be a no-op or worse:** pg_cron does not QUEUE past the limit, it declines to start. Lowering it converts "job starved after being launched" into "job not launched", which may simply relabel the same loss. ⛔ It is also a `postgres.conf`/ALTER SYSTEM change likely needing a restart on Supabase, so it is **not** a sandbox action. **Its real merit would be making the failure honest rather than fewer** — that needs a measurement nobody has taken.

## ⚠ Explicitly NOT claimed

- **No claim that starvation is a large share of failures.** Over 6 h it was **18 startup timeouts against 95 statement timeouts** — the statement-timeout class (R108's seq scan, the Atlas lanes) is far larger. This is the *smaller, structurally sillier* problem.
- **No claim that 37/30 h is user-visible.** Not established. A starved `rpc-trust-health-history` or `rpc-pinnacle-mints-backfill` tick is one missed sample, not an outage.
- ⚠ **A starved job is INVISIBLE to every `pipeline_runs`-based arm** (its body never ran), so `detect_stalled_pipelines` sees only the resulting silence and the cause is not in the record. **`cron.job_run_details` is the only place this class exists.** That is worth knowing before anyone tries to explain a silence gap from `pipeline_runs` alone.

## 🔬 Falsifier / what to read first

1. Re-run the `pg_settings` query — if `cron.max_running_jobs` is no longer 32, this filing is stale.
2. Re-run the minute-of-hour histogram over a fresh 30 h. If the `:10` spike is gone without anyone staggering anything, the clustering was an artifact of that window and the lever dissolves.
3. Split the two classes with `return_message ilike '%startup timeout%'` vs `'%statement timeout%'` — **never report a single `failed` count for this instrument**, since the two have opposite causes and opposite fixes.

---

## 🔬 FALSIFIERS RE-RUN 2026-09-20T03:2xZ (8:2x PM PT 09-19) — Claude Code, Windows box

*All three of this filing's own falsifiers, answered 15 h later. **One fires: the stagger lever dissolves.** Nothing was staggered, tuned or shipped in between — the only schedule changes tonight were jobid 324 (`48` → `31 0,6,12,18`) and four new jobs, none on the minutes below.*

**1. `pg_settings` — filing NOT stale.** `cron.max_running_jobs` = **32** (`default`), `max_worker_processes` = **6** (configuration file), `max_parallel_workers` = **2**. Unchanged. The 5× overcommit stands.

**2. 🚨 THE MINUTE-OF-HOUR HISTOGRAM — THIS FALSIFIER FIRES.** Fresh 24 h to 03:20Z, `return_message like 'job startup timeout%'`:

| minute | starved | distinct jobs | | minute | starved | distinct jobs |
|---|---:|---:|---|---|---:|---:|
| :30 | 16 | 8 | | :42 | 9 | 9 |
| :51 | 15 | 6 | | :39 | 9 | 7 |
| :50 | 15 | 7 | | :52 | 9 | 9 |
| :10 | **14** | 7 | | :12 | 8 | 8 |
| :18 | 14 | 7 | | :29 | 8 | 4 |
| :09 | 12 | 8 | | :17 | 7 | 7 |

⛔ **`:10` is no longer a spike — it is FOURTH, at 14 against a flat 7–16 across at least twelve minutes, and nobody staggered anything.** This filing's own condition is met verbatim: *"the clustering was an artifact of that window and the lever dissolves."* ⛔ **LEVER 1 (STAGGER) SHOULD NOT BE SHIPPED** — it was sized against a concentration that no longer exists, and moving jobs off five minutes cannot help a loss spread across twelve. ⭐ **Corroborating, and cheap: of ACTIVE hourly jobs the most crowded minute-field carries FOUR jobs (`*/2`), then three (`47`) — the schedule is not densely collided to begin with.**

**3. The two classes, split as instructed** (never one `failed` count): in the 03:05–03:20Z window, **10 startup timeouts vs 4 statement timeouts**. ⚠ **Note the ratio INVERTED versus this filing's 6 h sample of 18 : 95** — one window, not a trend, but it means "the smaller problem" is not reliably the smaller one.

### ⭐ What replaces the stagger hypothesis: OCCUPANCY, not COLLISION

📏 **Measured at the 03:18:00.001158Z instant, where SEVEN jobs failed to start in the same microsecond: only FOUR cron jobs were mid-flight.** Four running against six total worker processes — which are shared with parallel query workers (`max_parallel_workers` = 2) — leaves ~0–2 slots, so **seven arrivals starve without any two of them having to collide with each other.** ⇒ **The binding term is how many LONG-RUNNING jobs are already holding workers, not how many jobs share a round minute.** That is why the distribution flattened: under #126 (fleet busy-seconds 34,236 on 09-15 → 233,894 on 09-19 at flat run counts) every job holds its worker ~10× longer, so occupancy is high at *every* minute rather than spiking at a few.

👉 **THE LEVER FOLLOWS THE MECHANISM: reduce job DURATION or job COUNT (i.e. #126), or raise the worker pool — not minute placement.** ⚠ **And the second lever this filing describes gets stronger, not weaker:** with occupancy dominant, lowering `cron.max_running_jobs` toward the real slot count converts a silent starve into an honest decline — still a restart-class change, still not a sandbox action.

⚠ **MEASURED vs INFERRED, kept apart.** Measured: the settings, the 24 h histogram, the four-mid-flight/seven-refused instant, the class split. **Inferred and NOT directly observed: that the worker pool was actually exhausted at that instant** — there is no instrument here that reports free bgworker slots, so the pool-exhaustion step is read off the config plus the concurrency count, not seen. ⛔ **A future session should not upgrade that to "measured" without an instrument that shows the slots.**
