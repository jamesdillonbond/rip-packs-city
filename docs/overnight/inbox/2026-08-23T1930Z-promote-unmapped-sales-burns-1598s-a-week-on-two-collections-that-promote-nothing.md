# `promote_unmapped_sales` spends **1,598 s/week** on two collections that promote **zero** rows — and it was invisible because its duration column read 0

**Filed 2026-08-23 (PT) 12:30 by Claude (Cowork, cloud). Measured, NOT shipped.**
Saturation control at measurement time: `io_wait=5 / active=7` — quiet, per the
[18:12Z monitor](2026-08-23T1812Z-daytime-monitor-saturation-spell-symptoms.md)'s instruction to
re-measure outside the spell.

Direct follow-on from
[the duration_ms fix](2026-08-23T1910Z-pipeline-runs-duration-ms-was-structurally-zero-for-ten-pipelines.md):
this job's cost only became readable once `finished_at` stopped preceding `started_at`. ⓘ It also
carries its own `duration_ms` inside `extra`, which is what the table below uses — so its history
survives, unlike the other nine.

## The numbers — last 7 days, per collection

| collection | runs | avg ms | **total DB time** | eligible | promoted |
|---|---|---|---|---|---|
| `nfl_all_day` | 808 | 28,800 | **23,270 s (6.5 h)** | 648 | 564 |
| `ufc_strike` | 121 | 9,321 | **1,128 s** | **0** | **0** |
| `laliga_golazos` | 328 | 1,433 | **470 s** | **0** | **0** |

**≈ 24,868 s — 6.9 hours of database time in 7 days**, about a 4% duty cycle. Of that,
**1,598 s (26.6 minutes/week) is spent by UFC and Golazos discovering that there is nothing to
do.** Not "mostly nothing". Zero eligible, zero promoted, across 449 runs.

## Why this is the jobid-78 pattern, not a tuning question

The register already records the shape: *"jobid 78 — candidate pool 4,256 / already written 4,256,
exactly equal… Raising it would only make the waste reliable. DECLINED, correctly."* And:
**failure rate is not waste; work-per-outcome is.**

Work-per-outcome here:

- `ufc_strike` — **∞** (1,128 s ÷ 0 promotions)
- `laliga_golazos` — **∞** (470 s ÷ 0)
- `nfl_all_day` — 41 s of DB time per promoted row (23,270 s ÷ 564)

⚠ **UFC is not idle-because-empty.** A sampled row shows `open_backlog: 1069` with
`eligible: 0` — there IS a backlog and nothing in it ever qualifies. That is either correct and
permanent (the same shape as
[[allday-backfilled-sales-can-never-be-probed]], where two correct guards compose into rows that
can never be scanned) or a wedge nobody can see. **Either way, paying 9.3 s per run to re-learn
"still 0" is the waste, and the answer is not to make the query faster.**

## Cheap actions, in order

1. **Gate the per-collection leg on `eligible > 0`** — or on a cheap backlog probe — before doing
   the expensive part. Costs one index lookup; removes 449 runs/week of pure scan.
2. **Then** ask the real question for UFC: 1,069 open rows, 0 ever eligible. Is that the correct
   permanent state (in which case archive them and stop counting them as backlog), or a stuck
   predicate? ⛔ Do NOT widen the eligibility predicate to "fix" the zero without answering that —
   that converts invisible waste into visible bad data.
3. NFL at 41 s per promoted row is expensive but is doing real work. Leave it; re-derive after (1).

## What I am NOT claiming

- ⛔ **Not "this causes the saturation spells."** It is a ~4% duty-cycle contributor measured in a
  quiet window; the band class is known and I am not reopening it. What is new is only that this
  job's cost was **unreadable until an hour ago**.
- ⛔ **Not a 30-day figure.** `pipeline_runs` retains **72.7 h** (oldest row 2026-08-20 18:41Z,
  47,264 rows) — I wrote "30 days" on a sibling filing an hour ago and had to correct it. The
  7-day window above is served from `extra->>'duration_ms'` on the rows that exist; treat it as
  ~3 days of runs annualised by that column, not a 7-day census. **Confirm against
  `pipeline_runs_daily` before quoting any weekly total in a decision.**

## Sibling number worth recording while it is visible

`pack-ask-hourly-low-roll` (jobid 77 `rpc-roll-pack-ask-hourly-low`, `7,22,37,52 * * * *`,
`cron_heavy`): **2,879 cron runs / 30 days, avg 46.8 s over the last 7** — roughly **37 hours of
worker time a month, a ~5% duty cycle from one job**. Unlike the above it is doing real work:
813,809 rows written across the 274 runs the retention window holds, ~2,970 rows/run, none zero.
⚠ Its `pipeline_runs` logging only begins **2026-08-20 18:52Z** — that is the retention edge, not
a logging gap. I briefly mis-read 274-of-2,879 as a 9.5% logging rate by comparing a 3-day table
against a 30-day cron count; **the cron history and pipeline_runs do not share a window.**
