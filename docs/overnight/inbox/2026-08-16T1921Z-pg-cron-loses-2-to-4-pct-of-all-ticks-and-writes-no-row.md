# pg_cron never STARTS ~2-4% of all scheduled ticks, and a lost tick writes no `pipeline_runs` row

Filed 2026-08-16 12:21 PT (19:21Z). **Read-only. Nothing changed.** Found while splitting jobid 71's
failure modes — 3 of its 13 weekly failures were not timeouts at all.

## The signal

`cron.job_run_details.return_message = 'job startup timeout'` means pg_cron could not launch a
background worker. **The job never ran.** It is not "ran and failed":

| date | total ticks | never started | % |
|---|---|---|---|
| 08-03 | 3,614 | 12 | **0.33%** |
| 08-07 | 3,615 | 15 | 0.41% |
| 08-09 | 3,607 | 20 | 0.55% |
| 08-13 | 3,934 | 42 | 1.07% |
| **08-14** | 4,002 | **154** | **3.85%** |
| 08-15 | 4,005 | 123 | 3.07% |
| 08-16 (partial) | 3,289 | 62 | 1.89% |

**Tick volume is essentially flat** (~3,600 -> ~4,000/day, matching pg_cron 85 -> 92 jobs), so this is
a **rate** change, not a volume change: a rising baseline (0.33% -> ~1% by 08-13) with volatility
(spikes 08-05 1.97%, 08-10 1.58%, 08-11 2.06%) and a step to **3.85% on 08-14**.

⚠ **08-14 is the same date CLAUDE.md records for the `fmv-recalc` step change** (completion rate
collapsed, kill rate 38% -> 75%). Two independent instruments crossing on one date is worth more than
either alone — but note both are *symptoms* of instance saturation, so this is one root cause with two
faces, **not a second investigation to open**.

## Why it is invisible to every existing monitor

**A tick that never starts writes no `pipeline_runs` row at all.** So:

- The pipeline's own `ok`/`rows_written` telemetry is computed **only from ticks that did start** —
  every health reading is conditioned on survival, and reads green.
- `detect_stalled_pipelines()` keys on the terminal row and only fires on *sustained* absence. A 2-4%
  dropout on a `*/2` job is nowhere near that threshold.
- This is the **same shape** as the documented "a 401 writes no `pipeline_runs` row, so it looks
  exactly like never scheduled" trap, and the `fmv-recalc` "`pipeline_runs` counts SURVIVORS" trap —
  a third instance of the same blind spot, arriving by a third route.

## What it is NOT

⚠ **Not specific jobs breaking.** The per-job rate is strikingly uniform — **1.7% to 3.9%** across the
twelve worst — so the absolute leaderboard is just a frequency ranking: `rpc-pinnacle-mints-backfill`
(`*/2`) tops it with 104 missed ticks in 7 d **at 2.1%**, which is what 2% of 3,360 ticks looks like.
**Do not "fix" the jobs at the top of that list.** Both `postgres`- and `cron_heavy`-owned jobs are hit
at the same rate, so it is not a role budget either.

⚠ **Mostly not data loss, but not provably harmless.** Cursored backfills lose nothing — the next tick
resumes. The exposure is any job that is **not** idempotent-on-resume, or whose window is bounded by
wall-clock rather than a cursor. That set has not been enumerated, and enumerating it is the useful
next step.

## What would settle the cause

pg_cron launches each run in a background worker; startup fails when a slot cannot be obtained.
Candidates, none tested: `max_worker_processes` exhaustion under concurrent heavy jobs; connection
pressure against `max_connections=90` on the 2 GB instance; or simply the documented disk-IO
saturation delaying worker startup past pg_cron's tolerance.

The cheap discriminator is **time-of-day correlation against the known saturation window** — if the
losses cluster where the heavy `cron_heavy` jobs overlap, it is contention, not a static limit.

⚠ **Do not raise a worker/connection limit to "fix" this without that measurement.** On a 2 GB
instance more concurrent workers is a plausible way to make the saturation worse, and the
documented tier guidance is to fix expensive queries rather than add capacity.
