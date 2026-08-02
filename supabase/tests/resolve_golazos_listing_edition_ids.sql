-- DB invariant: public.resolve_golazos_listing_edition_ids() → integer — the
-- Golazos listing edition-id self-heal. Pins the unambiguous-only guard
-- (n_editions = 1): it back-fills a listing's edition_id ONLY when the flow_id
-- resolves to exactly one distinct edition across sales; an ambiguous (>1 edition)
-- or absent match stays NULL (never guessed), an already-set edition_id is left
-- alone, and only the Golazos collection is touched.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802191500_audit_20260802_snapshot_resolve_golazos_listing_edition_ids.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE cached_listings_v2 (
  listing_resource_id text PRIMARY KEY,
  flow_id             bigint,
  collection_id       uuid,
  edition_id          uuid
);

CREATE TABLE sales (
  collection_id uuid,
  nft_id        text,
  edition_id    uuid
);

-- >>> BEGIN verbatim resolve_golazos_listing_edition_ids (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_golazos_listing_edition_ids()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_coll uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  v_resolved int := 0;
BEGIN
  WITH bridge AS (
    SELECT l.listing_resource_id, b.edition_id, b.n_editions
    FROM public.cached_listings_v2 l
    CROSS JOIN LATERAL (
      SELECT (array_agg(DISTINCT sa.edition_id))[1] AS edition_id,
             count(DISTINCT sa.edition_id)          AS n_editions
      FROM public.sales sa
      WHERE sa.collection_id = v_coll
        AND sa.nft_id = l.flow_id::text
        AND sa.edition_id IS NOT NULL
    ) b
    WHERE l.collection_id = v_coll
      AND l.edition_id IS NULL
  ),
  upd AS (
    UPDATE public.cached_listings_v2 l
       SET edition_id = b.edition_id
      FROM bridge b
     WHERE l.listing_resource_id = b.listing_resource_id
       AND l.collection_id = v_coll
       AND l.edition_id IS NULL
       AND b.n_editions = 1
       AND b.edition_id IS NOT NULL
    RETURNING 1
  )
  SELECT count(*) INTO v_resolved FROM upd;

  RETURN v_resolved;
END;
$function$;
-- <<< END verbatim resolve_golazos_listing_edition_ids <<<

-- L1: Golazos, unresolved, one distinct edition across sales → RESOLVE.
-- L2: Golazos, unresolved, TWO distinct editions → ambiguous, leave NULL.
-- L3: Golazos, unresolved, no matching sales → leave NULL.
-- L4: Golazos, already resolved → leave as-is (edition_id NOT NULL filter).
-- L5: different collection (Top Shot), unresolved, has sales → not touched.
INSERT INTO cached_listings_v2 (listing_resource_id, flow_id, collection_id, edition_id) VALUES
  ('L1', 111, '06248cc4-b85f-47cd-af67-1855d14acd75', NULL),
  ('L2', 222, '06248cc4-b85f-47cd-af67-1855d14acd75', NULL),
  ('L3', 333, '06248cc4-b85f-47cd-af67-1855d14acd75', NULL),
  ('L4', 444, '06248cc4-b85f-47cd-af67-1855d14acd75', '00000000-0000-0000-0000-0000000000e4'),
  ('L5', 555, '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL);

INSERT INTO sales (collection_id, nft_id, edition_id) VALUES
  ('06248cc4-b85f-47cd-af67-1855d14acd75', '111', '00000000-0000-0000-0000-0000000000e1'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', '111', '00000000-0000-0000-0000-0000000000e1'),  -- same edition twice → still 1 distinct
  ('06248cc4-b85f-47cd-af67-1855d14acd75', '222', '00000000-0000-0000-0000-0000000000e2'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', '222', '00000000-0000-0000-0000-0000000000e3'),  -- two distinct → ambiguous
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '555', '00000000-0000-0000-0000-0000000000e5');

SELECT _assert_eq(resolve_golazos_listing_edition_ids()::text, '1', 'exactly one listing resolved (only the unambiguous L1)');
SELECT _assert_eq((SELECT edition_id::text FROM cached_listings_v2 WHERE listing_resource_id='L1'), '00000000-0000-0000-0000-0000000000e1', 'L1 resolved to its single edition');
SELECT _assert(( (SELECT edition_id FROM cached_listings_v2 WHERE listing_resource_id='L2') IS NULL ), 'L2 ambiguous (2 editions) → left NULL');
SELECT _assert(( (SELECT edition_id FROM cached_listings_v2 WHERE listing_resource_id='L3') IS NULL ), 'L3 no sales → left NULL');
SELECT _assert_eq((SELECT edition_id::text FROM cached_listings_v2 WHERE listing_resource_id='L4'), '00000000-0000-0000-0000-0000000000e4', 'L4 already-resolved → unchanged');
SELECT _assert(( (SELECT edition_id FROM cached_listings_v2 WHERE listing_resource_id='L5') IS NULL ), 'L5 non-Golazos collection → not touched');

SELECT '✓ resolve_golazos_listing_edition_ids invariants pass' AS result;
ROLLBACK;
