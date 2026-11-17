-- audit_20260922_schedule_the_wmc_edition_key_reconciler
--
-- Wires reconcile_wmc_edition_key_from_moments onto pg_cron. Recorded as a migration so
-- the schedule is reproducible from main -- it was first created via execute_sql, which
-- leaves nothing in the repo, and a schedule that exists only in the database is exactly
-- the drift this estate keeps getting bitten by.
--
-- cron.schedule upserts by jobname, so re-running this is idempotent.
--
-- CADENCE. Hourly at :21. The minute was chosen by reading the live schedule rather than
-- guessing: of 159 active jobs, nothing hourly occupies :21. The work is small (candidate
-- population 16,414 rows estate-wide, and the window is capped at 3,000/tick behind a
-- wrapping cursor), so hourly comfortably cycles it while keeping a newly-written NULL
-- key -- the wallet-search paste path -- healed within the hour rather than never.
--
-- REVERT: SELECT cron.unschedule('rpc-wmc-edition-key-reconcile');

SELECT cron.schedule('rpc-wmc-edition-key-reconcile', '21 * * * *',
  'SELECT public.reconcile_wmc_edition_key_from_moments(3000, 45)');
