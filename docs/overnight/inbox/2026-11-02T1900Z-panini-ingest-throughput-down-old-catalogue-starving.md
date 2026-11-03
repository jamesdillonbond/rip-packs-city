# Inbox 2026-11-02T1900Z — Panini ingest throughput down + old catalogue starving (read-only diagnosis, needs Claude Code)

Source: scheduled Panini freshness check ~11:00 AM PT 11-02 plus a follow-up diagnosis pass. Nothing was changed (DB, repo, laptop, Task Scheduler, scheduled-check prompt). Full write-ups in the Rip Packs City project: `claude/panini-throughput-diagnosis-2026-11-02.md` and `…-addendum.md`.

## Verdict
Runner is firing and authenticated (7 walks/24h, fmv_yield 1.00, stalest-first order intact, known_complete true) but does far too little work per walk.
- Yesterday 11-01: 1,832 editions priced = 36% of trailing-7, 4.6% of the 40,154-edition catalogue, 28% of days 8-28 baseline (6,522/day).
- Daily editions priced: 10-22 7,774 · 10-23 8,146 · 10-24 7,513 · 10-25 8,078 · 10-26 6,984 · 10-27 8,905 · 10-28 6,105 · 10-29 1,517 · 10-30 970 · 10-31 3,108 · 11-01 1,832.
- Old catalogue starving (Escalation 5): 14,576 editions un-repriced 7+ days, oldest 251.5 h, median old age 143.8 h, 0 walked in last 24 h. A starvation, not unretired prices. At ~3k/day a full pass over 40k takes ~12-13 days, so it cannot clear by itself.

## Cause so far
1. 10-29 ~06:00 → 10-30 ~17:00 PT: laptop runner dark (known; see handoff-2026-10-30-flowty-retirement). Recovered.
2. 10-31 onward is NOT the outage. Walks run ~180-195 min but write only 400-720 editions (was 1,500+ through 10-27). Batches are 1 edition, ~38-40 s apart, 390 serials per card.
3. Measured s/edition by serials per edition (70 h): ≤30 → 9.6 s · 31-100 → 10.8 s · 101-250 → 17.4 s · 250+ → 28.9 s. Heavy print runs (250+) are ~23% of editions but ~31% of walk time. Serial paging explains ~1.5x, not the whole 2-3x. Even light cards cost ~10 s, which points at per-page latency (Panini or browser).
4. Not proven: why per-card time rose after 10-28. Ruled out: walk order, enumeration time, FMV write path, pricing quality (repeat HI/MED 55.4%, n=3,529; algo panini-1.4.0 alone).
5. Evidence needed: %USERPROFILE%\panini-run.log on the laptop (`walk done N/M in Xm`, `serial paging: cards_paged=… extra_pages=…`). It is outside the Cowork-connected folders.

## Proposed fixes (none applied)
A. Read the last 3 `walk done` / `serial paging` lines in panini-run.log to see whether paging or page latency dominates.
B. Lower `PANINI_SERIAL_PAGES` (default 12 extra pages, runner line ~590) to ~6 in the Task Scheduler environment, or page only cards whose serials are stale > 7 d. Edition price does not use serial pages. Kill switch =0. Trade-off: serial-grain freshness (sales_missed).
C. Close the idle gap: walks end ~60 min before the next starts. Budget defaults are 75 min full / 105 min walk-only with RUN_DEADLINE 110 min (runner lines ~906/911) and the task repeats every 2 h with IgnoreNew (panini-schedule-every-2h.ps1); the ~180 min walks are chained runs, so change PANINI_WALK_BUDGET_MIN / PANINI_RUN_BUDGET_MIN in the task environment, not the script default.
D. Optional code: an aged-priority line so editions > 7 d old go ahead of fresh stalest-first ties (walk-order merge in scripts/ingest-panini-runner.mjs ~483-511, app/api/cron/panini-ingest/route.ts ~276-323). Run __tests__/api-cron-panini-ingest-walk-order.test.ts and `node --check` before and after.
E. Check-spec: with a ~12-day pass the Escalation 5 `old_older_7d >= 5` rule fires daily by design; gate on age only (oldest > 216 h) in the scheduled check `trig_01K68ddYeWqUumNN2RavC4ht` (11 AM PT daily). Not edited from the cloud.
F. Laptop reliability: confirm panini-keep-awake.ps1 and the power plan; a second outage reproduces the dip.

## Success test
Query 4/4b: pct_of_baseline > 55 and old_max_age_h falling toward < 168 within ~2 weeks; expect ~6-7k editions/day after B+C.
