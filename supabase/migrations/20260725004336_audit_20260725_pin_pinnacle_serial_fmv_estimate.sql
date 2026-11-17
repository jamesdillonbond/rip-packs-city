-- Version-controls the LIVE definition of pinnacle_serial_fmv_estimate (the
-- serial-scarcity FMV overlay) so it can be pinned by a DB-invariant test. This
-- re-asserts the exact current definition (via pg_get_functiondef) — an
-- idempotent CREATE OR REPLACE that changes no behavior and preserves grants.
-- The earlier defining migration (20260706003000_..._pinnacle_serial_fmv_model)
-- used lowercase DDL that the drift-guard extractor (case-sensitive on
-- "CREATE OR REPLACE FUNCTION public.") cannot read; this uppercase copy is the
-- pinnable source. Revert: none needed (no-op re-assert).
CREATE OR REPLACE FUNCTION public.pinnacle_serial_fmv_estimate(p_serial integer, p_mint_count integer, p_base_fmv numeric)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with band as (
    select case
             when p_serial is null or p_serial <= 0 or p_base_fmv is null then null
             when p_serial = 1 then 'first'
             when p_mint_count is null or p_mint_count <= 1 then 'normal'
             when p_serial::numeric / p_mint_count <= 0.05 then 'low5'
             when p_serial::numeric / p_mint_count <= 0.20 then 'low20'
             else 'normal'
           end as b
  )
  select case
           when band.b is null then p_base_fmv
           else round(p_base_fmv * coalesce(
             (select m.multiplier from public.pinnacle_serial_fmv_multipliers m
               where m.band = band.b and m.is_reliable), 1.0), 2)
         end
  from band;
$function$;
