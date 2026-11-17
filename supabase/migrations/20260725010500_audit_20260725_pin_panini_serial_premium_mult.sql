-- Version-controls the LIVE definition of panini_serial_premium_mult (the Panini
-- special-serial FMV premium multiplier: jersey-mint > perfect-mint > number-1,
-- else 1.00x) so it can be pinned by a DB-invariant test. Idempotent no-op
-- re-assert of the exact current definition; the prior migration only ALTERed its
-- search_path (no readable CREATE for the drift-guard extractor). Preserves grants.
CREATE OR REPLACE FUNCTION public.panini_serial_premium_mult(p_is_jersey boolean, p_is_perfect boolean, p_is_num1 boolean)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    case when p_is_jersey  then (select multiplier from public.panini_serial_premium where flag='jersey mint') end,
    case when p_is_perfect then (select multiplier from public.panini_serial_premium where flag='perfect mint') end,
    case when p_is_num1    then (select multiplier from public.panini_serial_premium where flag='number 1') end,
    1.00);
$function$;
