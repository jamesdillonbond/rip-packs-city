-- audit_20261112_fmv_comparable_estimates_refresh_logs_its_runs
--
-- pg_cron jobid 868 (rpc-refresh-fmv-comparable-estimates, 36 1,7,13,19 * * * UTC) calls
-- refresh_fmv_comparable_estimates(), which writes NO pipeline_runs row — so no instrument can see the
-- lane fail or go silent, and the FMV session's "still to add: a cadence-watchlist row" could not be
-- added (a watched lane that never logs alarms forever). Found 2026-11-12 ~8:40 AM PT (Cowork cloud;
-- Trevor: "Keep going").
-- WHAT. A wrapper, run_refresh_fmv_comparable_estimates(), calls the refresh and logs
-- `fmv-comparable-estimates`: ok only when rows were WRITTEN (a 0-row refresh over four collections is a
-- failure, not a quiet day), the error string on an exception. The refresh body is NOT touched (it belongs
-- to the comp-1.0 work in flight). Job 868 is re-pointed at the wrapper in place (cron.schedule upserts on
-- jobname; asserted to stay 868). A statement_timeout kill (57014) is not catchable here — the watchlist
-- row's silence limit is what catches that.
-- anon-exec: run_refresh_fmv_comparable_estimates is NOT anon-executable (EXECUTE revoked from public, anon, authenticated).
-- REVERT: select cron.schedule('rpc-refresh-fmv-comparable-estimates', '36 1,7,13,19 * * *',
--   $c$select public.refresh_fmv_comparable_estimates()$c$); set the watchlist row is_active = false;
--   then remove the wrapper.

create or replace function public.run_refresh_fmv_comparable_estimates()
returns jsonb language plpgsql set search_path = public, pg_temp as $fn$
declare
  v_started timestamptz := clock_timestamp();
  v_n integer;
  v_ok boolean;
  v_err text;
begin
  begin
    v_n := public.refresh_fmv_comparable_estimates();
    v_ok := coalesce(v_n, 0) > 0;
    if not v_ok then v_err := 'refresh wrote 0 rows'; end if;
  exception when others then
    v_ok := false;
    v_err := sqlerrm;
  end;
  perform public.log_pipeline_run('fmv-comparable-estimates', v_started, v_n, v_n, NULL, v_ok, v_err,
    NULL, NULL, NULL, jsonb_build_object('model_version', 'comp-1.0'));
  return jsonb_build_object('ok', v_ok, 'rows_written', v_n, 'error', v_err);
end $fn$;
revoke all on function public.run_refresh_fmv_comparable_estimates() from public, anon, authenticated;

DO $$
DECLARE v bigint;
BEGIN
  v := cron.schedule('rpc-refresh-fmv-comparable-estimates', '36 1,7,13,19 * * *',
                     $c$select public.run_refresh_fmv_comparable_estimates()$c$);
  IF v <> 868 THEN
    RAISE EXCEPTION 'cron.schedule returned % (expected 868): would duplicate the job', v;
  END IF;
END $$;

insert into public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes, is_active)
values ('fmv-comparable-estimates', 420, 780, 'info',
  'Added 2026-11-12 with the comp-1.0 comparable-edition estimate refresh (pg_cron 868, 36 1,7,13,19 UTC, every 6 h) via run_refresh_fmv_comparable_estimates(). ok=false when the refresh raises or writes 0 rows. Silence over 7 h = a missed tick or a statement_timeout kill. SHADOW model: nothing user-facing reads it yet. info until a human read promotes it.',
  true);
