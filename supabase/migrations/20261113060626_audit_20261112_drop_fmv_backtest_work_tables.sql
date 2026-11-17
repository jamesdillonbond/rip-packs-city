-- 2026-11-12 ~10:15 PM PT. Trevor: "Fix those things that were open first".
-- The three work tables behind the 11-12 morning FMV backtests (first-sale targets, weekly trend,
-- trend targets). Their conclusions are recorded in the ledger and the block 1-7 handoffs; nothing
-- reads them (no function body, no view, no repo code - checked on pg_depend, prosrc and a tree grep).
-- Derived entirely from sales_market / fmv_snapshots, so they can be rebuilt from
-- 20261112155438 and 20261112160033.
-- Revert: re-run those two migrations.
drop table if exists public.audit_20261112_fmv_first_sale_targets;
drop table if exists public.audit_20261112_fmv_trend_weekly;
drop table if exists public.audit_20261112_fmv_trend_targets;