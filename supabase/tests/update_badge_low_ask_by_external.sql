-- DB invariant: public.update_badge_low_ask_by_external — the by-external_id
-- badge low_ask writer (the AllDay/Golazos counterpart to
-- update_badge_low_ask_from_cached_listings, which keys by player/set/tier). It
-- takes a jsonb array of {external_id, low_ask}, and writes each onto the matching
-- badge_editions row — but ONLY where the value differs (IS DISTINCT FROM),
-- scoped to the collection, skipping rows with a null external_id or low_ask.
-- Returns the count updated.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260427020000_badge_low_ask_aggregator.sql), verified
-- byte-identical to live prod via pg_get_functiondef on 2026-07-31.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.badge_editions (
  collection_id uuid,
  external_id   text,
  low_ask       numeric,
  updated_at    timestamptz
);

-- >>> BEGIN verbatim update_badge_low_ask_by_external (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.update_badge_low_ask_by_external(
  p_collection_id uuid,
  p_data jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH src AS (
    SELECT
      (j->>'external_id')::text AS external_id,
      (j->>'low_ask')::numeric AS low_ask
    FROM jsonb_array_elements(p_data) j
    WHERE (j->>'external_id') IS NOT NULL
      AND (j->>'low_ask') IS NOT NULL
  ),
  upd AS (
    UPDATE badge_editions be
    SET
      low_ask = src.low_ask,
      updated_at = now()
    FROM src
    WHERE be.collection_id = p_collection_id
      AND be.external_id = src.external_id
      AND (be.low_ask IS DISTINCT FROM src.low_ask)
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;
-- <<< END verbatim update_badge_low_ask_by_external <<<

\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.badge_editions (collection_id, external_id, low_ask) VALUES
  (:ad::uuid, 'X1', NULL),   -- NULL -> 50
  (:ad::uuid, 'X2', 80),     -- already 80 = incoming → unchanged (DISTINCT FROM guard)
  (:ad::uuid, 'X3', 5),      -- no incoming row → unchanged
  (:ts::uuid, 'X1', NULL);   -- other collection, same external_id → untouched

-- Incoming floors: X1->50, X2->80 (same), and an id-less + low_ask-less row (both skipped).
SELECT _assert_eq(public.update_badge_low_ask_by_external(:ad::uuid, jsonb_build_array(
  jsonb_build_object('external_id','X1','low_ask',50),
  jsonb_build_object('external_id','X2','low_ask',80),
  jsonb_build_object('external_id','X4','low_ask',99),   -- no matching badge → no update
  jsonb_build_object('low_ask', 10),                     -- null external_id → skipped
  jsonb_build_object('external_id','X5')                 -- null low_ask → skipped
))::text, '1', 'only X1 actually changes (NULL -> 50); the equal, no-match, and null-field rows are not counted');

SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE external_id='X1' AND collection_id=:ad::uuid),
  '50', 'X1 low_ask written from the payload');
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE external_id='X2'),
  '80', 'X2 already at the incoming value is left as-is (IS DISTINCT FROM guard)');
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE external_id='X3'),
  '5', 'X3 with no incoming row keeps its value');
SELECT _assert(
  (SELECT low_ask FROM public.badge_editions WHERE external_id='X1' AND collection_id=:ts::uuid) IS NULL,
  'the same external_id in a different collection is never touched (scoping)');

SELECT '✓ update_badge_low_ask_by_external invariants pass' AS result;
ROLLBACK;
