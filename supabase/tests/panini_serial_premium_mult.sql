-- DB invariant: public.panini_serial_premium_mult — the Panini special-serial FMV
-- premium multiplier. Given three special-serial flags it returns the premium
-- multiplier via a strict COALESCE precedence: jersey-mint > perfect-mint >
-- number-1, else 1.00x. This pins that precedence, the 1.00 default, AND the
-- fall-through when a flagged tier has no configured row (COALESCE skips a NULL
-- lookup to the next candidate) — a silent mis-order or a swallowed NULL would
-- misprice every special serial.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725010500_audit_20260725_pin_panini_serial_premium_mult.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.panini_serial_premium (flag text, multiplier numeric);
INSERT INTO public.panini_serial_premium (flag, multiplier) VALUES
  ('jersey mint', 5.5),
  ('perfect mint', 3.25),
  ('number 1', 2.1);

-- >>> BEGIN verbatim panini_serial_premium_mult (keep byte-identical to the migration) >>>
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
-- <<< END verbatim panini_serial_premium_mult <<<

-- jersey wins over everything
SELECT _assert_eq(public.panini_serial_premium_mult(true,  true,  true )::text, '5.5',  'jersey mint wins over perfect + number-1');
-- perfect wins when jersey is absent
SELECT _assert_eq(public.panini_serial_premium_mult(false, true,  true )::text, '3.25', 'perfect mint wins over number-1');
-- number-1 when it is the only flag
SELECT _assert_eq(public.panini_serial_premium_mult(false, false, true )::text, '2.1',  'number-1 premium');
-- no flags → 1.00 default
SELECT _assert_eq(public.panini_serial_premium_mult(false, false, false)::text, '1.00', 'no special serial → 1.00x default');
-- jersey alone
SELECT _assert_eq(public.panini_serial_premium_mult(true,  false, false)::text, '5.5',  'jersey mint alone');

-- Fall-through: a flagged tier with NO configured row yields NULL from its CASE,
-- and COALESCE moves to the next candidate. Drop 'jersey mint' so a jersey+perfect
-- serial falls through to the perfect-mint premium instead of returning NULL.
DELETE FROM public.panini_serial_premium WHERE flag = 'jersey mint';
SELECT _assert_eq(public.panini_serial_premium_mult(true,  true,  false)::text, '3.25', 'missing jersey-mint row falls through to perfect-mint');
-- And with only a flag whose row is missing, fall all the way to 1.00.
DELETE FROM public.panini_serial_premium WHERE flag = 'number 1';
SELECT _assert_eq(public.panini_serial_premium_mult(false, false, true )::text, '1.00', 'missing number-1 row falls through to 1.00 default');

SELECT '✓ panini_serial_premium_mult: all 7 assertions passed' AS result;

ROLLBACK;
