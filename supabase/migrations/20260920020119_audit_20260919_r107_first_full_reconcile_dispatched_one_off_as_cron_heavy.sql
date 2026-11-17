-- One-off dispatch of the first callable FULL reconcile (R107), as cron_heavy so it runs under the
-- same role, budget (600 s) and wrapper the daily 09:36Z job uses. Scheduled for the next minute;
-- the job was unscheduled by the session once its cron.job_run_details row landed (SET LOCAL ROLE
-- cron_heavy; cron.unschedule — postgres cannot unschedule a cron_heavy-owned job), and this file is
-- the record of the dispatch. RESULT (7:03 PM PT): succeeded, 45.0 s, upserted 21,424, pruned 0;
-- afterwards check_edition_fmv_current_source_drift(1) = [], orphan (edition_id, computed_at)
-- pairs 105 → 0, cache-ahead rows 15 → 0; 15 fmv_usd values changed vs the backup (net -$271.09,
-- max |Δ| $1,349.55 — the 2,999 → 1,649.45 pre-haircut ask). REVERT: n/a (the data revert is the
-- backup table named in 20260920020102).
SET LOCAL ROLE cron_heavy;
SELECT cron.schedule('zz-r107-first-full-reconcile', '3 2 * * *', 'SELECT public.run_edition_fmv_current_full_reconcile_job();');
RESET ROLE;
