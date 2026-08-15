-- DB invariant: public.remap_topshot_from_onchain_map() → jsonb
-- — re-keys BOTH `sales` and `moments` onto the edition the on-chain map says the
-- moment belongs to. Part of the TopShot parallel-conflation family; every
-- edition-keyed FMV is derived from the rows it rewrites.
--
-- The two halves are deliberately ASYMMETRIC, and pinning that asymmetry is the
-- point of this file:
--
--   1. SALES are re-keyed unconditionally — there is no uniqueness to protect.
--   2. MOMENTS are re-keyed FREE-SLOT ONLY. _mv_free drops any row whose target
--      (edition_id, serial_number) is already held by a DIFFERENT moment. Those
--      rows are neither forced nor silently discarded: they are reported as
--      `moments_deferred_conflict`. A regression that forced them would corrupt
--      moment identity; one that dropped them silently would make the return
--      value lie about what was left undone.
--   3. ⚠ `o.id <> mv.moment_pk` is DEFENSIVE AND CURRENTLY REDUNDANT, and this
--      file deliberately does NOT assert it. _mv only admits rows whose
--      (edition_id, serial_number) already differs from the target, so a
--      candidate can never be sitting in its own target slot and can never be its
--      own conflict. Mutation-checked: removing the clause changes nothing today.
--      It is not dead code — it becomes load-bearing the moment anyone widens
--      _mv to admit unchanged rows (e.g. to audit no-ops), at which point every
--      candidate would block itself, the moments half would silently become a
--      no-op, and the function would still report success. Contriving a fixture
--      to "cover" it would assert a state the function cannot reach; the honest
--      record is this note plus the coupling it names.
--   4. PARALLEL WINS OVER BASE, same COALESCE(epar, ebase) precedence as the wmc
--      sibling.
--   5. Unresolvable targets are COUNTED (`unresolved_targets`), never guessed.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260815163000_audit_20260815_snapshot_remap_topshot_from_onchain_map.sql);
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
  id            bigint,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  serial_number integer
);

CREATE TABLE moments (
  id            bigint,
  collection_id uuid,
  nft_id        text,
  edition_id    uuid,
  serial_number integer,
  updated_at    timestamptz
);

CREATE TABLE topshot_misattrib_onchain_map (
  nft_id          text,
  set_id_onchain  integer,
  play_id_onchain integer,
  serial_number   integer
);

CREATE TABLE topshot_moment_subeditions (
  nft_id        text,
  subedition_id integer
);

CREATE TABLE audit_topshot_sale_drain_remap_20260621 (
  sale_id        bigint,
  nft_id         text,
  old_edition_id uuid,
  old_serial     integer,
  new_edition_id uuid,
  new_serial     integer
);

CREATE TABLE audit_topshot_moment_drain_remap_20260621 (
  moment_pk      bigint,
  nft_id         text,
  old_edition_id uuid,
  old_serial     integer,
  new_edition_id uuid,
  new_serial     integer,
  action         text
);

-- >>> BEGIN verbatim remap_topshot_from_onchain_map (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_from_onchain_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sales int := 0;
  v_moments int := 0;
  v_mv_total int := 0;
  v_unresolved int := 0;
BEGIN
  -- Authoritative target edition per mapped nft: prefer ::subID parallel edition, else base.
  DROP TABLE IF EXISTS _tgt;
  CREATE TEMP TABLE _tgt ON COMMIT DROP AS
  SELECT m.nft_id,
         m.serial_number AS new_serial,
         COALESCE(epar.id, ebase.id) AS new_edition_id
  FROM topshot_misattrib_onchain_map m
  LEFT JOIN topshot_moment_subeditions sub
         ON sub.nft_id = m.nft_id AND COALESCE(sub.subedition_id,0) > 0
  LEFT JOIN editions ebase
         ON ebase.collection_id = v_ts
        AND ebase.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text)
  LEFT JOIN editions epar
         ON sub.subedition_id IS NOT NULL AND epar.collection_id = v_ts
        AND epar.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text || '::' || sub.subedition_id::text);

  SELECT count(*) INTO v_unresolved FROM _tgt WHERE new_edition_id IS NULL;

  -- ── SALES re-key (primary) ──
  INSERT INTO audit_topshot_sale_drain_remap_20260621 (sale_id,nft_id,old_edition_id,old_serial,new_edition_id,new_serial)
  SELECT s.id, s.nft_id, s.edition_id, s.serial_number, t.new_edition_id, t.new_serial
  FROM sales s JOIN _tgt t ON t.nft_id = s.nft_id
  WHERE s.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial);

  UPDATE sales s
  SET edition_id = t.new_edition_id,
      serial_number = COALESCE(t.new_serial, s.serial_number)
  FROM _tgt t
  WHERE s.nft_id = t.nft_id AND s.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (s.edition_id <> t.new_edition_id OR s.serial_number IS DISTINCT FROM t.new_serial);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- ── MOMENTS re-key (safe, free-slot only) ──
  DROP TABLE IF EXISTS _mv;
  CREATE TEMP TABLE _mv ON COMMIT DROP AS
  SELECT m.id AS moment_pk, m.nft_id, m.edition_id AS old_ed, m.serial_number AS old_ser,
         t.new_edition_id AS new_ed, COALESCE(t.new_serial, m.serial_number) AS new_ser
  FROM moments m JOIN _tgt t ON t.nft_id = m.nft_id
  WHERE m.collection_id = v_ts AND t.new_edition_id IS NOT NULL
    AND (m.edition_id <> t.new_edition_id OR m.serial_number IS DISTINCT FROM COALESCE(t.new_serial, m.serial_number));
  SELECT count(*) INTO v_mv_total FROM _mv;

  DROP TABLE IF EXISTS _mv_free;
  CREATE TEMP TABLE _mv_free ON COMMIT DROP AS
  SELECT mv.* FROM _mv mv
  WHERE NOT EXISTS (
    SELECT 1 FROM moments o
    WHERE o.collection_id = v_ts AND o.edition_id = mv.new_ed AND o.serial_number = mv.new_ser AND o.id <> mv.moment_pk
  );

  INSERT INTO audit_topshot_moment_drain_remap_20260621 (moment_pk,nft_id,old_edition_id,old_serial,new_edition_id,new_serial,action)
  SELECT moment_pk,nft_id,old_ed,old_ser,new_ed,new_ser,'update' FROM _mv_free;

  UPDATE moments m
  SET edition_id = f.new_ed, serial_number = f.new_ser, updated_at = now()
  FROM _mv_free f WHERE m.id = f.moment_pk;
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  RETURN jsonb_build_object(
    'sales_rekeyed', v_sales,
    'moments_rekeyed', v_moments,
    'moments_deferred_conflict', v_mv_total - v_moments,
    'unresolved_targets', v_unresolved,
    'map_size', (SELECT count(*) FROM topshot_misattrib_onchain_map)
  );
END $function$;
-- <<< END verbatim remap_topshot_from_onchain_map <<<

-- ── Fixture ────────────────────────────────────────────────────────────────
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000e0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1000'),  -- wrong home
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),  -- base target
  ('00000000-0000-0000-0000-0000000000a5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::5');-- parallel target

INSERT INTO topshot_misattrib_onchain_map (nft_id, set_id_onchain, play_id_onchain, serial_number) VALUES
  ('n-par',    48, 1652, 501),   -- subedition 5 → PARALLEL
  ('n-base',   48, 1652, 502),   -- no subedition → base
  ('n-clash',  48, 1652, 600),   -- moment target slot already taken → deferred
  ('n-unres',  48, 7777, 503);   -- no such edition → unresolved

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id) VALUES ('n-par', 5);

INSERT INTO sales (id, collection_id, nft_id, edition_id, serial_number) VALUES
  (1, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-par',   '00000000-0000-0000-0000-0000000000e0', 1),
  (2, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-base',  '00000000-0000-0000-0000-0000000000e0', 2),
  (3, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-unres', '00000000-0000-0000-0000-0000000000e0', 3),
  -- Already correct on both edition and serial → excluded by the change predicate.
  (4, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-clash', '00000000-0000-0000-0000-0000000000b1', 600),
  -- Other collection → untouched.
  (5, '06248cc4-b85f-47cd-af67-1855d14acd75', 'n-par',   '00000000-0000-0000-0000-0000000000e0', 9);

INSERT INTO moments (id, collection_id, nft_id, edition_id, serial_number, updated_at) VALUES
  (10, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-par',  '00000000-0000-0000-0000-0000000000e0', 1, NULL),
  (11, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-base', '00000000-0000-0000-0000-0000000000e0', 2, NULL),
  -- n-clash wants (b1, 600) but moment 13 already occupies that slot → DEFERRED.
  (12, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-clash','00000000-0000-0000-0000-0000000000e0', 5, NULL),
  (13, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-other','00000000-0000-0000-0000-0000000000b1', 600, NULL);

-- ── Run ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _res AS SELECT remap_topshot_from_onchain_map() AS j;

-- Only n-par and n-base move. Sale 4 (n-clash) ALREADY sits on the map's target
-- edition AND serial, so the `edition_id <> new OR serial IS DISTINCT FROM new`
-- predicate excludes it — a re-key that rewrote it would be a pointless write and
-- a spurious audit row. Sale 3 is unresolvable; sale 5 is another collection.
SELECT _assert_eq((SELECT (j->>'sales_rekeyed') FROM _res), '2', 'sales: only rows whose edition OR serial actually changes are re-keyed');
SELECT _assert_eq((SELECT (j->>'moments_rekeyed') FROM _res), '2', 'moments: only the two FREE-slot rows moved');
SELECT _assert_eq((SELECT (j->>'moments_deferred_conflict') FROM _res), '1', 'the occupied-slot moment is DEFERRED and reported, not forced and not silently dropped');
SELECT _assert_eq((SELECT (j->>'unresolved_targets') FROM _res), '1', 'unresolvable target counted, never guessed');

-- Parallel precedence.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=1), '00000000-0000-0000-0000-0000000000a5', 'sale on a subedition moment keys to the PARALLEL edition');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=2), '00000000-0000-0000-0000-0000000000b1', 'sale with no subedition keys to the base');
SELECT _assert_eq((SELECT serial_number::text FROM sales WHERE id=1), '501', 'sale serial taken from the map');

-- Unresolved / other-collection rows untouched.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=3), '00000000-0000-0000-0000-0000000000e0', 'unresolvable sale left alone');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=5), '00000000-0000-0000-0000-0000000000e0', 'other-collection sale untouched');

-- The deferred moment keeps its ORIGINAL identity; the occupant is undisturbed.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE id=12), '00000000-0000-0000-0000-0000000000e0', 'deferred moment keeps its old edition — a forced move would corrupt moment identity');
SELECT _assert_eq((SELECT serial_number::text FROM moments WHERE id=12), '5', 'deferred moment keeps its old serial');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE id=13), '00000000-0000-0000-0000-0000000000b1', 'the slot occupant is never disturbed');

-- Free-slot moments moved, and stamped.
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE id=10), '00000000-0000-0000-0000-0000000000a5', 'free-slot moment moved to the parallel');
SELECT _assert((SELECT updated_at IS NOT NULL FROM moments WHERE id=10), 'moved moment is stamped updated_at');
SELECT _assert((SELECT updated_at IS NULL FROM moments WHERE id=12), 'deferred moment is NOT stamped (no write happened)');

-- Audit tables mirror the writes — they are the revert paths.
SELECT _assert_eq((SELECT count(*)::text FROM audit_topshot_sale_drain_remap_20260621), '2', 'one sale-audit row per re-keyed sale, and none for the already-correct row');
SELECT _assert_eq((SELECT count(*)::text FROM audit_topshot_moment_drain_remap_20260621), '2', 'moment-audit records only the rows actually moved, not the deferred one');
SELECT _assert_eq((SELECT old_edition_id::text FROM audit_topshot_sale_drain_remap_20260621 WHERE sale_id=1), '00000000-0000-0000-0000-0000000000e0', 'sale audit stores the PRE-remap edition (the revert value)');

SELECT '✓ remap_topshot_from_onchain_map invariants pass' AS result;
ROLLBACK;
