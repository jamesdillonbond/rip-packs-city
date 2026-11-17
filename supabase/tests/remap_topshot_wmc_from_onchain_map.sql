-- DB invariant: public.remap_topshot_wmc_from_onchain_map() → jsonb
-- — re-keys FOSSIL wallet_moments_cache rows (edition_key not in the canonical
-- `setID:playID[::subID]` form) onto the real edition, with the on-chain map as
-- the authority.
--
-- wmc is the portfolio store — ~34 DB functions sum wmc.fmv_usd — and CLAUDE.md
-- records that wmc UUID fossils render as REAL MOMENTS on /share and wallet
-- snapshots. So a bad re-key here is directly user-visible, not internal.
--
-- Pins four properties:
--
--   1. PARALLEL WINS OVER BASE. new_key is COALESCE(epar, ebase). A moment with
--      subedition_id > 0 whose parallel edition exists must key to the PARALLEL.
--      Collapsing it to the base is the precise parallel-conflation defect this
--      whole program exists to fix, and it is invisible in the return value.
--   2. UNRESOLVED IS COUNTED, NOT GUESSED. A fossil row with no resolvable
--      edition has new_key IS NULL: reported in `unresolved_no_edition`, left
--      alone. It is never written to a fallback key.
--   3. THE AUDIT ROW AND THE UPDATE SHARE ONE PREDICATE
--      (`new_key IS NOT NULL AND new_key <> old_key`), so the audit table is a
--      faithful record of exactly what changed — it is the revert path. A
--      divergence would leave rows rewritten with no way back.
--   4. ALREADY-CANONICAL ROWS ARE NOT TOUCHED. The int-key regex is a NOT-match:
--      only fossils are in scope.
--
-- ⚠ The stub loop swallows per-row failures (`EXCEPTION WHEN OTHERS THEN NULL`)
-- so one un-stubbable moment cannot abort the batch. That is deliberate, but it
-- means a systematic stubbing failure shows up ONLY as a smaller
-- `editions_stubbed` count — never as an error.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260815162000_audit_20260815_snapshot_remap_topshot_wmc_from_onchain_map.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  moment_id      text,
  edition_key    text,
  serial_number  integer
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

CREATE TABLE audit_20260627_wmc_fossil_onchain_remap (
  wallet_address  text,
  collection_id   uuid,
  moment_id       text,
  old_edition_key text,
  old_serial      integer,
  new_edition_key text,
  new_serial      integer
);

-- Stub of the edition seeder the loop calls. Inserts the canonical base edition
-- so the stubbing branch is observable; raises for set 666 so the per-row
-- EXCEPTION guard is exercised too.
CREATE OR REPLACE FUNCTION public.ensure_topshot_edition_stub(p_set integer, p_play integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_set = 666 THEN RAISE EXCEPTION 'cannot stub'; END IF;
  INSERT INTO editions (id, collection_id, external_id)
  VALUES (gen_random_uuid(), '95f28a17-224a-4025-96ad-adf8a4c63bfd', p_set::text || ':' || p_play::text)
  ON CONFLICT DO NOTHING;
END $$;

-- >>> BEGIN verbatim remap_topshot_wmc_from_onchain_map (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.remap_topshot_wmc_from_onchain_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_wmc int := 0;
  v_stubbed int := 0;
  v_unresolved int := 0;
  r record;
BEGIN
  -- Ensure a canonical base edition exists for every mapped nft that keys a
  -- fossil row but has no set:play edition yet. Per-row guarded so one failure
  -- can't abort the batch.
  FOR r IN
    SELECT DISTINCT m.set_id_onchain, m.play_id_onchain
    FROM topshot_misattrib_onchain_map m
    WHERE EXISTS (
            SELECT 1 FROM wallet_moments_cache w
            WHERE w.collection_id = v_ts AND w.moment_id::text = m.nft_id::text
              AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND NOT EXISTS (
            SELECT 1 FROM editions e
            WHERE e.collection_id = v_ts
              AND e.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text))
  LOOP
    BEGIN
      PERFORM ensure_topshot_edition_stub(r.set_id_onchain, r.play_id_onchain);
      v_stubbed := v_stubbed + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  DROP TABLE IF EXISTS _wtgt;
  CREATE TEMP TABLE _wtgt ON COMMIT DROP AS
  SELECT w.wallet_address, w.collection_id, w.moment_id,
         w.edition_key AS old_key, w.serial_number AS old_serial,
         m.serial_number AS map_serial,
         COALESCE(epar.external_id, ebase.external_id) AS new_key
  FROM wallet_moments_cache w
  JOIN topshot_misattrib_onchain_map m ON m.nft_id::text = w.moment_id::text
  LEFT JOIN topshot_moment_subeditions sub
         ON sub.nft_id = m.nft_id AND COALESCE(sub.subedition_id,0) > 0
  LEFT JOIN editions ebase
         ON ebase.collection_id = v_ts
        AND ebase.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text)
  LEFT JOIN editions epar
         ON sub.subedition_id IS NOT NULL AND epar.collection_id = v_ts
        AND epar.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text || '::' || sub.subedition_id::text)
  WHERE w.collection_id = v_ts
    AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$';

  SELECT count(*) INTO v_unresolved FROM _wtgt WHERE new_key IS NULL;

  INSERT INTO audit_20260627_wmc_fossil_onchain_remap
    (wallet_address, collection_id, moment_id, old_edition_key, old_serial, new_edition_key, new_serial)
  SELECT wallet_address, collection_id, moment_id::text, old_key, old_serial, new_key, COALESCE(map_serial, old_serial)
  FROM _wtgt
  WHERE new_key IS NOT NULL AND new_key <> old_key;

  UPDATE wallet_moments_cache w
  SET edition_key = t.new_key,
      serial_number = COALESCE(t.map_serial, w.serial_number)
  FROM _wtgt t
  WHERE w.wallet_address = t.wallet_address
    AND w.collection_id = t.collection_id
    AND w.moment_id = t.moment_id
    AND t.new_key IS NOT NULL AND t.new_key <> t.old_key;
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  RETURN jsonb_build_object(
    'wmc_rekeyed', v_wmc,
    'editions_stubbed', v_stubbed,
    'unresolved_no_edition', v_unresolved,
    'map_size', (SELECT count(*) FROM topshot_misattrib_onchain_map)
  );
END $function$;
-- <<< END verbatim remap_topshot_wmc_from_onchain_map <<<

-- ── Fixture ──────────────────────────────────────────────────────────
-- Base edition 48:1652 and its parallel 48:1652::5 both exist, so the COALESCE
-- precedence is observable. 48:2000 exists as a base only.
INSERT INTO editions (id, collection_id, external_id) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652'),
  ('00000000-0000-0000-0000-0000000000a5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::5'),
  ('00000000-0000-0000-0000-0000000000b2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:2000'),
  -- ⚠ A '::0' edition must EXIST for the `COALESCE(sub.subedition_id,0) > 0`
  -- guard to be observable. Without it, treating subedition 0 as a parallel
  -- simply finds no epar row and falls back to the base anyway — the same
  -- answer, so the guard looks untested when it is merely masked.
  ('00000000-0000-0000-0000-0000000000a0', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '48:1652::0');

INSERT INTO topshot_misattrib_onchain_map (nft_id, set_id_onchain, play_id_onchain, serial_number) VALUES
  ('n-par',     48, 1652, 501),   -- has a subedition → must key to the PARALLEL
  ('n-base',    48, 1652, 502),   -- no subedition → base
  ('n-nomap',   48, 3000, 503),   -- no edition, and set 3000 stubs fine
  ('n-canon',   48, 2000, 504),   -- wmc row is ALREADY canonical → out of scope
  ('n-noop',    48, 2000, 505),   -- fossil resolves to a key equal to old_key? no → see below
  ('n-fail',   666,    1, 506),   -- stub raises → per-row EXCEPTION guard
  -- n-shift is what makes the fossil-regex assertion observable: its wmc key is
  -- ALREADY canonical but the map points somewhere else, so if the NOT-match
  -- regex were dropped it would be re-keyed. (n-canon cannot show this — its map
  -- resolves to its own key, so `new_key <> old_key` masks the regex there. The
  -- two guards back each other up, which is why one fixture row cannot test both.)
  ('n-shift',  48, 1652, 507);

INSERT INTO topshot_moment_subeditions (nft_id, subedition_id) VALUES
  ('n-par',  5),
  ('n-base', 0);                  -- subedition_id 0 is NOT a parallel (COALESCE(...,0) > 0)

INSERT INTO wallet_moments_cache (wallet_address, collection_id, moment_id, edition_key, serial_number) VALUES
  ('0xaaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-par',   'uuid-a:uuid-b', 1),
  ('0xaaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-base',  'uuid-c:uuid-d', 2),
  ('0xbbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-nomap', 'uuid-e:uuid-f', 3),
  -- Already canonical: excluded by the NOT-match regex, so never re-keyed.
  ('0xbbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-canon', '48:2000',       4),
  ('0xccc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-fail',  'uuid-g:uuid-h', 5),
  ('0xccc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'n-shift', '48:2000',       7),
  -- Another collection's fossil row must be untouched.
  ('0xddd', '06248cc4-b85f-47cd-af67-1855d14acd75', 'n-par',   'uuid-a:uuid-b', 6);

-- ── Run ──────────────────────────────────────────────────────────────
CREATE TEMP TABLE _res AS SELECT remap_topshot_wmc_from_onchain_map() AS j;

-- n-par, n-base and n-nomap (stubbed into existence) re-key; n-fail cannot be
-- stubbed so it stays unresolved; n-canon is out of scope entirely.
SELECT _assert_eq((SELECT (j->>'wmc_rekeyed') FROM _res), '3', 're-keyed exactly the three resolvable fossil rows');
SELECT _assert_eq((SELECT (j->>'unresolved_no_edition') FROM _res), '1', 'the un-stubbable moment is COUNTED as unresolved, not written');
SELECT _assert_eq((SELECT (j->>'map_size') FROM _res), '7', 'map_size reports the whole map');

-- 1. Parallel precedence — the single most important assertion in this file.
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='n-par' AND wallet_address='0xaaa'), '48:1652::5', 'subedition row keys to the PARALLEL, not the base (COALESCE(epar, ebase))');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='n-base'), '48:1652', 'subedition_id 0 is not a parallel → keys to the base');
SELECT _assert_eq((SELECT serial_number::text FROM wallet_moments_cache WHERE moment_id='n-par' AND wallet_address='0xaaa'), '501', 'serial taken from the on-chain map');

-- 2. Unresolved rows are left exactly as they were.
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='n-fail'), 'uuid-g:uuid-h', 'unresolvable fossil keeps its old key rather than getting a fallback');
SELECT _assert_eq((SELECT serial_number::text FROM wallet_moments_cache WHERE moment_id='n-fail'), '5', 'unresolvable fossil keeps its old serial');

-- 3. The audit table mirrors the UPDATE exactly — it is the revert path.
SELECT _assert_eq((SELECT count(*)::text FROM audit_20260627_wmc_fossil_onchain_remap), '3', 'one audit row per re-keyed row, no more and no fewer');
SELECT _assert_eq((SELECT old_edition_key FROM audit_20260627_wmc_fossil_onchain_remap WHERE moment_id='n-par'), 'uuid-a:uuid-b', 'audit row records the PRE-remap key (the revert value)');
SELECT _assert_eq((SELECT new_edition_key FROM audit_20260627_wmc_fossil_onchain_remap WHERE moment_id='n-par'), '48:1652::5', 'audit row records the post-remap key');
SELECT _assert_eq((SELECT old_serial::text FROM audit_20260627_wmc_fossil_onchain_remap WHERE moment_id='n-par'), '1', 'audit row records the pre-remap serial');

-- 4. Scope: an already-canonical row and another collection's row are untouched.
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='n-canon'), '48:2000', 'already-canonical row is out of scope (regex is a NOT-match)');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE moment_id='n-shift'), '48:2000', 'canonical row whose map points elsewhere is STILL out of scope — the regex, not luck, is what excludes it');
SELECT _assert_eq((SELECT edition_key FROM wallet_moments_cache WHERE wallet_address='0xddd'), 'uuid-a:uuid-b', 'other-collection fossil untouched');

SELECT '✓ remap_topshot_wmc_from_onchain_map invariants pass' AS result;
ROLLBACK;
