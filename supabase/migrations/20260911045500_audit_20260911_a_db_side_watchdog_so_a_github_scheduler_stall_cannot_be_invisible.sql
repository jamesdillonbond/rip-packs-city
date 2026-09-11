-- ============================================================================
-- A DB-SIDE WATCHDOG FOR GITHUB'S SCHEDULER — 2026-09-10 PT (04:55Z 09-11)
--
-- 🚨 WHAT HAPPENED. On 2026-09-10 GitHub delivered ZERO `schedule` events to
-- this repository from 01:30Z onward. Measured, not inferred: `schedule`-event
-- workflow runs land ~4.3/hour (30 runs over the 7 hours to 01:30Z, hourly
-- range 1–6); across the next 2.8 hours, with ~27 slots passing on four
-- high-frequency workflows, ZERO arrived. Against the freshest measured
-- delivery rate for this repo — 27% of an hourly cron over 191.9 hours, median
-- gap 4.06h, max 5.97h (measured 2026-09-10 PT, superseding the 16-of-48 figure
-- in sales-indexers-backstop.yml) — twenty-seven empty slots is p ≈ 2e-4 IF the
-- slots were independent. ⚠ They are not: shedding is load-correlated, so read
-- that as an upper bound on significance rather than as proof. What is not in
-- doubt is the direction — this window is far worse than the long-run rate.
-- Actions itself was healthy throughout: three `workflow_dispatch` runs and
-- every push CI run succeeded in the same window, and the queue held exactly
-- one run (from 2026-08-19), so nothing was merely delayed.
--
-- ⛔ THE STRUCTURAL DEFECT THIS FIXES IS NOT THE STALL. It is that EVERY
-- watcher in this estate is itself a GHA `schedule` — `pipeline-sentinel`
-- (hourly :34) above all — so the lanes and their alarm stop together. A
-- correlated alarm is no alarm. Tonight the ten lanes of dead-lane-backstop,
-- topshot-active-listings-ingest, topshot-sales-history-backfill and
-- pinnacle-owner-discovery were silent for hours with NOTHING able to say so,
-- and the only reason it was noticed is that a session happened to look.
--
-- ✅ THE FIX IS AN INDEPENDENT SCHEDULER. pg_cron lives in the database, ran
-- normally through both of today's outages (the ~10h Vercel spend-cap pause,
-- #76, and this stall), and is the one caller GitHub cannot throttle. This
-- function is therefore the watcher of the watchers, and the two systems now
-- observe each other:
--     pg_cron  -> notices that GitHub's scheduler has stopped delivering
--     GHA      -> notices that pg_cron has stopped (the watchlist row below)
--
-- ⚠ WHY THE ALARM WINDOW IS 6 HOURS AND NOT 3. A threshold is a false-alarm
-- budget, so it has to be computed from the delivery rate rather than picked.
-- At 27% delivery and 4 slots/hour a 3-hour window is 12 slots: an all-miss run
-- has p = 0.73^12 ≈ 2.3%, and with 96 starting positions a day that is ~2 such
-- runs EVERY DAY — a watchdog that fires daily on nothing is worse than none,
-- because the estate learns to ignore it. Six hours is 24 slots: p ≈ 5e-4 per
-- evaluation, ~2.5% across a day of half-hourly ticks. The cost is detection
-- latency and it is stated plainly — a stall publishes ~6h in, not 3. The 3h and
-- 24h tick COUNTS are written on every tick regardless, so degradation is
-- readable long before the flag flips: the flag is the alarm, the counts are the
-- instrument. ⚠ Re-derive both if the backstop's cadence or GitHub's rate moves.
--
-- ⭐ HOW SCHEDULER LIVENESS IS MEASURED, and why it needed a code change: a
-- heartbeat row used to record that a workflow RAN but not WHICH TRIGGER ran
-- it, so a `schedule` tick and a hand-fired `workflow_dispatch` were
-- indistinguishable in `pipeline_runs` — which is exactly the distinction
-- tonight turned on (the only runs that existed were dispatches). Both
-- heartbeat writers now tag `extra.event` with `github.event_name`, and this
-- function counts ONLY `event = 'schedule'` rows. `dead-lane-backstop` fires
-- 4x/hour, so the alarm window carries four times the slots an hourly probe
-- would: at 27% delivery the sentinel alone cannot separate a stall from its own
-- normal 4.06h median gap at any useful latency. That sampling rate is why the
-- probe lives on the backstop and not only on the sentinel.
--
-- ⚠ THREE STATES, NEVER TWO — a watchdog that cannot see is not a watchdog
-- that sees nothing wrong. `gha_schedule_stalled` is:
--     true   -> tagged heartbeats exist, the probe has been live > 6h, and no
--               `schedule`-tagged tick landed in the last 6h
--     false  -> a `schedule`-tagged tick landed within 6h
--     NULL   -> cannot tell yet: no tagged heartbeat inside retention, or the
--               probe itself is younger than the 6h window (deploy grace)
-- `verdict` spells out which. A NULL must never be read as "fine".
--
-- 🚨 AND THE FIRST TICK FOUND THE HOLE IN THAT, WHICH IS WHY THE 12-HOUR RULE
-- EXISTS. A TOTAL stall produces no tagged heartbeat AT ALL — nothing runs, so
-- nothing writes one — and the branches above classify that as `unknown`, not
-- `stalled`. With `ok` keyed on `stalled` alone, the single worst case this
-- watchdog was built for would have written `ok = true` forever while the
-- estate's only scan (`ok = false`) saw nothing. That is this repo's own
-- honesty defect, rebuilt inside the instrument meant to prevent it, and it
-- was caught only by running the thing and reading what it actually wrote.
--
-- ⚠ SO AN UNKNOWN HAS A SHELF LIFE: tolerable for the first 12 hours after this
-- lane starts writing (a deploy artifact), a BROKEN INSTRUMENT after that, and a
-- broken instrument must never read as health. `instrument_broken` carries it and
-- sets `ok = false` exactly like a stall does. 12h is chosen to be longer than
-- any legitimate gap before the first tagged heartbeat (the backstop fires 4x an
-- hour even at 27% delivery) and far shorter than the 73h retention that bounds
-- what can be seen at all.
--
-- ⚠ `p_ok` DESCRIBES THE FINDING, NOT THIS FUNCTION'S EXECUTION, and that is
-- deliberate: `ok = false` is what the daytime monitor scans for, so a row
-- that merely carried the stall in `extra` would be written and never seen.
-- This function's own liveness is evidenced by the row EXISTING — and by the
-- watchlist row below, which makes the GHA sentinel alarm if these rows stop.
-- Cadence breaches are carried as CONTEXT only and never set `ok = false`:
-- the sentinel already alarms on those, and during any GHA stall there will be
-- many, which would bury the one finding this lane exists to publish.
--
-- ⚠ rows_* ARE NULL, NEVER 0. A watchdog has measured NOTHING; a lane writes 0
-- because it genuinely moved no rows. The 3-argument `log_pipeline_run`
-- overload COALESCEs all three to 0 — a fabricated zero — so this calls the
-- 11-argument form with explicit NULLs.
--
-- ⚠ RETENTION BOUNDS WHAT THIS CAN SEE: `pipeline_runs` keeps ~73h, so the
-- scan window is 72h and a stall older than that reads as "no tagged
-- heartbeats" (NULL / unknown), not as a stall. For detection the 3h window is
-- what matters.
--
-- COST: `detect_stalled_pipelines()` measured 18.5 ms / 1,767 shared-hit
-- buffers warm; the heartbeat scan covers ~15.7k rows/24h. At 2 ticks/hour the
-- whole watchdog costs well under a second of DB time per day. The DB is
-- IO-bound, so this was measured before scheduling rather than assumed.
--
-- REVERT (all three parts):
--   SELECT cron.unschedule('rpc-gha-schedule-watchdog');
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'gha-schedule-watchdog';
--   DROP FUNCTION IF EXISTS public.rpc_gha_schedule_watchdog();
-- The `extra.event` tags in the two workflows are independent and harmless on
-- their own (an extra jsonb key); revert those with `git revert` if wanted.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rpc_gha_schedule_watchdog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_breaches      jsonb;
  v_breach_count  int;
  v_breach_sample jsonb;
  v_ticks_6h      int;
  v_ticks_3h      int;
  v_ticks_24h     int;
  v_last_sched    timestamptz;
  v_tagged_any    int;
  v_first_tagged  timestamptz;
  v_last_any      timestamptz;
  v_self_first    timestamptz;
  v_broken        boolean;
  v_stalled       boolean;
  v_verdict       text;
  v_silent_min    numeric;
  v_error         text;
  v_extra         jsonb;
BEGIN
  -- Context, not the verdict. A jsonb-array check returns an ARRAY: read its
  -- LENGTH, never a row count.
  v_breaches     := public.detect_stalled_pipelines();
  v_breach_count := jsonb_array_length(v_breaches);

  SELECT COALESCE(jsonb_agg(nm ORDER BY nm), '[]'::jsonb)
    INTO v_breach_sample
    FROM (
      SELECT e->>'pipeline' AS nm
        FROM jsonb_array_elements(v_breaches) e
       ORDER BY 1
       LIMIT 12                       -- bounded: a broad stall must not write an
    ) s;                              -- unbounded blob into pipeline_runs.extra

  SELECT count(*) FILTER (WHERE h.ev = 'schedule' AND h.started_at > now() - interval '6 hours'),
         count(*) FILTER (WHERE h.ev = 'schedule' AND h.started_at > now() - interval '3 hours'),
         count(*) FILTER (WHERE h.ev = 'schedule' AND h.started_at > now() - interval '24 hours'),
         max(h.started_at) FILTER (WHERE h.ev = 'schedule'),
         count(*) FILTER (WHERE h.ev IS NOT NULL),
         min(h.started_at) FILTER (WHERE h.ev IS NOT NULL),
         max(h.started_at)
    INTO v_ticks_6h, v_ticks_3h, v_ticks_24h, v_last_sched, v_tagged_any, v_first_tagged, v_last_any
    FROM (
      -- ⚠ EQUALITY, NOT `LIKE '%-heartbeat'`, AND THE DIFFERENCE IS 329x. A
      -- leading wildcard cannot use `pipeline_runs_pipeline_started_idx`
      -- (pipeline, started_at DESC), so the LIKE form SEQ-SCANS the whole table:
      -- measured 3,618 buffers / 147 ms against 11 buffers / 2.8 ms for this.
      -- Narrowing the time window does NOT help — the seq scan reads every page
      -- either way. On a Small instance whose saturation is IO-bound, a watchdog
      -- must not cost 28 MB of reads twice an hour.
      --
      -- ⚠ A CURATED LIST ROTS, so it is guarded rather than trusted:
      -- `__tests__/gha-schedule-watchdog-covers-every-tagged-heartbeat.test.ts`
      -- walks `.github/workflows/**` for every heartbeat writer that tags
      -- `extra.event` and fails if one is missing from this list. Add a new
      -- tagged heartbeat and that test tells you to come back here.
      SELECT pr.started_at, pr.extra->>'event' AS ev
        FROM public.pipeline_runs pr
       WHERE pr.pipeline IN ('sentinel-heartbeat', 'dead-lane-backstop-heartbeat')
         AND pr.started_at > now() - interval '72 hours'
    ) h;

  IF v_tagged_any = 0 THEN
    v_stalled := NULL;
    v_verdict := 'unknown_no_tagged_heartbeats';
  ELSIF v_first_tagged > now() - interval '6 hours' THEN
    -- Deploy grace: a probe younger than its own window cannot establish a
    -- stall, and a guard that punishes its own first hours is worse than none.
    v_stalled := NULL;
    v_verdict := 'unknown_probe_younger_than_window';
  ELSIF v_ticks_6h = 0 THEN
    v_stalled := true;
    v_verdict := 'stalled';
  ELSE
    v_stalled := false;
    v_verdict := 'delivering';
  END IF;

  -- The watchdog's own age, read BEFORE this tick inserts its row, so the first
  -- tick can never accuse itself.
  SELECT min(pr.started_at) INTO v_self_first
    FROM public.pipeline_runs pr
   WHERE pr.pipeline = 'gha-schedule-watchdog'
     AND pr.started_at > now() - interval '72 hours';

  v_broken := v_stalled IS NULL
              AND v_self_first IS NOT NULL
              AND v_self_first < now() - interval '12 hours';

  v_silent_min := CASE WHEN v_last_sched IS NULL THEN NULL
                       ELSE round((extract(epoch FROM (now() - v_last_sched)) / 60)::numeric, 0) END;

  v_error := CASE
    WHEN v_stalled THEN
      format('github actions has delivered no schedule-tagged tick in %s (last %s); %s cadence lane(s) breaching',
             COALESCE(v_silent_min::text || ' min', 'the 72h retention window'),
             COALESCE(v_last_sched::text, 'never'),
             v_breach_count)
    WHEN v_broken THEN
      format('this watchdog cannot tell (%s) and has been unable to since %s - an unknown this old is a BROKEN PROBE, not health: no heartbeat writer is tagging extra.event, or none has run at all',
             v_verdict, v_self_first)
  END;

  v_extra := jsonb_build_object(
    'source',                       'pg_cron',
    'verdict',                      v_verdict,
    'gha_schedule_stalled',         v_stalled,
    'instrument_broken',            v_broken,
    'watchdog_first_row_at',        v_self_first,
    'last_scheduled_tick_at',       v_last_sched,
    'minutes_since_scheduled_tick', v_silent_min,
    'scheduled_ticks_6h',           v_ticks_6h,
    'scheduled_ticks_3h',           v_ticks_3h,
    'scheduled_ticks_24h',          v_ticks_24h,
    'tagged_heartbeats_72h',        v_tagged_any,
    'first_tagged_heartbeat_at',    v_first_tagged,
    'last_heartbeat_any_at',        v_last_any,
    'cadence_breach_count',         v_breach_count,
    'cadence_breach_sample',        v_breach_sample,
    'window_note',                  'scheduled_ticks_* count only heartbeat rows whose extra.event = schedule; pipeline_runs retains ~73h'
  );

  PERFORM public.log_pipeline_run(
    p_pipeline        := 'gha-schedule-watchdog',
    p_started_at      := now(),
    p_rows_found      := NULL::int,
    p_rows_written    := NULL::int,
    p_rows_skipped    := NULL::int,
    -- `ok = false` for BOTH findings: a stall, and an unknown too old to be a
    -- deploy artifact. Anything else would let the worst case read as health.
    p_ok              := NOT (COALESCE(v_stalled, false) OR COALESCE(v_broken, false)),
    p_error           := v_error,
    p_collection_slug := NULL::text,
    p_cursor_before   := NULL::text,
    p_cursor_after    := NULL::text,
    p_extra           := v_extra
  );

  RETURN v_extra;
END
$fn$;

COMMENT ON FUNCTION public.rpc_gha_schedule_watchdog() IS
  'pg_cron watchdog: records whether GitHub Actions is still DELIVERING schedule events, read from heartbeat rows tagged extra.event = schedule. Writes one gha-schedule-watchdog row per tick with ok = false when stalled. Exists because every other watcher in this estate is itself a GHA schedule, so alarm and subject fail together (2026-09-10).';

-- anon-exec: REVOKED below -- rpc_gha_schedule_watchdog is an ops watchdog, called only by pg_cron as postgres; no user-facing surface reads it.
REVOKE ALL ON FUNCTION public.rpc_gha_schedule_watchdog() FROM PUBLIC, anon, authenticated;
-- ⚠ The REVOKE above strips PUBLIC, which is where a pg_cron caller holding no
-- explicit grant would otherwise get its EXECUTE from. Granting the job's role
-- in the SAME migration is what keeps this from failing as SILENCE:
-- cron.job_run_details would show the error and pipeline_runs never would.
GRANT EXECUTE ON FUNCTION public.rpc_gha_schedule_watchdog() TO postgres;

-- Every 30 minutes. The finding it publishes turns on a 6-hour window, so the
-- cadence only has to be dense enough that the record is never more than half
-- an hour stale. `SET statement_timeout` is in the COMMAND, not the function:
-- on pg_cron a function-level SET is INERT.
SELECT cron.schedule(
  'rpc-gha-schedule-watchdog',
  '8,38 * * * *',
  $cron$SET statement_timeout = '20s'; SELECT public.rpc_gha_schedule_watchdog();$cron$
);

-- ⭐ THE OTHER HALF OF THE MUTUAL OBSERVATION. Without this row, pg_cron dying
-- would be as invisible as GitHub's scheduler dying was tonight. With it, the
-- GHA sentinel alarms on a watchdog that stops writing — and the watchdog
-- alarms on a GHA scheduler that stops delivering. Neither can hide the other's
-- failure. 90 min = three missed 30-minute ticks; the watchlist's own
-- created_at grace covers the first 90 minutes after this migration.
INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, max_silent_minutes, is_active, notes)
VALUES (
  'gha-schedule-watchdog',
  'medium',
  90,
  true,
  'pg_cron rpc-gha-schedule-watchdog (8,38). Watches whether GitHub Actions still DELIVERS schedule events; this row is the reverse direction, so the GHA sentinel notices if pg_cron stops. Added 2026-09-10 PT after GitHub delivered zero scheduled runs repo-wide for 2.8h+ while every watcher in the estate was itself a GHA schedule.'
)
ON CONFLICT (pipeline) DO NOTHING;
