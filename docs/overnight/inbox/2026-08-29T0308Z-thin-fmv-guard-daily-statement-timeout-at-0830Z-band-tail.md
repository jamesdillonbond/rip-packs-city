# `rpc-refresh-thin-fmv-guard` failed its 08-28 08:30Z daily tick on a statement timeout — likely band-tail saturation collateral, but unfiled and it writes an FMV table

**Source:** daytime monitor 2026-08-29 03:08Z (13:05 PT tick). `check_pgcron_recent_failures()` surfaced exactly one pg_cron failure: `rpc-refresh-thin-fmv-guard`, `last_run 2026-08-28 08:30:00Z status=failed`, `last_fail_message: canceling statement due to statement timeout` in `INSERT INTO public.topshot_thin_fmv_editions (edition_id, fmv_usd, median_90d, n_90d, computed_at) WITH cand AS (…)`.

**Not in a spell at read time** — positive control `io_wait 0 / active 0` at 03:05Z. So the *interpretation below* is a quiet-window read of a band-time failure, not a spell filing.

**Cadence + history (`cron.job_run_details`, 48h):** schedule `30 8 * * *` (daily, single tick at 08:30 UTC), `active=true`. **last_ok 2026-08-27 08:30:00Z (succeeded), last_run 2026-08-28 08:30:00Z (failed).** So the job succeeded at its slot the day before and failed at the same slot today — a 1-of-2 coin-flip at a fixed time-of-day.

**Read (stated as a hypothesis, not a conclusion):** 08:30Z sits in the **tail of the 01:00–19:00Z daytime IO band** (same band the 2026-08-28T1810Z filing and repeated ledger entries attribute statement-timeout collateral to). A daily job that clears its slot one day and times out the next, at the same in-band minute, with a plain `statement timeout` and **no logic error**, is the textbook saturation-collateral shape CLAUDE.md warns against reading as N distinct bugs. **Most-likely cause: band saturation, not a query that structurally cannot complete.**

**Why it is still worth a row rather than a shrug:** (1) it is **not previously filed** in inbox or ledger (verified: no `thin-fmv-guard` / `topshot_thin_fmv_editions` reference in either), and a recurring daily FMV-write failure that nobody has looked at is exactly what this monitor exists to surface; (2) it writes `topshot_thin_fmv_editions`, which is **accuracy-relevant** (thin-market FMV fallback), so a persistent failure would degrade coverage silently on the thinnest editions — the ones least able to afford a missing price.

**Risk read:** LOW. Single daily tick, one failure, upstream-independent (this is an internal INSERT, unrelated to tonight's Top Shot GraphQL 530 outage). No user-facing board reads this directly at WAU ~2.

**Suggested action (quiet-window RE-MEASURE, do NOT raise the timeout):**
1. In a quiet window (20:00–00:00Z, io_wait ~0), run the guard's `INSERT … WITH cand AS (…)` body under `EXPLAIN (ANALYZE, BUFFERS)` and read **BUFFERS**, not wall-clock. If it completes comfortably under its declared `statement_timeout` cold, the 08-28 failure was band collateral → **no code change; let it self-clear on the 08-29 08:30Z tick** (a monitor tick after ~08:35Z can confirm).
2. Only if it exceeds budget *outside* the band is there a real query-cost defect to fix — in which case scope the `cand` CTE (the same DISTINCT-ON / predicate-vs-index-order class two `refresh_wmc_fmv_*` functions were just fixed for; check whether `cand` walks a `fmv_snapshots` index whose lead column is not the predicate column). ⛔ Do not raise `statement_timeout` — that buys a slower failure and more IO.
3. ⛔ Do not alarm if the 08-29 08:30Z tick succeeds — that confirms band collateral and this row can be dropped.

**NOT established:** whether the INSERT's own cost is anywhere near budget (no BUFFERS taken — an in-band ANALYZE would only add load and mislead), nor that the failure recurs (n=1 failure against n=1 recent success). This is a sense-and-log, not a diagnosis.
