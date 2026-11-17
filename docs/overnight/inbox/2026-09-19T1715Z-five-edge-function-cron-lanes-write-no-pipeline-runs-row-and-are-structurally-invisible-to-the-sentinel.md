# Five edge-function cron lanes write no `pipeline_runs` row and are structurally invisible to the sentinel

**Filed 2026-09-19 10:15 AM PT (Cowork cloud), out of the pack-sales outage.** Two of the five
were found DEAD for 6 and 7 days; they are fixed and are NOT the subject of this filing. The
subject is the other three and the class.

## The class

Every sentinel pipeline arm — Pipeline Silence, Pipeline Success, Pipeline Success Coverage — and
`detect_stalled_pipelines()` are scoped to `pipeline_cadence_watchlist` over `pipeline_runs`.
**A lane that writes no `pipeline_runs` row is out of scope BY CONSTRUCTION, not by curation.**
No arm can fire on it, and no amount of watchlist editing changes that, because the watchlist
keys on a pipeline name that never appears.

⚠ And `cron.job_run_details` does not cover the gap: these lanes dispatch with `net.http_post`,
which **succeeds when the POST is ENQUEUED**, never when the edge function did work. Jobids 25/29
recorded 478 and 477 `succeeded` runs in 24 h over a lane that had been dead for six days.

## The measured set

Of the **12** active cron jobs that POST to `/functions/v1/`, **5** write nothing to
`pipeline_runs` (~1,390 dispatches/day):

| jobid | job | edge function | schedule | dispatches/day | state 2026-09-19 |
|---|---|---|---|---|---|
| 29 | `rpc-topshot-pack-sales-backfill` | `backfill-topshot-pack-sales` | `1-58/3` | 480 | **was DEAD 6d — fixed** |
| 25 | `rpc-allday-pack-sales-backfill` | `backfill-allday-pack-sales` | `*/3` | 480 | **was DEAD 7d — fixed** |
| 27 | `rpc-allday-dist-opened-backfill` | `backfill-allday-dist-opened` | `2-58/4` | 360 | `{"done":true}` since 2026-07-12 — see below |
| 22 | `rpc-allday-resolve-pull-editions` | `resolve-allday-pull-editions` | `9,39` | 48 | appears functional (returned an empty result set) |
| 26 | `rpc-allday-resolve-rip-dist-api` | `resolve-allday-rip-dist-api` | `17` | 24 | appears functional (returned `{"ok":true}`) |

⚠ **The blind set was settled by DISPATCH-MINUTE ALIGNMENT, not by name-matching.** No pipeline's
start-minutes match `2-58/4`, `17`, or an All-Day `9,39`; name-similarity had suggested three
false matches (`allday-dist-opened-expiry`, `allday-edition-resolver`, `backfill-pack-rip-metadata`)
and all three are other jobs on other minutes.

⚠ **22 and 26 are NOT verified healthy** — "appears functional" means one manual dispatch returned
a non-latched body. Neither was checked against an outcome table, because I could not identify
their target tables with confidence. That is the honest state, and it is the next step.

## jobid 27 is waste, NOT an outage — and the discriminator matters

`pack_opens_api_state` has both rows `done = true, last_status = 'done'` since **2026-07-11/12**,
at `packs_seen 2,814,815 / rips_written 2,754,566`. Unlike pack sales, **a forward lane exists and
is live**: `allday-pack-opens-forward` (jobid 20) ran 41 times in 24 h, all ok, 24 rows written.
So its `done` is CORRECT — a completed historical backfill — and unlatching it would restart a
2.8-million-row walk for nothing.

⭐ **That discriminator is the whole lesson of the pack-sales fix: `done` is wrong when the
backfill IS the only ingester, and right when a forward lane carries the head.** Do not apply the
unlatch pattern without checking which case you are in.

**Candidate (not shipped):** cut jobid 27 from `2-58/4` (360/day) to something sparse. It has
returned `{"done":true}` for ~69 days, so that is ~24,800 no-op edge invocations and 360
worker-slot acquisitions/day on a box where `max_worker_processes = 6` against
`cron.max_running_jobs = 32` is a documented starvation source. Left unshipped because it is
cadence work on an ingest lane and the 2026-08-26 entry is emphatic that such cuts have bitten
before — though the mechanism there (freshness = lap time) provably does not apply to a lane that
is done and has a forward partner.

## What has been done about the class

Only for the two pack-sales lanes, and only as a side effect:
`public.unlatch_pack_sales_cursors()` (migration `20260919164919`, pg_cron jobid 526) writes a
`pipeline_runs` row every tick, so those two now have coverage, and the sentinel arm
**Pack Sales Ingest (Top Shot / All Day)** reads it.

**The general fix does not exist.** Three lanes remain blind. The options, none costed:
1. Have each edge function write its own `pipeline_runs` row — ⛔ blocked: no committed source
   (deep-audit R21).
2. A DB-side wrapper per lane, like `unlatch_pack_sales_cursors` — works, but is one bespoke
   function per lane.
3. A generic arm that reads `cron.job_run_details` for edge-function jobs and pairs it with an
   outcome-table freshness registry — the only option that scales, and the only one that would
   have caught this without knowing the lane existed.

---

## ✅ NEGATIVE CONTROL: the `done`-latch pattern is NOT widespread — swept, 2026-09-19 10:5x AM PT

Before anyone repeats this: **every `*_cursor` / `*_state` base table in `public` carrying an
`updated_at` was swept for the same staleness tell (20 tables).** Result — **no further dead lanes.**
Each stale one is explained:

| table | age | explanation |
|---|---|---|
| `ufc_studio_sales_history_state` | 2,051 h | UFC market closed 2026-05-13 — **expected** |
| `allday_mint_scan_state` | 1,960 h | not investigated — see below |
| `pack_opens_api_state` | 1,671 h | completed backfill, **live forward lane** (`allday-pack-opens-forward`) |
| `sales_ingest_state` | 1,344 h | not investigated — see below |
| `dune_budget_state` | 669 h | not investigated — see below |
| `sales_seller_recovery_state` | 273 h | matches `sales-seller-recovery-dune`'s last find (09-08); already reported by the `Zero-Yield Lanes` arm |
| `match_topshot_players_state` | 202 h | lane runs daily and succeeds with `rows_found = 0, rows_written = 0` **every day for 12 days** — genuinely nothing to match, not a latch |
| `rtr_user_state`, `trade_chain_state` | NULL | empty tables |
| everything else | ≤ 14.6 h | healthy |

✅ **And the fix is holding:** both pack-sales cursors now read **0.0 h** in this same sweep, against
the 5.6 and 6.7 days they were frozen at this morning.

✅ **AND THE THREE STRAGGLERS ARE NOW CLOSED TOO — none is a latch, all three are explained.**

* `sales_ingest_state` (56 d, `cursor_end = 2022-01-01` against a `floor_date = 2019-01-01`, so
  the walk did **NOT** reach its floor) — ⛔ **NOT a finding: its lane was DELIBERATELY RETIRED on
  2026-07-28**, which matches the 2026-07-25 freeze. The disposition is recorded in-tree and is
  cited by two sibling routes as precedent (`topshot-flowty-sales-history-backfill`,
  `evm-transfers-ingest`): the route is KEPT, only the schedule was removed, and its own test file
  describes it as `auth + inert`. **Do not "fix" it.**
* `dune_budget_state` (28 d) — written by `lib/dune/budget.ts`. The only Dune lane still running is
  `sales-seller-recovery-dune`, which the sentinel reports **EXHAUSTED** ("the cycle cap is spent
  and every Dune lane paces at 0 until the reset — a configured stop, not a failure"). Consistent;
  nothing to do.
* `allday_mint_scan_state` (82 d) — **an ORPHAN table.** Zero references in live code, zero in
  `cron.job.command`, zero in any `public` function body; it appears only in two ARCHIVED handoffs
  from 2026-06-29. It holds **1 row** and nothing has written it since. Its staleness is explained
  by there being no writer at all. ⚠ Filed as an observation, not a cleanup instruction — dropping
  a table is Trevor's call and the row is harmless.

⭐ **So the sweep closes completely: 20 of 20 state tables explained, 0 further dead lanes.** The
`done`-latch that killed the two pack-sales lanes is, as far as this estate's state tables can
show, **a two-lane problem and not a pattern.**

## ⛔ RETRACTED 2026-09-19 11:2x AM PT — THE SIDE FINDING BELOW IS WRONG IN BOTH HALVES

**Left in place per the inbox's no-clobber rule. Read the retraction, not the claim.**

**Half one — "a daily zero-yield lane cannot trigger the arm because of the ≥50-run floor":** the floor
is real, but the lane I cited would not qualify anyway. Measured offenders at `p_min_runs` =
50 / 30 / 20 / 10 / 5 are **1, 2, 2, 2, 2** — lowering it adds exactly ONE lane, and that lane is
`topshot-dupe-sales-watch` (31 runs, 1 baseline find), **a WATCH lane for which finding nothing is
the desired outcome. Lowering the floor adds a FALSE positive.** And `match-topshot-players` is
absent even at 5, because over 30 days it ran 31 times and **found 15,683 rows while writing 0** —
the arm's predicate is "found nothing", so it was never in scope and the floor is not why.
⛔ **Do not lower `p_min_runs`.**

**Half two — "Pipeline Silence flagging `topshot-active-listings-ingest` at 952m is a
threshold-vs-cadence artifact":** 🚨 **it is not an artifact; the arm is right.** That lane went
**8 runs/day (09-07) → 1/day (09-16..19), with 09-15 missing entirely**, every run `ok`, at
**1,075,776–1,403,533 ms per run (18–23 minutes)**. Its cadence is decaying as a SYMPTOM of IO
saturation. ⭐ **Raising its `max_silent_minutes` — which is what I proposed — would have silenced a
real degradation to make a warning go away.**

⭐ **The reusable lesson: a threshold that looks mismatched to a cadence may be reporting that THE
CADENCE MOVED.** The 21-day history was one query away and reversed the conclusion.

ℹ **New open item out of the retraction:** `topshot-active-listings-ingest` at 1 run/day and ~20
min/run. Nothing here establishes whether 1/day is sufficient for active-listing freshness or what
its intended cadence is. **That is the next question, and it is not a threshold question.**

---

## ⚠ Side finding: a DAILY zero-yield lane cannot trigger the `Zero-Yield Lanes` arm

`match-topshot-players` has found **0 rows on 12 consecutive daily runs** and the arm does not name
it, because the arm's population is `7d zero / 30d baseline / ≥50 runs` — **a daily lane can never
reach 50 runs in the window.** So the arm is structurally blind to exactly the lanes whose waste is
cheapest to stop.

⭐ This is the same **threshold-vs-cadence** class as `Pipeline Silence` warning that
`topshot-active-listings-ingest` is "silent 952m (>900m)" when that lane is simply irregular and
succeeded on its last three runs (349 / 281 / 361 rows). **Neither is a false alarm exactly — each
is a population whose shape the threshold was not chosen for.** Cheap to fix (scale the run-count
floor by the lane's cadence rather than using a constant); not shipped here.

## Drained 2026-09-22 — RESOLVED — the `edge_lane_watch` registry + `check_edge_lane_observability()` (ledger 2026-09-19, R110 exit). Live 2026-09-22: 12 lanes inspected, 0 unregistered, 0 stale, 2 unchecked by design.

*(Per-item drained marker, the mechanism `docs/reference/autonomous-tasks.md` names as the unblock for archival. Re-derived live by the 2026-09-22 daytime Cowork pass; archiving remains Trevor's call.)*
