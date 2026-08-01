-- DB invariant: public.raise_impossible_parallel_circ() — the TopShot parallel
-- circulation self-heal. It corrects editions whose recorded circulation_count is
-- below a serial number that has actually SOLD (an impossible, scarcity-inflating
-- state), by raising circulation to the max sold serial. The load-bearing
-- properties: (a) scoped to TopShot PARALLEL editions only (external_id ~ '::'),
-- (b) MONOTONIC — it only ever raises, never lowers, and (c) every raise is
-- audited. A regression here would silently mutate circulation on the wrong
-- editions, poisoning FMV and pack-EV.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801160200_audit_20260801_snapshot_raise_impossible_parallel_circ.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id               uuid PRIMARY KEY,
  external_id      text,
  circulation_count integer,
  collection_id    uuid,
  last_updated_at  timestamptz
);
CREATE TABLE sales (
  edition_id    uuid,
  serial_number integer
);
CREATE TABLE impossible_parallel_circ_raises (
  edition_id  uuid,
  external_id text,
  old_circ    integer,
  new_circ    integer
);

-- >>> BEGIN verbatim raise_impossible_parallel_circ (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.raise_impossible_parallel_circ()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_raised int := 0;
BEGIN
  WITH offenders AS (
    SELECT e.id, e.external_id, e.circulation_count AS old_circ,
           max(s.serial_number)::int AS new_circ
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.external_id ~ '::'
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count
    GROUP BY e.id, e.external_id, e.circulation_count
  ),
  upd AS (
    UPDATE public.editions e
       SET circulation_count = o.new_circ,
           last_updated_at   = now()
      FROM offenders o
     WHERE e.id = o.id
       AND o.new_circ > e.circulation_count   -- MONOTONIC: raise only
    RETURNING e.id, o.external_id, o.old_circ, o.new_circ
  ),
  aud AS (
    INSERT INTO public.impossible_parallel_circ_raises (edition_id, external_id, old_circ, new_circ)
    SELECT id, external_id, old_circ, new_circ FROM upd
    RETURNING 1
  )
  SELECT count(*) INTO v_raised FROM upd;

  RETURN jsonb_build_object('raised', v_raised, 'at', now());
END;
$function$;
-- <<< END verbatim raise_impossible_parallel_circ <<<

-- TopShot collection id the function hard-codes.
-- e1: TS parallel, circ 10, a serial 25 sold → must raise to 25 + audit.
INSERT INTO editions VALUES ('11111111-1111-1111-1111-111111111111', '100:200::3', 10, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('11111111-1111-1111-1111-111111111111', 25),
                         ('11111111-1111-1111-1111-111111111111', 8);
-- e2: TS NON-parallel (no '::'), circ 5, serial 30 sold → must be LEFT ALONE
--     (the '::' scope guard). This is the key false-positive guard.
INSERT INTO editions VALUES ('22222222-2222-2222-2222-222222222222', '100:200', 5, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('22222222-2222-2222-2222-222222222222', 30);
-- e3: parallel in a DIFFERENT collection, serial 40 > circ 5 → LEFT ALONE.
INSERT INTO editions VALUES ('33333333-3333-3333-3333-333333333333', '1:2::9', 5, '06248cc4-b85f-47cd-af67-1855d14acd75', NULL);
INSERT INTO sales VALUES ('33333333-3333-3333-3333-333333333333', 40);
-- e4: TS parallel where every serial <= circ → NOT an offender, untouched.
INSERT INTO editions VALUES ('44444444-4444-4444-4444-444444444444', '7:8::1', 50, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);
INSERT INTO sales VALUES ('44444444-4444-4444-4444-444444444444', 12),
                         ('44444444-4444-4444-4444-444444444444', 50);

SELECT _assert_eq((raise_impossible_parallel_circ()->>'raised'), '1', 'exactly one edition raised');

-- e1 raised to the max sold serial.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='11111111-1111-1111-1111-111111111111'),
  '25', 'e1 circ raised to max serial 25');
-- e2 (non-parallel) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='22222222-2222-2222-2222-222222222222'),
  '5', 'e2 non-parallel untouched');
-- e3 (other collection) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='33333333-3333-3333-3333-333333333333'),
  '5', 'e3 other-collection untouched');
-- e4 (no serial exceeds circ) untouched.
SELECT _assert_eq((SELECT circulation_count::text FROM editions WHERE id='44444444-4444-4444-4444-444444444444'),
  '50', 'e4 within-circ untouched');

-- Exactly one audit row, for e1, capturing old→new.
SELECT _assert_eq((SELECT count(*)::text FROM impossible_parallel_circ_raises), '1', 'one audit row');
SELECT _assert_eq(
  (SELECT old_circ::text || '->' || new_circ::text FROM impossible_parallel_circ_raises WHERE edition_id='11111111-1111-1111-1111-111111111111'),
  '10->25', 'audit captured old→new');

-- Idempotent: a second run finds no offenders and raises 0.
SELECT _assert_eq((raise_impossible_parallel_circ()->>'raised'), '0', 'second run is a no-op (monotonic + healed)');

SELECT '✓ raise_impossible_parallel_circ invariants pass' AS result;
ROLLBACK;
