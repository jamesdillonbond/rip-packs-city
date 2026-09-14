# A lane has ticked **4,023 times since it last found a row**, reports `ok` every time, and its cursor has not moved in 39 days

*Filed 2026-09-14 ~11:2x AM PT by Claude Code (cloud). **READ-ONLY — nothing was unscheduled, and the decision below is deliberately NOT taken.** Found while validating a different instrument, which is the only reason anyone looked.*

---

## 1 · The measurement

`topshot-pack-opens-history-backfill`, driven by pg_cron **jobid 56** at `11,26,41,56 * * * *` (4×/hour):

| fact | value | source |
|---|---|---|
| last day with `rows_found > 0` | **2026-08-01** | `pipeline_runs_daily` (indefinite) |
| runs since that day | **4,023** | same |
| `ok` rate over those runs | **~100 %** (jobid 56 lifetime 6,055/6,124) | `cron.job_run_details` |
| lifetime `rows_found` | **38,849** | `pipeline_runs_daily` |
| cursor `topshot_pack_opens_history_backfill` | **61,808,846** | `event_cursor` |
| cursor `updated_at` | **2026-08-06 22:11:20Z** — 39 days | same |

⭐ **The lane is not broken-and-never-worked.** It found 38,849 rows between 2026-07-29 and 2026-08-01. It did its job and then stopped producing.

⭐ **Two different states, and the dates separate them.** From **08-01 to 08-06** the cursor ADVANCED while finding nothing — normal for a walk through ranges with no matching events. Since **08-06** the cursor has not advanced **at all** while the job keeps running and reporting success.

## 2 · What that shape most likely means — and the part I did NOT measure

A cursor that stops advancing while its job keeps succeeding is the shape of a lane that **reached a terminal bound and correctly no-ops**. That is the most likely reading, and it would make this a *waste* item rather than a *correctness* item.

⛔ **But I cannot distinguish "reached its floor" from "exits early before doing any work and still reports `ok`" from outside the code.** The floor constant lives in the edge function `ingest-topshot-pack-opens-history`, which I did not read. ⚠ **When someone does: `get_edge_function` hands back live gate keys** (CLAUDE.md, and it has burned a transcript) — redact or hash, never echo.

⚠ **So do not act on this filing as though the terminal state were established.** Both readings produce identical `pipeline_runs` rows, which is precisely why `ok = true, rows_found = 0` is a null instrument here.

## 3 · The cost, which is the same under either reading

- **~96 runs/day, ~35,000/year**, producing nothing for 39 days, on an instance whose documented constraint is **disk-IO budget**, not CPU.
- ⭐ **And the larger cost by this estate's own doctrine: a permanently-zero lane trains the next reader to skip it.** That is the reasoning already recorded for retiring jobid 55's watchlist arm and for the badge-sync arm — *"a permanently red arm is worse than no arm"*, and permanently-zero is the same defect with the sign flipped.

## 4 · Control — parked-ness is not universal, so this measurement discriminates

Of the 14 `*backfill*` cursors, 11 have not moved in weeks-to-months, **but not all of them are idle by accident**:

- ✅ `topshot_offer_fill_backfill` — updated **2026-09-14 13:05Z** (alive)
- ✅ `golazos_sales_v1_backfill` — updated **2026-09-14 15:34Z** (alive, ticks 3-hourly at :34)
- ⓘ `topshot_flowty_backfill` — frozen 2026-08-04, and **correctly so**: Flowty's marketplace shut down (register #3)
- ⓘ `allday_pack_opens_backfill` — frozen 2026-09-04, and **deliberately so**: jobid 55 was unscheduled (register #102(a))

**So a frozen backfill cursor is often the right answer.** What singles this one out is that it is frozen **while its scheduler is still firing 96 times a day.**

## 5 · How it was found, which is worth more than the finding

It surfaced from `event_cursor_watermarks.changes_observed`, shipped hours earlier (migration `20260914220000`) precisely because `observations` counted RUNS rather than EVIDENCE. **A cursor with `changes_observed = 0` across live observations is exactly the "parked while watched" signal**, and the old schema could not express it.

## 6 · Suggested exit — a decision, not a chore

1. Read the floor constant in `ingest-topshot-pack-opens-history` (**redact gate keys**) and compare it to cursor **61,808,846**.
2. **If it is at the floor:** the walk is COMPLETE — retire jobid 56, or drop it to a cadence that matches "nothing to do" (daily, not 4×/hour). Record the completion so the next reader does not re-open it.
3. **If it is NOT at the floor:** the lane is stuck while reporting success, and that is a correctness item — `~19 M`-block-style silent stalls are a documented class here.
4. ⛔ **Do NOT unschedule on the evidence in this filing alone.** If the lane is paused rather than finished, unscheduling turns a recoverable gap into a permanent one — the exact trap #102(a) records for the AllDay twin.
