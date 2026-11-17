-- DB invariant: public.topshot_serial_board_candidates — the feed behind the
-- Top Shot serial (#1 / perfect) premium board. It selects TS editions that are
-- eligible to show a serial estimate: on-chain set+play ids present, positive
-- circulation, and a LATEST FMV of HIGH/MEDIUM confidence — then derives a #1 and
-- a perfect-serial estimate via serial_fmv_estimate, drops rows with no estimate,
-- applies a minimum-#1-estimate floor, and orders by #1 estimate desc. A loosened
-- filter would surface LOW/NO_DATA editions (fabricated-confidence signal); a
-- broken latest-FMV pick would price off a stale snapshot.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260726012000_audit_20260726_serial_board_candidates_pooled_edition_id.sql),
-- with its body verified byte-identical to live prod via pg_get_functiondef on
-- 2026-07-31. serial_fmv_estimate (itself pinned separately) is STUBBED here to a
-- deterministic estimate so this test isolates the candidate FILTER + ordering.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.editions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id     uuid,
  external_id       text,
  set_id_onchain    integer,
  play_id_onchain   integer,
  series            smallint,
  tier              text,
  circulation_count integer
);
CREATE TABLE public.fmv_snapshots (
  edition_id    uuid,
  collection_id uuid,
  fmv_usd       numeric,
  confidence    text,
  computed_at   timestamptz
);

-- Stub for the (separately-pinned) serial_fmv_estimate. Deterministic: the #1
-- estimate (serial=1) = fmv * 10; the perfect estimate (serial=circ) = fmv. This
-- makes no1 vary per edition so the floor + ordering are observable.
CREATE FUNCTION public.serial_fmv_estimate(
  p_collection text, p_serial integer, p_circ integer, p_tier text,
  p_fmv numeric, p_conf text, p_edition uuid
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('estimate_usd',
    CASE WHEN p_fmv IS NULL THEN NULL
         WHEN p_serial = 1 THEN p_fmv * 10
         ELSE p_fmv END);
$$;

-- >>> BEGIN verbatim topshot_serial_board_candidates (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.topshot_serial_board_candidates(p_min_no1_estimate numeric DEFAULT 0)
 RETURNS TABLE(rpc_edition_id uuid, external_id text, set_id_onchain integer, play_id_onchain integer, series smallint, tier text, circulation_count integer, edition_fmv_usd numeric, confidence text, no1_estimate_usd numeric, perfect_estimate_usd numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH latest_fmv AS (
    SELECT DISTINCT ON (fs.edition_id) fs.edition_id, fs.fmv_usd, fs.confidence::text AS confidence
    FROM fmv_snapshots fs
    WHERE fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    ORDER BY fs.edition_id, fs.computed_at DESC
  ),
  base AS (
    SELECT e.id AS rpc_edition_id, e.external_id,
           e.set_id_onchain, e.play_id_onchain, e.series, e.tier::text AS tier,
           e.circulation_count, lf.fmv_usd AS edition_fmv_usd, lf.confidence,
           (serial_fmv_estimate('95f28a17-224a-4025-96ad-adf8a4c63bfd', 1, e.circulation_count, e.tier::text, lf.fmv_usd, lf.confidence, e.id) ->> 'estimate_usd')::numeric AS no1_estimate_usd,
           (serial_fmv_estimate('95f28a17-224a-4025-96ad-adf8a4c63bfd', e.circulation_count, e.circulation_count, e.tier::text, lf.fmv_usd, lf.confidence, e.id) ->> 'estimate_usd')::numeric AS perfect_estimate_usd
    FROM editions e
    JOIN latest_fmv lf ON lf.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND e.set_id_onchain IS NOT NULL
      AND e.play_id_onchain IS NOT NULL
      AND e.circulation_count > 0
      AND lf.confidence IN ('HIGH','MEDIUM')
  )
  SELECT rpc_edition_id, external_id, set_id_onchain, play_id_onchain, series, tier,
         circulation_count, edition_fmv_usd, confidence, no1_estimate_usd, perfect_estimate_usd
  FROM base
  WHERE COALESCE(no1_estimate_usd, perfect_estimate_usd) IS NOT NULL
    AND COALESCE(no1_estimate_usd, 0) >= p_min_no1_estimate
  ORDER BY no1_estimate_usd DESC NULLS LAST;
$function$;
-- <<< END verbatim topshot_serial_board_candidates <<<

\set ts  '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set ad  '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set eHi  '''11111111-1111-1111-1111-111111111111'''
\set eMed '''22222222-2222-2222-2222-222222222222'''
\set eLow '''33333333-3333-3333-3333-333333333333'''
\set eNoIds '''44444444-4444-4444-4444-444444444444'''
\set eAllDay '''55555555-5555-5555-5555-555555555555'''
\set eStale '''66666666-6666-6666-6666-666666666666'''

INSERT INTO public.editions (id, collection_id, external_id, set_id_onchain, play_id_onchain, series, tier, circulation_count) VALUES
  (:eHi::uuid,    :ts::uuid, '141:1', 141, 1, 4, 'LEGENDARY', 100),  -- eligible, HIGH, fmv 50 → no1 500
  (:eMed::uuid,   :ts::uuid, '141:2', 141, 2, 4, 'RARE',      500),  -- eligible, MEDIUM, fmv 20 → no1 200
  (:eLow::uuid,   :ts::uuid, '141:3', 141, 3, 4, 'COMMON',   1000),  -- LOW confidence → excluded
  (:eNoIds::uuid, :ts::uuid, '141:4', NULL, 4, 4, 'RARE',     300),  -- set_id_onchain NULL → excluded
  (:eAllDay::uuid,:ad::uuid, 'ad:1',  10,  1, 1, 'LEGENDARY', 200),  -- wrong collection → excluded
  (:eStale::uuid, :ts::uuid, '141:6', 141, 6, 4, 'RARE',      250);  -- newest FMV is LOW → excluded

-- eStale carries an OLD high-conf snapshot and a NEWER low-conf one → the DISTINCT
-- ON (computed_at DESC) must pick the low-conf latest, excluding it.
INSERT INTO public.fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, computed_at) VALUES
  (:eHi::uuid,    :ts::uuid, 50, 'HIGH',   '2026-07-31T10:00:00Z'),
  (:eMed::uuid,   :ts::uuid, 20, 'MEDIUM', '2026-07-31T10:00:00Z'),
  (:eLow::uuid,   :ts::uuid, 15, 'LOW',    '2026-07-31T10:00:00Z'),
  (:eNoIds::uuid, :ts::uuid, 30, 'HIGH',   '2026-07-31T10:00:00Z'),
  (:eAllDay::uuid,:ad::uuid, 40, 'HIGH',   '2026-07-31T10:00:00Z'),
  (:eStale::uuid, :ts::uuid, 99, 'HIGH',   '2026-07-30T10:00:00Z'),
  (:eStale::uuid, :ts::uuid, 12, 'LOW',    '2026-07-31T11:00:00Z');

-- No floor: exactly the two eligible HIGH/MEDIUM editions, ordered by #1 estimate desc.
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_serial_board_candidates(0)), '2',
  'only the two eligible TS HIGH/MEDIUM editions are candidates');
SELECT _assert_eq(
  (SELECT string_agg(external_id, ',') FROM (SELECT external_id FROM public.topshot_serial_board_candidates(0)) q),
  '141:1,141:2',
  'ordered by no1_estimate desc: eHi (500) before eMed (200)');
SELECT _assert_eq(
  (SELECT no1_estimate_usd::text FROM public.topshot_serial_board_candidates(0) WHERE external_id='141:1'),
  '500', 'the #1 estimate is derived per edition (fmv 50 * 10)');

-- The min-#1 floor drops eMed (200) when the floor is 300.
SELECT _assert_eq((SELECT count(*)::text FROM public.topshot_serial_board_candidates(300)), '1',
  'the p_min_no1_estimate floor excludes editions below it');
SELECT _assert_eq(
  (SELECT external_id FROM public.topshot_serial_board_candidates(300)),
  '141:1', 'only the above-floor edition remains');

-- eStale (newest snapshot LOW) is never a candidate — latest-FMV-wins is enforced.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.topshot_serial_board_candidates(0) WHERE external_id='141:6'),
  'an edition whose LATEST snapshot is LOW is excluded even if an older HIGH one exists');

SELECT '✓ topshot_serial_board_candidates invariants pass' AS result;
ROLLBACK;
