-- Revert path: re-run the CREATE in supabase/migrations/20260802192000_audit_20260802_snapshot_check_set_completion.sql
-- (byte-identical to the live def captured 2026-11-23 ~7:50 AM PT). 0 callers: code, SQL bodies, pg_cron, cron-job.org, pg_stat_statements.
-- Unscoped editions.external_id join (#142 class): wrong-if-ever-called.
DROP FUNCTION public.check_set_completion(text);
