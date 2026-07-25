-- DB invariant: public.pinnacle_serial_fmv_estimate — the serial-scarcity FMV
-- OVERLAY. Given a base (edition) FMV, a serial, and the edition mint count, it
-- classifies the serial into a scarcity band and multiplies by that band's
-- learned multiplier (only when the fit is marked is_reliable). This pins the
-- load-bearing rules a bad edit could silently break:
--   * band precedence — serial=1 ('first') wins BEFORE the mint<=1 short-circuit,
--     which itself wins BEFORE the ratio bands;
--   * the ratio thresholds are INCLUSIVE — 0.05 -> 'low5', 0.20 -> 'low20';
--   * an UNRELIABLE band multiplier is ignored (falls back to 1.0x);
--   * null/<=0 serial or null base_fmv -> band NULL -> base_fmv returned RAW
--     (unrounded), never multiplied.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260725004336_audit_20260725_pin_pinnacle_serial_fmv_estimate.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- The only dependency: the learned per-band multipliers. 'normal' is present but
-- is_reliable=false, so it must NOT be applied.
CREATE TABLE public.pinnacle_serial_fmv_multipliers (band text, multiplier numeric, is_reliable boolean);
INSERT INTO public.pinnacle_serial_fmv_multipliers (band, multiplier, is_reliable) VALUES
  ('first', 3.0, true),
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
-- <<< END verbatim pinnacle_serial_fmv_estimate <<<

-- serial=1 → 'first' → 100 * 3.0 = 300.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 100, 100)::text,   '300.00', 'serial 1 → first band 3.0x');
-- serial=1 wins over the mint<=1 short-circuit (precedence): still 'first'.
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 1, 100)::text,     '300.00', 'serial 1 beats mint<=1 → first');
-- ratio 0.05 exactly → 'low5' (inclusive) → 100 * 2.0 = 200.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(5, 100, 100)::text,   '200.00', 'serial/mint = 0.05 → low5 (inclusive)');
-- ratio 0.20 exactly → 'low20' (inclusive) → 100 * 1.5 = 150.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(20, 100, 100)::text,  '150.00', 'serial/mint = 0.20 → low20 (inclusive)');
-- ratio > 0.20 → 'normal', but its multiplier is is_reliable=false → 1.0x → 100.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(50, 100, 100)::text,  '100.00', 'normal band unreliable → 1.0x, still rounded to 100.00');
-- mint<=1 short-circuits low-serial to 'normal' (→ 1.0x here) BEFORE the ratio bands.
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(5, 1, 100)::text,     '100.00', 'mint<=1 → normal short-circuit (not low5)');
-- null serial → band NULL → base returned RAW (unrounded): 100, not 100.00
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(NULL, 100, 100)::text, '100', 'null serial → raw base_fmv, not multiplied/rounded');
-- serial<=0 → same raw-base path
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(0, 100, 100)::text,    '100', 'serial 0 → raw base_fmv');
-- null base → band NULL → returns NULL
SELECT _assert_eq(public.pinnacle_serial_fmv_estimate(1, 100, NULL)::text,   NULL,   'null base_fmv → NULL');

SELECT '✓ pinnacle_serial_fmv_estimate: all 9 assertions passed' AS result;

ROLLBACK;
