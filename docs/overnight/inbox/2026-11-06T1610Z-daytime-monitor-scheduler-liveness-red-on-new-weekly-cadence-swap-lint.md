# Scheduler-liveness check reds `main` daily — the new weekly `cadence-swap-lint.yml` has no scheduled run yet

- **Filed:** 2026-11-06 ~16:10 UTC (08:10 AM PT), daytime health monitor (read-only pass).
- **Priority:** HIGH-ish for noise/visibility (a persistent red on `main`), LOW for platform impact (no data/user effect).

## What

The daily **Scheduler liveness** GitHub Actions check (`.github/workflows/scheduler-liveness.yml`,
job "Did the scheduled workflows actually fire") is **failing**, and that failure is attached to
`main` HEAD (commit `2548434`). Its annotation:

> `cadence-swap-lint.yml has not fired on schedule for ever (bound 192h). Its schedule is not running.`

So the one red check on `main` right now is this liveness detector, not a broken build or test.

## Why (benign root cause — a newly-added weekly workflow before its first slot)

- `cadence-swap-lint.yml` was **added 2026-11-02 ~23:13 UTC** (ledger `2026-11-02 · SHIPPED (CI)`,
  ledger line ~382). Its schedule is **weekly**: `cron: "41 17 * * 1"` (Mondays 17:41 UTC).
- Run history (GitHub API): **2 runs total** — a `push` run (11-02 23:13Z, failure) and a
  `workflow_dispatch` run (11-02 23:15Z, success). **Zero `event=schedule` runs ever.**
- It was committed *after* the Monday 11-02 17:41Z slot had already passed, so its **first scheduled
  slot is Monday 11-09 17:41 UTC**. Until that lands, there is no schedule-event run for the
  detector to see.
- The liveness detector's weekly bound is **192h** (one 168h period + 24h grace — the 2026-10-26
  "stops calling a LATE daily job dead" fix, ledger line ~1146). That fix graces a weekly job that
  ran *late*, but a weekly job that has **never had a first scheduled run** still trips the
  total-silence branch ("…for ever"), so it reds `main` every day from 11-02 until the first slot
  records on 11-09.

## Impact / not-impact

- **No platform or data impact.** Scheduled GitHub workflows are firing normally (RPC Data Pipeline,
  Pipeline Sentinel, Offer-Fill Backfill, etc. all `success` in the 15:09–15:19Z window today);
  `detect_stalled_pipelines()` `[]`; `rpc_ops_snapshot()` security/trust/stalled all clean;
  the DB-side `gha-schedule-watchdog` reports **0 cadence lanes breaching**.
- **Real cost:** `main` carries a red CI check daily, which can mask a genuinely new failure and
  erodes the "red means act" signal.
- A manual `workflow_dispatch` does **not** clear it — the detector counts schedule-event runs only.

## Suggested action (night pass / Trevor — sensing only, not fixed here)

1. **Simplest:** let it self-clear after the **Mon 11-09 17:41 UTC** scheduled run of
   `cadence-swap-lint` records, then confirm the next 08:17Z Scheduler-liveness run goes green.
   Risk: a weekly slot *can* also be shed by GitHub; if 11-09 is shed, this stays red another week.
2. **Durable fix (preferred):** teach `scripts/check-scheduler-liveness.mjs` to grace a workflow
   whose **first scheduled slot has not elapsed since it was added** — i.e. skip the total-silence
   failure when the workflow has zero schedule-event runs AND its age < (period + grace). This is
   the sibling gap to the 10-26 daily-late fix: that one covered *late*, this one covers
   *not-yet-first-fired*. Add a test: a 3-day-old weekly workflow with 0 schedule runs is alive;
   a 9-day-old one with 0 schedule runs is dead.

## Source / evidence

- GHA check-run `127994330348` on `main` HEAD `2548434`, annotation quoted above.
- `.github/workflows/cadence-swap-lint.yml` (`cron: "41 17 * * 1"`, added 11-02).
- `actions/workflows/cadence-swap-lint.yml/runs`: total 2, 0 schedule-event.
- Ledger: 2026-11-02 cadence-swap-lint ship (~L382); 2026-10-26 liveness daily-late fix (~L1146).
