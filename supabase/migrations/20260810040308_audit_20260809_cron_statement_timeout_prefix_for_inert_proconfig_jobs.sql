-- audit_20260809: 8 pg_cron jobs were silently capped at the GLOBAL statement_timeout (120s)
-- while the plpgsql function each one calls declares a larger statement_timeout in its
-- proconfig (180s-600s). A function-level `SET statement_timeout` is INERT for the top-level
-- call: the statement timer is armed by start_xact_command() BEFORE the function's GUC nest
-- level is entered, so the function value can neither raise nor lower the budget.
--
-- PROVEN in prod this session with two positive controls:
--   probe A: fn declaring statement_timeout='1s', pg_sleep(3)  -> COMPLETED (cannot lower)
--   probe C: session at 1s, fn declaring '200s', pg_sleep(3)   -> canceled at 1s (cannot raise)
-- and corroborated by observed failure durations: every affected job dies at 120.0s, while
-- jobid 256 (role cron_heavy = 600s, fn claims 900s) dies at 602s.
--
-- Fix: put the budget where it actually binds -- an in-command `SET statement_timeout`, the
-- same pattern jobids 235/236/237/240/241/245/248 already use. Each job gets the value its
-- own function declares, so this honours the original author's intent rather than inventing one.
-- Deliberately NOT repointing these to the cron_heavy role: 3 of the functions have no EXECUTE
-- grant for cron_heavy, so this way no role privilege changes at all.
--
-- REVERT: SELECT cron.alter_job(<jobid>, command => <exact pre-migration text below>);
--   4   ' SELECT public.refresh_cross_collection_cohort_step2(); '
--   5   'SELECT public.compute_serial_fmv_multipliers();'
--   36  'SELECT public.refresh_mv_topshot_set_play_catalog();'
--   49  'SELECT public.compute_serial_fmv_multipliers(''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid);'
--   50  'SELECT public.compute_serial_fmv_power_model(''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid);'
--   54  'SELECT public.compute_serial_fmv_jersey_model(''dee28451-5d62-409e-a1ad-a83f763ac070''::uuid, 365);'
--   199 'SELECT public.prune_stale_wmc()'
--   259 'SELECT public.reconcile_all_saved_wallet_stats()'
DO $mig$
DECLARE
  r record;
  v_cmd text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      (4::int,   'rpc-ccm-step2'::text,                      '300s'::text),
      (5,        'rpc-serial-fmv-multipliers-weekly',        '600s'),
      (36,       'rpc-refresh-mv-ts-set-play-catalog',       '180s'),
      (49,       'rpc-allday-serial-fmv-multipliers',        '600s'),
      (50,       'rpc-allday-serial-fmv-power-model',        '600s'),
      (54,       'rpc-allday-serial-fmv-jersey',             '600s'),
      (199,      'rpc-weekly-wmc-prune',                     '600s'),
      (259,      'rpc-reconcile-saved-wallet-stats',         '300s')
    ) AS t(jobid, jobname, budget)
  LOOP
    SELECT j.command INTO v_cmd FROM cron.job j WHERE j.jobid = r.jobid AND j.jobname = r.jobname;

    IF v_cmd IS NULL THEN
      RAISE EXCEPTION 'cron job % / % not found -- refusing to splice blind', r.jobid, r.jobname;
    END IF;

    IF v_cmd ILIKE '%statement_timeout%' THEN
      RAISE EXCEPTION 'cron job % / % already carries a statement_timeout; command=%',
        r.jobid, r.jobname, v_cmd;
    END IF;

    IF v_cmd !~* '^\s*SELECT\s+public\.' THEN
      RAISE EXCEPTION 'cron job % / % is not a bare SELECT public.<fn>() call; command=%',
        r.jobid, r.jobname, v_cmd;
    END IF;

    PERFORM cron.alter_job(
      r.jobid,
      command => format('SET statement_timeout = %L; %s', r.budget, btrim(v_cmd))
    );
  END LOOP;
END
$mig$;