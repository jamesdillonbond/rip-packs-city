# Four of the nineteen hardened event-range walkers have never run

**Filed 2026-08-21 (PT ~10:00), Claude Code interactive. MEASURED, with a positive
control. NOT acted on — deleting or wiring an ingest route is Trevor's call.**

---

## What this is

Two passes on 2026-08-21 fixed the cursor-swallow in 19 event-range walkers. This
is the liveness check nobody ran on that population, and it scopes the impact
claim both passes made.

`pipeline_runs_daily` is retained **indefinitely**, so a zero there is a real
absence rather than the ~73h `pipeline_runs` retention artifact. All-time run
counts:

| walker | runs (all time) | last day |
|---|---|---|
| golazos-listings-indexer | 2,181 | 2026-08-21 |
| allday-listings-indexer | 2,164 | 2026-08-21 |
| golazos-sales-indexer | 2,136 | 2026-08-21 |
| allday-sales-indexer | 2,127 | 2026-08-21 |
| allday-offers-indexer | 1,632 | 2026-08-21 |
| topshot-offers-indexer | 1,628 | 2026-08-21 |
| pinnacle-listings-indexer | 1,621 | 2026-08-21 |
| pinnacle-sales-indexer | 1,370 | 2026-08-21 |
| backfill-offer-fill-sales | 892 | 2026-08-21 |
| ufc-sales-indexer | 501 | 2026-08-21 |
| ufc-sales-history-backfill | 181 | 2026-08-21 |
| golazos-sales-history-backfill | 176 | 2026-08-21 |
| pinnacle-sales-history-backfill | 176 | 2026-08-21 |
| allday-sales-history-backfill | 172 | 2026-08-21 |
| topshot-flowty-sales-history-backfill | 145 | 2026-08-17 |
| **golazos-offers-indexer** | **0** | never |
| **topshot-listings-indexer** | **0** | never |
| **ufc-listings-indexer** | **0** | never |
| **app/api/pinnacle/ingest-events** | **0** | never (see below) |

## The honest consequence for both ledger entries

**15 of 19 are live, and that is where data was actually being lost.** The fix is
correct on all 19 and costs nothing on the dormant ones, but neither entry should
be read as "19 pipelines were losing data" — four of them were losing nothing
because they were doing nothing.

## The positive control, because a null result needs one

All three `*-indexer` routes **do** call `log_pipeline_run` (2, 2 and 5 call sites
respectively) and their `PIPELINE_NAME` matches the name queried above. So the
zero is "never ran", not "ran without logging". Their live siblings prove the
instrument works: `allday-offers-indexer` 1,632 runs against
`golazos-offers-indexer` 0, same shape, same cadence tier.

Neither has ANY caller: no `vercel.json` cron, no GitHub Actions workflow, no
`pg_cron` job, no in-repo `fireNextPipelineStep` chain. The only unenumerable
caller is cron-job.org, and a cron-job.org entry that had ever fired would have
written a row.

- `topshot-listings-indexer` — created **2026-05-17**, dormant ~3 months
- `ufc-listings-indexer` — created **2026-05-17**, dormant ~3 months
- `golazos-offers-indexer` — created **2026-07-28**, dormant ~3.5 weeks

⚠ TopShot listings are not un-served: `ts-listing-ingest` and
`topshot-listing-cache` both sit in `pipeline-health`'s `EXPECTED_INTERVAL_MIN`
map at 20 min. So `topshot-listings-indexer` looks like a superseded alternate,
not a gap. **UFC listings and Golazos offers have no such substitute that I could
find** — if those are meant to be ingested, they are not being ingested.

## The fourth one is a different, worse shape

`app/api/pinnacle/ingest-events` (38 lines, calls `ingestPinnacleSalesEvents` in
`lib/pinnacle/flow-events.ts` — one of the two instances the name-based sweep
hid) **writes no `pipeline_runs` row at all.** It is invisible to
`detect_stalled_pipelines`, to the cadence watchlist and to every health board
**by construction**, so its zero above proves nothing on its own.

Read the outcome table instead of the self-report: its cursor lives in
`backfill_state.id = 'pinnacle_flow_events'`, and **that row does not exist.**
Control: the table is live — `topshot-fmv-sweep` updated `last_run_at` today
(2026-08-21 13:40Z), and nine other ids carry state. So the walker has never
completed a run either. It also has no in-repo caller.

⚠ This is the more dangerous configuration of the two, and worth keeping even
after the route is resolved: a cursored walker with **no pipeline_runs row** can
run, fail, and advance a cursor with zero observability. If it were ever wired,
nothing would report it. Any new walker should write a `pipeline_runs` row before
it writes a cursor.

## Options (do not auto-apply — an ingest route is not a safe unilateral change)

1. **Delete all four** as dead code, the way `cron/pinnacle-listings-reconcile`
   was deleted today. Cheapest, and removes four routes' worth of maintenance
   surface that two sessions just spent effort hardening.
2. **Wire the two with no substitute** (`ufc-listings-indexer`,
   `golazos-offers-indexer`) if UFC listings and Golazos offers are wanted —
   a cron-job.org entry each, plus a `pipeline_cadence_watchlist` row so a
   silent stall is visible.
3. **`app/api/pinnacle/ingest-events`** — decide separately. If it is kept, it
   needs a `pipeline_runs` row before anything else; if it is wired as-is it
   would be the only cursored walker in the repo with no telemetry.

Deleting is reversible (`git revert`); leaving them dormant costs nothing but
keeps three routes in every future sweep's population. Recorded so the next
sweep does not re-derive it.
