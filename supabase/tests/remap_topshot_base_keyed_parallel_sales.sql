-- DB invariant: public.remap_topshot_base_keyed_parallel_sales() → integer — the
-- INVERSE of the parallel→base correction: moves a sale sitting on a BASE edition
-- whose moment is a known PARALLEL (subedition_id > 0) onto the matching parallel
-- edition (<base>::<sub>). Pins: it fires only for base-keyed sales (current
-- external_id has no '::'), only for real parallels (subedition_id > 0, never a
-- subedition_id=0 base), only when the target parallel edition EXISTS, and only
-- when the feeder base matches the current edition, and (2026-11-26) only for mappings resolved in the
-- last 7 days (older ones are filed at write time or by topshot_parallel_sales_followup). A regression mis-keys parallel
-- sales and corrupts both editions' FMV.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261126174004_audit_20261126_remap_base_keyed_parallel_sales_scoped_to_recent_resolutions.sql);
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
  base_external_id text,
  resolved_at      timestamptz DEFAULT now()
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
    -- 2026-11-26: only mappings the chain answered in the last 7 days. A sale written after its
    -- mapping is filed on the parallel at write time (#251); one written before it is moved once the
    -- mapping resolves. The full-history join timed out (120 s) on 11-26 after 0 moves for days.
    AND ms.resolved_at > now() - interval '7 days'
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

-- S6: parallel 5, but its mapping resolved 8 days ago -> outside the window, kept on base.
INSERT INTO sales (collection_id, nft_id, edition_id, serial_number) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n6', '00000000-0000-0000-0000-0000000000b1', 15);
INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id, resolved_at) VALUES
  ('n6', 5, 'setA:playA', now() - interval '8 days');

-- Run: exactly S1 + S4 remapped onto their parallel editions.
SELECT _assert_eq(remap_topshot_base_keyed_parallel_sales()::text, '2', 'exactly 2 base-keyed parallel sales remapped');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n1'), '00000000-0000-0000-0000-00000000e005', 'S1 subedition 5 → ::5 parallel edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n4'), '00000000-0000-0000-0000-00000000e009', 'S4 subedition 9 → ::9 parallel edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n2'), '00000000-0000-0000-0000-0000000000b1', 'S2 subedition 0 (base) → kept on base');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n3'), '00000000-0000-0000-0000-00000000e005', 'S3 already on a parallel → not touched');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n5'), '00000000-0000-0000-0000-0000000000b1', 'S5 subedition 7 but no ::7 edition exists → kept on base');

SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE nft_id='n6'), '00000000-0000-0000-0000-0000000000b1', 'S6 mapping resolved 8 days ago -> outside the window, kept on base');

SELECT '✓ remap_topshot_base_keyed_parallel_sales invariants pass' AS result;
ROLLBACK;
