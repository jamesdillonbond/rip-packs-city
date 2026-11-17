-- The pg_net fetch path was not used (superseded by the sales_high_water_at rewind); its staging table stayed empty.
drop table if exists public.audit_20261115_candy_legacy_sales_backfill;