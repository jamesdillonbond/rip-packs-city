# The board-liveness SWEEP completes only ~half the time — and `cron.job_run_details.status` under-reports that by 40%

Filed 2026-08-18 18:05 PT / 01:05Z (Claude Code, interactive). **The 999s themselves are already fully
documented** in `docs/reference/trust-board-and-safety.md` (they are the deliberate `budget_exhausted`
branch, not the exception sentinel; `duration_ms` and a direct probe call are the discriminators). ⚠ **I
started to re-file that and stopped — grepping `docs/` first is what caught it.** This adds the one thing
that analysis did not have: **the root cause, quantified.**

## The sweep's completion rate

`rpc-public-board-liveness-sweep` (jobid 288, `28 */6`) runs
`SET statement_timeout='900s'; SELECT public_board_liveness_sweep(600000);` — i.e. a **600 s internal
budget** under a **900 s statement timeout**. Last 10 runs, in seconds:

`79 · 127 · 292 · 414 · 549 · 621 · 788 · 900✗ · 900✗ · 904✗`

| reading | count |
|---|---|
| cron reports `failed` (hit the 900 s timeout) | **3 / 10** |
| **exceeded the 600 s INTERNAL budget** (⇒ `budget_exhausted: true` ⇒ leg publishes 999) | **5 / 10** |
| completed cleanly inside 600 s | **5 / 10** |

⚠ **THE INSTRUMENT LESSON: `cron.job_run_details.status` UNDER-REPORTS this failure by 40%.** The 621 s and
788 s runs report **`succeeded`** — they returned normally — yet both blew the function's own 600 s budget and
therefore produced an inconclusive sweep. **A job with an internal budget SHORTER than its statement timeout
has a failure mode that its scheduler cannot see.** That is the generalisation of the note already in
`trust-board-and-safety.md` ("do not infer which from the leg's cron status"), now with a rate on it.

⚠ **The durations are OSCILLATING ACROSS the budget, not sitting under it** — 79 → 904 across ten runs, with
the top half straddling 600 s. **This is the second recorded instance of that exact shape**, after jobid 235
`rpc-refresh-market-index-daily` (118.9 / 357.7 / 438.3 / 462.1 s, recorded in the same reference file). **A
job whose runtime has grown to straddle its own budget fails intermittently and looks flaky rather than
sick** — worth treating as a recognised pattern rather than two coincidences.

## Current state: recovered, and the board will self-correct at 02:48Z

- The **00:28Z sweep succeeded in 549 s** (inside budget). Direct probe now returns
  `budget_exhausted: false, probed: 45, empty_or_error: 0, slow: 14, sweep_age_min: 33`.
- The precompute still publishes **999 / 999** from the **20:48Z** leg run, which read the exhausted 18:28Z
  sweep state.
- jobid 326 (`48 2,8,14,20`) next fires **02:48Z** and will publish the true values.

⚠ **So the two currently-breached board arms are STALE, not real.** The honest values are
`public_board_empty_count = 0` (**green**, currently shown as a maximal 999 breach) and
`public_board_slow_count = 14` (**still breaching at `breach_at 1`, but 14 ≠ 999**). **Do not investigate a
board-integrity incident off these numbers before 02:48Z.**

⚠ **I did NOT hand-run the leg to correct them early.** It would have written real values into the trust
board ~2 h sooner, but it is a mutation to the operator's primary health surface made outside its schedule,
and the arm self-corrects. **Left for the schedule.**

## What would actually fix it

1. **Find why the sweep's runtime grew.** It probes 45 active boards; at 549–904 s that is ~12–20 s per board.
   Whether that is per-board cost growth or board-count growth is unmeasured — **measure before tuning.**
2. **Do not just raise the 600 s internal budget** — that converts inconclusive sweeps into 900 s statement
   kills, trading a visible-but-honest 999 for an outright failure. The budget is doing its job.
3. **Consider a partial-sweep report instead of all-or-nothing.** `probed: 0` vs `probed: 30 of 45` are very
   different facts, and the current shape collapses both to 999.
4. ⚠ **The deeper defect stands: 999 is a NUMBER in a numeric-only channel** (`rpc_trust_health_precompute`
   is `metric, value, computed_at, duration_ms` — **no status column**), so "could not measure" has nowhere
   to go except into the value, where it reads as a maximal confirmed breach. **A status/inconclusive column
   is the structural fix**, and it would retire the whole 999 convention.
