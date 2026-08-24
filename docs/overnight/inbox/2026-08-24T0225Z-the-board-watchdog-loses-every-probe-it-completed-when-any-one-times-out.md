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
