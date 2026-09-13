-- Register #102 said two suppressions justify themselves by naming a
-- pipeline_cadence_watchlist row as `is_active=true` while both rows read false,
-- and recommended RE-ENABLING those rows. ⛔ That recommendation is REFUTED and is
-- deliberately NOT followed here.
--
-- Re-derived 2026-09-13: both rows were switched off ON PURPOSE, together with the
-- lanes they watch.
--   · allday-pack-opens-backfill — the 2026-09-03 ledger entry records pg_cron
--     jobid 55 UNSCHEDULED because "25 of 25 ticks in four hours died at pg_net's
--     90 s wall, and because pg_net answers a batch when its slowest member
--     finishes, EVERY OTHER pg_net request on the platform queued behind it".
--     AllDay is sunset. That entry says in terms: "Its watchlist arm is retired
--     with it per that arm's own rule", and it left
--     audit_20260904_jobid55_watchlist_retire_backup as the revert.
--   · ufc-sales-indexer — UFC-on-Flow secondary trading is closed and its
--     cron-job.org trigger is separately recorded dead (operator/auth).
--
-- ⛔ SO RE-ENABLING THE ROWS WOULD HAVE BEEN THE WRONG FIX TWICE OVER: it would
-- re-create permanently-firing alarms for lanes that are deliberately stopped, and
-- it would read as reversing a change that fixed platform-wide pg_net head-of-line
-- blocking. A permanently-red arm is the failure mode this estate already names.
--
-- ⭐ THE REAL DEFECT IS THE STALE JUSTIFICATION, and that is what this migration
-- fixes. Each suppression still asserts a live safety net. A reader checking
-- whether muting is safe finds a net that no longer exists and concludes wrongly —
-- which is exactly what happened when #102 was filed.
--
-- Backup + revert:
--   UPDATE public.pipeline_alert_suppression s SET reason = b.reason
--   FROM public.audit_20260913_suppression_stale_net_claims_backup b
--   WHERE s.pipeline = b.pipeline;

CREATE TABLE IF NOT EXISTS public.audit_20260913_suppression_stale_net_claims_backup AS
SELECT pipeline, reason, added_at, expires_at, now() AS backed_up_at
FROM public.pipeline_alert_suppression
WHERE pipeline IN ('allday_pack_opens_backfill', 'ufc_sales');

UPDATE public.pipeline_alert_suppression
SET reason = reason || E'\n\n[CORRECTION 2026-09-13] The sentence above claiming the '
  || 'pipeline_cadence_watchlist row for allday-pack-opens-backfill is is_active=true is '
  || 'NO LONGER TRUE and has not been since 2026-09-04. That row was retired DELIBERATELY, '
  || 'in the same action that unscheduled pg_cron jobid 55, because 25 of 25 ticks in four '
  || 'hours died at pg_net''s 90 s wall and head-of-line blocked every other pg_net request '
  || 'on the platform. AllDay is sunset; the walk had ~19M blocks left. Revert for that '
  || 'retirement: audit_20260904_jobid55_watchlist_retire_backup. SO THERE IS NO CADENCE NET '
  || 'FOR THIS LANE, AND THAT IS INTENTIONAL — the lane has no caller at all, so an alarm on '
  || 'it would be permanently red. Do NOT "restore" the watchlist row without first giving '
  || 'the lane a caller AND re-checking the pg_net blocking that killed it.'
WHERE pipeline = 'allday_pack_opens_backfill';

UPDATE public.pipeline_alert_suppression
SET reason = reason || E'\n\n[CORRECTION 2026-09-13] The sentence above claiming the '
  || 'pipeline_cadence_watchlist row for ufc-sales-indexer is is_active=true is NO LONGER '
  || 'TRUE — measured is_active=false. UFC-on-Flow secondary trading is closed and this '
  || 'lane''s cron-job.org trigger is separately recorded dead (operator/auth), so the '
  || 'absence of a cadence net is consistent with a market that does not trade rather than '
  || 'an oversight. Stakes are low BUT the stale claim is the defect: do not treat that '
  || 'sentence as evidence that a total-stop signal exists.'
WHERE pipeline = 'ufc_sales';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS for the backup table above — appended 2026-09-13 by a CONCURRENT SESSION,
-- not by this migration's author, because it left `main` red.
--
-- `__tests__/migration-new-public-table-enables-rls.test.ts` requires these three
-- statements in the SAME file as the CREATE TABLE, and it is right to: a public
-- table without them is anon-readable from the moment it exists.
-- `selfheal_audit_table_rls()` (pg_cron 232, `47 * * * *`) does cover this table
-- because the prefix is `audit_`, so PRODUCTION closes on its own — but "exposed
-- until :47" is what the guard exists to stop being the normal case.
--
-- ⚠ APPENDED TO THE APPLIED FILE rather than fixed forward, deliberately, and
-- the trade is stated because the guard's own header argues the other way:
--   · `check-migration-parity.mjs` matches on NAME, not content, so editing a
--     committed+applied file does not break parity (verified in that script).
--   · The header's objection to editing an applied file is that churn "carries a
--     real chance of altering what the file would do if it ever WERE replayed" —
--     these statements make a replay STRICTLY more correct, which is the one
--     case where that objection does not bite.
--   · The alternative (grandfather + a forward migration) grows the list the
--     guard exists to freeze AND needs a prod `apply_migration`, whose ~10-20 s
--     `PGRST002` burst is a real user-facing cost for something the healer
--     already fixes at :47.
-- Idempotent, so it is safe if the author ships their own fix on top.
ALTER TABLE public.audit_20260913_suppression_stale_net_claims_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260913_suppression_stale_net_claims_backup FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.audit_20260913_suppression_stale_net_claims_backup TO postgres, service_role;
