-- 2026-09-19 (Cowork cloud). AUTHORED 05:00 PT 09-19 = 12:00Z.
--
-- Cleans up three artifacts an automated R108 experiment left behind, and records what that
-- experiment PROVED -- which is the valuable part and was not written down anywhere.
--
--   1. cron job 516 'zz-r108-probe-setcic' (postgres, ACTIVE, daily '52 11 * * *') -> unscheduled
--   2. public.zz_r108_probe (RLS OFF, anon+authenticated SELECT, 1 column 'a integer', 100 rows)
--      -> dropped, taking zz_r108_probe_idx_a with it
--
-- ⚠ WHY THIS IS URGENT AND NOT MERE TIDYING: the probe table is a LIVE BREACH of the platform's
--   standing security invariant and it turned main's Smoke Tests RED on 7b6d9dae0 --
--   'HARD FAIL: public base tables: RLS on + no anon write -- 1 violation(s):
--   rls_off_base_table:zz_r108_probe'. check_public_security_invariants() agrees: 1 row.
--   The job was also failing every day and would keep doing so.
--   ⭐ Note which instrument caught it: the DB-side guard and the CI smoke gate agreed, but the
--      guard is only read when someone runs it -- the SMOKE GATE is what made it unmissable.
--
-- ⭐⭐ WHAT THE EXPERIMENT PROVED, AND IT IS A PINCER WORTH KEEPING. Job 516's command was
--     "SET statement_timeout = '900s'; CREATE INDEX CONCURRENTLY zz_r108_probe_idx_a ON
--      public.zz_r108_probe (a);"
--     Its single run, 04:52 PT 09-19, failed in 0.4 s with:
--       ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
--
--     ⇒ A MULTI-STATEMENT pg_cron COMMAND IS WRAPPED IN A TRANSACTION BLOCK. The standing note
--       that "a one-off pg_cron job CAN run CREATE INDEX CONCURRENTLY -- fresh libpq connection,
--       no transaction block" holds ONLY for a command that is ONE statement with NO prefix.
--
--     🚨 SO THE R108 RECIPE CANNOT USE A `SET statement_timeout` PREFIX TO BUY TIME: adding the
--        prefix is exactly what destroys the no-transaction-block property CIC requires. That
--        closes the pincer already recorded for R108 -- as postgres the build dies at the
--        cluster-wide 120 s statement_timeout in "waiting for writers before validation", and the
--        obvious workaround (prefix a longer timeout) is now MEASURED to be impossible, not merely
--        untried. As cron_heavy the 600 s role default applies with no prefix needed, but
--        cron_heavy is not the table owner, so it cannot build the index either.
--        👉 R108 therefore needs a route that is neither: a single-statement job running as a role
--           that BOTH owns topshot_atlas_market_events AND carries a role-level timeout above the
--           build time. Do not re-try the SET-prefix form; it is refuted.
--
-- ⛔ NOT a claim on R108 itself. This migration removes scratch and writes down a negative result.
--
-- REVERT: the probe was scratch (100 rows of a single integer column, no view, function or other
--   cron reader). To reconstruct the experiment:
--     create table public.zz_r108_probe (a integer);
--     insert into public.zz_r108_probe select generate_series(1,100);
--   -- but see above: the SET-prefix form is refuted, so there is no reason to.

DO $mig$
DECLARE
  v_cols   int;
  v_rows   bigint;
  v_refs   int;
  v_jobs   int;
BEGIN
  IF to_regclass('public.zz_r108_probe') IS NULL THEN
    RAISE NOTICE 'zz_r108_probe already absent';
  ELSE
    -- NON-VACUITY: prove this is the scratch probe and not something that grew a purpose.
    SELECT count(*) INTO v_cols FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'zz_r108_probe';
    EXECUTE 'SELECT count(*) FROM public.zz_r108_probe' INTO v_rows;

    SELECT (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND pg_get_functiondef(p.oid) ILIKE '%zz\_r108\_probe%')
         + (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
               AND pg_get_viewdef(c.oid) ILIKE '%zz\_r108\_probe%')
      INTO v_refs;

    IF v_cols <> 1 OR v_rows <> 100 THEN
      RAISE EXCEPTION 'zz_r108_probe is not the 1-column/100-row scratch probe (cols=%, rows=%) '
        '- refusing to drop a table that changed since it was inspected', v_cols, v_rows;
    END IF;
    IF v_refs <> 0 THEN
      RAISE EXCEPTION 'zz_r108_probe has % function/view reader(s) - refusing to drop it', v_refs;
    END IF;

    DROP TABLE public.zz_r108_probe;
  END IF;

  SELECT count(*) INTO v_jobs FROM cron.job
   WHERE jobname = 'zz-r108-probe-setcic' AND command ILIKE '%zz\_r108\_probe%';
  IF v_jobs = 1 THEN
    PERFORM cron.unschedule('zz-r108-probe-setcic');
  ELSIF v_jobs = 0 THEN
    RAISE NOTICE 'zz-r108-probe-setcic already unscheduled';
  ELSE
    RAISE EXCEPTION 'expected 0 or 1 zz-r108-probe-setcic, found % - refusing to guess', v_jobs;
  END IF;

  -- Read the end state back rather than trusting the calls.
  IF to_regclass('public.zz_r108_probe') IS NOT NULL THEN
    RAISE EXCEPTION 'zz_r108_probe survived the drop';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'zz-r108-probe-setcic') THEN
    RAISE EXCEPTION 'zz-r108-probe-setcic survived the unschedule';
  END IF;

  RAISE NOTICE 'r108 probe artifacts removed';
END
$mig$;
