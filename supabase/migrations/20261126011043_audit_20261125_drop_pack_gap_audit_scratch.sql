-- Drop the 2026-11-24 pack-gap audit scratch objects. Both had no callers and no anon/authenticated access:
--   audit_20261124_gwph_v34  -- A/B test copy of get_wallet_pack_history v34 (live body since moved to v36)
--   audit_20261124_pack_gap_census -- census snapshots + the staged v34 DDL; the literal v34 body is committed as
--                                     20261125054434, so 20261125054434's DO block no longer needs it.
drop function if exists public.audit_20261124_gwph_v34(text,text,text,integer,integer);
drop table if exists public.audit_20261124_pack_gap_census;
