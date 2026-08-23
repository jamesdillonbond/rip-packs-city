# ⭐ The series-rollup fix WAS load-tested — its best run happened in the day's worst hour, and I spent all evening saying it was unverified

**Filed:** 2026-08-23 20:55Z (13:55 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** MEASURED, and it CLOSES an item I had been carrying as open.

## The claim I kept repeating, and why it was wrong

Every filing and handoff I wrote this evening carried the same caveat: *"the incremental refresh
has still never been tested inside a saturation spell — 18:59 (3.6 s) and 19:59 (3.3 s) both ran
in quiet/middling windows."* I could not falsify it because there is **no IO-history table** in
this database, so I treated "was that hour loaded?" as unanswerable after the fact.

It was answerable, cheaply, and I never took the reading. `cron.job_run_details` records every
run of every job. **The other jobs in the same hour ARE the load control.**

## What the control says

Whole-instance cron load, by hour, 2026-08-23:

| hour (UTC) | runs | failed | at 590s+ ceiling | avg s | **total busy s** |
|---|---|---|---|---|---|
| 13:00 | 168 | 54 | 2 | 43.4 | 7,288 |
| 14:00 | 172 | 0 | 0 | 31.6 | **5,433** ← calmest afternoon hour |
| 15:00 | 172 | 30 | 2 | 43.2 | 7,431 |
| 16:00 | 173 | 1 | 0 | 37.1 | 6,422 |
| 17:00 | 174 | 3 | 1 | 31.8 | 5,533 |
| **18:00** | **193** | 5 | **4** | **65.2** | **12,576** ← **worst hour of the day** |
| 19:00 | 168 | 1 | 0 | 30.7 | 5,164 |
| 20:00 | 141 | 0 | 0 | 16.5 | 2,330 |

18:00 is the busiest hour on every axis at once: 1.7–2.4× the busy-seconds of any other hour,
double the average run length, the most runs, and the most jobs pinned at their 590 s+ ceiling.
Four jobs hit the wall in that hour — `rpc-public-board-liveness-sweep` at 900 s,
`rpc-refresh-allday-pack-sales-agg` at 633 s, `rpc-refresh-allday-pack-realized` and
`rpc-allday-ev-corrected-refresh` at 600 s each.

Per-job, for the ones that run hourly and therefore span both windows:

| job | 14:00 | 15:00 | 16:00 | 17:00 | **18:00** | 19:00 |
|---|---|---|---|---|---|---|
| `rpc-refresh-wmc-fmv-changed` (303) | 403.6 | 279.7 | 388.5 | 374.5 | 370.1 | 374.7 |
| `rpc-refresh-panini-squeeze` (353) | 199.3 | 410.0 | 248.2 | 213.7 | 265.2 | 330.1 |
| `rpc-allday-nem-from-sales-backfill` (215) | 406.2 | 407.1 | 483.0 | 403.3 | **535.6** ← its daily max | 297.1 |
| `rpc-atlas-pack-ev` (217) | 80.0 | 600.0 | 250.3 | 80.5 | **393.6** | 104.1 |
| **`rpc-series-detail-rollup` (357)** | **350.7** | **177.4** | **48.8** | **600.0 FAIL** | **3.6** | **3.3** |

⭐ **The comparison that settles it: the pre-fix job took 350.7 s in the day's CALMEST hour
(14:00, 5,433 busy-s, zero failures). The post-fix job took 3.6 s in the day's WORST
(18:00, 12,576 busy-s, four jobs at the ceiling).** And across a 2.4× load swing between 18:00
and 19:00, it moved 3.6 s → 3.3 s — an 8% difference. It is no longer load-sensitive, because it
is no longer read-bound.

The neighbours prove this is not ambient relief: 303 is flat across all six hours, and 353 is
*slower* at 19:00 than at 14:00.

## ⚠ The method error, which is the part worth keeping

I had the right rule and applied it in only one direction. The recorded rule is *"read
`rpc_ops_snapshot()`/io_wait BEFORE a perf measurement"* — written after I ran 29 s and 38 s
EXPLAINs inside a saturation spell the daytime monitor had independently detected. That rule is
about **not measuring during load**. What I never did was the mirror image: **checking, after the
fact, whether a measurement I already had was taken during load.**

⛔ And I concluded "unverifiable" from the absence of a *purpose-built* instrument. There was no
IO-history table, so I stopped. But `cron.job_run_details` had 1,161 runs across eight hours
sitting there — **the load signal was already recorded, as a side effect of something else.** The
generalisation: *before declaring a question unanswerable for want of an instrument, ask what
already-recorded data varies with the thing you want to measure.* Every scheduled job on a shared
instance is a load sensor.

The cost was not just a wrong caveat. I scheduled a 21:05Z check to catch the 20:59 tick — and
20:00 is the **quietest hour on the board** (2,330 busy-s), so that check could never have
answered the question it was scheduled for. **A verification aimed at a question the window cannot
answer reads as diligence and produces nothing.** Trigger cancelled.

## What this does NOT establish

- ⚠ **One hour is one hour.** 18:00 is the worst hour *of today*. It is not the worst state this
  instance reaches — the recurring disk-IO saturation spells are worse, and none has landed on a
  post-fix tick yet.
- The 2 h watermark safety lag is untested against a *late* snapshot batch. The `WHERE
  EXCLUDED.computed_at >= t.computed_at` guard means a late older row cannot move a row backwards,
  but no run has exercised it.
- `pruned` has been 0 on every tick, so the mark-and-sweep arm has never actually deleted
  anything. It is unexercised, not proven.

## Also confirmed in passing: the `duration_ms` fix is live

`log_pipeline_run` now stamps `finished_at` with `clock_timestamp()`, and `series-detail-rollup`
rows show it:

```
18:13:32  duration_ms 0     finished_at 2.2 ms BEFORE started_at   (old body)
18:59:00  duration_ms 0     finished_at 25.7 ms BEFORE started_at  (old body)
19:06:58  duration_ms 4046  ok                                     (fixed 19:06:48)
19:59:00  duration_ms 3233  ok
```

The inversion is gone and the numbers are real. Historical rows stay 0 — `duration_ms` is
`GENERATED ALWAYS` and rewriting 47k+ rows for data that is unrecoverable for nine of the ten
affected pipelines is not worth a table rewrite.
