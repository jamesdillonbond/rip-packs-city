-- audit_20261123_vacuum_panini_card_serials_as_cron_heavy
--
-- 2026-11-23 ~3:19 PM PT (Claude Code cloud; Trevor: "Keep going"). Inbox 2026-11-23T2206Z (daytime monitor):
-- pg_cron 678 `maint-vacuum-panini-card-serials` (VACUUM (ANALYZE) public.panini_card_serials, `4 11,19 * * *` UTC =
-- 3:04 / 11:04 AM PT, created 20261003132500 for index-only scans) failed 11:04 AM PT 11-23:
-- "canceling statement due to statement timeout" after 156 s. It runs as `postgres`, which has no role timeout and
-- inherits the 120 s cluster default; its last 8 runs took 17–106 s on a ~12.8 GB table still growing.
--
-- ⛔ The monitor's suggested `SET statement_timeout=0; VACUUM …` would FAIL: a multi-statement pg_cron command runs
-- in a transaction block, and VACUUM cannot (database.md, R108). The repo's recipe instead is the one job 383 uses
-- for sales_2026: run the job as `cron_heavy` (role default statement_timeout 600 s) with GRANT MAINTAIN — no SET.
-- ⚠ Without MAINTAIN a VACUUM does not error, it WARNS "permission denied … skipping" and the run reads
-- `succeeded` — so the post-condition asserts the privilege, not just the job's owner.
-- Lane budget: same job name, moved between roles — no job added.
--
-- REVERT:
--   SELECT cron.unschedule('maint-vacuum-panini-card-serials');
--   SELECT cron.schedule('maint-vacuum-panini-card-serials', '4 11,19 * * *', 'VACUUM (ANALYZE) public.panini_card_serials');  -- as postgres
--   REVOKE MAINTAIN ON TABLE public.panini_card_serials FROM cron_heavy;

GRANT MAINTAIN ON TABLE public.panini_card_serials TO cron_heavy;

SELECT cron.unschedule('maint-vacuum-panini-card-serials');

SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('maint-vacuum-panini-card-serials', '4 11,19 * * *',
  'VACUUM (ANALYZE) public.panini_card_serials');
RESET ROLE;

DO $$
DECLARE v_user text; v_n int;
BEGIN
  SELECT count(*), max(username) INTO v_n, v_user FROM cron.job WHERE jobname = 'maint-vacuum-panini-card-serials';
  IF v_n <> 1 THEN RAISE EXCEPTION 'expected 1 job maint-vacuum-panini-card-serials, found %', v_n; END IF;
  IF v_user <> 'cron_heavy' THEN RAISE EXCEPTION 'job runs as %, expected cron_heavy', v_user; END IF;
  IF NOT has_table_privilege('cron_heavy', 'public.panini_card_serials', 'MAINTAIN') THEN
    RAISE EXCEPTION 'cron_heavy lacks MAINTAIN on panini_card_serials: the VACUUM would warn-and-skip as a success';
  END IF;
END $$;
