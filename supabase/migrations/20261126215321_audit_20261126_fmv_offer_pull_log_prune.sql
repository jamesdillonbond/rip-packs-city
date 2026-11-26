-- audit_20261126_fmv_offer_pull_log_prune — 2026-11-26 ~2:00 PM PT (Claude Code cloud; Trevor approved "Yes do it all").
-- Keeps public.fmv_offer_pull_log (written by fmv_snapshots_pull_topshot_thin_to_best_offer since 20261126212338,
-- ~95 rows in its first 35 minutes) to 180 days: the weekly offer-rule reads score a snapshot against sales up to
-- 90 days later, so 180 days leaves every read its full window. Daily at 3:07 AM PT (11:07 UTC); the delete walks
-- fmv_offer_pull_log_logged_idx. One statement, no SET prefix, so pg_cron does not run it as a transaction block.
-- Revert: SELECT cron.unschedule('rpc-fmv-offer-pull-log-prune');
select cron.schedule('rpc-fmv-offer-pull-log-prune', '7 11 * * *',
                     $$DELETE FROM public.fmv_offer_pull_log WHERE logged_at < now() - interval '180 days'$$);