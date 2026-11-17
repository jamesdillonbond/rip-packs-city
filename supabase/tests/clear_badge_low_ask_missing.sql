-- DB invariant: public.clear_badge_low_ask_missing — the stale-ask reaper for
-- badge_editions. After a low_ask refresh writes fresh floors for every edition
-- currently listed, this clears (sets low_ask = NULL) any badge_edition in the
-- SAME collection that was NOT in the just-seen `present` set, so a delisted
-- edition stops showing a stale floor. Getting the WHERE wrong either wipes live
-- asks (if it clears rows that ARE present) or leaves stale asks on delisted
-- editions (if it fails to clear the missing ones); it must also stay scoped to
-- the passed collection and count only rows it actually changed.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260427070000_badge_low_ask_clear_missing.sql), and was
-- verified byte-identical to the live prod definition via pg_get_functiondef on
-- 2026-07-31. __tests__/db-invariants-drift-guard.test.ts fails CI if the copy
-- drifts from the migration.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.badge_editions (
  external_id   text,
  collection_id uuid,
  low_ask       numeric,
  updated_at    timestamptz
);

-- >>> BEGIN verbatim clear_badge_low_ask_missing (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.clear_badge_low_ask_missing(
  p_collection_id uuid,
  p_present_external_ids text[]
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rows_affected integer;
BEGIN
  WITH upd AS (
    UPDATE badge_editions be
    SET
      low_ask = NULL,
      updated_at = now()
    WHERE be.collection_id = p_collection_id
      AND be.low_ask IS NOT NULL
      AND NOT (be.external_id = ANY(p_present_external_ids))
    RETURNING 1
  )
  SELECT COUNT(*) INTO rows_affected FROM upd;
  RETURN rows_affected;
END;
$$;
-- <<< END verbatim clear_badge_low_ask_missing <<<

\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''

INSERT INTO public.badge_editions (external_id, collection_id, low_ask) VALUES
  ('present1',  :ts::uuid, 10.0),   -- in the present set → keep
  ('missing1',  :ts::uuid, 20.0),   -- listed floor but NOT present → clear
  ('missing2',  :ts::uuid, 30.0),   -- listed floor but NOT present → clear
  ('already',   :ts::uuid, NULL),   -- already NULL + not present → not counted, stays NULL
  ('other_ad', :ad::uuid, 99.0);   -- different collection + not present → untouched (scoping)

-- Reap TS-collection asks not in the present set {present1}.
SELECT _assert_eq(
  public.clear_badge_low_ask_missing(:ts::uuid, ARRAY['present1'])::text, '2',
  'returns the count of rows ACTUALLY cleared (missing1 + missing2), not every missing row');

-- present1 keeps its floor …
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE external_id='present1'), '10.0',
  'an edition IN the present set keeps its low_ask');
-- … the two missing floors are cleared …
SELECT _assert_eq((SELECT count(*)::text FROM public.badge_editions
  WHERE collection_id = :ts::uuid AND external_id IN ('missing1','missing2') AND low_ask IS NOT NULL), '0',
  'delisted editions (not in the present set) have low_ask cleared');
-- … the already-null missing row is untouched (and was not double-counted above) …
SELECT _assert_eq((SELECT count(*)::text FROM public.badge_editions
  WHERE external_id='already' AND low_ask IS NULL), '1',
  'an already-NULL low_ask stays NULL and is not counted (low_ask IS NOT NULL guard)');
-- … and the OTHER collection is never touched, even though it is missing too.
SELECT _assert_eq((SELECT low_ask::text FROM public.badge_editions WHERE external_id='other_ad'), '99.0',
  'a different collection is out of scope — never cleared even when absent from the present set');

-- Idempotency: a second reap with the same present set clears nothing new.
SELECT _assert_eq(
  public.clear_badge_low_ask_missing(:ts::uuid, ARRAY['present1'])::text, '0',
  'a second reap finds nothing left to clear (idempotent)');

SELECT '✓ clear_badge_low_ask_missing invariants pass' AS result;
ROLLBACK;
