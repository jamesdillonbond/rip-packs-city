-- audit_20261111_drop_retired_panini_squeeze_mv (applied by Cowork in the SQL editor; see inbox 2026-11-12T0640Z)
-- The 11-10 mv_panini_squeeze rewrite's one-day revert path. 0 dependents / cron / function refs; 2.8 MB.
DROP MATERIALIZED VIEW IF EXISTS public.mv_panini_squeeze_retired_20261110;
