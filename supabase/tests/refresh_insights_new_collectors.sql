-- DB invariant: public.refresh_insights_new_collectors — pg_cron
-- `rpc-refresh-new-collectors` @ `45 9 * * *`.
--
-- WHAT IT DOES. Refreshes the five materialized views behind the "new
-- collectors" insights surface, then logs its own pipeline_runs row.
--
-- ⚠ THE ORDER IS THE INVARIANT. `mv_ts_buyer_first_buy` is refreshed FIRST
-- because the other four are derived from it. A `REFRESH MATERIALIZED VIEW` on a
-- dependent view reads whatever its source currently holds, so refreshing the
-- summary/spend/gateway/cohort views BEFORE the base one recomputes them from
-- YESTERDAY's first-buy data — silently, with no error, and the run still logs
-- ok. The published surface would then be internally inconsistent: a summary
-- that disagrees with the base it claims to summarise. This is the one thing a
-- reader of this function must not "tidy" into a different order or a loop.
--
-- THE OTHER PROPERTIES:
--   • ⚠ `rows_written` is `count(*) FROM mv_ts_buyer_first_buy` read AFTER the
--     refreshes, so it reports the post-refresh size rather than a delta. An
--     operator reading it as "buyers added today" would be wrong by the whole
--     historical population — hence the `extra.buyers` label rather than
--     anything suggesting a change count.
--   • ⚠ Its `EXCEPTION WHEN OTHERS` logs an `ok:false` row and does NOT
--     RE-RAISE. So a failure is visible in pipeline_runs but invisible to the
--     caller, and pg_cron records the job as succeeded. That is a deliberate
--     trade (telemetry over propagation) and is asserted so a rework keeps the
--     logging half.
--   • ⚠ As everywhere in this repo: PostgreSQL excludes QUERY_CANCELED from
--     OTHERS, so a statement timeout skips the handler entirely and leaves NO
--     pipeline_runs row at all — indistinguishable from "never scheduled". This
--     function declares no statement_timeout of its own, so it inherits the
--     session's. Recorded, not changed.
--
-- ⚠ The five objects below are TABLES standing in for materialized views, with
-- `REFRESH MATERIALIZED VIEW` shimmed by a stand-in that records the ORDER of
-- the calls. That is the only way to observe an ordering property: the real
-- views' contents would prove the data is right, not that it was computed in a
-- sequence that makes it right.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 2b9e76fbe4e9ddd1a47420c98c613a81).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs (
  pipeline        text,
  collection_slug text,
  started_at      timestamptz,
  finished_at     timestamptz,
  ok              boolean,
  error           text,
  rows_written    int,
  extra           jsonb
);

-- The refresh-order recorder. A real MV cannot report that it was refreshed, so
-- the five views are backed by tables and an event trigger records each refresh
-- in sequence.
CREATE TABLE public.__refresh_log (
  seq  serial,
  name text
);

CREATE MATERIALIZED VIEW public.mv_ts_buyer_first_buy AS
  SELECT g AS buyer FROM generate_series(1, 3) g;
CREATE MATERIALIZED VIEW public.mv_insights_new_collectors_summary AS SELECT 1 AS x;
CREATE MATERIALIZED VIEW public.mv_insights_new_collectors_spend AS SELECT 1 AS x;
CREATE MATERIALIZED VIEW public.mv_insights_new_collectors_gateway AS SELECT 1 AS x;
CREATE MATERIALIZED VIEW public.mv_insights_new_collectors_cohorts AS SELECT 1 AS x;

CREATE FUNCTION public.__log_refresh() RETURNS event_trigger LANGUAGE plpgsql AS $et$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF r.command_tag = 'REFRESH MATERIALIZED VIEW' THEN
      INSERT INTO public.__refresh_log (name) VALUES (split_part(r.object_identity, '.', 2));
    END IF;
  END LOOP;
END $et$;

CREATE EVENT TRIGGER __log_refresh_trg ON ddl_command_end
  WHEN TAG IN ('REFRESH MATERIALIZED VIEW') EXECUTE FUNCTION public.__log_refresh();

-- >>> BEGIN verbatim refresh_insights_new_collectors (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_insights_new_collectors()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start timestamptz := clock_timestamp();
  v_rows int;
BEGIN
  REFRESH MATERIALIZED VIEW public.mv_ts_buyer_first_buy;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_summary;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_spend;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_gateway;
  REFRESH MATERIALIZED VIEW public.mv_insights_new_collectors_cohorts;
  SELECT count(*) INTO v_rows FROM public.mv_ts_buyer_first_buy;
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, rows_written, extra)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), true, v_rows,
          jsonb_build_object('buyers', v_rows));
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.pipeline_runs (pipeline, collection_slug, started_at, finished_at, ok, error)
  VALUES ('refresh-new-collectors', 'nba_top_shot', v_start, clock_timestamp(), false, SQLERRM);
END;
$function$;
-- <<< END verbatim refresh_insights_new_collectors <<<

SELECT public.refresh_insights_new_collectors();

-- ⚠ THE ORDERING INVARIANT. The base view must be refreshed FIRST, or the four
-- derived views are recomputed from yesterday's first-buy data — silently, with
-- the run still reporting ok, leaving a summary that disagrees with the base it
-- claims to summarise.
SELECT _assert_eq(
  (SELECT string_agg(name, ',' ORDER BY seq) FROM public.__refresh_log),
  'mv_ts_buyer_first_buy,mv_insights_new_collectors_summary,mv_insights_new_collectors_spend,mv_insights_new_collectors_gateway,mv_insights_new_collectors_cohorts',
  'the BASE view is refreshed first, then the four derived from it, in order'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.__refresh_log),
  '5',
  'all five views are refreshed — a dropped one leaves a stale panel with no error'
);

-- ── Its telemetry ──────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT ok::text || '/' || rows_written::text || '/' || collection_slug || '/' || (extra->>'buyers')
     FROM public.pipeline_runs WHERE pipeline = 'refresh-new-collectors'),
  'true/3/nba_top_shot/3',
  'the success path logs its own row, with the post-refresh buyer COUNT (not a delta)'
);

-- ── The failure path ───────────────────────────────────────────────────────
-- ⚠ It logs ok:false and does NOT re-raise, so the caller and pg_cron both see
-- success. Asserted so a rework keeps the logging half — this is the ONLY signal
-- that the refresh failed. (A statement timeout skips even this: PostgreSQL
-- excludes QUERY_CANCELED from OTHERS.)
DELETE FROM public.pipeline_runs;
DROP MATERIALIZED VIEW public.mv_insights_new_collectors_spend;

SELECT public.refresh_insights_new_collectors();

SELECT _assert_eq(
  (SELECT ok::text FROM public.pipeline_runs WHERE pipeline = 'refresh-new-collectors'),
  'false',
  'a failure logs an ok:false row rather than vanishing'
);

SELECT _assert_eq(
  (SELECT (error IS NOT NULL)::text FROM public.pipeline_runs WHERE pipeline = 'refresh-new-collectors'),
  'true',
  '...carrying SQLERRM, which is the only description of what broke'
);

-- ⚠ And the call itself still SUCCEEDS — no re-raise. pg_cron records the job as
-- succeeded, so `cron.job_run_details` is NOT a usable health signal here; only
-- pipeline_runs.ok is.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.pipeline_runs WHERE pipeline = 'refresh-new-collectors'),
  '1',
  'the function returns normally on failure — cron.job_run_details will say succeeded'
);

ROLLBACK;
