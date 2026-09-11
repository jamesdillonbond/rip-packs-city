-- ============================================================================
-- THE WATCHDOG'S VERDICT BRANCHES WERE IN THE WRONG ORDER — 2026-09-10 PT
--
-- 🚨 CAUGHT BY READING A LIVE TICK, NOT BY REASONING. At 22:01 PT a
-- `sentinel-heartbeat` row landed carrying `event = schedule` — the first
-- GitHub-delivered scheduled tick since 18:30 PT, and exactly the fact the
-- watchdog exists to report. Its 22:08 PT tick then published
-- `unknown_probe_younger_than_window`.
--
-- ⛔ THAT IS A MISREPORT, even though it raises no false alarm: the probe COULD
-- tell, because a `schedule`-tagged tick inside the window is positive proof of
-- delivery. The deploy grace exists solely to stop a young probe asserting a
-- STALL; it was never meant to suppress good news. It sat above the
-- delivery test, so a perfectly healthy scheduler would have read "cannot tell"
-- for the probe's entire first six hours.
--
-- ⭐ THE LESSON IS THE SYMMETRY: this repo's honesty canon is usually invoked
-- against a failed read rendering as a fact, and the reflex is to widen
-- `unknown`. **An `unknown` that is actually KNOWN is the same defect facing the
-- other way** — it makes an instrument look blind during the window someone
-- would most want to read it.
--
-- Fix: test `scheduled_ticks_6h > 0` FIRST; the three remaining branches are
-- unchanged and still reach `stalled` only after the grace. Nothing else in the
-- function, its grants, its schedule or its watchlist row is touched.
--
-- REVERT: re-apply the function body from
-- `20260911045500_audit_20260911_a_db_side_watchdog_so_a_github_scheduler_stall_cannot_be_invisible`.
--
-- ANON-EXECUTE DECISION (added 2026-09-10 PT; the guard was red on `main` without it).
-- This is a SAME-SIGNATURE `CREATE OR REPLACE`, which PRESERVES the existing ACL
-- rather than creating a new overload with default PUBLIC EXECUTE, so the revoke
-- in the creating migration (20260911045500) still stands and this file changes
-- no grant at all. Verified live before writing this, with
-- `has_function_privilege` and not acl text:
--   anon=false  authenticated=false  service_role=true  postgres=true
-- ⛔ So the correct fix here is the MARKER, not a REVOKE: adding a REVOKE to an
-- already-applied migration would pose as a no-op while being the only statement
-- in the file that could change production.
-- anon-exec: already revoked in 20260911045500 — rpc_gha_schedule_watchdog is a pg_cron-only watchdog, never reached by a browser caller
-- ============================================================================

-- anon-exec: UNCHANGED -- rpc_gha_schedule_watchdog keeps the REVOKE FROM PUBLIC, anon,
-- authenticated granted in 20260911045500, and deliberately does not repeat it: CREATE OR
-- REPLACE FUNCTION does NOT reset a function's ACL, so a revoke here would be ACL churn
-- rather than a decision. Re-verified live after this migration: has_function_privilege
-- reads anon false, authenticated false, postgres true.
--
-- ⚠ THIS MARKER IS WHY CI WENT RED, AND THE LESSON IS ONE ALREADY IN CLAUDE.md: GREP FOR
-- THE GUARDS THAT READ A FILE BEFORE YOU EDIT IT. I ran the documentation guards for the
-- docs in the same push and never re-ran the MIGRATION guards after adding this file, so a
-- guard I had already tripped once tonight caught me a second time. The detector needs
-- `anon-exec:` and the function name on the SAME LINE -- which is the first line above.
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

  -- ⚠ ORDER MATTERS, AND THE FIRST VERSION HAD IT WRONG (corrected 2026-09-10 PT,
  -- caught by reading a live tick). A `schedule`-tagged heartbeat inside the
  -- window PROVES delivery, so it must be tested BEFORE the deploy grace — the
  -- original order made a healthy scheduler read `unknown_probe_younger_than_
  -- window` for the probe's first six hours, and it did exactly that at 22:08 PT
  -- seven minutes after a real scheduled tick landed. The grace exists only to
  -- stop a YOUNG probe asserting a STALL; it was never meant to suppress good
  -- news. ⭐ An `unknown` that is actually KNOWN is a misreport too — honesty
  -- runs in both directions, not just away from false alarms.
  IF v_ticks_6h > 0 THEN
    v_stalled := false;
    v_verdict := 'delivering';
  ELSIF v_tagged_any = 0 THEN
    v_stalled := NULL;
    v_verdict := 'unknown_no_tagged_heartbeats';
  ELSIF v_first_tagged > now() - interval '6 hours' THEN
    -- Deploy grace: a probe younger than its own window cannot establish a
    -- stall, and a guard that punishes its own first hours is worse than none.
    v_stalled := NULL;
    v_verdict := 'unknown_probe_younger_than_window';
  ELSE
    v_stalled := true;
    v_verdict := 'stalled';
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
