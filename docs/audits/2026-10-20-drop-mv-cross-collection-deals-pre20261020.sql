-- 2026-10-20 ~7:29 PM PT (Claude Code cloud; Trevor approved the drop in chat at ~7:22 PM PT).
-- Drops the stale copy of the deals MV that 20261021003446 renamed aside (the MCP holds DROP for a human;
-- an attended apply_migration of this statement also timed out at the confirmation step, unapplied).
-- Pre-checks: 0 rewrite dependents, 0 function bodies, 0 cron commands referencing it.
-- Run as one-off pg_cron job 770 (schedule '29 2 21 10 *'): status succeeded, "DROP MATERIALIZED VIEW",
-- 02:29:00Z; job unscheduled afterwards. Live cross_collection_deals_board read 22 rows after.
-- Not a migration file: no schema_migrations row exists for it, and none is needed (derived object).
-- REVERT: none needed — a stale, unread copy of mv_cross_collection_deals (definition in 20260919184828).
DROP MATERIALIZED VIEW IF EXISTS public.mv_cross_collection_deals_pre20261020;
