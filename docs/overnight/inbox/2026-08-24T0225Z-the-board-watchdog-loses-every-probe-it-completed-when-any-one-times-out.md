# ⛔ The public-board watchdog discards ALL completed probes when any single board times out — and a "succeeded" tick covered 6 of 45

**Filed:** 2026-08-24 02:25Z (19:25 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** MEASURED, **NOT fixed** — and deliberately so, see the last section.

## What the history table says

`public_board_liveness_sweep` runs `28 */6 * * *` (jobid 288) over **45 active boards**. Five ticks
should have landed in the last 30 hours. `public_board_liveness_history` holds:

| tick (UTC) | cron status | wall | **boards recorded** |
|---|---|---|---|
| 2026-08-23 00:28 | succeeded | 517.7 s | **45** |
| 2026-08-23 06:28 | **failed** | 900.7 s | **0** |
| 2026-08-23 12:32 | **succeeded** | 728.9 s | **6** |
| 2026-08-23 18:30 | **failed** | 900.4 s | **0** |
| 2026-08-24 00:28 | succeeded | 60.9 s | **45** |

**96 of a possible 225 probes — 43% coverage.** Two ticks produced literally nothing.

## Two distinct defects, and the second is the nastier one

### 1. ⛔ A failed tick rolls back every probe it had already completed

`public_board_liveness_sweep` is a **FUNCTION**, so the whole sweep is one transaction. When board
*n* exceeds the 900 s `statement_timeout`, the error propagates and **the state and history rows for
boards 1…n−1 roll back with it**. That is why the failed ticks recorded zero, not "some".

The function is careful and its author already knew the hard part — the header documents that a
per-board `statement_timeout` cannot work because *"the timer is armed once at the top-level
statement and is re-armed by neither `SET LOCAL` nor `COMMIT` — both verified empirically
2026-08-16"*. That is correct and it is a recorded dead end. **But it addresses preemption, not
durability.** A `COMMIT` after each board would not let the sweep survive a slow board — it would
let the sweep KEEP the 20-odd boards it already probed. Those are different problems and only the
first one was solved.

⚠ The 600 s `p_budget_ms` cannot help either: it is checked *between* boards, and the predictive
skip **exempts the first board** by design (to guarantee forward progress). So one board whose cost
exceeds the remaining 900 s takes the tick down regardless of the budget.

### 2. ⛔ A tick can report `succeeded` having covered 6 of 45 boards

The 12:32 tick exited on `budget_exhausted` after 728.9 s with **6 boards probed and 39 skipped**,
and `cron.job_run_details.status` reads **`succeeded`**. This is the documented
*"dispatch status is not outcome"* trap in a new shape: not a failure disguised as success, but
**87% missing coverage disguised as success.** The `skipped` / `budget_exhausted` counters exist in
the function's return value and are, as far as this filing can tell, surfaced to nobody.

## ⚠ What I got wrong on the way, recorded so nobody re-derives it

I hypothesised a **rotation trap**: a board that times out never gets its `checked_at` stamped, so it
stays least-recently-probed and leads the rotation forever. **That is wrong.** Every one of the 45
boards carries `checked_at = 2026-08-24 00:28:00.114861+00` — a successful sweep re-stamps all of
them, so the rotation does reset. The failure is not sticky.

The real driver is **variance, not a pathological board**. `candy_scarcity_board` — named in three of
the four recent timeout messages — measured **3,756 ms** on the last successful tick against a 14-day
p50 of **14,837 ms**. Its neighbours swing as hard: `allday_scarcity_board` 1,576 ms last vs 23,429 ms
p50; `candy_pack_market` 2,396 ms vs 16,064 ms; `candy_player_board` 34,338 ms vs 6,801 ms. **These
boards move 5–15× run to run.** The sweep is a victim of instance contention, not of one bad view.

## ⛔ Why I did NOT ship the fix tonight

The fix is a **PROCEDURE with a `COMMIT` after each board** so completed probes are durable, plus
surfacing `skipped`/`budget_exhausted`. It needs a matching cron change (`SELECT` → `CALL`, jobid 288
is `postgres`-owned so `alter_job` reaches it).

**I am not shipping it in the same session that changed the sweep's input conditions.** At 22:07Z
I cut `rpc-refresh-panini-squeeze` from ~13,040 to ~491 worker-seconds/day. The very next sweep —
**00:28, the first after that cutover — ran in 60.9 s and covered all 45 boards**, against 517–900 s
for every recent tick.

⚠ **n=1, and 00:00 was also the quietest hour on the board (2,505 cron busy-seconds), so this is not
attribution.** But it is a live hypothesis that the watchdog's failures were substantially
*contention* the panini job was manufacturing. **Ship a structural change to the watchdog now and
both effects become unmeasurable.**

👉 **Read the 06:28 and 12:28 ticks first.** If the sweep now completes at 45/45 with wall times far
under budget, the durability fix drops from "urgent" to "correct hygiene" and can be scheduled
calmly. If it fails again, ship the PROCEDURE conversion — the diagnosis above is complete and does
not need redoing.

---

## ✅ FALSIFIER READ 2026-08-25 ~18:20 PT (2026-08-26 01:20Z, Claude Code interactive) — the ship condition IS met, and the PRESCRIBED FIX IS BLOCKED by a constraint discovered two days AFTER this filing was written

This filing ended with a falsifier: *"Read the 06:28 and 12:28 ticks first. If the sweep now completes at 45/45 … the durability fix drops to hygiene. If it fails again, ship the PROCEDURE conversion."* **Two days of ticks now exist. Read them.**

### 1. It failed again — so by this filing's own rule, the answer is "ship"

`cron.job_run_details`, jobid 288, all dispatches:

| window | ticks dispatched | failed at 900 s | rate |
|---|---:|---:|---:|
| pre-cutover (08-21 06:28 → 08-23 18:30) | 11 | **5** | **45.5%** |
| post-cutover (08-24 00:28 → 08-26 00:28) | 8 | **1** (08-24 18:31, 900.2 s) | **12.5%** |

⭐ **The contention hypothesis is CORROBORATED BUT NOT SUFFICIENT.** Cutting `rpc-refresh-panini-squeeze` did not make this go away — it cut the failure rate ~3.6×. ⚠ **And one scheduled slot (08-24 ~12:28) produced NO `job_run_details` row at all** — the `job startup timeout` / worker-starvation class, a third outcome neither this filing nor the falsifier anticipated.

### 2. ⭐ The mechanism splits in two, and only ONE half loses work

| exit path | function | history rows for that tick |
|---|---|---|
| `budget_exhausted` / predictive skip | **returns normally** | **persist** — 6, 8, 10, 22 boards recorded on 08-23/08-22/08-21/08-19 |
| 900 s `statement_timeout` | **aborts** | **NONE** — the whole transaction rolls back |

**08-24 18:31 failed at 900.2 s; job 290 then ran at 18:51, succeeded, and `public_board_liveness_history` has no 18:51 tick** — the capture had nothing new because `public_board_liveness_state.checked_at` never advanced. ✅ *"Loses every probe it completed"* is **exactly right for the timeout class** and **wrong for the partial-coverage class**, which is already durable. The durability fix targets ~1 tick in 8, not the partial ones.

### 3. 🚨 THE PRESCRIBED FIX CANNOT BE APPLIED AS WRITTEN

This filing prescribes *"a PROCEDURE with a `COMMIT` after each board"*. **PostgreSQL forbids `COMMIT` in a routine carrying an attached `SET` config clause** — established in this repo on **2026-08-23**, one day after this filing, when an `ALTER PROCEDURE … SET search_path` broke `reconcile_all_saved_wallet_stats` with `invalid transaction termination … at COMMIT`.

Read live 2026-08-26:

| routine | kind | secdef | proconfig |
|---|---|---|---|
| `public_board_liveness_sweep` | `f` | **true** | **`{search_path=public, pg_temp}`** |
| `reconcile_all_saved_wallet_stats` | `p` | false | **null** |
| `rpc_trust_health_precompute_refresh_p` | `p` | false | **null** |

⛔ **Both routines on this database that actually COMMIT are `prosecdef=false, proconfig=null`. That is the only shape that can.** So the conversion additionally requires **stripping `search_path` from a SECURITY DEFINER routine**, which is the exact hardening this repo guards (`check_secdef_anon_exec_drift`, the migration anon-exec marker). ⚠ **Shipping the fix as specified would have produced `invalid transaction termination` on the first COMMIT and taken the watchdog fully dark** — a worse state than losing one tick in eight.

⚠ **I did NOT confirm the construct by running it**: `execute_sql` wraps every statement in a transaction, so a scratch `CALL` returns `2D000` from the *harness*, not from the construct — the same limitation this repo records for `CREATE INDEX CONCURRENTLY`. **The blocker above rests on the live `proconfig`/`prosecdef` read and the 08-23 incident, not on that failed probe.** Scratch objects rolled back with the wrapper; nothing was left behind.

### 4. ✅ Caller enumeration — exactly ONE, and the apparent second is a COMMENT

Six sources swept. `cron.job`: **jobid 288 only**. `pg_proc`: one hit, `public_board_liveness_probe` — which **does not call the sweep**; it reads `public_board_liveness_state` and merely *names* the sweep in a comment. ⚠ **A bare-name grep counted a comment as a consumer, for at least the third recorded time.** `pg_views`, `pg_matviews`, `pg_trigger`: none. Repo grep: migrations only. **The jsonb return value is consumed by nobody** — pg_cron logs `1 row` and discards it — so the return-type change a PROCEDURE forces is free.

### 5. ➡ The option this filing did not consider, and it needs no COMMIT and no SECDEF change

**Split the sweep across more pg_cron ticks.** Each tick is already its own transaction, so a timeout loses only that tick's slice — the same durability property, with **no `COMMIT`, no PROCEDURE conversion, no `search_path` strip, and no change to the function's kind or grants.** The rotation (`ORDER BY s.checked_at NULLS FIRST`) already makes slicing correct by construction: every tick takes the least-recently-probed boards. Going `28 */6` → e.g. `28 */2` with a smaller budget covers 45 boards with a fraction of the per-tick blast radius.

⛔ **NOT shipped, and this one is a genuine decision rather than a diagnosis gap:** more ticks means more IO on an IO-bound instance (register R46), which is the trade this filing's own §2 exists to weigh. **The diagnosis is complete; what remains is Trevor's call between (a) drop SECURITY DEFINER + the SET clause, then convert to a committing PROCEDURE, and (b) slice the schedule and leave the routine alone.** ⭐ **(b) is cheaper, reversible with one `cron.alter_job`, and touches no security surface.**

### 6. What is still NOT established

- ⛔ **Whether SECURITY DEFINER is load-bearing here at all.** Only `postgres` (via pg_cron) calls it and `anon`/`authenticated` already read `false` for EXECUTE. It may be vestigial — but "may be" is not a measurement, and dropping SECDEF is a privilege change that needs its own check.
- ⛔ **Attribution of the residual 12.5%.** One failure in eight post-cutover is too few to separate contention from a genuinely slow board.
- ⛔ **The missing 08-24 12:28 dispatch.** Consistent with the known `max_worker_processes` starvation class, but not measured here.
