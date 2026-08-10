-- DB invariant: public.get_wallet_total_fmv(text, uuid) — the wallet/portfolio
-- total-value read. Its non-obvious, load-bearing behavior is the 3-tier FMV
-- COALESCE per moment: (1) the moment's own latest fmv_snapshot, (2) for legacy
-- integer-keyed editions with no snapshot, the highest latest-FMV of a UUID-keyed
-- SIBLING sharing name+series, else (3) the FMV denormalized on the wmc row. Plus
-- the optional collection scope and the empty→0 guard. A regression would mis-state
-- the headline portfolio dollar figure.
--
-- ⚠ COLLECTION SCOPE (fixed 2026-08-10): the editions join is scoped by
-- collection_id. external_id is unique WITHIN a collection but COLLIDES across
-- collections, so an unscoped join fanned every colliding moment onto a second,
-- unrelated collection's edition and DOUBLE-ADDED its FMV (measured ~3.1x on a
-- live Golazos wallet). The `collision decoy` fixture below pins this: a regression
-- to the unscoped join would price the c1 moment against the c2 edition too.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260810040000_audit_20260810_fix_get_wallet_total_fmv_collection_scope.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  computed_at timestamptz
);
CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  external_id   text,
  name          text,
  series        smallint,
  collection_id uuid
);
CREATE TABLE wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric
);

-- >>> BEGIN verbatim get_wallet_total_fmv (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_total_fmv(p_wallet text, p_collection_id uuid DEFAULT NULL::uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '30s'
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (edition_id)
      edition_id, fmv_usd
    FROM fmv_snapshots
    ORDER BY edition_id, computed_at DESC
  ),
  sibling_fmv AS (
    SELECT DISTINCT ON (int_ed.id)
      int_ed.id AS int_edition_id,
      lf.fmv_usd
    FROM editions int_ed
    JOIN editions uuid_ed ON uuid_ed.name = int_ed.name
      AND uuid_ed.series = int_ed.series
      AND uuid_ed.id != int_ed.id
    JOIN latest_fmv lf ON lf.edition_id = uuid_ed.id
    WHERE int_ed.external_id ~ '^\d+:\d+$'
    ORDER BY int_ed.id, lf.fmv_usd DESC NULLS LAST
  )
  SELECT COALESCE(SUM(COALESCE(lf.fmv_usd, sf.fmv_usd, wmc.fmv_usd)), 0)
  FROM wallet_moments_cache wmc
  LEFT JOIN editions e ON e.external_id = wmc.edition_key AND e.collection_id = wmc.collection_id
  LEFT JOIN latest_fmv lf ON lf.edition_id = e.id
  LEFT JOIN sibling_fmv sf ON sf.int_edition_id = e.id AND lf.edition_id IS NULL
  WHERE wmc.wallet_address = p_wallet
    AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id);
$function$;
-- <<< END verbatim get_wallet_total_fmv <<<

-- Collections used in fixtures.
-- c1 = 11111111-...-c1 ; c2 = 22222222-...-c2

-- EA (UUID-keyed, in c1) has two snapshots; the LATER computed_at (20) must win over 5.
INSERT INTO editions VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 'uuidkeyA',  'Star', 8, '11111111-1111-1111-1111-1111111111c1');
INSERT INTO fmv_snapshots VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 5,  '2026-01-01'),
                                 ('aaaaaaaa-0000-0000-0000-000000000001', 20, '2026-06-01');
-- EA2 (UUID-keyed, c1, NOT held directly) shares name+series with the integer
-- edition below and has a HIGHER fmv (30) — it must be the sibling winner.
INSERT INTO editions VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 'uuidkeyA2', 'Star', 8, '11111111-1111-1111-1111-1111111111c1');
INSERT INTO fmv_snapshots VALUES ('aaaaaaaa-0000-0000-0000-000000000002', 30, '2026-06-01');
-- EB (integer-keyed, c1, no snapshot of its own) → must use the max sibling FMV (30).
INSERT INTO editions VALUES ('bbbbbbbb-0000-0000-0000-000000000001', '100:200', 'Star', 8, '11111111-1111-1111-1111-1111111111c1');
-- COLLISION DECOY: EC shares external_id 'uuidkeyA' with EA but lives in c2 and
-- carries a huge fmv (999). A DIFFERENT name/series keeps it out of the sibling
-- match, so it ONLY tests the main-join collection scope. The wallet holds
-- 'uuidkeyA' in c1, so the scoped join must price it against EA (20), never EC.
INSERT INTO editions VALUES ('cccccccc-0000-0000-0000-000000000001', 'uuidkeyA', 'Other', 9, '22222222-2222-2222-2222-2222222222c2');
INSERT INTO fmv_snapshots VALUES ('cccccccc-0000-0000-0000-000000000001', 999, '2026-06-01');

-- Wallet w1 holdings:
--   direct EA in c1          → tier 1 latest snapshot = 20 (NOT 20+999; EC is c2)
INSERT INTO wallet_moments_cache VALUES ('w1', '11111111-1111-1111-1111-1111111111c1', 'uuidkeyA', NULL);
--   integer EB in c1         → tier 2 sibling FMV = 30
INSERT INTO wallet_moments_cache VALUES ('w1', '11111111-1111-1111-1111-1111111111c1', '100:200', NULL);
--   orphan key in c1         → tier 3 wmc.fmv_usd = 3 (no edition, no sibling)
INSERT INTO wallet_moments_cache VALUES ('w1', '11111111-1111-1111-1111-1111111111c1', 'orphankey', 3);
--   another moment in c2     → tier 3 wmc.fmv_usd = 100 (excluded by a c1 filter)
INSERT INTO wallet_moments_cache VALUES ('w1', '22222222-2222-2222-2222-2222222222c2', 'orphankey2', 100);

-- Unscoped total = 20 + 30 + 3 + 100 = 153 (the cross-collection EC=999 is NOT added).
SELECT _assert_eq(get_wallet_total_fmv('w1', NULL)::text, '153', 'unscoped 3-tier total; cross-collection decoy excluded');
-- Scoped to c1 = 20 + 30 + 3 = 53 (drops the c2 moment).
SELECT _assert_eq(get_wallet_total_fmv('w1', '11111111-1111-1111-1111-1111111111c1')::text, '53', 'collection-scoped total');
-- A wallet with no rows → COALESCE(...,0) = 0, never NULL.
SELECT _assert_eq(get_wallet_total_fmv('nobody', NULL)::text, '0', 'empty wallet → 0 not NULL');

SELECT '✓ get_wallet_total_fmv invariants pass' AS result;
ROLLBACK;
