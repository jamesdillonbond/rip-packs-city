-- audit_20260902_detect_stalled_pipelines_says_whether_the_schedule_is_firing
--
-- ⛔ THE DEFECT. `detect_stalled_pipelines()` keyed on ONE number:
-- `max(started_at)` over the pipeline's own terminal rows. So it could report
-- that a pipeline had gone silent, and could NOT report why — and the two causes
-- need opposite responses:
--
--   the schedule stopped firing  -> fix cron-job.org / pg_cron
--   it fires and is KILLED at the
--   lambda wall before it can log -> fix maxDuration / the route
--
-- ⚠ `try/catch` cannot catch a `maxDuration` kill, so the killed case writes
-- NOTHING and is indistinguishable from the never-fired case at the terminal
-- row. That is register R11's structural residual, filed 2026-08-15: *"a
-- heartbeating-but-killed pipeline oscillates in and out of stalled"*.
--
-- The evidence to tell them apart has existed since 2026-08-20 —
-- `lib/pipeline/heartbeat.ts` writes a `<pipeline>-heartbeat` marker BEFORE the
-- work — and 21 of the 87 active watchlist rows now carry one. Nothing read it.
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ──────────────────────────
-- Three ADDED fields: `heartbeat_last_run`, `uncorrelated_heartbeats`,
-- `classification` (`no_marker` | `invoked_but_never_logged` | `not_invoked`).
--
-- ⛔ THE `WHERE` IS BYTE-IDENTICAL AND THE ROW SET CANNOT MOVE. Both added
-- LATERALs are unGROUPed aggregates, so each returns exactly one row and a LEFT
-- JOIN to them can neither add nor remove a caller-visible row. This is an
-- enrichment, never a silencer: a marker must NEVER refresh the real pipeline's
-- silence clock, which is the whole reason the helper writes under a suffixed
-- name.
--
-- PROVED rather than argued, over the whole population in ONE statement (so a
-- concurrent write cannot fake agreement): with the silence threshold forced so
-- that every watchlist row qualifies, old body 87 rows, new body 87 rows,
-- 0 only-in-old, 0 only-in-new.
--
-- ⚠ `classification` is only ever emitted for a row that ALREADY failed the
-- silence test. `invoked_but_never_logged` on a healthy pipeline is not a thing
-- this function can say, and the label must not be read that way.
--
-- 🚨 THE ±5 s CORRELATION IS LOAD-BEARING AND THE OBVIOUS SPELLING IS WRONG.
-- The first version counted heartbeats with `h.started_at > last_run`, and
-- against live data that reported 3 pipelines with orphaned markers —
-- `allday-listings-retry`, `snapshot-pack-asks`, `candy-editions-ingest` — all
-- three HEALTHY. Their marker is written 2–14 ms AFTER the terminal row's
-- `started_at`, because the two timestamps come from different clocks in the
-- route, so a tick was counting ITS OWN heartbeat as evidence of its own death.
-- Re-measured with the ±5 s window `lib/pipeline/heartbeat.ts` documents:
-- **3 -> 0**. A plausible mechanism is not a measurement.
--
-- POSITIVE CONTROL, so the counter is not trusted at zero: the same correlation
-- run over the full 73 h retention finds exactly ONE uncorrelated marker
-- fleet-wide — `fmv-recalc` at 2026-09-01 00:15:52Z, `extra` = offset 10000,
-- edition_limit 500, max_duration_s 300. That is a real killed tick that no
-- alert on this platform could see, and the counter sees it.
--
-- COST (warm, same session, 2026-09-02): 1,200 -> 1,490 buffers, 5.6 -> 6.8 ms,
-- against this function's own 8 s `statement_timeout`.
--
-- REVERT: re-apply the body from
--   supabase/migrations/20260812050544_audit_20260812_detect_stalled_pipelines_carry_watchlist_notes.sql
-- (drops the three fields; nothing else in the object changes).

-- anon-exec: NO REVOKE, deliberately — detect_stalled_pipelines already exists and
-- `CREATE OR REPLACE FUNCTION` does NOT reset a function's ACL, so this migration
-- cannot have widened anything. Verified live immediately after applying: EXECUTE
-- is held by `service_role` and `postgres` only, exactly as before, and
-- `check_secdef_anon_exec_drift()` returns 0. A revoke here would be a production
-- ACL CHANGE dressed as a no-op, which is the opposite of what this guard wants.
CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_silent_minutes', w.max_silent_minutes,
           'silent_minutes', round((extract(epoch from (now()-lr.last_run))/60)::numeric, 0),
           'last_run', lr.last_run,
           'heartbeat_last_run', hbl.last_hb,
           'uncorrelated_heartbeats', orp.uncorrelated,
           'classification',
             CASE
               WHEN hbl.last_hb IS NULL THEN 'no_marker'
               WHEN (extract(epoch from (now()-hbl.last_hb))/60) <= w.max_silent_minutes
                 THEN 'invoked_but_never_logged'
               ELSE 'not_invoked'
             END,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now()-lr.last_run))/60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(started_at) AS last_run FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT max(h.started_at) AS last_hb
    FROM pipeline_runs h WHERE h.pipeline = w.pipeline || '-heartbeat'
  ) hbl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS uncorrelated FROM pipeline_runs h
    WHERE h.pipeline = w.pipeline || '-heartbeat'
      AND h.started_at > COALESCE(lr.last_run, now() - interval '30 days') - interval '5 s'
      AND NOT EXISTS (SELECT 1 FROM pipeline_runs t
                      WHERE t.pipeline = w.pipeline
                        AND t.started_at BETWEEN h.started_at - interval '5 s'
                                             AND h.started_at + interval '5 s')
  ) orp ON true
  WHERE w.is_active
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);
$function$;

COMMENT ON FUNCTION public.detect_stalled_pipelines() IS
'Watchlisted pipelines whose newest terminal pipeline_runs row is older than their max_silent_minutes. Since 2026-09-02 each row also carries heartbeat_last_run, uncorrelated_heartbeats and classification (no_marker | invoked_but_never_logged | not_invoked), read from the <pipeline>-heartbeat marker lib/pipeline/heartbeat.ts writes BEFORE the work, so a maxDuration kill is distinguishable from a schedule that stopped firing. The WHERE is unchanged and the marker never refreshes the real pipeline''s silence clock. The +/-5s correlation window is load-bearing: a bare > comparison reported 3 healthy pipelines as orphaned because their marker is written 2-14ms after the terminal row''s started_at.';
