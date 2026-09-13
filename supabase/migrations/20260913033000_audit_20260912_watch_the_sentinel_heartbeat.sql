-- ⭐ THE PAGER WAS NOT ON ITS OWN WATCHLIST. 136 active
-- `pipeline_cadence_watchlist` rows and NEITHER `sentinel` NOR
-- `sentinel-heartbeat` was one of them -- so the estate's alerting lane was the
-- only lane with no cadence arm at all. That is the register #80 shape stated
-- exactly: every watcher is a GHA schedule, and nothing watches the watcher.
--
-- MEASURED 2026-09-12 (PT), inside the `pipeline_runs` retention window:
-- `pipeline-sentinel.yml` is scheduled `34 * * * *` (hourly) and over a common
-- 51.2 h window GitHub STARTED only **19 of 51** ticks (37%); of 19 heartbeats,
-- 14 carry `event = schedule` and 0 are `workflow_dispatch`. Median gap ~3 h,
-- worst in window 14.1 h. Control: `backfill-pack-rip-metadata`, also hourly,
-- same table, same retention, but called by cron-job.org -- **0.86 runs/hour**.
--
-- ⚠ WHY `sentinel-heartbeat` AND NOT `sentinel`. The heartbeat is written by the
-- workflow BEFORE it calls the route, so it isolates DELIVERY from ROUTE HEALTH.
-- Watching `sentinel` instead would conflate "GitHub never started the job" with
-- "the route died" -- and those were separately measured this night (19 started,
-- 19 completed, **0** died), which is exactly the distinction worth keeping.
-- Watching both would double-report one fault.
--
-- ⚠ THRESHOLD IS 240 MIN AND THAT IS DELIBERATELY ABOVE THE CHRONIC MEDIAN.
-- At an hourly cadence the "correct" bound looks like ~120 min, and it would be
-- wrong here: the chronic median gap is ~180 min, so a 120-min arm would fire on
-- nearly every run and become permanent furniture -- the failure mode this repo
-- has paid for before (an arm that is always amber is an arm nobody reads).
-- 240 min fires on gaps WORSE than the known-degraded normal, i.e. on genuine
-- blackouts, and stays quiet through the chronic condition, which is tracked in
-- register #80 where a number belongs rather than in an alert that cries daily.
-- `max_minutes_without_success` is 480: the heartbeat is always written ok=true,
-- so a success gap only means delivery stopped for twice the blackout bound.
-- severity `medium` joins the sentinel's warn list; it does not page.
--
-- ⚠⚠ WHAT THIS CANNOT DO, STATED SO NOBODY MISTAKES IT FOR A FIX: it is
-- evaluated BY the sentinel, so it CANNOT FIRE DURING A BLACKOUT -- only on the
-- first run after one ends, reporting the gap retrospectively. It converts an
-- invisible chronic problem into a visible one on the ~37% of ticks that land.
-- **The real fix is transport**: move `pipeline-sentinel.yml`'s invocation to
-- cron-job.org, the measured-healthy path already carrying the control above.
-- ⛔ That was deliberately NOT done as a pg_cron + pg_net job, even though the
-- estate has 20+ of those and it would have been one INSERT: every one of them
-- carries its secret in the URL QUERY STRING (`?key=rpc_pls_...`), which this
-- register already documents as a live leak vector because Supabase edge logs
-- record full request URLs -- and `cron.job.command` is itself readable
-- plaintext. Adding the sentinel's bearer to that surface to fix a scheduling
-- problem would trade an availability bug for a credential one. cron-job.org
-- sends the token as a HEADER; it needs Trevor's console.
--
-- REVERT: delete from public.pipeline_cadence_watchlist where pipeline =
-- 'sentinel-heartbeat';
insert into public.pipeline_cadence_watchlist
  (pipeline, max_silent_minutes, severity, is_active, max_minutes_without_success, notes)
values
  ('sentinel-heartbeat', 240, 'medium', true, 480,
   'Written by pipeline-sentinel.yml BEFORE it calls the route, so it measures GitHub DELIVERY, not route health (19 started / 19 completed / 0 died, 2026-09-12). Scheduled hourly; chronic median gap ~3h at ~37% delivery, so 240min is set ABOVE the degraded normal to catch blackouts without becoming permanent amber. CANNOT fire during a blackout - the sentinel evaluates it - only on the first run after one ends. Real fix is moving the invocation to cron-job.org; see register #80.')
on conflict (pipeline) do update
  set max_silent_minutes = excluded.max_silent_minutes,
      severity = excluded.severity,
      is_active = excluded.is_active,
      max_minutes_without_success = excluded.max_minutes_without_success,
      notes = excluded.notes;
