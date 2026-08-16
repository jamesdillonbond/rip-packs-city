-- DB invariant: public.refresh_topshot_special_serial_owners_mv — pg_cron
-- `rpc-refresh-special-serial-owners-mv` @ `13 4,16 * * *`.
--
-- ⚠ ITS NAME SAYS TOPSHOT AND IT REFRESHES **TWO** MVs — Top Shot AND All Day.
-- That is the first thing to know about it, and the reason it gets its own pin
-- rather than joining the eight-wrapper file: someone auditing All Day's special
-- serials for a refresh job will not find one, because it is inside a function
-- named for another collection. Asserted directly, so the pairing cannot be
-- silently halved (dropping the All Day line leaves the Top Shot board fine and
-- the All Day one frozen, with the run still reporting ok).
--
-- THE OTHER PROPERTIES:
--   • Both refreshes are CONCURRENTLY, so both MVs need a unique index — see
--     supabase/tests/mv_refresh_wrappers.sql, which proves that coupling.
--   • ⚠ `SET enable_nestloop TO 'off'` is a PLANNER HINT baked into the function
--     definition. It is invisible from any call site and survives no refactor
--     that rebuilds the body from scratch. Asserted from `pg_get_functiondef`,
--     because nothing else would ever notice its removal until the job started
--     timing out at its 200s budget.
--   • ⚠ It logs through `log_pipeline_run` with NAMED ARGUMENTS. CLAUDE.md
--     records that PostgREST/plpgsql resolve that overload by its argument-NAME
--     set, and that one invented name makes a pipeline vanish from telemetry
--     entirely — indistinguishable from never having been invoked. A test that
--     merely calls the function would not notice; this one asserts the ROW lands.
--   • ⚠ Its EXCEPTION handler logs `ok:false` and does NOT re-raise, so pg_cron
--     records success and `pipeline_runs.ok` is the only health signal. (And
--     PostgreSQL excludes QUERY_CANCELED from OTHERS, so a timeout at the
--     declared 200s skips even that — recorded, not changed.)
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 77e64846ded276de8e70ad683a087679).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs (
  pipeline        text,
  started_at      timestamptz,
  finished_at     timestamptz DEFAULT now(),
  rows_found      int,
  rows_written    int,
  rows_skipped    int,
  ok              boolean,
  error           text,
  collection_slug text,
  cursor_before   text,
  cursor_after    text,
  extra           jsonb
);

-- The live 11-arg signature, with the defaults that make a named-argument call
-- with only a SUBSET of them resolve at all.
CREATE FUNCTION public.log_pipeline_run(
  p_pipeline text,
  p_started_at timestamptz DEFAULT now(),
  p_rows_found int DEFAULT 0,
  p_rows_written int DEFAULT 0,
  p_rows_skipped int DEFAULT 0,
  p_ok boolean DEFAULT true,
  p_error text DEFAULT NULL,
  p_collection_slug text DEFAULT NULL,
  p_cursor_before text DEFAULT NULL,
  p_cursor_after text DEFAULT NULL,
  p_extra jsonb DEFAULT NULL
) RETURNS void LANGUAGE sql AS $log$
  INSERT INTO public.pipeline_runs (pipeline, started_at, rows_found, rows_written, rows_skipped,
                                    ok, error, collection_slug, cursor_before, cursor_after, extra)
  VALUES (p_pipeline, p_started_at, p_rows_found, p_rows_written, p_rows_skipped,
          p_ok, p_error, p_collection_slug, p_cursor_before, p_cursor_after, p_extra);
$log$;

CREATE TABLE public.__mv_src (n int);
INSERT INTO public.__mv_src VALUES (1);

CREATE MATERIALIZED VIEW public.topshot_special_serial_owners_mv AS
  SELECT max(n) AS n FROM public.__mv_src;
CREATE MATERIALIZED VIEW public.allday_special_serial_owners_mv AS
  SELECT max(n) AS n FROM public.__mv_src;

CREATE UNIQUE INDEX topshot_ssom_uq ON public.topshot_special_serial_owners_mv (n);
CREATE UNIQUE INDEX allday_ssom_uq  ON public.allday_special_serial_owners_mv (n);

-- >>> BEGIN verbatim refresh_topshot_special_serial_owners_mv (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_topshot_special_serial_owners_mv()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '200s'
 SET enable_nestloop TO 'off'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.topshot_special_serial_owners_mv;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.allday_special_serial_owners_mv;
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => true,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn',
      'mvs', 'topshot+allday'
    )
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM public.log_pipeline_run(
    p_pipeline   => 'refresh-special-serial-owners-mv',
    p_started_at => v_started,
    p_ok         => false,
    p_error      => SQLERRM,
    p_extra      => jsonb_build_object(
      'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000)::int,
      'logged_by', 'fn'
    )
  );
END;
$function$;
-- <<< END verbatim refresh_topshot_special_serial_owners_mv <<<

UPDATE public.__mv_src SET n = 42;
SELECT public.refresh_topshot_special_serial_owners_mv();

-- ⚠ BOTH MVs, despite the topshot-only name. Halving this pairing leaves the
-- All Day board frozen while everything reports healthy.
SELECT _assert_eq(
  (SELECT (SELECT n FROM public.topshot_special_serial_owners_mv)::text || '/' ||
          (SELECT n FROM public.allday_special_serial_owners_mv)::text),
  '42/42',
  'it refreshes BOTH the Top Shot and the All Day special-serial MVs, despite its name'
);

-- ⚠ The named-argument log call actually RESOLVES and writes a row. A single
-- wrong argument name would make this pipeline vanish from telemetry entirely,
-- indistinguishable from never being invoked — the failure CLAUDE.md documents
-- for stale-fmv-monitor, which wrote zero rows ever.
SELECT _assert_eq(
  (SELECT ok::text || '/' || (extra->>'logged_by') || '/' || (extra->>'mvs')
     FROM public.pipeline_runs WHERE pipeline = 'refresh-special-serial-owners-mv'),
  'true/fn/topshot+allday',
  'the named-argument log_pipeline_run call resolves and lands a row'
);

SELECT _assert_eq(
  (SELECT ((extra->>'duration_ms')::int >= 0)::text
     FROM public.pipeline_runs WHERE pipeline = 'refresh-special-serial-owners-mv'),
  'true',
  '...carrying a real measured duration'
);

-- ⚠ The planner hint. It is invisible from every call site and nothing would
-- notice its removal until the job began timing out at its 200s budget.
SELECT _assert_eq(
  (SELECT (pg_get_functiondef(p.oid) ~ 'SET enable_nestloop TO ''off''')::text
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'refresh_topshot_special_serial_owners_mv'),
  'true',
  'the enable_nestloop=off planner hint is part of the function definition'
);

-- ── The failure path ───────────────────────────────────────────────────────
-- ⚠ It logs ok:false and does NOT re-raise, so pg_cron records SUCCESS and
-- pipeline_runs.ok is the only health signal there is.
DELETE FROM public.pipeline_runs;
DROP MATERIALIZED VIEW public.allday_special_serial_owners_mv;

SELECT public.refresh_topshot_special_serial_owners_mv();

SELECT _assert_eq(
  (SELECT ok::text || '/' || (error IS NOT NULL)::text
     FROM public.pipeline_runs WHERE pipeline = 'refresh-special-serial-owners-mv'),
  'false/true',
  'a failed refresh logs ok:false with SQLERRM rather than vanishing'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pipeline_runs WHERE pipeline = 'refresh-special-serial-owners-mv'),
  '1',
  'the call returns normally on failure — cron.job_run_details will report succeeded'
);

ROLLBACK;
