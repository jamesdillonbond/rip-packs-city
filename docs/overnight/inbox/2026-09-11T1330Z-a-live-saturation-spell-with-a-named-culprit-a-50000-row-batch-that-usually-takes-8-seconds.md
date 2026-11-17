# A LIVE saturation spell, caught mid-event, with a named culprit — a 50,000-row batch that usually takes 8 seconds — 2026-09-11T13:30Z

Filed by Claude Code on Trevor's box (interactive, 06:30 PT). Found by re-deriving the **go-live M11
row**, which claimed *"~0 saturation spells since 08-30"*. It is not ~0, and one was in progress
while this was being written.

---

## M11 is not met — three consecutive days

Counted on the 2026-09-09 filing's own discriminator: `cron.job_run_details` rows failing with
**`job startup timeout`**. ⭐ That failure mode writes **no `pipeline_runs` row at all**, so every
pipeline monitor on the platform reads it as silence — which is why the go-live row could sit at
"~0" while this was happening.

| day | startup timeouts | hours affected |
|---|---:|---:|
| 09-03 → 09-08 | **0** | 0 |
| 09-09 | **135** | 3 |
| 09-10 | **63** | 2 |
| **09-11 (partial)** | **61** | 3 |

The bar is **0 in 7 days**. It is 259 in 3, and today is not over.

## Caught live, which is the part that usually cannot be got

At 13:25Z, `pg_stat_activity` (client backends only):

```
active  LWLock : WALWrite     17 backends   query = COMMIT
active  IO     : DataFileRead  7 backends   query = SELECT public.backfill_pinnacle_trade_acquisitions(50000)   longest 191 s
active  IO     : WalWrite      1 backend    query = COMMIT
idle    Client                 7 backends
```

⭐ **The chain reads cleanly in one direction:** seven parallel workers on one function doing heavy
`DataFileRead` → disk IO saturated → **WAL writes stall** → every committing session queues on
`LWLock:WALWrite`. **29 backends blocked, longest 34 s.** ⚠ And the shape is NOT the mechanism the
2026-09-09 filing describes (overlapping six-hourly MV refreshes exhausting `max_worker_processes=6`)
— this is **one job's batch size**, not slot contention.

## The culprit, and why it is invisible on a normal day

**pg_cron jobid 355 — `rpc-backfill-pinnacle-trade-acquisitions`, `23 1-22/3 * * *`, batch 50,000.**

| run (UTC) | duration |
|---|---:|
| 09-11 **13:23** | **212 s and still running** |
| 09-11 10:23 | 80 s |
| 09-11 07:23 / 04:23 / 01:23 | 10 s / 8 s / 9 s |
| 09-10 **13:23** | **490 s** |
| 09-10 10:23 | 100 s |
| 09-10 07:23 and earlier | 7–8 s |

⭐ **It normally finishes in EIGHT SECONDS and occasionally runs 60× that.** Nothing watches duration,
its `return_message` is always the same `"1 row"`, and `status` reads `succeeded` either way — so on
the scheduler's own instruments a 490-second run and an 8-second run are **indistinguishable**.

⚠ **THIS IS A CAUSE, NOT PROVEN THE ONLY ONE — stated because the correlation is tempting.** Its slow
runs line up with **3 of the 5 burst hours** (09-10 13Z, 09-11 10Z, 09-11 13Z). **09-10's 12Z burst
(34 timeouts) has no slow run of 355 behind it** and is unexplained. And the 09-09 filing's warning
applies directly: in a fleet-wide slowdown every lane is 6–32× slower, so **ratios cannot separate
cause from victim**. What raises this above correlation is the live reading — at 13:25Z this function
was the ONLY non-`COMMIT` work running.

## The lever, and the rule it follows

⭐ **`50000` is the lever, and this repo already has the rule: "A `LIMIT` bounds a query's OUTPUT, not
its COST — cut ITEMS per tick, not rows per item."** A batch that is free when the backlog is drained
and brutal when it is not is exactly the shape that hides until it bites.

**Suggested actions — none taken here.**

1. **Cut the batch** from 50,000 to something that keeps the p99 near the 8-second norm (2,000–5,000),
   and let the 3-hourly cadence drain the backlog across more ticks. ⚠ **Measure first:** compare
   BUFFERS between batch sizes, not wall-clock — saturation confounds timings in both directions, and
   this instance is saturated right now, so **any timing taken during the spell is worthless**.
2. **Give it a duration watch.** A job whose `succeeded/"1 row"` is identical at 8 s and 490 s has no
   instrument at all. The cheapest honest one is a `cron.job_run_details` duration arm, since the
   function writes no `pipeline_runs` row to hang a heartbeat on.
3. ⛔ **Do NOT conclude the spell class is solved by fixing 355.** 09-10 12Z remains unexplained, and
   the 09-09 nine-hour spell had a different shape entirely. **This closes one door, not the corridor.**

**Risk of doing nothing:** recurring multi-hour windows in which ~20 pg_cron jobs never start, are
invisible to every pipeline monitor by construction, and take a go-live gate (M11) with them.
