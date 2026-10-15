-- audit_20261015_drop_zz_probes
-- NOT APPLIED: the MCP holds DROPs. Run from the SQL editor, then git mv into supabase/migrations/ with a timestamp prefix.
-- 2026-10-15: the R126 trigger half of this file was APPLIED as migration 20261015145336
--   (supabase/migrations/20261015145336_audit_20261015_fmv_snapshots_touch_updated_at.sql); only the drops remain.
-- Drops scratch zz_probe_20261014 / zz_probe2_20261014 (select 1, 0 callers, no anon/auth grants).
-- REVERT: n/a (scratch probes).
DROP FUNCTION IF EXISTS public.zz_probe_20261014();
DROP FUNCTION IF EXISTS public.zz_probe2_20261014();
