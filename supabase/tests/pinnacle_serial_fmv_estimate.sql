-- DB invariant: public.pinnacle_serial_fmv_estimate — the Disney Pinnacle serial
-- premium OVERLAY. Given a base (render) FMV, a serial and the mint count, it
-- classifies the serial and multiplies by that band's learned multiplier (only
-- when the fit is marked is_reliable).
--
-- ⚠ 2026-09-27: premiums for #1 and PERFECT (#N of N) ONLY, the shared
-- serial_fmv_estimate pattern (Trevor). The old top-5% / top-20% bands are gone;
-- the fixture below still carries stale low5/low20 rows to prove they are ignored.
-- Pins:
--   * band precedence — serial=1 ('first') wins, including on a mint of 1;
--   * 'perfect' needs mint > 1 and serial = mint;
--   * every other serial is 'normal' — a low serial earns NO premium now;
--   * an UNRELIABLE band multiplier is ignored (falls back to 1.0x);
--   * null/<=0 serial or null base_fmv -> band NULL -> base_fmv returned RAW
--     (unrounded), never multiplied.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260927183258_audit_20260927_pinnacle_serial_premium_first_and_perfect_only.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The only dependency: the learned per-band multipliers. 'normal' is present but
-- is_reliable=false, so it must NOT be applied. low5/low20 are STALE rows the
-- function must no longer reach.
CREATE TABLE public.pinnacle_serial_fmv_multipliers (band text, multiplier numeric, is_reliable boolean);
INSERT INTO public.pinnacle_serial_fmv_multipliers (band, multiplier, is_reliable) VALUES
  ('first', 3.0, true),
  ('perfect', 2.5, true),
  ('low5',  2.0, true),
  ('low20', 1.5, true),
  ('normal', 1.2, false);

-- >>> BEGIN verbatim pinnacle_serial_fmv_estimate (keep byte-identical to the migration) >>>
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
             when p_mint_count is not null and p_mint_count > 1 and p_serial = p_mint_count then 'perfect'
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
-- <<< END verbatim pinnacle_serial_fmv_estimate <<<

-- serial=1 → 'first' → 100 * 3.0 = 300.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 100, 100)::text,   '300.00', 'serial 1 → first band 3.0x');
-- serial=1 wins even on a mint of 1 (it is also the last serial there).
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 1, 100)::text,     '300.00', 'serial 1 of 1 → first, not perfect');
-- serial = mint (> 1) → 'perfect' → 100 * 2.5 = 250.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(100, 100, 100)::text, '250.00', 'serial = mint → perfect band 2.5x');
-- a LOW serial earns nothing now: 5/100 was 'low5' (2.0x) — must be normal → 1.0x
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(5, 100, 100)::text,   '100.00', 'serial 5/100 → normal, the stale low5 row is not applied');
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(20, 100, 100)::text,  '100.00', 'serial 20/100 → normal, the stale low20 row is not applied');
-- one short of perfect is normal
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(99, 100, 100)::text,  '100.00', 'serial 99/100 → normal');
-- unknown mint → cannot be perfect → normal (unreliable → 1.0x)
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(7, NULL, 100)::text,  '100.00', 'null mint → normal');
-- null serial → band NULL → base returned RAW (unrounded): 100, not 100.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(NULL, 100, 100)::text, '100', 'null serial → raw base_fmv, not multiplied/rounded');
-- serial<=0 → same raw-base path
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(0, 100, 100)::text,    '100', 'serial 0 → raw base_fmv');
-- null base → band NULL → returns NULL
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 100, NULL)::text,   NULL,   'null base_fmv → NULL');

SELECT '✓ pinnacle_serial_fmv_estimate: all 10 assertions passed' AS result;

ROLLBACK;
