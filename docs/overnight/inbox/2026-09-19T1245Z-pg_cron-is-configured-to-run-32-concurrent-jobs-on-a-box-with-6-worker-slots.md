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
