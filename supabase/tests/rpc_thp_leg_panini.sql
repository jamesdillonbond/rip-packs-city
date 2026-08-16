-- DB invariant: public.rpc_thp_leg_panini — one leg of the trust-board precompute.
--
-- Writes two arms: `panini_sale_field_mapping_shortfall` and
-- `panini_sale_price_capture_dry_days`. The dry-days arm is one of the five currently
-- breached (19 and climbing +1/day), so how it counts is exactly what an operator is
-- reading when they decide whether the Panini outage is continuing or new.
--
-- ⚠ THE PROPERTY WORTH PINNING IS THAT DRY DAYS ARE COUNTED FROM THE NEWEST DAY
-- BACKWARDS AND STOP AT THE FIRST DAY WITH SUPPLY — it is a CURRENT-STREAK counter,
-- not a total. `bool_or(...) OVER (ORDER BY capture_day DESC ROWS BETWEEN UNBOUNDED
-- PRECEDING AND CURRENT ROW)` is a running "have we seen supply yet, scanning from
-- today into the past", and the arm counts the rows before that first sighting. So an
-- old dry spell that has since recovered contributes NOTHING, and the arm resets to 0
-- the moment one day captures a price. Read as a total it would look like a much
-- larger, permanent problem; read as a streak it is the outage's age in days, which is
-- why +1/day is the outage continuing rather than new information.
--
-- The function DDL below is VERBATIM from its committed migration, whose body was
-- verified against live prod prosrc (whitespace-collapsed md5, both comment-stripped
-- and not) on 2026-08-16. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.rpc_trust_health_precompute (
  metric      text PRIMARY KEY,
  value       numeric,
  computed_at timestamptz,
  duration_ms numeric
);

CREATE TABLE public._panini_supply (
  capture_day            date,
  raw_supplied_sale_price int,
  mapping_shortfall      numeric
);
CREATE VIEW public.v_panini_serial_sale_field_supply AS
  SELECT capture_day, raw_supplied_sale_price, mapping_shortfall FROM public._panini_supply;

-- Newest first: two dry days, then a day WITH supply, then two more dry days behind it.
-- The current dry STREAK is 2. A total would be 4.
INSERT INTO public._panini_supply (capture_day, raw_supplied_sale_price, mapping_shortfall) VALUES
  (current_date,              0,  12),   -- dry (today)
  (current_date - 1,          0,  40),   -- dry
  (current_date - 2,          7,  95),   -- SUPPLY — the streak stops here
  (current_date - 3,          0,   5),   -- dry, but BEHIND the supply day
  (current_date - 4,          0,   1);   -- dry, but BEHIND the supply day

-- >>> BEGIN verbatim rpc_thp_leg_panini (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '60s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_short numeric; v_dry numeric;
BEGIN
  BEGIN
    WITH src AS (
      SELECT v.capture_day, v.raw_supplied_sale_price, v.mapping_shortfall
      FROM public.v_panini_serial_sale_field_supply v
    ),
    runs AS (
      SELECT bool_or(s.raw_supplied_sale_price > 0) OVER (
               ORDER BY s.capture_day DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS seen_supply
      FROM src s
    )
    SELECT COALESCE(max(s2.mapping_shortfall), 0)::numeric,
           (SELECT count(*) FROM runs r WHERE NOT r.seen_supply)::numeric
      INTO v_short, v_dry
    FROM src s2;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_sale_field_mapping_shortfall', v_short, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('panini_sale_price_capture_dry_days', COALESCE(v_dry, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['panini_sale_field_mapping_shortfall','panini_sale_price_capture_dry_days']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_panini <<<

SELECT public.rpc_thp_leg_panini();

SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_sale_price_capture_dry_days'), '2',
  'dry days is the CURRENT STREAK counted from the newest day backwards (2), NOT the '
  'total number of dry days in the window (4) — an old spell that has recovered does '
  'not contribute, and the arm resets the moment one day captures a price');

SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_sale_field_mapping_shortfall'), '95',
  'shortfall is the MAX over the whole window, including days inside a recovered spell '
  '— the two arms deliberately have different horizons');

-- The streak resets to zero the instant the newest day captures a price. This is the
-- direction that matters operationally: it is how an operator learns the outage ended.
SAVEPOINT recovered;
UPDATE public._panini_supply SET raw_supplied_sale_price = 3 WHERE capture_day = current_date;
SELECT public.rpc_thp_leg_panini();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_sale_price_capture_dry_days'), '0',
  'one captured day at the head resets the streak to 0 — the arm goes green immediately, '
  'it does not decay');
ROLLBACK TO SAVEPOINT recovered;

-- ⚠ An EMPTY view publishes 0 dry days and 0 shortfall — i.e. the runner having stopped
-- producing rows AT ALL reads as perfect health on both arms. Same manufactured-green
-- shape as rpc_thp_leg_fmv_coverage's stale% arm.
SAVEPOINT no_rows;
DELETE FROM public._panini_supply;
SELECT public.rpc_thp_leg_panini();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 0), '2',
  'no rows at all publishes 0 on BOTH arms — a runner that has stopped writing entirely '
  'is indistinguishable from a healthy one. Manufactured from absence.');
ROLLBACK TO SAVEPOINT no_rows;

-- The 999 sentinel DOES fire on an ordinary error.
SAVEPOINT generic_err;
DROP VIEW public.v_panini_serial_sale_field_supply;
SELECT public.rpc_thp_leg_panini();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '2',
  'an ordinary error flips BOTH arms to 999, above the dry-days breach threshold of 3');
ROLLBACK TO SAVEPOINT generic_err;

-- ── ⚠ THE SENTINEL IS UNREACHABLE ON THE ONLY FAILURE THIS INSTANCE PRODUCES ──
-- PostgreSQL: "the special condition name OTHERS matches every error type except
-- QUERY_CANCELED and ASSERT_FAILURE" — and a statement_timeout raises query_canceled
-- (57014). Live `WHERE value = 999` has returned zero rows, ever. Pinned as CURRENT
-- BEHAVIOUR: catching the cancel was shipped and reverted the same session
-- (2026-08-15, `255e7d24`) because the timer is not re-armed afterwards. If a change
-- makes the sentinel reachable, THIS FAILS.
DROP VIEW public.v_panini_serial_sale_field_supply;
CREATE FUNCTION public._cancel() RETURNS TABLE(capture_day date, raw_supplied_sale_price int,
                                               mapping_shortfall numeric)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
CREATE VIEW public.v_panini_serial_sale_field_supply AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_panini();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(caught, 'a 57014 escapes the leg — WHEN OTHERS does not match QUERY_CANCELED');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'no 999 is written on a timeout, so both arms keep their previous values and publish '
  'them as current — and v_rpc_trust_health has no per-metric age column to expose that');

SELECT '✓ rpc_thp_leg_panini invariants pass' AS result;

ROLLBACK;
