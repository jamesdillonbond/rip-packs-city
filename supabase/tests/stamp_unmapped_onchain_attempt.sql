-- DB invariant: public.stamp_unmapped_onchain_attempt — advances the AllDay
-- resolvers' rotating candidate window and increments the per-row attempt counter
-- in one statement.
--
-- Why it exists at all: PostgREST cannot express a column-referencing update
-- (`onchain_attempts = onchain_attempts + 1`), so the two resolvers previously
-- did a plain `.update({last_onchain_attempt_at})` and there was nowhere to keep
-- a count. Without the count, "attempted 3 times and STILL failing" is
-- inexpressible — `last_onchain_attempt_at` is a single overwritten timestamp
-- that cannot tell a first attempt from a twentieth — which is why the
-- unmapped_resolution_backlog_max trust arm cannot currently separate a genuinely
-- stuck row from a merely queued one.
--
-- THE LOAD-BEARING SEMANTIC IS THE nft_id KEYING, NOT THE COUNTER. One moment can
-- carry several unmapped sale rows, and a single on-chain borrow attempt covers
-- all of them. Stamping only the deduped row would leave its siblings NULL, and
-- since the window orders by `last_onchain_attempt_at NULLS FIRST`, those NULL
-- siblings would re-select the SAME moment on the very next tick — the stuck
-- window this whole mechanism exists to fix. A regression narrowing the match
-- from nft_id to row id restores that bug silently: the resolver still logs
-- ok=true and still reports rows stamped.
--
-- The two scope guards are equally load-bearing in the other direction: the
-- UPDATE must never touch a RESOLVED row (a resolved row's attempt history is
-- finished) and must never cross collections.
--
-- The function DDL below is a VERBATIM copy of the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE unmapped_sales (
  id uuid DEFAULT gen_random_uuid(),
  collection_id uuid,
  nft_id text,
  resolved_at timestamptz,
  last_onchain_attempt_at timestamptz,
  onchain_attempts integer NOT NULL DEFAULT 0);

-- >>> BEGIN verbatim stamp_unmapped_onchain_attempt (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.stamp_unmapped_onchain_attempt(
  p_collection_id uuid,
  p_nft_ids text[],
  p_at timestamptz DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF p_collection_id IS NULL OR p_nft_ids IS NULL OR array_length(p_nft_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE unmapped_sales
     SET last_onchain_attempt_at = COALESCE(p_at, now()),
         onchain_attempts = onchain_attempts + 1
   WHERE collection_id = p_collection_id
     AND resolved_at IS NULL
     AND nft_id = ANY(p_nft_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
-- <<< END verbatim stamp_unmapped_onchain_attempt <<<

-- AllDay + a foreign collection, resolved + unresolved, and one moment (nft "A")
-- deliberately carrying THREE sibling sale rows.
INSERT INTO unmapped_sales (collection_id, nft_id, resolved_at, last_onchain_attempt_at, onchain_attempts) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A', NULL, NULL,                     0),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A', NULL, NULL,                     0),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A', NULL, '2026-07-01T00:00:00Z',   4),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'B', NULL, NULL,                     0),
  -- already resolved: must be left completely alone
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'C', '2026-07-02T00:00:00Z', '2026-07-01T00:00:00Z', 9),
  -- same nft_id, different collection: must not be crossed into
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'A', NULL, NULL,                     0);

-- ── ALL sibling rows of a probed moment move together ───────────────────────────
SELECT _assert_eq(
  stamp_unmapped_onchain_attempt(
    'dee28451-5d62-409e-a1ad-a83f763ac070', ARRAY['A','B'], '2026-08-04T12:00:00Z')::text,
  '4', 'returns the matched row count — 3 sibling rows for nft A plus 1 for B');

SELECT _assert_eq(
  (SELECT string_agg(onchain_attempts::text, ',' ORDER BY onchain_attempts)
     FROM unmapped_sales
    WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND nft_id='A'),
  '1,1,5', 'every sibling row of the probed moment is incremented, from its OWN prior value');

SELECT _assert_eq(
  (SELECT count(*)::text FROM unmapped_sales
    WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND nft_id='A'
      AND last_onchain_attempt_at = '2026-08-04T12:00:00Z'),
  '3', 'no sibling is left with a NULL stamp — that is what re-selected the same moment forever');

-- ── A RESOLVED row is never touched ────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT onchain_attempts::text || '|' || last_onchain_attempt_at::text
     FROM unmapped_sales WHERE nft_id='C'),
  '9|2026-07-01 00:00:00+00', 'a resolved row keeps its attempt history and stamp, untouched');

-- ── Collection scope holds even on an identical nft_id ─────────────────────────
SELECT _assert_eq(
  (SELECT onchain_attempts::text FROM unmapped_sales
    WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND nft_id='A'),
  '0', 'a same-named nft in another collection must never be stamped');

-- ── The counter ACCUMULATES across runs; it is not a boolean ───────────────────
SELECT stamp_unmapped_onchain_attempt(
  'dee28451-5d62-409e-a1ad-a83f763ac070', ARRAY['B'], '2026-08-04T13:00:00Z');
SELECT stamp_unmapped_onchain_attempt(
  'dee28451-5d62-409e-a1ad-a83f763ac070', ARRAY['B'], '2026-08-04T14:00:00Z');
SELECT _assert_eq(
  (SELECT onchain_attempts::text FROM unmapped_sales
    WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND nft_id='B'),
  '3', 'three attempts on the same row read 3 — the whole point of the column');

-- ── A NULL p_at still stamps (COALESCE to now()), never nulls the column out ────
SELECT stamp_unmapped_onchain_attempt(
  'dee28451-5d62-409e-a1ad-a83f763ac070', ARRAY['B'], NULL);
SELECT _assert_eq(
  (SELECT (last_onchain_attempt_at IS NOT NULL)::text FROM unmapped_sales
    WHERE collection_id='dee28451-5d62-409e-a1ad-a83f763ac070' AND nft_id='B'),
  'true', 'a NULL p_at falls back to now(); it must never blank the stamp');

-- ── Degenerate inputs write NOTHING and return 0 ───────────────────────────────
-- An empty batch reaching an unguarded `= ANY('{}')` would be harmless, but a
-- NULL collection_id must not be allowed to broaden the UPDATE.
SELECT _assert_eq(stamp_unmapped_onchain_attempt(NULL, ARRAY['A'], now())::text, '0',
  'a NULL collection_id is refused, never broadened to all collections');
SELECT _assert_eq(stamp_unmapped_onchain_attempt(
  'dee28451-5d62-409e-a1ad-a83f763ac070', NULL, now())::text, '0', 'a NULL id array writes nothing');
SELECT _assert_eq(stamp_unmapped_onchain_attempt(
  'dee28451-5d62-409e-a1ad-a83f763ac070', ARRAY[]::text[], now())::text, '0',
  'an empty id array writes nothing');

-- Those three degenerate calls must not have moved a single counter.
SELECT _assert_eq(
  (SELECT string_agg(onchain_attempts::text, ',' ORDER BY collection_id, nft_id, onchain_attempts)
     FROM unmapped_sales),
  '1,1,5,4,9,0', 'no degenerate call incremented anything anywhere');

SELECT '✓ stamp_unmapped_onchain_attempt invariants pass' AS result;
ROLLBACK;
