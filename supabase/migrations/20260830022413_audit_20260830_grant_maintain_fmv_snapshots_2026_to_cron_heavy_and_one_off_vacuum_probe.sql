-- audit 2026-08-30: prove the cron_heavy VACUUM mechanism (jobid 383 pattern) on the table the
-- cloud pass named as the /api/collection-moments driver (heap fetches 14,386/15,181 on
-- fmv_snapshots_2026 inside get_wallet_moments_with_fmv; last_vacuum NULL, autovacuum only).
-- Grant MAINTAIN so cron_heavy (statement_timeout 600s) can VACUUM (ANALYZE) it; schedule a
-- named ONE-OFF probe job at a free minute (02:29Z; minute 29 at 02Z collides with nothing —
-- jobid 261 is `29 * * * *` but is a light job). The probe is unscheduled by name after its first run.
-- Revert: REVOKE MAINTAIN ON TABLE public.fmv_snapshots_2026 FROM cron_heavy;
--         SET ROLE cron_heavy; SELECT cron.unschedule('tmp-vacuum-fmv-snapshots-2026');
DO $$
DECLARE v_new bigint;
BEGIN
  IF has_table_privilege('cron_heavy','public.fmv_snapshots_2026','MAINTAIN') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: cron_heavy already holds MAINTAIN on fmv_snapshots_2026';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tmp-vacuum-fmv-snapshots-2026') THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: probe job already exists';
  END IF;
  GRANT MAINTAIN ON TABLE public.fmv_snapshots_2026 TO cron_heavy;
  SET LOCAL ROLE cron_heavy;
  v_new := cron.schedule('tmp-vacuum-fmv-snapshots-2026', '29 2 * * *', 'VACUUM (ANALYZE) public.fmv_snapshots_2026');
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobid = v_new AND username = 'cron_heavy' AND active) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: probe job % not cron_heavy/active', v_new;
  END IF;
  RAISE NOTICE 'tmp-vacuum-fmv-snapshots-2026 scheduled as jobid % (cron_heavy) 29 2 * * *', v_new;
END $$;