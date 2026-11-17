-- 2026-11-16 (PT) — drop the Top Shot-only Compare candidate read (Trevor: "Do what you think is best").
--
-- get_topshot_trade_compare(text, text, int) (migration 20261116180340) was replaced by
-- get_trade_compare(uuid, text, text, int) (20261116221606), whose caller went live in c44fd21.
-- Before this drop: no caller in app/, lib/, scripts/, supabase/functions/; none in cron.job or in
-- any other function body (pg_proc.prosrc); pg_stat_statements held only its 5 calls from earlier
-- the same day. Re-verified live after c44fd21 served Top Shot, All Day and Golazos compares.
--
-- Revert: re-apply the CREATE OR REPLACE + REVOKE/GRANT block of 20261116180340.

DROP FUNCTION IF EXISTS public.get_topshot_trade_compare(text, text, int);
