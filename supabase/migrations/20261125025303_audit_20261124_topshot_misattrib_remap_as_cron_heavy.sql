-- audit_20261124_topshot_misattrib_remap_as_cron_heavy
--
-- 2026-11-24 ~7:00 PM PT (Claude Code cloud; Trevor: "work autonomously … fix any issues you encounter").
-- Inbox 2026-11-24T1617Z (daytime monitor): pg_cron 721 `rpc-topshot-misattrib-remap`
-- (`SELECT public.remap_topshot_from_onchain_map();`, `53 5 * * *` UTC) failed 11-20 and 11-24 with
-- "canceling statement due to statement timeout" — both runs died at EXACTLY 120.0 s (11-20 on the
-- audit INSERT, 11-24 on the UPDATE sales leg). Successful runs took 52–98 s over a 50,736-row map,
-- i.e. the lane has been riding the 120 s cluster default.
--
-- The function DECLARES statement_timeout=300s, but a function's SET is inert on pg_cron (database.md):
-- the job runs as `postgres`, which has no role timeout, so the 120 s global binds. The monitor's
-- option 1 ("give it its own longer timeout") on proconfig would change nothing by construction.
-- Fix is the CALLER: run the job as `cron_heavy` (role default 600 s), the job-919 / job-383 recipe.
-- The function is SECURITY DEFINER owned by postgres, so cron_heavy needs EXECUTE only (it was FALSE:
-- the function carries no PUBLIC grant — the database.md "EXECUTE is checked against the CALLER" trap).
-- Lane budget: same job name, moved between roles — no job added.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-misattrib-remap');
--   SELECT cron.schedule('rpc-topshot-misattrib-remap', '53 5 * * *', 'SELECT public.remap_topshot_from_onchain_map();');  -- as postgres
--   REVOKE EXECUTE ON FUNCTION public.remap_topshot_from_onchain_map() FROM cron_heavy;

GRANT EXECUTE ON FUNCTION public.remap_topshot_from_onchain_map() TO cron_heavy;

SELECT cron.unschedule('rpc-topshot-misattrib-remap');

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('rpc-topshot-misattrib-remap', '53 5 * * *',
  'SELECT public.remap_topshot_from_onchain_map();');
RESET ROLE;

DO $$
DECLARE v_user text; v_n int;
BEGIN
  SELECT count(*), max(username) INTO v_n, v_user FROM cron.job WHERE jobname = 'rpc-topshot-misattrib-remap';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 job rpc-topshot-misattrib-remap, found %', v_n; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'job runs as %, expected cron_heavy', v_user; END IF;
  IF NOT has_function_privilege('cron_heavy', 'public.remap_topshot_from_onchain_map()', 'EXECUTE') THEN
    RAISE EXCEPTION 'cron_heavy cannot EXECUTE remap_topshot_from_onchain_map(): the job would fail every tick';
  END IF;
END $$;
