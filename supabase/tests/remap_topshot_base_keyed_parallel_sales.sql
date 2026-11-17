-- DB invariant: public.remap_topshot_base_keyed_parallel_sales() → integer — the
-- INVERSE of the parallel→base correction: moves a sale sitting on a BASE edition
-- whose moment is a known PARALLEL (subedition_id > 0) onto the matching parallel
-- edition (<base>::<sub>). Pins: it fires only for base-keyed sales (current
-- external_id has no '::'), only for real parallels (subedition_id > 0, never a
-- subedition_id=0 base), only when the target parallel edition EXISTS, and only
-- when the feeder base matches the current edition. A regression mis-keys parallel
-- sales and corrupts both editions' FMV.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802205000_audit_20260802_snapshot_remap_topshot_base_keyed_parallel_sales.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE sales (
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

-- >>> BEGIN verbatim remap_topshot_base_keyed_parallel_sales (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_base_keyed_parallel_sales()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
DECLARE n integer;
BEGIN
  UPDATE sales s
  SET edition_id = te.id
  FROM topshot_moment_subeditions ms,
       editions be,
       editions te
  WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND ms.nft_id = s.nft_id
    AND ms.subedition_id > 0
    AND be.id = s.edition_id
    AND be.external_id NOT LIKE '%::%'
    AND be.external_id = ms.base_external_id
    AND te.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND te.external_id = be.external_id || '::' || ms.subedition_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$function$;
-- <<< END verbatim remap_topshot_base_keyed_parallel_sales <<<

-- BE base + two parallels (::5, ::9). No ::7 edition exists (tests target-exists).
-- A synthetic ::0 edition exists so the subedition_id > 0 guard is LOAD-BEARING:
-- without it, S2 (subedition 0) would mis-remap onto ::0. (The
-- external_id NOT LIKE '%::%' guard is defense-in-depth — it is redundant with the
-- be.external_id = ms.base_external_id feeder match, since a parallel edition's
-- external_id can never equal a moment's base_external_id.)
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA'),
  ('00000000-0000-0000-0000-00000000e000', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA::0'),
  ('00000000-0000-0000-0000-00000000e005', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA::5'),
  ('00000000-0000-0000-0000-00000000e009', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'setA:playA::9');

-- Sales currently keyed on the BASE edition (except S3 which is already on a parallel).
INSERT INTO sales (collection_id, nft_id, edition_id, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n1', '00000000-0000-0000-0000-0000000000b1', 10),  -- S1: parallel 5 → remap to ::5
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n2', '00000000-0000-0000-0000-0000000000b1', 11),  -- S2: subedition 0 → keep on base
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n3', '00000000-0000-0000-0000-00000000e005', 12),  -- S3: already on parallel → keep
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n4', '00000000-0000-0000-0000-0000000000b1', 13),  -- S4: parallel 9 → remap to ::9
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n5', '00000000-0000-0000-0000-0000000000b1', 14);  -- S5: parallel 7 but no ::7 edition → keep

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('n1', 5, 'setA:playA'),
  ('n2', 0, 'setA:playA'),
  ('n3', 5, 'setA:playA'),
  ('n4', 9, 'setA:playA'),
  ('n5', 7, 'setA:playA');

-- Run: exactly S1 + S4 remapped onto their parallel editions.
SELECT _assert_eq(remap_topshot_base_keyed_parallel_sales()::text, '2', 'exactly 2 base-keyed parallel sales remapped');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n1'), '00000000-0000-0000-0000-00000000e005', 'S1 subedition 5 → ::5 parallel edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n4'), '00000000-0000-0000-0000-00000000e009', 'S4 subedition 9 → ::9 parallel edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n2'), '00000000-0000-0000-0000-0000000000b1', 'S2 subedition 0 (base) → kept on base');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n3'), '00000000-0000-0000-0000-00000000e005', 'S3 already on a parallel → not touched');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n5'), '00000000-0000-0000-0000-0000000000b1', 'S5 subedition 7 but no ::7 edition exists → kept on base');

SELECT '✓ remap_topshot_base_keyed_parallel_sales invariants pass' AS result;
ROLLBACK;
