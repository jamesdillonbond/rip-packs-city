# Daytime monitor — 2026-08-18T21:10Z (in an active saturation spell)

**One candidate, and it is a SYMPTOM to re-measure in a quiet window — not a causal conclusion.** Sweep ran during a confirmed disk-IO saturation spell (positive control below), so per SKILL §1c no cost/cause claims are drawn here.

## Positive control (why this is a spell, not N bugs)
`pg_stat_activity` at 21:06Z: **io_wait=31 / active=33 / total=44** — the overwhelming majority of active sessions are in IO wait. `rpc_ops_snapshot()` itself timed out at the statement-timeout, which is the §1c spell tell.

Downstream of that one root cause, and therefore NOT filed as distinct bugs (all known-class per focus.md "one root cause; do not open new investigations into saturation symptoms"):
- `check_pgcron_recent_failures()` returned **20 jobs, every one** a `statement timeout` or `job startup timeout`, **zero logic errors** — textbook §1c saturation collateral (MV-refresh legs: pack-ev-latest ×12, topshot/allday pack-sales-agg, misattrib, ccm-step1/2, set-completers, new-collectors, fmv-display-guard, thin-sale-ask, fmv-clamp, challenge-costs, board-liveness-sweep, candy-wmc-ghost-purge, etc.).
- `detect_stalled_pipelines()` returned 4, three already known/filed: `candy-editions-ingest` (08-03/04 timeout class, handed off), `compute-golazos-pack-ev` (filed 2026-08-18T1406Z), `topshot-active-listings-ingest` (known atlas-proxy egress dropout).

## The one candidate — `allday-pack-opens-backfill` silence: scheduler-stop vs spell collateral
- **Observation (dated sample):** `detect_stalled_pipelines()` reports it **silent 419 min** vs its 90-min threshold, `last_run` 2026-08-18T14:16:06Z. Job 55 fires every 10 min (`6,16,26,36,46,56 * * * *`).
- **Why it is ambiguous:** its watchlist note says the finite walk was due to hit `SPORK_FLOOR` (65,264,619) ~2026-08-14 and thereafter return `done:true`, and that the row is KEPT ACTIVE deliberately because "silence still means the SCHEDULER stopped" = a real signal. But we are mid-spell with pg_cron broadly `job startup timeout`-ing, so a 419-min gap on a 10-min cron is equally consistent with job-55 ticks being startup-timed-out and never logging.
- **Suggested action (quiet-window RE-MEASURE, low risk, read-only):** when IO wait clears, confirm (a) `SELECT jobname, active FROM cron.job WHERE jobid=55;` still `active=true`, and (b) `cron.job_run_details` for jobid 55 shows recent `succeeded`/`done:true` ticks. If the scheduler is firing and only the spell suppressed logging → close as saturation collateral. If job 55 is unscheduled or genuinely silent post-spell → real finding (the designed tripwire caught a scheduler stop), retire-or-repair per the watchlist note.

## Clean this run
Security invariants clean (public RLS-off `[]`, anon/authenticated write-grant-on-RLS-off `[]`). Vercel: no un-superseded ERROR — the lone ERROR (15:09Z `drain-fmv-cold-tail` heartbeat commit) was superseded by READY builds of later commits; latest is BUILDING (Top Shot series-filter fix, 21:08Z), last prod READY 17:36Z. Artifact payload-query validation SKIPPED this run per §1b (heavy reads during a spell are symptoms, not broken artifacts).
