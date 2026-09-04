-- audit_20260904_pipeline_cadence_watchlist_gains_an_opt_in_no_success_arm
--
-- Ships the design the 2026-08-29T0130Z inbox filing asked for after REFUTING the
-- one-word fix: detect_stalled_pipelines() reads max(started_at) with no `ok` filter,
-- so a pipeline that RUNS and FAILS keeps every silence clock green — it reported
-- ALL CLEAR through a 7-hour total outage, and hid topshot-fmv-populate at 1,065
-- minutes without a success. Flipping the incumbent's predicate to last-SUCCESS was
-- measured and rejected: 21 of 83 watchlisted pipelines (25 %) would have breached at
-- some point in 48 h, because `max_silent_minutes` was tuned against last-RUN.
--
-- WHAT THIS IS: a SECOND, opt-in arm, additive end to end.
--   1. `pipeline_cadence_watchlist.max_minutes_without_success` (integer, NULL). NULL
--      = not armed. No existing arm changes behaviour.
--   2. `detect_pipelines_without_success()` — same shape and posture as its sibling
--      (jsonb array, STABLE SECURITY DEFINER, 8 s, service_role only), reporting the
--      active rows whose newest `ok = true` run is older than their own threshold,
--      or which have NO ok run inside pipeline_runs' ~73 h retention.
--   3. A seed FROM DATA, never by taste (the filing's rule): each active arm gets
--      GREATEST(3 × its own max gap between consecutive ok runs over retention,
--      2 × its max_silent_minutes), or 3 × max_silent_minutes when it has fewer than
--      two ok runs to measure a gap from. Measured 2026-09-04 01:5xZ before seeding:
--      87 active arms, 0 past 3 × their own max ok-gap, 0 past 2 × max_silent —
--      a zero-noise baseline. The single exception is `ingest` (Top Shot GQL sales,
--      no ok run in retention): its upstream host is decommissioned and its alert is
--      deliberately suppressed (pipeline_alert_suppression, ledger 2026-08-30), so it
--      is seeded NULL with a note rather than armed to fire on day one.
--   4. The reader is a NEW sentinel arm ("Pipeline Success"), shipped alongside; the
--      incumbent function and its callers (get_pipeline_alerts_core, rpc_ops_snapshot,
--      check_pipelines_running_but_not_succeeding) are untouched.
--
-- Relation to `running_but_not_succeeding` (get_pipeline_alerts): that arm is a
-- 90-minute window that also demands ZERO rows written, so a productive partial
-- sweep logging ok=false stays silent there by design. This arm is the LONG horizon —
-- hours to days, per pipeline — and asks only "when did this last succeed", which is
-- why it must be opt-in with a per-pipeline threshold and why a NULL threshold is a
-- decision, not an omission.
--
-- anon-exec: detect_pipelines_without_success — service_role/postgres only; EXECUTE revoked from PUBLIC, anon, authenticated below.
--
-- REVERT: DROP FUNCTION public.detect_pipelines_without_success();
--         ALTER TABLE public.pipeline_cadence_watchlist DROP COLUMN max_minutes_without_success;
--         (the sentinel arm then reports "RPC error" — remove it from the route in the same revert.)

ALTER TABLE public.pipeline_cadence_watchlist
  ADD COLUMN IF NOT EXISTS max_minutes_without_success integer;

COMMENT ON COLUMN public.pipeline_cadence_watchlist.max_minutes_without_success IS
  'Opt-in "no success" arm (2026-09-04): minutes since the newest ok=true pipeline_runs row before detect_pipelines_without_success() reports this pipeline. NULL = not armed. Seeded from each pipeline''s own measured ok-gap distribution; raise or NULL it with a note, never by taste.';

CREATE OR REPLACE FUNCTION public.detect_pipelines_without_success()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_minutes_without_success', w.max_minutes_without_success,
           'minutes_without_success',
             CASE WHEN ls.last_ok IS NULL THEN NULL
                  ELSE round((extract(epoch from (now() - ls.last_ok)) / 60)::numeric, 0) END,
           'last_ok', ls.last_ok,
           'last_run', lr.last_run,
           'runs_retained', lr.runs_retained,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now() - ls.last_ok)) / 60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(pr.started_at) AS last_ok
    FROM pipeline_runs pr
    WHERE pr.pipeline = w.pipeline AND pr.ok
  ) ls ON true
  LEFT JOIN LATERAL (
    SELECT max(pr.started_at) AS last_run, count(*) AS runs_retained
    FROM pipeline_runs pr
    WHERE pr.pipeline = w.pipeline
  ) lr ON true
  WHERE w.is_active
    AND w.max_minutes_without_success IS NOT NULL
    AND (ls.last_ok IS NULL
         OR (extract(epoch from (now() - ls.last_ok)) / 60) > w.max_minutes_without_success);
$function$;

REVOKE EXECUTE ON FUNCTION public.detect_pipelines_without_success() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_pipelines_without_success() TO service_role;

-- Seed from data. ok-gap = minutes between consecutive ok=true runs, per pipeline,
-- over whatever pipeline_runs retains (~73 h).
WITH ok_runs AS (
  SELECT pr.pipeline, pr.started_at
  FROM public.pipeline_runs pr
  JOIN public.pipeline_cadence_watchlist w ON w.pipeline = pr.pipeline AND w.is_active
  WHERE pr.ok
), gaps AS (
  SELECT pipeline,
         extract(epoch FROM started_at - lag(started_at) OVER (PARTITION BY pipeline ORDER BY started_at)) / 60 AS gap_min
  FROM ok_runs
), per AS (
  SELECT pipeline, max(gap_min) AS max_ok_gap_min, count(gap_min) AS gaps
  FROM gaps GROUP BY pipeline
)
UPDATE public.pipeline_cadence_watchlist w
   SET max_minutes_without_success =
         CASE
           WHEN w.pipeline = 'ingest' THEN NULL
           WHEN p.max_ok_gap_min IS NOT NULL AND p.gaps >= 1
             THEN GREATEST(ceil(3 * p.max_ok_gap_min)::integer, 2 * w.max_silent_minutes)
           ELSE 3 * w.max_silent_minutes
         END,
       notes = CASE
           WHEN w.pipeline = 'ingest'
             THEN coalesce(w.notes, '') || ' | [NO-SUCCESS ARM 2026-09-04: deliberately NOT armed — upstream public-api.nbatopshot.com is decommissioned (530) and this pipeline''s alert is suppressed; arm it when the Atlas port lands.]'
           ELSE coalesce(w.notes, '') || ' | [NO-SUCCESS ARM seeded 2026-09-04 from the pipeline''s own ok-gap over ~73 h: '
                || CASE WHEN p.max_ok_gap_min IS NOT NULL AND p.gaps >= 1
                        THEN 'max ok-gap ' || round(p.max_ok_gap_min) || ' min -> GREATEST(3x, 2x max_silent)'
                        ELSE 'fewer than two ok runs retained -> 3x max_silent' END
                || ']'
         END
  FROM (SELECT w2.pipeline FROM public.pipeline_cadence_watchlist w2 WHERE w2.is_active) act
  LEFT JOIN per p ON p.pipeline = act.pipeline
 WHERE w.pipeline = act.pipeline;
