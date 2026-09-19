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
