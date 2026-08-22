# The pg_cron `job startup timeout` class finally has a named cause — and a near-miss that would have frozen a stale MV permanently

**Filed 2026-08-22 ~09:00 PT (16:00Z), Claude Code interactive, triaging an 11-item pipeline alert.
MEASURED. NOTHING SHIPPED — the one fix worth making is blocked by a privilege split, documented in §4.**

---

## 0. ⚠ READ THIS FIRST — the near-miss, because the lesson is worth more than the finding

I had a clean, well-evidenced hypothesis: **jobid 70 (`rpc-refresh-misattrib-candidates`) is redundant
waste — disable it.** 15 of 16 runs failed since 08-07, burning 8,616 s of heavy IO, and jobid 62
appeared to do the same refresh 4×/day. I was one statement from `cron.alter_job(70, active := false)`.

**It was wrong.** jobid 62's full command is:

```
SELECT public.remap_misattributed_topshot_sales(); SELECT public.refresh_topshot_conflated_editions_detector_only()
```

`refresh_topshot_conflated_editions_detector_only()` — **a different function.** My earlier query had
truncated the command at 80 characters, so I saw `SELECT public.refresh_topshot` and inferred the callee
from the prefix. **jobid 70 is the SOLE caller of `refresh_topshot_misattrib_candidates()`.**

🚨 **Disabling it would have made a 6-day-stale MV permanently stale, and I would have written it up as
a cleanup.** CLAUDE.md's rule is stated for exactly this: *read `cron.job.command` to learn what a
schedule calls; never infer the callee from the name — two objects one suffix apart yielded opposite
conclusions.* This is the third recorded instance. ⚠ **The truncation is the sharp edge: `left(command,
80)` silently converts "read the command" into "infer from the prefix."** Select the full column.

---

## 1. The 11 alerts are not 11 problems

| alert | last error | class |
|---|---|---|
| `allday-buyer-backfill` 76.5% | statement timeout | saturation |
| `compute-allday-pack-ev` 69.1% | upstream request timeout | saturation |
| `fmv-recalc` 58.2% | `saturation-class` (self-labelled) | saturation, **known** |
| `populate-pinnacle-wmc-fmv` 72.9% | upstream request timeout | saturation |
| `refresh_wmc_fmv_drift_active` 58.8% | statement timeout | saturation |
| `run-insider-detectors` 61.8% | upstream request timeout | saturation |
| `topshot-fmv-populate` 80.0% | statement timeout | saturation |
| `wallet-username-resolver` 84.2% | connection-pool timeout | saturation-adjacent, see §5 |
| `pgcron-startup-timeout` | worker never launched | **saturation, §2 — the new part** |
| `allday-pack-opens-backfill` 78.9% | `events … status 503` | **upstream 503, NOT saturation** |
| `topshot-active-listings-ingest` 71.4% | `egress_blocked` | **known** — atlas-proxy needs an operator `wrangler deploy` |

**Positive control taken at the same instant, per CLAUDE.md:** `pg_stat_activity` showed **5 of 5**
non-idle sessions in IO wait (`IO/DataFileRead`, `IPC/BufferIo`). So every duration in this window is
uninterpretable and only buffer counts would be comparable. Connections were **44 of 90** — the
Postgres pool is *not* exhausted.

---

## 2. 🚨 The `job startup timeout` class has a cause, and it is a CONFIG MISMATCH nobody has named

```
max_worker_processes   = 6
cron.max_running_jobs  = 32
```

pg_cron runs each job as a **background worker**, drawn from `max_worker_processes` — a pool of **6**,
shared with parallel-query workers and the logical-replication launcher. `cron.max_running_jobs = 32`
tells pg_cron it may run 32 at once. **When more jobs overlap than there are worker slots, pg_cron
cannot launch one and records `job startup timeout` — the function body never runs and nothing reaches
`pipeline_runs`.**

Measured over 24 h:

- **169** startup timeouts across **28 distinct jobs** (the alert saw only its own 30-minute slice: 18/12).
- **Peak concurrent cron jobs: 17.**
- **252 minutes/day above 5 concurrent** — i.e. over four hours a day spent above the worker pool.

⚠ **This explains a condition the ledger has already described twice without naming.** The 2026-08-22
entry recorded *"26 and 83 failed in adjacent minutes — the signature of a global condition"* and left it
there. This is that condition.

⚠ **Precision caveat on my own number:** the concurrency figure expands each run over its start→end
minutes, which also counts runs that themselves died of startup timeout. It therefore overstates
somewhat. The direction is not in doubt (peak 17 against a pool of 6) but do not quote "17" as exact.

⛔ **The lever is NOT raising `max_worker_processes`** — it is compute-tier-linked and needs a restart,
and CLAUDE.md forbids buying the way out. **The lever is reducing overlap: stagger the schedules.** A
concrete first candidate is §3.

---

## 3. jobid 70 — the sole refresher of an MV that has been stale for 6 days

`rpc-refresh-misattrib-candidates`, `35 15 * * *`, owner `cron_heavy`, calls
`refresh_topshot_misattrib_candidates()` → `REFRESH MATERIALIZED VIEW mv_topshot_misattrib_candidates`.

**Since 2026-08-07: 16 runs, 1 success, 15 failures, 8,616 s (2.4 h) of heavy IO burned.** Fourteen are
`canceling statement due to statement timeout` at the 600 s wall; one is `job startup timeout`.

**The MV is stale, and the timestamp proves the mechanism:** `last_autoanalyze` on
`mv_topshot_misattrib_candidates` is **2026-08-16T15:38:36Z** — which is the finish of the single
successful run (08-16 15:35, 188 s). **Nothing has refreshed it in 6 days.**

**Why it started failing.** Its own history shows the job was fine when it was cheap: 07-14 → 08-06 it
succeeded almost every day at **23–589 s** (many around 35 s). The failures begin 08-07 and are
continuous. 15:35Z sits deep inside the measured **01:00–19:00Z** degraded band.

✅ **And the objection that made the cross-collection move "Trevor's decision" does NOT apply here.**
That one was gated on an `ACCESS EXCLUSIVE` lock during the Pacific afternoon on a table the public
board reads. Checked here: `has_table_privilege` is **false for both `anon` and `authenticated`**, **no
view references the MV**, and its only reader is `topshot_misattrib_drain_targets` — an internal drain
feed. **A daytime lock on it is invisible to users.**

**The fix is one line**, and 23Z is the measured-quietest hour (and clear of tonight's 20:15Z/21:15Z
applies and of the proposed 23:10Z/23:25Z moves for jobids 60/4):

```sql
SELECT cron.alter_job(70, schedule := '35 23 * * *');
```

⚠ **Then VERIFY it took** — CLAUDE.md records one occasion where `cron.alter_job(schedule := …)`
silently did not. Read `cron.job_run_details.start_time` for jobid 70 the next day; if it still starts at
15:35Z, `cron.schedule` a fresh job and `cron.unschedule` the old one.

---

## 4. ⛔ WHY IT IS NOT SHIPPED — a privilege split that blocks 42 of 93 cron jobs

Attempted and cleanly refused, twice:

| role | owns job 70? | may EXECUTE `cron.alter_job`? |
|---|---|---|
| `postgres` (what this session runs as) | **no** | yes |
| `cron_heavy` (the job's owner; I am a member) | yes | **no** |

`SET ROLE cron_heavy` → `permission denied for function alter_job`. As `postgres`,
`has_table_privilege('postgres','cron.job','UPDATE')` is **false**, so the direct-catalog fallback is
closed too. **Verified afterwards that nothing changed: jobid 70 is still `35 15 * * *`, active.**

🚨 **This is a general constraint, not a quirk of one job. Job ownership splits 51 `postgres` / 42
`cron_heavy`, and NO session-reachable role can reschedule any of the 42.** ⚠ **The ledger currently
implies otherwise** — the 2026-08-22 entry records a successful `cron.alter_job` on jobids 83/84, which
are `postgres`-owned, and a reader would reasonably generalise that to "we can alter cron jobs."

⛔ **I did not grant `cron_heavy` EXECUTE on `cron.alter_job` to get around this.** That is a privilege
change on the role that runs the heavy fleet, it is off-limits for autonomous action, and it is not
obviously the right fix — the alternative (reassigning job ownership) has different blast radius.
**Trevor's call which, if either.**

**Operator ask:** run the one-liner in §3 from the Supabase SQL editor (which connects with sufficient
rights), or decide the privilege question if this is going to recur — and it will, for any of the 42.

---

## 5. Two items in the alert that are NOT saturation, kept separate on purpose

- **`allday-pack-opens-backfill` — `events 84704498-84704747 status 503`.** An upstream Flow access-node
  503, not a DB symptom. Folding it into the saturation bucket would lose it.
- **`topshot-active-listings-ingest` — `egress_blocked`.** The known atlas-proxy item: it needs an
  operator `wrangler deploy` plus a Cloudflare-egress probe. Unchanged, still operator-gated.
- **`wallet-username-resolver` — `Timed out acquiring connection from connection pool`, 84.2%.** ⚠ Note
  this is the pooler, not Postgres (44/90 connections at the time). ⚠ **And note the interaction with
  today's earlier change:** I re-pointed this pipeline's *cadence* arm from 75→450 min. That arm watches
  cadence only and is **structurally blind to the failure rate** — which is exactly why this failure-rate
  alert still fires, and correctly so. The two instruments are doing their separate jobs.
