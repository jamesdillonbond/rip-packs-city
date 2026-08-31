-- audit_20260831_pipeline_runs_error_truncation_trigger
-- anon-exec: tg_pipeline_runs_truncate_error — BEFORE INSERT trigger function, RETURNS trigger (not RPC-callable);
-- EXECUTE revoked from anon/authenticated below anyway, belt and braces.
--
-- WHY (measured 2026-08-31, follow-on to 20260831004414): the dead-host storm writers store the FULL upstream
-- Cloudflare 530 HTML page in pipeline_runs.error — max/p95 192,873 chars, 166 rows > 2000 chars in the live window.
-- That is TOAST bloat plus a detoast+regex tax on every consumer of the column (refresh_error_triage timed out on it;
-- fixed reader-side by classifying LEFT(error,1500)). The writer-side fix cannot live in log_pipeline_run alone:
-- grep 2026-08-31 shows ~10 routes INSERT INTO pipeline_runs DIRECTLY via PostgREST (.from("pipeline_runs").insert),
-- including the storm writers ingest and offers-sweep. A BEFORE INSERT trigger is the only single point that covers
-- every writer path (RPC logger, direct PostgREST inserts, SQL).
--
-- Truncation keeps the first 8,000 chars — an order of magnitude above every legitimate error in the window
-- (p50 = 53 chars; real stack traces are low-KB) — and appends a marker naming the original length, so nothing about
-- a truncated row is silent. error_triage classification reads LEFT(...,1500) and sample_error LEFT(...,500), both
-- unaffected. Grouping by error stays deterministic: same input -> same truncated output.
--
-- REVERT: DROP TRIGGER trg_pipeline_runs_truncate_error ON public.pipeline_runs;
--         DROP FUNCTION public.tg_pipeline_runs_truncate_error();

CREATE OR REPLACE FUNCTION public.tg_pipeline_runs_truncate_error()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.error IS NOT NULL AND length(NEW.error) > 8000 THEN
    NEW.error := LEFT(NEW.error, 8000) || ' …[error truncated at insert: original ' || length(NEW.error) || ' chars]';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_pipeline_runs_truncate_error() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pipeline_runs_truncate_error ON public.pipeline_runs;
CREATE TRIGGER trg_pipeline_runs_truncate_error
BEFORE INSERT ON public.pipeline_runs
FOR EACH ROW
WHEN (NEW.error IS NOT NULL)
EXECUTE FUNCTION public.tg_pipeline_runs_truncate_error();

DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_pipeline_runs_truncate_error'
      AND tgrelid = 'public.pipeline_runs'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: trigger missing';
  END IF;
END
$mig$;
