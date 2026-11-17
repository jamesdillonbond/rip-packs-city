-- DB invariant: public.remap_topshot_realign_miskeyed_subeditions(integer) → jsonb
-- — realigns rows sitting on the WRONG parallel of the right base (`48:1652::7`
-- when the moment belongs on `::5`), or on a parallel when they belong on the
-- base.
--
-- Distinct from remap_topshot_split_resolved_subeditions, which moves rows OFF
-- the base ONTO a parallel. This one only ever touches rows that already carry a
-- `::N` suffix, and that distinction is enforced by one predicate:
--
--   1. `cur.external_id LIKE x.base || '::%'` — every write requires the row to
--      currently sit on a `::`-suffixed edition OF THE SAME BASE. This is what
--      stops a realign dragging a row across bases. Drop it and the sweep re-keys
--      rows it was never meant to touch, including ones correctly sitting on a
--      base edition.
--   2. subedition_id = 0 resolves to the BASE key (no `::0` suffix), so a row
--      wrongly on a parallel is pulled back to the base.
--   3. Collisions — the target parallel already holds that serial under a
--      DIFFERENT nft — are skipped across ALL THREE tables, so the tables never
--      disagree about one moment.
--   4. All three writes ARE audited here (its sibling omits the moments audit),
--      giving every row a revert path.
--
-- ⚠ `m2.nft_id <> m.nft_id` in the collision CTE is DEFENSIVE AND UNREACHABLE,
-- and is deliberately not asserted. A row only enters _realign when its current
-- key DIFFERS from its correct one, so it can never be sitting at correct_ed_id
-- and can never be its own collision. Mutation-checked: removing it changes
-- nothing. Same shape as the identical clause in the split sibling.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260815164000_audit_20260815_snapshot_remap_topshot_realign_miskeyed_subeditions.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid,
  serial_number integer,
  updated_at    timestamptz
);

CREATE TABLE topshot_moment_subeditions (
  nft_id           text,
  subedition_id    integer,
  base_external_id text
);

CREATE TABLE sales (
  id            bigint,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid
);

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text
);

CREATE TABLE audit_20260705_subedition_realign_remap (
  src         text,
  nft_id      text,
  old_edition text,
  new_edition text,
  row_ref     text
);

-- >>> BEGIN verbatim remap_topshot_realign_miskeyed_subeditions (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_realign_miskeyed_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_moments int := 0; v_sales int := 0; v_wmc int := 0; v_skipped int := 0;
BEGIN
  DROP TABLE IF EXISTS _sub_ed;
  CREATE TEMP TABLE _sub_ed ON COMMIT DROP AS
  SELECT id, external_id, split_part(external_id,'::',1) AS base
  FROM editions WHERE collection_id = v_ts AND external_id ~ '::';

  DROP TABLE IF EXISTS _realign;
  CREATE TEMP TABLE _realign ON COMMIT DROP AS
  SELECT DISTINCT cur.nft_id, cur.base,
         (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
               ELSE sub.base_external_id || '::' || sub.subedition_id END) AS correct_ext,
         tgt.id AS correct_ed_id
  FROM (
    SELECT m.nft_id, se.base, se.external_id AS cur_ext
    FROM moments m JOIN _sub_ed se ON se.id = m.edition_id WHERE m.collection_id = v_ts
    UNION
    SELECT s.nft_id, se.base, se.external_id
    FROM sales s JOIN _sub_ed se ON se.id = s.edition_id WHERE s.collection_id = v_ts
    UNION
    SELECT w.moment_id AS nft_id, split_part(w.edition_key,'::',1) AS base, w.edition_key AS cur_ext
    FROM wallet_moments_cache w WHERE w.collection_id = v_ts AND w.edition_key ~ '::'
  ) cur
  JOIN topshot_moment_subeditions sub
    ON sub.nft_id = cur.nft_id AND sub.subedition_id IS NOT NULL AND sub.base_external_id = cur.base
  JOIN editions tgt
    ON tgt.collection_id = v_ts
   AND tgt.external_id = (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
                               ELSE sub.base_external_id || '::' || sub.subedition_id END)
  WHERE cur.cur_ext <> (CASE WHEN sub.subedition_id = 0 THEN sub.base_external_id
                             ELSE sub.base_external_id || '::' || sub.subedition_id END)
  LIMIT greatest(1, p_limit);

  -- Collision set: mis-keyed moments whose correct edition already holds that
  -- serial under a DIFFERENT nft. These are left in place (flagged, not moved).
  DROP TABLE IF EXISTS _collide;
  CREATE TEMP TABLE _collide ON COMMIT DROP AS
  SELECT DISTINCT x.nft_id
  FROM _realign x
  JOIN moments m ON m.nft_id = x.nft_id AND m.collection_id = v_ts
  JOIN moments m2 ON m2.edition_id = x.correct_ed_id AND m2.serial_number = m.serial_number AND m2.nft_id <> m.nft_id;
  GET DIAGNOSTICS v_skipped = ROW_COUNT;

  -- MOMENTS (clean only)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'moments', m.nft_id, cur.external_id, x.correct_ext, m.nft_id
  FROM moments m
  JOIN _realign x ON x.nft_id = m.nft_id
  JOIN editions cur ON cur.id = m.edition_id
  WHERE m.collection_id = v_ts AND cur.external_id LIKE x.base || '::%' AND m.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = m.nft_id);
  UPDATE moments m SET edition_id = x.correct_ed_id, updated_at = now()
  FROM _realign x, editions cur
  WHERE m.nft_id = x.nft_id AND m.collection_id = v_ts
    AND cur.id = m.edition_id AND cur.external_id LIKE x.base || '::%'
    AND m.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = m.nft_id);
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  -- SALES (clean only — mirror the same nft exclusion for consistency)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'sales', s.nft_id, cur.external_id, x.correct_ext, s.id::text
  FROM sales s
  JOIN _realign x ON x.nft_id = s.nft_id
  JOIN editions cur ON cur.id = s.edition_id
  WHERE s.collection_id = v_ts AND cur.external_id LIKE x.base || '::%' AND s.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = s.nft_id);
  UPDATE sales s SET edition_id = x.correct_ed_id
  FROM _realign x, editions cur
  WHERE s.nft_id = x.nft_id AND s.collection_id = v_ts
    AND cur.id = s.edition_id AND cur.external_id LIKE x.base || '::%'
    AND s.edition_id <> x.correct_ed_id
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = s.nft_id);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- WMC (clean only)
  INSERT INTO audit_20260705_subedition_realign_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'wmc', w.moment_id, w.edition_key, x.correct_ext, w.wallet_address
  FROM wallet_moments_cache w
  JOIN _realign x ON x.nft_id = w.moment_id
  WHERE w.collection_id = v_ts AND w.edition_key LIKE x.base || '::%' AND w.edition_key <> x.correct_ext
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = w.moment_id);
  UPDATE wallet_moments_cache w SET edition_key = x.correct_ext
  FROM _realign x
  WHERE w.moment_id = x.nft_id AND w.collection_id = v_ts
    AND w.edition_key LIKE x.base || '::%' AND w.edition_key <> x.correct_ext
    AND NOT EXISTS (SELECT 1 FROM _collide c WHERE c.nft_id = w.moment_id);
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  RETURN jsonb_build_object('moments_realigned', v_moments, 'sales_realigned', v_sales,
                            'wmc_realigned', v_wmc, 'collisions_skipped', v_skipped);
END
$function$;
-- <<< END verbatim remap_topshot_realign_miskeyed_subeditions <<<

-- ── Fixture ────────────────────────────────────────────────────────────────
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000a5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::5'),
  ('00000000-0000-0000-0000-0000000000a7', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::7'),
  -- A DIFFERENT base with its own parallel, so the same-base confinement is testable.
  ('00000000-0000-0000-0000-0000000000d1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:2000'),
  ('00000000-0000-0000-0000-0000000000d5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:2000::5');

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('a1', 5, '48:1652'),   -- on ::7, belongs on ::5
  ('b1', 0, '48:1652'),   -- on ::5, belongs on the BASE
  ('c1', 5, '48:1652'),   -- on ::7, belongs on ::5 — but the slot is taken
  ('e1', 5, '48:1652'),   -- already on ::5 → nothing to do
  -- ⚠ f1's MOMENT is already correct but its SALE is mis-keyed. It therefore
  -- enters _realign via the sales branch of the UNION while needing no moments
  -- write at all — the only shape that makes the moments `edition_id <> correct`
  -- guard observable. Without it f1's moment is pointlessly rewritten and counted.
  ('f1', 5, '48:1652');

INSERT INTO moments (nft_id, collection_id, edition_id, serial_number, updated_at) VALUES
  ('a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a7', 1, NULL),
  ('b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 2, NULL),
  ('c1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a7', 3, NULL),
  -- The blocker: already holds serial 3 on c1's target parallel.
  ('d1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 3, NULL),
  ('e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 4, NULL),
  ('f1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 8, NULL);

INSERT INTO sales (id, collection_id, nft_id, edition_id) VALUES
  (1, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1', '00000000-0000-0000-0000-0000000000a7'),
  (2, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'c1', '00000000-0000-0000-0000-0000000000a7'),
  -- ⚠ a1 also has a sale parked on ANOTHER base's parallel. The same-base
  -- confinement is the only thing stopping the sweep dragging it to 48:1652::5.
  (3, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1', '00000000-0000-0000-0000-0000000000d5'),
  (4, '06248cc4-b85f-47cd-af67-1855d14acd75', 'a1', '00000000-0000-0000-0000-0000000000a7'),
  (5, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'f1', '00000000-0000-0000-0000-0000000000a7');

INSERT INTO wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('0xaaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a1', '48:1652::7'),
  ('0xbbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'c1', '48:1652::7'),
  ('0xccc', '06248cc4-b85f-47cd-af67-1855d14acd75', 'a1', '48:1652::7'),
  -- ⚠ b1's wmc row is what makes `correct_ext` observable. The moments/sales
  -- writes use correct_ed_id (a uuid); ONLY the wmc write uses the derived KEY
  -- STRING, so a subedition-0 that wrongly produced '48:1652::0' instead of the
  -- bare base would be invisible without a wmc row to land on.
  ('0xddd', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'b1', '48:1652::5');

-- ── Run ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _res AS SELECT remap_topshot_realign_miskeyed_subeditions(8000) AS j;

SELECT _assert_eq((SELECT (j->>'collisions_skipped') FROM _res), '1', 'the blocked realign is detected as a collision');
SELECT _assert_eq((SELECT (j->>'moments_realigned') FROM _res), '2', 'only a1 and b1 move (c1 collides, e1 is already correct)');
SELECT _assert_eq((SELECT (j->>'sales_realigned') FROM _res), '2', 'a1 sale 1 and f1 sale 5 move — sale 3 is on another base, sale 4 another collection, sale 2 collides');
SELECT _assert_eq((SELECT (j->>'wmc_realigned') FROM _res), '2', 'a1 and b1 wmc rows move');
-- f1 enters _realign through its mis-keyed SALE, but its moment is already right:
-- the moments write must skip it rather than count a no-op rewrite.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='f1'), '00000000-0000-0000-0000-0000000000a5', 'f1 moment already correct → untouched');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=5), '00000000-0000-0000-0000-0000000000a5', 'f1 mis-keyed sale IS realigned');
-- subedition_id 0 must produce the BARE base key, never '<base>::0'.
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xddd'), '48:1652', 'subedition 0 yields the bare base key, not a ::0 suffix');

-- 1. Wrong-parallel → right-parallel, and parallel → base.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='a1'), '00000000-0000-0000-0000-0000000000a5', 'a1 realigned ::7 → ::5');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='b1'), '00000000-0000-0000-0000-0000000000b1', 'subedition_id 0 pulls the row back to the BASE, not to a ::0 key');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='e1'), '00000000-0000-0000-0000-0000000000a5', 'a row already on the right parallel is a no-op');

-- 2. THE confinement predicate: a1 sale parked on a DIFFERENT base is untouched.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=3), '00000000-0000-0000-0000-0000000000d5', 'a sale on ANOTHER base is never dragged across bases');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=1), '00000000-0000-0000-0000-0000000000a5', 'the same-base sale IS realigned');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=4), '00000000-0000-0000-0000-0000000000a7', 'other-collection sale untouched');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xccc'), '48:1652::7', 'other-collection wmc row untouched');

-- 3. The collision is skipped in all three tables at once.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='c1'), '00000000-0000-0000-0000-0000000000a7', 'collided moment stays put');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=2), '00000000-0000-0000-0000-0000000000a7', 'collided sale stays put');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xbbb'), '48:1652::7', 'collided wmc row stays put');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='d1'), '00000000-0000-0000-0000-0000000000a5', 'the blocking moment is never disturbed');

-- 4. All three writes are audited.
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260705_subedition_realign_remap WHERE src='moments'), '2', 'moments writes audited');
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260705_subedition_realign_remap WHERE src='sales'), '2', 'sales writes audited');
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260705_subedition_realign_remap WHERE src='wmc'), '2', 'wmc writes audited');
SELECT _assert_eq((SELECT old_edition FROM audit_20260705_subedition_realign_remap WHERE src='wmc' AND nft_id='a1'), '48:1652::7', 'audit records the pre-realign key (the revert value)');

SELECT '✓ remap_topshot_realign_miskeyed_subeditions invariants pass' AS result;
ROLLBACK;
