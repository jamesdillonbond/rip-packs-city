-- DB invariant: public.remap_topshot_split_resolved_subeditions(integer) → jsonb
-- — splits moments off a BASE edition onto their resolved `::N` PARALLEL edition
-- across all three keyed tables (sales, wallet_moments_cache, moments).
--
-- Pins three properties:
--
--   1. THE LIMIT IS BOUND TO ACTIONABLE ROWS. The `AND (EXISTS ... OR EXISTS ...
--      OR EXISTS ...)` clause restricts the candidate set to nfts that are STILL
--      base-keyed somewhere. topshot_moment_subeditions is ~673k rows and ~99%
--      already split, so without this the LIMIT samples an arbitrary slice of
--      already-done work and the drain is structurally blind to its own backlog
--      — it reports success while making no progress. That is the failure this
--      clause was added to fix; this test is what stops it regressing.
--   2. CONFLATION KNOTS ARE SKIPPED ACROSS ALL THREE TABLES. If the target ::N
--      edition already holds that serial under a DIFFERENT nft, the row is left
--      on the base everywhere — sales, wmc AND moments. Skipping it in two of the
--      three would leave the tables disagreeing about the same moment.
--   3. ONLY BASE-KEYED ROWS MOVE. Every write is predicated on the row currently
--      sitting on the base edition, so a re-run is a no-op rather than a second
--      hop, and a row keyed somewhere else entirely is never swept up.
--
-- ⚠ `m2.nft_id <> m.nft_id` in the collision CTE is DEFENSIVE AND CURRENTLY
-- UNREACHABLE, and is deliberately not asserted. m is selected at base_ed_id and
-- m2 at sub_ed_id, and those are different editions by construction, so a moment
-- can never be its own collision. Mutation-checked: removing it changes nothing
-- today. Contriving a fixture would assert a state the query cannot produce.
--
-- ⚠ Asymmetry worth knowing: sales and wmc writes are audited into
-- audit_20260704_subedition_split_remap, but the MOMENTS update is NOT. The
-- moments half has no row-level revert path. Pinned below as an observation, not
-- endorsed — a future change that adds one should update this assertion.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260729030000_audit_20260729_split_resolved_subeditions_limit_binds_on_actionable.sql),
-- which was verified byte-identical to the LIVE prod definition on 2026-08-15;
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
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

CREATE TABLE moments (
  nft_id        text,
  collection_id uuid,
  edition_id    uuid,
  serial_number integer,
  updated_at    timestamptz
);

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text
);

CREATE TABLE audit_20260704_subedition_split_remap (
  src          text,
  nft_id       text,
  old_edition  text,
  new_edition  text,
  row_ref      text
);

-- >>> BEGIN verbatim remap_topshot_split_resolved_subeditions (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_split_resolved_subeditions(p_limit integer DEFAULT 8000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sales int := 0; v_wmc int := 0; v_moments int := 0; v_skipped int := 0;
BEGIN
  DROP TABLE IF EXISTS _split;
  CREATE TEMP TABLE _split ON COMMIT DROP AS
  SELECT sub.nft_id, sub.base_external_id AS base, se.external_id AS sub_ext,
         be.id AS base_ed_id, se.id AS sub_ed_id
  FROM topshot_moment_subeditions sub
  JOIN editions be ON be.collection_id = v_ts AND be.external_id = sub.base_external_id
  JOIN editions se ON se.collection_id = v_ts AND se.external_id = sub.base_external_id || '::' || sub.subedition_id
  WHERE sub.subedition_id > 0 AND sub.base_external_id ~ '^[0-9]+:[0-9]+$'
    -- Bind the LIMIT to rows with real work: still base-keyed somewhere.
    -- Without this the LIMIT samples an arbitrary slice of a 673k-row table that
    -- is ~99% already-split, and the drain is structurally blind to the backlog.
    AND (
      EXISTS (SELECT 1 FROM wallet_moments_cache w
               WHERE w.moment_id::text = sub.nft_id AND w.collection_id = v_ts
                 AND w.edition_key = sub.base_external_id)
      OR EXISTS (SELECT 1 FROM moments m
                  WHERE m.nft_id = sub.nft_id AND m.collection_id = v_ts
                    AND m.edition_id = be.id)
      OR EXISTS (SELECT 1 FROM sales s
                  WHERE s.nft_id = sub.nft_id AND s.collection_id = v_ts
                    AND s.edition_id = be.id)
    )
  LIMIT greatest(1, p_limit);

  -- Conflation knots: a base moment whose target ::N already holds that serial
  -- under a DIFFERENT nft. Skip these across all three tables (left on base).
  DROP TABLE IF EXISTS _split_collide;
  CREATE TEMP TABLE _split_collide ON COMMIT DROP AS
  SELECT DISTINCT x.nft_id
  FROM _split x
  JOIN moments m  ON m.nft_id = x.nft_id AND m.collection_id = v_ts AND m.edition_id = x.base_ed_id
  JOIN moments m2 ON m2.edition_id = x.sub_ed_id AND m2.serial_number = m.serial_number AND m2.nft_id <> m.nft_id;
  GET DIAGNOSTICS v_skipped = ROW_COUNT;

  -- SALES
  INSERT INTO audit_20260704_subedition_split_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'sales', s.nft_id, x.base, x.sub_ext, s.id::text
  FROM sales s JOIN _split x ON x.nft_id = s.nft_id
  WHERE s.collection_id = v_ts AND s.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = s.nft_id);
  UPDATE sales s SET edition_id = x.sub_ed_id
  FROM _split x WHERE s.nft_id = x.nft_id AND s.collection_id = v_ts AND s.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = s.nft_id);
  GET DIAGNOSTICS v_sales = ROW_COUNT;

  -- WMC
  INSERT INTO audit_20260704_subedition_split_remap (src, nft_id, old_edition, new_edition, row_ref)
  SELECT 'wmc', w.moment_id::text, x.base, x.sub_ext, w.wallet_address
  FROM wallet_moments_cache w JOIN _split x ON x.nft_id = w.moment_id::text
  WHERE w.collection_id = v_ts AND w.edition_key = x.base
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = w.moment_id::text);
  UPDATE wallet_moments_cache w SET edition_key = x.sub_ext
  FROM _split x WHERE w.moment_id::text = x.nft_id AND w.collection_id = v_ts AND w.edition_key = x.base
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = w.moment_id::text);
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  -- MOMENTS
  UPDATE moments m SET edition_id = x.sub_ed_id, updated_at = now()
  FROM _split x WHERE m.nft_id = x.nft_id AND m.collection_id = v_ts AND m.edition_id = x.base_ed_id
    AND NOT EXISTS (SELECT 1 FROM _split_collide c WHERE c.nft_id = m.nft_id);
  GET DIAGNOSTICS v_moments = ROW_COUNT;

  RETURN jsonb_build_object('sales_split', v_sales, 'wmc_split', v_wmc,
                            'moments_split', v_moments, 'collisions_skipped', v_skipped);
END
$function$;
-- <<< END verbatim remap_topshot_split_resolved_subeditions <<<

-- ── Fixture ────────────────────────────────────────────────────────────────
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000a5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::5'),
  -- Exists so the base-regex guard is observable: a non-int base that DOES
  -- resolve to real base+sub editions, so only the regex excludes it.
  ('00000000-0000-0000-0000-0000000000f1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'uuid-a:uuid-b'),
  ('00000000-0000-0000-0000-0000000000f5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'uuid-a:uuid-b::5'),
  -- ⚠ A '::0' edition must EXIST for the `subedition_id > 0` guard to be
  -- observable: without it, relaxing the guard finds no matching `se` row and
  -- falls out of the join anyway, so the guard looks tested when it is masked.
  ('00000000-0000-0000-0000-0000000000a0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::0');

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id, base_external_id) VALUES
  ('n-ok',      5, '48:1652'),
  ('n-collide', 5, '48:1652'),
  ('n-zero',    0, '48:1652'),        -- subedition_id 0 is not a parallel
  ('n-badbase', 5, 'uuid-a:uuid-b');  -- base fails the int regex

INSERT INTO sales (id, collection_id, nft_id, edition_id) VALUES
  (1, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-ok',      '00000000-0000-0000-0000-0000000000b1'),
  (2, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-collide', '00000000-0000-0000-0000-0000000000b1'),
  (3, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-zero',    '00000000-0000-0000-0000-0000000000b1'),
  (4, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-badbase', '00000000-0000-0000-0000-0000000000f1'),
  -- Already on the parallel → nothing to do (and proves re-runs are no-ops).
  (5, '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-ok',      '00000000-0000-0000-0000-0000000000a5');

INSERT INTO wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key) VALUES
  ('0xaaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-ok',      '48:1652'),
  ('0xbbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-collide', '48:1652'),
  ('0xccc', '06248cc4-b85f-47cd-af67-1855d14acd75', 'n-ok',      '48:1652'),  -- other collection
  -- ⚠ A wmc row for a SPLITTABLE nft that is NOT on the base. This is what makes
  -- the `w.edition_key = x.base` predicate observable: drop it and this row is
  -- overwritten to the ::5 key, silently re-keying a moment the sweep was never
  -- asked to touch.
  ('0xddd', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-ok',      '48:9999');

INSERT INTO moments (nft_id, collection_id, edition_id, serial_number, updated_at) VALUES
  ('n-ok',      '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000b1', 3, NULL),
  ('n-collide', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000b1', 7, NULL),
  -- The knot: a DIFFERENT nft already holds serial 7 on the target ::5 edition.
  ('n-holder',  '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000a5', 7, NULL);

-- ── Run ────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _res AS SELECT remap_topshot_split_resolved_subeditions(8000) AS j;

SELECT _assert_eq((SELECT (j->>'collisions_skipped') FROM _res), '1', 'the conflation knot is detected');
SELECT _assert_eq((SELECT (j->>'sales_split') FROM _res), '1', 'only the clean base-keyed sale is split');
SELECT _assert_eq((SELECT (j->>'wmc_split') FROM _res), '1', 'only the clean base-keyed wmc row is split');
SELECT _assert_eq((SELECT (j->>'moments_split') FROM _res), '1', 'only the clean base-keyed moment is split');

-- 2. The knot is skipped in ALL THREE tables — leaving it split in some and not
-- others would make the tables disagree about one moment.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=2), '00000000-0000-0000-0000-0000000000b1', 'knot sale stays on the base');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xbbb'), '48:1652', 'knot wmc row stays on the base');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='n-collide'), '00000000-0000-0000-0000-0000000000b1', 'knot moment stays on the base');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='n-holder'), '00000000-0000-0000-0000-0000000000a5', 'the serial holder is never disturbed');

-- 3. The clean row moved everywhere it was base-keyed.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=1), '00000000-0000-0000-0000-0000000000a5', 'clean sale moved to the parallel');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xaaa'), '48:1652::5', 'clean wmc row moved to the parallel');
SELECT _assert_eq((SELECT edition_id::text FROM moments WHERE nft_id='n-ok'), '00000000-0000-0000-0000-0000000000a5', 'clean moment moved to the parallel');

-- Scope guards.
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=3), '00000000-0000-0000-0000-0000000000b1', 'subedition_id 0 is not a parallel → untouched');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=4), '00000000-0000-0000-0000-0000000000f1', 'non-int base fails the regex → untouched even though both editions exist');
SELECT _assert_eq((SELECT edition_id::text FROM sales WHERE id=5), '00000000-0000-0000-0000-0000000000a5', 'a sale already on the parallel is a no-op (re-runs do not double-hop)');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xccc'), '48:1652', 'other-collection wmc row untouched');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xddd'), '48:9999', 'a wmc row not sitting on the base is NOT swept up — only base-keyed rows move');

-- Audit coverage, including the documented asymmetry.
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260704_subedition_split_remap WHERE src='sales'), '1', 'sales write is audited');
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260704_subedition_split_remap WHERE src='wmc'), '1', 'wmc write is audited');
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260704_subedition_split_remap WHERE src='moments'), '0', 'moments write is NOT audited — recorded as the current contract, not as an endorsement');
SELECT _assert_eq((SELECT old_edition FROM audit_20260704_subedition_split_remap WHERE src='sales'), '48:1652', 'audit records the pre-split base (the revert value)');

SELECT '✓ remap_topshot_split_resolved_subeditions invariants pass' AS result;
ROLLBACK;
