-- DB invariant: public.populate_wmc_fmv_from_snapshots — denormalizes the latest
-- FMV per edition onto wallet_moments_cache (wmc), the cache every collector
-- wallet page + /share card reads. A wrong value here renders a wrong FMV on a
-- user's holdings. Two paths: the default NULL-ONLY chunked drain (fills only wmc
-- rows whose fmv_usd is NULL, so a tick never disturbs an already-set value and
-- successive ticks drain the backlog), and the FORCE path (re-syncs every matched
-- row to the latest FMV but only where it actually DIFFERS). Both take the LATEST
-- snapshot per edition, match on (collection_id, edition_key = external_id), honor
-- an optional collection filter, and return the count changed.
--
-- As of 2026-08-12 both paths also carry `confidence` into wmc.fmv_confidence.
-- THE INVARIANT THAT MATTERS: the label is read from the SAME snapshot row the
-- value came from, never from "the latest snapshot" resolved independently.
-- Before this column existed, fmv_current carried confidence and wmc did not, so
-- the staleness marker was structurally unavailable at the point 34 DB functions
-- sum wmc.fmv_usd into a portfolio total — get_wallet_collection_snapshot (behind
-- the anon-public /share/[wallet]) rendered a 2-year-old print as current value
-- with no marker. The E1 case below pins the pairing directly: E1's OLDER snapshot
-- is HIGH and its LATEST is STALE, so an implementation that resolved confidence
-- separately from the value would fail it.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260812042019_audit_20260812_populate_wmc_fmv_carry_confidence.sql),
-- verified byte-identical to the live prod definition via pg_get_functiondef on
-- 2026-08-12. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Mirrors the prod enum so the fixture exercises the real enum -> enum
-- assignment rather than a text stand-in.
CREATE TYPE public.fmv_confidence AS ENUM
  ('HIGH','MEDIUM','LOW','ASK_ONLY','SALES_ONLY','STALE','NO_DATA');

CREATE TABLE public.editions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid,
  external_id   text
);
CREATE TABLE public.fmv_snapshots (
  edition_id  uuid,
  fmv_usd     numeric,
  confidence  public.fmv_confidence,
  computed_at timestamptz
);
CREATE TABLE public.wallet_moments_cache (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric,
  fmv_confidence public.fmv_confidence
);

-- >>> BEGIN verbatim populate_wmc_fmv_from_snapshots (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.populate_wmc_fmv_from_snapshots(p_collection_id uuid DEFAULT NULL::uuid, p_force boolean DEFAULT false, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  IF p_force THEN
    WITH latest_fmv AS (
      SELECT DISTINCT ON (e.collection_id, e.external_id)
        e.collection_id,
        e.external_id,
        fs.fmv_usd,
        fs.confidence
      FROM public.editions e
      JOIN public.fmv_snapshots fs ON fs.edition_id = e.id
      WHERE fs.fmv_usd IS NOT NULL
        AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
      ORDER BY e.collection_id, e.external_id, fs.computed_at DESC
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = lf.fmv_usd,
             fmv_confidence = lf.confidence
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
         AND (wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
              OR wmc.fmv_confidence IS DISTINCT FROM lf.confidence)
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  ELSE
    -- NULL-only chunked path. Each call processes up to p_limit rows. Once
    -- a row gets a non-NULL fmv_usd it falls out of the candidate set, so
    -- successive cron ticks naturally drain the backlog.
    --
    -- FOR UPDATE SKIP LOCKED: this path races the wallet-backfill writers on the
    -- same wmc rows. Locking the target rows up front and skipping any that a
    -- backfill currently holds means the UPDATE never blocks — skipped rows stay
    -- NULL and are retried next tick (the same drain semantics as above), so the
    -- tick no longer fails with lock/deadlock/statement timeouts.
    WITH targets AS (
      SELECT wmc.id, wmc.collection_id, wmc.edition_key
      FROM public.wallet_moments_cache wmc
      WHERE wmc.fmv_usd IS NULL
        AND wmc.edition_key IS NOT NULL
        AND (p_collection_id IS NULL OR wmc.collection_id = p_collection_id)
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
    ),
    snapped AS (
      SELECT t.id AS wmc_id, fs.fmv_usd, fs.confidence
      FROM targets t
      JOIN public.editions e
        ON e.collection_id = t.collection_id
       AND e.external_id   = t.edition_key
      CROSS JOIN LATERAL (
        SELECT fmv_usd, confidence
        FROM public.fmv_snapshots
        WHERE edition_id = e.id
          AND fmv_usd IS NOT NULL
        ORDER BY computed_at DESC
        LIMIT 1
      ) fs
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd        = s.fmv_usd,
             fmv_confidence = s.confidence
        FROM snapped s
       WHERE wmc.id = s.wmc_id
       RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_updated FROM updated;
  END IF;

  RETURN COALESCE(v_updated, 0);
END;
$function$;
-- <<< END verbatim populate_wmc_fmv_from_snapshots <<<

\set ts '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set e1 '''e1111111-1111-1111-1111-111111111111'''
\set e2 '''e2222222-2222-2222-2222-222222222222'''
\set e3 '''e3333333-3333-3333-3333-333333333333'''
\set e5 '''e5555555-5555-5555-5555-555555555555'''
\set e6 '''e6666666-6666-6666-6666-666666666666'''

INSERT INTO public.editions (id, collection_id, external_id) VALUES
  (:e1::uuid, :ts::uuid, 'E1'),
  (:e2::uuid, :ts::uuid, 'E2'),
  (:e3::uuid, :ad::uuid, 'E3'),
  (:e5::uuid, :ts::uuid, 'E5'),   -- no snapshot at all
  (:e6::uuid, :ts::uuid, 'E6');

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, confidence, computed_at) VALUES
  (:e1::uuid, 100, 'HIGH',     now() - interval '2 days'),  -- older  (HIGH)
  (:e1::uuid, 120, 'STALE',    now() - interval '1 hour'),  -- LATEST → 120 + STALE win
  (:e2::uuid,  50, 'LOW',      now() - interval '1 hour'),
  (:e3::uuid, 200, 'ASK_ONLY', now() - interval '1 hour'),
  (:e6::uuid,  77, 'MEDIUM',   now() - interval '1 hour');

INSERT INTO public.wallet_moments_cache (id, collection_id, edition_key, fmv_usd, fmv_confidence) VALUES
  ('11111111-0000-0000-0000-000000000001', :ts::uuid, 'E1',      NULL, NULL),  -- NULL → fill 120/STALE
  ('11111111-0000-0000-0000-000000000002', :ts::uuid, 'E2',      999,  NULL),  -- set → NULL-path leaves it
  ('11111111-0000-0000-0000-000000000003', :ts::uuid, 'NOMATCH', NULL, NULL),  -- no edition → stays NULL
  ('11111111-0000-0000-0000-000000000004', :ad::uuid, 'E3',      NULL, NULL),  -- NULL → fill 200/ASK_ONLY
  ('11111111-0000-0000-0000-000000000005', :ts::uuid, 'E5',      NULL, NULL),  -- edition, no snapshot → stays NULL
  ('11111111-0000-0000-0000-000000000006', :ts::uuid, 'E6',      77,   NULL);  -- value already correct, label missing

-- ── NULL-only path (default): fills only the NULL rows with the LATEST fmv ───
SELECT _assert_eq(public.populate_wmc_fmv_from_snapshots()::text, '2',
  'NULL-only path fills exactly the two matchable NULL rows (E1, E3)');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000001'),
  '120', 'the LATEST snapshot wins (120, not the older 100)');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000001'),
  'STALE', 'the label comes from the SAME row as the value (STALE from the latest, not HIGH from the older)');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000004'),
  '200', 'a different-collection NULL row is filled when no collection filter is passed');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000004'),
  'ASK_ONLY', 'the label is carried for the cross-collection row too');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000002'),
  '999', 'an already-set fmv is NOT disturbed by the NULL-only path');
SELECT _assert(
  (SELECT fmv_usd FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000003') IS NULL,
  'a wmc row whose edition_key matches no edition stays NULL');
SELECT _assert(
  (SELECT fmv_usd FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000005') IS NULL,
  'a matched edition with NO snapshot leaves the row NULL (nothing to copy)');
SELECT _assert(
  (SELECT fmv_confidence FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000006') IS NULL,
  'the NULL-only path skips a row whose fmv is already set, even when its label is missing');

-- ── FORCE path, scoped to TopShot: re-syncs a DIFFERING value or label ──────
-- w2 (E2) currently reads 999 but the latest FMV is 50 → force updates it.
-- w6 (E6) already reads the correct 77 but has NO label → the widened
--   change-detection (fmv OR confidence differs) still picks it up. Without
--   that OR, every already-correct row would keep a NULL label forever.
-- w1 (E1) already equals its latest value AND label → excluded.
SELECT _assert_eq(public.populate_wmc_fmv_from_snapshots(:ts::uuid, true)::text, '2',
  'FORCE updates the row whose fmv differs (E2 999->50) AND the row whose label is missing (E6), not the already-correct E1');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000002'),
  '50', 'the stale set value is re-synced to the latest FMV');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000002'),
  'LOW', 'the re-synced row also gets the label from that same snapshot');
SELECT _assert_eq((SELECT fmv_confidence::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000006'),
  'MEDIUM', 'a value-correct but label-missing row is labeled without changing its value');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000006'),
  '77', 'and its value is left exactly as it was');
SELECT _assert_eq((SELECT fmv_usd::text FROM public.wallet_moments_cache WHERE id='11111111-0000-0000-0000-000000000004'),
  '200', 'the AllDay row is untouched by a TopShot-scoped force (collection scoping)');

SELECT '✓ populate_wmc_fmv_from_snapshots invariants pass' AS result;
ROLLBACK;
