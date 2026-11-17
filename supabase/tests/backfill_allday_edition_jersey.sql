-- DB invariant: public.backfill_allday_edition_jersey — the AllDay per-moment
-- jersey backfill that lights up the JERSEY-MATCH special-serial row. The row is
-- only correct if this function (a) accepts ONLY a valid NFL number 0..99,
-- (b) ignores NULL jerseys, (c) is change-detecting (never a redundant write),
-- (d) is scoped to the AllDay collection, and (e) returns the count actually
-- changed. A regression here silently paints a wrong jersey-match on a moment.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260710181203_audit_20260710_backfill_allday_edition_jersey_rpc.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal editions fixture: only the columns the function touches. The real
-- table is far wider, but the function references only these, and a self-
-- contained copy keeps this test runnable on a vanilla postgres:16.
CREATE TABLE public.editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL,
  external_id text NOT NULL,
  jersey_number integer
);

-- Two AllDay editions (the collection id the function hard-codes) + one row in a
-- different collection to prove collection scoping.
INSERT INTO public.editions (collection_id, external_id, jersey_number) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A100', NULL),  -- AllDay, unset
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A200', 7),     -- AllDay, already 7
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'A100', NULL);  -- Top Shot, same ext id

-- >>> BEGIN verbatim backfill_allday_edition_jersey (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.backfill_allday_edition_jersey(p_pairs jsonb)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH up AS (
    UPDATE public.editions e
    SET jersey_number = v.jersey
    FROM jsonb_to_recordset(p_pairs) AS v(external_id text, jersey integer)
    WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
      AND e.external_id = v.external_id
      AND v.jersey IS NOT NULL
      AND v.jersey BETWEEN 0 AND 99
      AND e.jersey_number IS DISTINCT FROM v.jersey
    RETURNING 1
  )
  SELECT count(*)::int FROM up;
$function$;
-- <<< END verbatim backfill_allday_edition_jersey <<<

-- (1) A valid jersey on an unset AllDay edition is written, and counted once.
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A100","jersey":23}]')::text,
  '1', 'valid jersey on unset row → 1 change');
SELECT _assert_eq(
  (SELECT jersey_number::text FROM public.editions
   WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND external_id='A100'),
  '23', 'jersey_number persisted');

-- (2) Change-detecting: re-applying the same value is a no-op (0 changed).
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A100","jersey":23}]')::text,
  '0', 'idempotent — same value → 0 changes');

-- (3) NULL jersey is ignored (never nulls an existing value, never counted).
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A200","jersey":null}]')::text,
  '0', 'null jersey → 0 changes');
SELECT _assert_eq(
  (SELECT jersey_number::text FROM public.editions
   WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND external_id='A200'),
  '7', 'existing jersey untouched by a null pair');

-- (4) Out-of-range numbers (>99 or <0) are rejected — team/non-player noise.
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A100","jersey":100}]')::text,
  '0', 'jersey 100 out of range → rejected');
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A100","jersey":-1}]')::text,
  '0', 'jersey -1 out of range → rejected');
-- boundary values 0 and 99 ARE valid
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A200","jersey":0}]')::text,
  '1', 'jersey 0 is a valid boundary');
SELECT _assert_eq(
  public.backfill_allday_edition_jersey('[{"external_id":"A200","jersey":99}]')::text,
  '1', 'jersey 99 is a valid boundary');

-- (5) Collection scoping: the same external_id in another collection is NOT touched.
SELECT _assert_eq(
  (SELECT jersey_number::text FROM public.editions
   WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND external_id='A100'),
  NULL, 'Top Shot row with same external_id stays NULL (collection-scoped)');

-- (6) Batch with a mix: one valid new change + one out-of-range + one unknown ext.
SELECT _assert_eq(
  public.backfill_allday_edition_jersey(
    '[{"external_id":"A100","jersey":45},{"external_id":"A200","jersey":250},{"external_id":"ZZZ","jersey":10}]'
  )::text,
  '1', 'batch counts only the one valid, changed, in-range, known row');

SELECT '✓ backfill_allday_edition_jersey invariants pass' AS result;
ROLLBACK;
