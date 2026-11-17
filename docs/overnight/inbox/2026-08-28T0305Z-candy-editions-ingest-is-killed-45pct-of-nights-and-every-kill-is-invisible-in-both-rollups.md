# 🚨 `candy-editions-ingest` is being KILLED on ~45 % of nights, and every kill is invisible in **both** rollups — moved out of the peak band

**Filed 2026-08-27 20:05 PT (2026-08-28 03:05Z) by Claude Code, cloud session (push-capable).**
Found by sweeping for pipelines that went dark, then followed through with the heartbeat correlation.
Includes the post-ship watch on tonight's pack-pool fix (§6).

---

## 1. The finding

`candy-editions-ingest` (Vercel cron, was `10 22 * * *`) **did not complete last night**. The heartbeat
correlation settles what happened, which is the whole reason that marker exists:

| 2026-08-25 | heartbeat + terminal | ✅ completed |
| 2026-08-26 | heartbeat + terminal | ✅ completed |
| **2026-08-27** | **heartbeat, NO terminal** | 🚨 **`after()` killed** |

Vercel's runtime log for that invocation gives the cause outright:

```
[candy-editions-ingest] wmc upsert err: canceling statement due to lock timeout        (x2)
[candy-editions-ingest] wmc metadata denorm err: canceling statement due to statement timeout  (x2)
Vercel Runtime Timeout Error: Task timed out after 800 seconds
```

**That is register item D8** — *wmc metadata denorm has no self-heal; the blocker is ROW-LOCK
CONTENTION* — now shown to be killing an entire daily catalogue ingest, not merely slowing it.

## 2. 🚨 It is recurring, and BOTH summary instruments report it as healthy

⚠ My first read was "2 runs in 30 days", which is wrong — `pipeline_runs` retains ~73 h, so that is a
**retention artifact**, exactly as CLAUDE.md warns. Re-read from the indefinite `pipeline_runs_daily`:

- **22 recorded days, every one `runs 1 · ok 1 · failed 0`.** A perfect record.
- **2026-08-27 is not a failure row. It is ABSENT.**

⭐ **A killed run does not appear as a failure anywhere — it appears as a MISSING DAY**, because the
terminal `log_pipeline_run` never executes and there is nothing to roll up. So the lifetime record reads
**100 % ok** while the job is failing.

Cross-referencing the heartbeat rollup against the terminal rollup (the only way to see it):

| | |
|---|---:|
| days with a heartbeat | 10 |
| days with a terminal row | 22 |
| **days with a heartbeat and NO terminal row** | **4** — 08-17, 08-18, 08-20, 08-21 |

Plus 08-27, confirmed directly. **That is 5 kills in the ~11 days the heartbeat has existed — ~45 %.**
⚠ The 16 terminal-only days simply predate the heartbeat; they cannot be classified either way.

⚠ **And the cadence alarm would not have caught it.** `max_silent_minutes` is 1800 (30 h) against a
daily job, so a single missed night sits at 29 h — **under the threshold** — and tonight's run would have
cleared it. **A once-daily pipeline with a 30 h alarm can only ever alarm on two consecutive failures.**

## 3. The action: moved out of the peak band, `10 22 * * *` → `10 1 * * *`

The failure is lock/statement contention, which is time-of-day driven, and 22:10Z sits inside the band
measured tonight as the platform's worst (board-view p50 **5× worse at 18Z than 00Z**, paired-controlled;
the liveness sweep itself succeeds **14/14 at 00Z against 6/11 at 12Z**).

⭐ **Hour 1 specifically, and not the "quietest" hour 0.** Hour 0 is quiet for external traffic but is
exactly where the `*/2`, `*/3` and `*/6` pg_cron cohorts all coincide — #42's schedule-alignment finding.
**Hours not divisible by 2 or 3 (1, 5, 7, 11 …) avoid every one of those cohorts**, and 01:10Z is clear
of the nearest neighbour (`45 1 * * *`) by 35 minutes. ⛔ 02:10Z was rejected on purpose:
`topshot-catalog-backfill` runs at 02:12 and also writes `wmc`, which is the exact table the lock
contention is on.

## 4. ⚠ What this does NOT establish

🚨 **The hour attribution is inferred, not measured for this pipeline.** Every one of its runs has been at
22:10, so its own data contains **no hour contrast** and cannot attribute the kills to the hour. The
mechanism comes from other instruments measured tonight. **Moving it is therefore as much an experiment
as a fix — and it creates the contrast that is currently missing.**

**Falsifier, stated plainly: if kills continue at ~45 % from 01:10Z, the hour is not the cause and the
fix is D8 itself (the wmc denorm), not the schedule.**

⚠ **Expect a cadence alarm in the meantime and do not misread it.** The last successful run was
2026-08-26 22:10; the next is now 2026-08-29 01:10, so the gap crosses the 30 h threshold. **That reflects
the 08-27 kill plus the one-off transition, not a new fault**, and it clears on the first run under the
new schedule.

⛔ **D8 itself is untouched.** Fixing row-lock contention on the wmc denorm is real engineering, it is
squarely in the ingest logic this pass leaves alone, and focus.md PRIORITY 3 says not to open new
saturation investigations. This moves the job away from the contention; it does not remove it.

## 5. ⭐ The durable lesson, worth more than this one pipeline

**A killed `after()` route is invisible in `pipeline_runs_daily` as well as in `pipeline_runs` — and in
the daily rollup it does not merely go missing, it makes the record look PERFECT.** Any pipeline whose
health is read from `pipeline_runs_daily` shares this blind spot. The heartbeat correlation is the only
thing that sees it, which is a concrete argument for continuing the E5 conversions: **the remaining 47
un-heartbeated `after()` routes cannot be audited this way at all.**

## 6. Post-ship watch — tonight's pack-pool fix (`20260828025307`)

First two ticks after the ORDER BY change, against **131 consecutive failing ticks** before it:

| tick | result |
|---|---|
| 02:58Z | ✅ **3/3 dists converted, 0 empty** — first `ok` in 11 h |
| 03:03Z | 3 empty walks — a `bucket % 3 = 0` tick, drawing the rips tier by design |

Backlog **368 → 365**; dists with pool rows **1,715 → 1,718**.

⭐ **A falsifiable prediction, so the residual is not mistaken for a regression: the failure rate should
settle near 33 %, not 0 %.** One tick in three is the rips tier's dedicated slot, and those 8 dists are
unconvertible, so they will keep producing empty walks until failure memory exists. **Anyone watching the
`ok` rate will still see red roughly a third of the time, and that is the design.** A rate materially
above ~33 % means something else is wrong.

## 7. Revert

Schedule: restore `"schedule": "10 22 * * *"` in `vercel.json`. Nothing else to unwind.
