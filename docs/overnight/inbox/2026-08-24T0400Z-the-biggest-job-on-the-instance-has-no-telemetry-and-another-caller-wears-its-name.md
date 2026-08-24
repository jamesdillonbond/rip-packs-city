# ⛔ The largest job on the instance writes NO telemetry — and a second, cheaper caller wears its name in `pipeline_runs`

**Filed:** 2026-08-24 04:00Z (21:00 PT) · **By:** Claude Opus 5, Cowork cloud · **Status:** MEASURED. **NOT fixed — FMV logic is off-limits for autonomous shipping and I am respecting that.** The remedies below are one edit each.

## The headline

`rpc-refresh-wmc-fmv-changed` (**jobid 303**) is the single largest consumer on the box:
**143 runs / 24 h, avg 336.4 s, max 578.7 s, 48,111 worker-seconds/day** — roughly **13.4 hours of
worker time per day**, and after tonight's panini fix it is ~5× the next consumer.

⛔ **It writes zero rows to `pipeline_runs`.** `refresh_wmc_fmv_changed(integer,integer)` — the exact
signature the cron calls — **does not contain a `log_pipeline_run` call at all** (checked against
`pg_proc.prosrc`). Same for `refresh_wmc_fmv_drift_active(numeric,integer)`.

## ⛔ And the name is already taken, by something 9× cheaper

`pipeline_runs` **does** hold 268 rows/24 h named `refresh_wmc_fmv_changed`. They are not jobid 303.

| | cron jobid 303 | the logged caller |
|---|---|---|
| schedule | `7-57/10` → 143 ticks/day | 268 runs/day, not on `:x7` |
| `p_limit` | **200000** | **50000** |
| telemetry | **none** | full, with `extra` |
| cost | **48,111 s/day** | 5,120 s/day |
| `ok=false` | n/a | **67 of 268** |

Two independent proofs they are different callers:

1. **Not one of the 268 rows lands on the `:x7` minute** the cron fires on. Bucketing by
   `extract(minute from started_at) % 10 = 7` puts **0** runs in the cron bucket and all 268 in
   "other".
2. **The parameters differ.** Every logged row carries `{"p_limit": 50000, "p_since_minutes": 30}`;
   the cron command is `SELECT public.refresh_wmc_fmv_changed(30, 200000)`.

So an app or edge worker calls the same function with a different limit and does its own
`log_pipeline_run` around it. **The DB function is innocent — the logging lives in the caller, and
only one of the two callers has any.**

## ⚠ Why this matters more than the raw seconds

**Anyone reading `pipeline_runs` for this pipeline gets 5,120 s/day and attributes it to the cron
job. The real cron figure is 48,111 s/day — 9.4× larger — and it is invisible in the table everyone
reads.** I nearly made exactly that error: my first pass at this job pulled the `pipeline_runs`
average (19.1 s) and it disagreed with the cron average (336.4 s) by 17×. **The disagreement is the
only reason the collision was found.**

This is a new shape in the *instruments that lie* family: not a monitor that mis-measures, but **two
systems sharing one pipeline name, where the instrumented one is the minor one.** A cost ranking
built on `pipeline_runs` cannot see the biggest job on the instance, and a health board reading
`ok=false` for this pipeline is reporting the app worker's 67 failures while the cron job's 9
failures go uncounted.

## ⚠ An open question I did NOT answer — possible duplicated work

Both callers refresh "wmc fmv changed" over the same **30-minute** lookback, concurrently: cron every
10 minutes at `p_limit=200000`, the other roughly every 5 minutes at `p_limit=50000`. **If their
windows overlap, they are substantially re-doing each other's work** — combined ≈ **53,000 s/day
(~14.7 worker-hours)**. Confirming or refuting that needs the function body read against both call
patterns, which is FMV logic. **Not attempted here.**

## The remedies, in order — each is small, none is shipped

1. **Cheapest and zero-risk: stop reading the wrong table for this job.** The data already exists in
   `cron.job_run_details`. Any cadence/cost arm for jobid 303 should read cron, not `pipeline_runs`.
   No code change at all.
2. **Give the cron call telemetry.** Wrap the cron command in `log_pipeline_run` under a *distinct*
   pipeline name — e.g. `refresh-wmc-fmv-changed-cron` — rather than adding it inside the function.
   ⭐ **Do not reuse the existing name**: that would merge two different workloads into one series and
   destroy the distinction this filing just established.
3. **Then, and only then, ask the overlap question.** With both callers labelled separately, a day of
   data answers whether the 200k and 50k passes duplicate work.

⛔ **Why I stopped here.** "FMV logic is off-limits for autonomous shipping" is a standing accuracy
rule, and this is the pricing path. Remedy 1 is genuinely zero-risk and remedy 2 is additive, but
both touch the largest job on the instance and neither is user-facing urgent. Diagnosing it fully so
the decision is one read away is the right trade at 21:00 PT unattended; shipping into the FMV path
at that hour is not.
