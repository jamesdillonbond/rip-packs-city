-- DB invariant: public.remap_topshot_parallel_to_base_misattributed() → integer
-- — the TopShot parallel→base sales-attribution correction. Pins the exact remap
-- conditions: a sale on a PARALLEL edition ('<base>::<sub>') moves to its BASE
-- edition when (a) the moment is a known base (subedition_id=0) OR (b) it is NOT a
-- known parallel AND its serial overflows the parallel's circulation while fitting
-- the base's. A legitimate parallel sale, a serial that fits the parallel, or a
-- base that can't cover the serial are all LEFT ALONE. The moments feeder is
-- remapped the same way but SKIPS a collision with an existing base (edition,serial).
-- A regression mis-keys sales and corrupts every edition-keyed FMV derived from them.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802204500_audit_20260802_snapshot_remap_topshot_parallel_to_base_misattributed.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id                uuid PRIMARY KEY,
  collection_id     uuid,
  external_id       text,
  circulation_count integer
);

CREATE TABLE sales (
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  serial_number integer
);

CREATE TABLE moments (
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  serial_number integer
);

CREATE TABLE topshot_moment_subeditions (
  nft_id           text,
  subedition_id    integer,
  base_external_id text
);

-- >>> BEGIN verbatim remap_topshot_parallel_to_base_misattributed (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_parallel_to_base_misattributed()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  ts_id constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  n_sales integer;
BEGIN
  -- 1. Sales (correctness path).
  UPDATE sales s
  SET edition_id = be.id
  FROM editions pe, editions be
  WHERE s.collection_id = ts_id
    AND pe.id = s.edition_id
    AND pe.external_id LIKE '%::%'
    AND be.collection_id = ts_id
    AND be.external_id = split_part(pe.external_id, '::', 1)
    AND (
      EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
              WHERE ms.nft_id = s.nft_id AND ms.subedition_id = 0)
      OR (
        NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
                    WHERE ms.nft_id = s.nft_id AND ms.subedition_id > 0
                      AND pe.external_id = ms.base_external_id || '::' || ms.subedition_id)
        AND pe.circulation_count > 0
        AND s.serial_number > pe.circulation_count
        AND be.circulation_count >= s.serial_number
      )
    );
  GET DIAGNOSTICS n_sales = ROW_COUNT;

  -- 2. Moments feeder cleanup (best-effort; skip any that would collide with an
  --    existing base (edition_id, serial_number) row).
  UPDATE moments m
  SET edition_id = be.id
  FROM editions pe, editions be
  WHERE m.collection_id = ts_id
    AND pe.id = m.edition_id
    AND pe.external_id LIKE '%::%'
    AND be.collection_id = ts_id
    AND be.external_id = split_part(pe.external_id, '::', 1)
    AND NOT EXISTS (SELECT 1 FROM moments m2
                    WHERE m2.edition_id = be.id AND m2.serial_number = m.serial_number)
    AND (
      EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
              WHERE ms.nft_id = m.nft_id AND ms.subedition_id = 0)
      OR (
        NOT EXISTS (SELECT 1 FROM topshot_moment_subeditions ms
                    WHERE ms.nft_id = m.nft_id AND ms.subedition_id > 0
                      AND pe.external_id = ms.base_external_id || '::' || ms.subedition_id)
        AND pe.circulation_count > 0
        AND m.serial_number > pe.circulation_count
        AND be.circulation_count >= m.serial_number
      )
    );

  RETURN n_sales;
END
$function$;
-- <<< END verbatim remap_topshot_parallel_to_base_misattributed <<<

-- BE = base edition (circ 1000); PE = its '::5' parallel (circ 100).
INSERT INTO editions (id, collection_id, external_id, circulation_count) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA',    1000),
  ('00000000-0000-0000-0000-0000000000f1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA::5', 100);

-- Sales, all currently mis-keyed onto the PARALLEL edition PE.
INSERT INTO sales (collection_id, nft_id, edition_id, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n1', '00000000-0000-0000-0000-0000000000f1', 50),   -- S1: known base → remap
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n2', '00000000-0000-0000-0000-0000000000f1', 500),  -- S2: overflow, base covers → remap
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n3', '00000000-0000-0000-0000-0000000000f1', 30),   -- S3: legit parallel → keep
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n4', '00000000-0000-0000-0000-0000000000f1', 50),   -- S4: fits in parallel → keep
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n5', '00000000-0000-0000-0000-0000000000f1', 1500); -- S5: overflow but base can't cover → keep

-- Subedition feeder: n1 is a known BASE (subedition_id 0); n3 is a legit ::5 parallel.
INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('n1', 0, 'setA:playA'),
  ('n3', 5, 'setA:playA');

-- Moments feeder: M1 known base, no collision → remap; M2 known base but the base
-- already has a moment at serial 60 → collision → SKIP.
INSERT INTO moments (collection_id, nft_id, edition_id, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm1',        '00000000-0000-0000-0000-0000000000f1', 50),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'm2',        '00000000-0000-0000-0000-0000000000f1', 60),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'base-exist','00000000-0000-0000-0000-0000000000b1', 60);
INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('m1', 0, 'setA:playA'),
  ('m2', 0, 'setA:playA');

-- Run: exactly S1 + S2 remapped.
SELECT _assert_eq(remap_topshot_parallel_to_base_misattributed()::text, '2', 'exactly 2 sales remapped (known-base + serial-overflow)');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n1'), '00000000-0000-0000-0000-0000000000b1', 'S1 known-base sale → base edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n2'), '00000000-0000-0000-0000-0000000000b1', 'S2 serial-overflow (base covers) → base edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n3'), '00000000-0000-0000-0000-0000000000f1', 'S3 legitimate parallel → kept on parallel');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n4'), '00000000-0000-0000-0000-0000000000f1', 'S4 serial fits the parallel → kept on parallel');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n5'), '00000000-0000-0000-0000-0000000000f1', 'S5 overflow but base cannot cover serial → kept on parallel');

-- Moments: M1 remapped, M2 skipped (would collide with base serial 60).
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='m1'), '00000000-0000-0000-0000-0000000000b1', 'M1 known base, no collision → base edition');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='m2'), '00000000-0000-0000-0000-0000000000f1', 'M2 known base but base serial 60 exists → collision skip, kept on parallel');

SELECT '✓ remap_topshot_parallel_to_base_misattributed invariants pass' AS result;
ROLLBACK;
