-- DB invariant: public.remap_pack_pool_uuid_key(text, text) → integer
-- — the pack_drop_pool half of the TopShot parallel-conflation program, and the
-- only remapper in that family that DELETES rows.
--
-- editions stores the same TopShot moment under two key conventions (int
-- 'setID:playID' and a UUID pair). Pool rows written under the UUID key must be
-- re-pointed at the canonical int-keyed edition. This pins the four properties a
-- regression would quietly break:
--
--   1. The int-key gate. p_int_key must match '^[0-9]+:[0-9]+$' or the function
--      returns 0 and writes NOTHING — it refuses to remap onto a UUID-keyed
--      target, which is what keeps the two conventions from collapsing.
--   2. Unseedable target → 0. If the canonical edition does not exist and
--      seed_topshot_editions cannot create it, the pool is left alone rather
--      than re-pointed at nothing.
--   3. UPDATE re-points only where the canonical is NOT already in that
--      (dist_id, slot_name).
--   4. DELETE removes exactly the rows the UPDATE skipped — the ones whose
--      canonical twin already exists. The `EXISTS` clause is what confines it to
--      genuine duplicates; drop it and the statement deletes live pool rows,
--      and drop_weight is the denominator of every pack-EV surface.
--
-- The return value is updated + deleted, so a caller that logs it cannot tell the
-- two apart — which is precisely why the row-level assertions below matter.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260815160000_audit_20260815_snapshot_remap_pack_pool_uuid_key.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE pack_drop_pool (
  collection_id   uuid,
  dist_id         text,
  slot_name       text,
  edition_id      uuid,
  edition_flow_id text,
  drop_weight     numeric
);

-- Stub of the seeder the function calls when the canonical edition is absent.
-- Starts as a NO-OP so the "cannot seed → return 0" path is reachable; replaced
-- further down with an inserting version to exercise the seed-then-remap path.
CREATE OR REPLACE FUNCTION public.seed_topshot_editions(p_keys text[]) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;

-- >>> BEGIN verbatim remap_pack_pool_uuid_key (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_pack_pool_uuid_key(p_uuid_key text, p_int_key text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_canon uuid;
  v_updated int := 0;
  v_deleted int := 0;
BEGIN
  IF p_int_key !~ '^[0-9]+:[0-9]+$' THEN RETURN 0; END IF;

  SELECT id INTO v_canon FROM editions
  WHERE collection_id = v_ts AND external_id = p_int_key LIMIT 1;

  IF v_canon IS NULL THEN
    PERFORM public.seed_topshot_editions(ARRAY[p_int_key]);
    SELECT id INTO v_canon FROM editions
    WHERE collection_id = v_ts AND external_id = p_int_key LIMIT 1;
  END IF;
  IF v_canon IS NULL THEN RETURN 0; END IF;

  UPDATE pack_drop_pool pp
  SET edition_id = v_canon, edition_flow_id = p_int_key
  WHERE pp.collection_id = v_ts
    AND pp.edition_flow_id = p_uuid_key
    AND pp.edition_id <> v_canon
    AND NOT EXISTS (
      SELECT 1 FROM pack_drop_pool x
      WHERE x.collection_id = pp.collection_id AND x.dist_id = pp.dist_id
        AND x.slot_name = pp.slot_name AND x.edition_id = v_canon);
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- collision leftovers (canonical already present in that dist+slot): drop the dupe row
  DELETE FROM pack_drop_pool pp
  WHERE pp.collection_id = v_ts
    AND pp.edition_flow_id = p_uuid_key
    AND pp.edition_id <> v_canon
    AND EXISTS (
      SELECT 1 FROM pack_drop_pool x
      WHERE x.collection_id = pp.collection_id AND x.dist_id = pp.dist_id
        AND x.slot_name = pp.slot_name AND x.edition_id = v_canon);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_updated + v_deleted;
END;
$function$;
-- <<< END verbatim remap_pack_pool_uuid_key <<<

-- ── Fixture ────────────────────────────────────────────────────────────────
-- Canonical int-keyed edition, plus the UUID-keyed edition the pool wrongly cites.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000a1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'uuid-a:uuid-b'),
  -- ⚠ This row is what makes the gate assertion below MEAN something. A
  -- UUID-keyed target that does NOT resolve to an edition returns 0 whether or
  -- not the gate exists — the missing-edition path masks it — so the gate has to
  -- be tested against a target that WOULD otherwise resolve and remap.
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'uuid-x:uuid-y');

-- ── 1. The int-key gate ────────────────────────────────────────────────────
-- A non-int target must return 0 AND leave the pool untouched. 'uuid-x:uuid-y'
-- resolves to edition b1, so without the gate this call re-points the row and
-- returns 1.
INSERT INTO pack_drop_pool (collection_id, dist_id, slot_name, edition_id, edition_flow_id, drop_weight) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd-gate', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 5);

SELECT _assert_eq(remap_pack_pool_uuid_key('uuid-a:uuid-b', 'uuid-x:uuid-y')::text, '0', 'non-int target key → 0 (refuses to collapse the two key conventions)');
SELECT _assert_eq(remap_pack_pool_uuid_key('uuid-a:uuid-b', '')::text, '0', 'empty target key → 0');
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id='d-gate'), '1', 'gate rejection wrote nothing');
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d-gate'), '00000000-0000-0000-0000-0000000000a1', 'gate rejection left edition_id alone');

-- ── 2. Unseedable canonical → 0, pool untouched ────────────────────────────
-- '99:99' has no edition and the stub seeder is a no-op, so the function must
-- decline rather than re-point the pool at nothing.
SELECT _assert_eq(remap_pack_pool_uuid_key('uuid-a:uuid-b', '99:99')::text, '0', 'canonical absent and unseedable → 0');
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d-gate'), '00000000-0000-0000-0000-0000000000a1', 'unseedable path wrote nothing');

DELETE FROM pack_drop_pool WHERE dist_id = 'd-gate';

-- ── 3 + 4. UPDATE re-points; DELETE removes only the collisions ────────────
--   d1/default : UUID-keyed row alone in its slot            → UPDATE (re-point)
--   d2/default : canonical ALREADY present in the same slot  → DELETE (dupe)
--   d3/default : canonical present but in a DIFFERENT slot   → UPDATE (no collision)
--   d4/default : a row on another collection                 → untouched
INSERT INTO pack_drop_pool (collection_id, dist_id, slot_name, edition_id, edition_flow_id, drop_weight) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd1', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 5),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd2', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 7),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd2', 'default', '00000000-0000-0000-0000-0000000000c1', '48:1652',      9),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd3', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 3),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd3', 'other',   '00000000-0000-0000-0000-0000000000c1', '48:1652',      4),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'd4', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 1),
  -- ⚠ d6 is the half-migrated shape, and it is the ONLY row that exercises the
  -- DELETE's `pp.edition_id <> v_canon` guard. It already points at the CANONICAL
  -- edition but still carries the OLD uuid flow id (a re-point whose flow id was
  -- never rewritten). Without that guard the row satisfies its own EXISTS
  -- subquery — it is itself the canonical row in that dist+slot — so the DELETE
  -- removes it, silently dropping a live pool row. Every other guard in the
  -- statement leaves this shape alone, which is why the mutation that removes
  -- this one survived until this row existed.
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd6', 'default', '00000000-0000-0000-0000-0000000000c1', 'uuid-a:uuid-b', 6);

-- 2 re-pointed (d1, d3) + 1 deleted (d2) = 3.
SELECT _assert_eq(remap_pack_pool_uuid_key('uuid-a:uuid-b', '48:1652')::text, '3', 'returns updated + deleted (2 re-pointed + 1 dupe dropped)');

SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d1'), '00000000-0000-0000-0000-0000000000c1', 'd1 re-pointed at the canonical edition');
SELECT _assert_eq((SELECT edition_flow_id FROM pack_drop_pool WHERE dist_id='d1'), '48:1652', 'd1 edition_flow_id rewritten to the int key');
SELECT _assert_eq((SELECT drop_weight::text FROM pack_drop_pool WHERE dist_id='d1'), '5', 'd1 drop_weight preserved by the re-point');

-- The collision case: the UUID row is gone and the canonical SURVIVES. Deleting
-- the canonical instead would silently shrink the pool a pack-EV surface divides by.
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id='d2'), '1', 'd2 collapsed to a single row');
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d2'), '00000000-0000-0000-0000-0000000000c1', 'd2 survivor is the CANONICAL row, not the UUID dupe');
SELECT _assert_eq((SELECT drop_weight::text FROM pack_drop_pool WHERE dist_id='d2'), '9', 'd2 survivor kept the canonical row''s weight');

-- Slot scoping: a canonical in a DIFFERENT slot is not a collision.
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id='d3'), '2', 'd3 kept both rows (different slots are not a collision)');
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d3' AND slot_name='default'), '00000000-0000-0000-0000-0000000000c1', 'd3/default re-pointed rather than deleted');

-- Collection scoping: a Golazos row sharing the flow id is untouched.
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d4'), '00000000-0000-0000-0000-0000000000a1', 'other-collection row untouched');

-- The half-migrated row SURVIVES: `edition_id <> v_canon` is what stops the
-- DELETE matching a row that is its own EXISTS witness.
SELECT _assert_eq((SELECT count(*)::text FROM pack_drop_pool WHERE dist_id='d6'), '1', 'd6 already-canonical row with a stale flow id is NOT deleted');
SELECT _assert_eq((SELECT drop_weight::text FROM pack_drop_pool WHERE dist_id='d6'), '6', 'd6 survived intact');

-- d6 has served its purpose (it proved the DELETE's self-witness guard above).
-- It is dropped here because it still carries the uuid flow id, so it would
-- legitimately be re-pointed by the seed-path call below and make that call's
-- return value 2 — correct behaviour, but it would blur an assertion about
-- seeding into an assertion about d6.
DELETE FROM pack_drop_pool WHERE dist_id = 'd6';

-- ── 5. The seed-then-remap path ────────────────────────────────────────────
-- Replace the stub with one that actually creates the canonical edition, and
-- confirm the function proceeds past the seeding branch instead of returning 0.
CREATE OR REPLACE FUNCTION public.seed_topshot_editions(p_keys text[]) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO editions (id, collection_id, external_id)
  SELECT '00000000-0000-0000-0000-0000000000c2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', k
  FROM unnest(p_keys) AS k
  ON CONFLICT DO NOTHING;
END $$;

INSERT INTO pack_drop_pool (collection_id, dist_id, slot_name, edition_id, edition_flow_id, drop_weight) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'd5', 'default', '00000000-0000-0000-0000-0000000000a1', 'uuid-a:uuid-b', 2);

SELECT _assert_eq(remap_pack_pool_uuid_key('uuid-a:uuid-b', '121:4255')::text, '1', 'seeds the missing canonical, then re-points');
SELECT _assert_eq((SELECT edition_id::text FROM pack_drop_pool WHERE dist_id='d5'), '00000000-0000-0000-0000-0000000000c2', 'd5 re-pointed at the newly seeded edition');

SELECT '✓ remap_pack_pool_uuid_key invariants pass' AS result;
ROLLBACK;
