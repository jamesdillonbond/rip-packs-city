-- DB invariant: public.refresh_cross_collection_cohort_step2 — pg_cron
-- `rpc-ccm-step2` @ `25 4 * * *`.
--
-- WHAT IT DOES. Rebuilds `cross_collection_ts_set_overlap_mat`: for each Top
-- Shot SET, how many of the cross-collection cohort hold it and how many of
-- their moments it accounts for. It is the DOWNSTREAM half of an ordered pair —
-- step1 rebuilds the cohort at `10 4`, this reads it 15 minutes later.
--
-- ⚠ THE COUPLING IS THE THING TO KNOW. This function reads
-- `cross_collection_cohort_mat` and has NO check that step1 ran, succeeded, or
-- ran recently. If step1 fails, this rebuilds the overlap table from a stale
-- cohort — and because step1 TRUNCATEs inside its own transaction, a step1 that
-- rolled back leaves the PREVIOUS cohort, so the failure mode is "yesterday's
-- cohort" rather than "no cohort". Both halves are asserted: an empty cohort
-- yields an empty overlap table (not an error, and not the whole platform).
--
-- THE PROPERTIES:
--   1. ⚠ The cohort join is what makes every number in this table a statement
--      about CROSS-COLLECTION collectors. Dropping it turns it into a Top Shot
--      set-popularity table with a misleading column name (`cohort_holders`).
--   2. ⚠ Scoped to the Top Shot collection_id on BOTH the wmc join and, via
--      `e.collection_id = w.collection_id`, the editions join. A cohort member's
--      All Day moments must not be counted into a Top Shot set.
--   3. ⚠ `COUNT(DISTINCT w.wallet_address)` for holders vs plain `COUNT(*)` for
--      moments — a collector holding 30 moments of one set is ONE holder. Using
--      COUNT(*) for both would inflate the holder count by the depth of each
--      collector's position, which is exactly the number a reader would take as
--      "how many people".
--   4. `WHERE e.set_id IS NOT NULL AND e.set_name IS NOT NULL` — an edition with
--      no set identity is excluded rather than grouped into a nameless bucket.
--   5. `MAX(e.set_name)` is a GROUP BY artefact, not a choice: rows are grouped
--      by `set_id` and the name is functionally dependent on it.
--   6. TRUNCATE-then-INSERT in one transaction, same as step1: atomic replace,
--      and a mid-run failure leaves the previous table intact.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816070000_audit_20260816_snapshot_last_four_scheduled_secdef_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 285f3041a7d5b20a766df594290b76a5).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.cross_collection_cohort_mat (
  wallet_address text
);

CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  edition_key    text
);

CREATE TABLE public.editions (
  external_id   text,
  collection_id uuid,
  set_id        uuid,
  set_name      text
);

CREATE TABLE public.cross_collection_ts_set_overlap_mat (
  set_id            uuid,
  set_name          text,
  cohort_holders    int,
  moments_in_cohort int,
  computed_at       timestamptz
);

-- >>> BEGIN verbatim refresh_cross_collection_cohort_step2 (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step2()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_set_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT
    e.set_id,
    MAX(e.set_name),
    COUNT(DISTINCT w.wallet_address),
    COUNT(*),
    v_started
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w
    ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e
    ON e.external_id::text = w.edition_key
   AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL
    AND e.set_name IS NOT NULL
  GROUP BY e.set_id;

  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END;
$function$;
-- <<< END verbatim refresh_cross_collection_cohort_step2 <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set sA '''5e700000-0000-0000-0000-00000000000a'''
\set sB '''5e700000-0000-0000-0000-00000000000b'''

-- COHORT: W1, W2.  NOT in the cohort: WOUT.
INSERT INTO public.cross_collection_cohort_mat (wallet_address) VALUES ('W1'), ('W2');

INSERT INTO public.editions (external_id, collection_id, set_id, set_name) VALUES
  ('10:1', :TS::uuid, :sA::uuid, 'Set A'),
  ('10:2', :TS::uuid, :sA::uuid, 'Set A'),
  ('10:3', :TS::uuid, :sB::uuid, 'Set B'),
  ('10:9', :TS::uuid, NULL,      'No Set Id'),   -- excluded: no set identity
  ('20:1', :AD::uuid, :sA::uuid, 'Set A'),       -- an All Day edition in "Set A"
  -- ⚠ An All Day edition sharing the external_id '10:1' with a Top Shot one.
  -- CLAUDE.md states outright that external_id is NOT unique across
  -- collections, so this is a real state — and it is the ONLY shape in which
  -- `e.collection_id = w.collection_id` is load-bearing: the wmc side is
  -- already pinned to Top Shot, so without a collision the editions-side scope
  -- is unobservable (its mutation passed until this row existed). Here it would
  -- make every Top Shot '10:1' moment ALSO count toward Set B.
  ('10:1', :AD::uuid, :sB::uuid, 'Set B');

-- W1 holds THREE moments of Set A -> ONE holder, three moments. That asymmetry
-- is the whole point of assertion 3.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key) VALUES
  ('W1', :TS::uuid, '10:1'),
  ('W1', :TS::uuid, '10:1'),
  ('W1', :TS::uuid, '10:2'),
  ('W2', :TS::uuid, '10:1'),
  ('W2', :TS::uuid, '10:3'),
  ('W1', :TS::uuid, '10:9'),          -- no set identity -> excluded
  -- ⚠ a cohort member's ALL DAY moment, whose edition maps to a set literally
  -- named "Set A". Without the collection scope it would be counted into the
  -- Top Shot set, inflating a Top Shot number with All Day holdings.
  ('W1', :AD::uuid, '20:1'),
  -- ⚠ a NON-cohort wallet with plenty of Set A. Without the cohort join every
  -- number here becomes plain set popularity under a column called
  -- `cohort_holders`.
  ('WOUT', :TS::uuid, '10:1'),
  ('WOUT', :TS::uuid, '10:2');

SELECT _assert_eq(
  (public.refresh_cross_collection_cohort_step2() ->> 'set_overlap_rows'), '2',
  'one row per Top Shot set held by the cohort'
);

-- ⚠ ONE holder is not three moments. A reader takes `cohort_holders` as "how
-- many people"; COUNT(*) there would inflate it by the depth of each position.
SELECT _assert_eq(
  (SELECT cohort_holders::text || '/' || moments_in_cohort::text
     FROM public.cross_collection_ts_set_overlap_mat WHERE set_id = :sA::uuid),
  '2/4',
  'holders are DISTINCT wallets while moments are rows — W1 holds 3 of Set A and counts once'
);

SELECT _assert_eq(
  (SELECT set_name || '/' || cohort_holders::text
     FROM public.cross_collection_ts_set_overlap_mat WHERE set_id = :sB::uuid),
  'Set B/1',
  'a set held by one cohort member reads as one holder'
);

-- ⚠ The cohort join. WOUT holds Set A twice and must contribute NOTHING.
SELECT _assert_eq(
  (SELECT moments_in_cohort::text FROM public.cross_collection_ts_set_overlap_mat
    WHERE set_id = :sA::uuid),
  '4',
  'a NON-cohort wallet contributes nothing — this is a cohort table, not a popularity table'
);

-- ⚠ The collection scope. W1's All Day moment maps to an edition whose set is
-- also called "Set A"; counting it would inflate a Top Shot figure with All Day.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_ts_set_overlap_mat
    WHERE moments_in_cohort > 4),
  '0',
  'a cohort member''s All Day moments are never counted into a Top Shot set'
);

-- An edition with no set identity is excluded rather than bucketed as nameless.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_ts_set_overlap_mat WHERE set_id IS NULL),
  '0',
  'an edition with no set_id is excluded, not grouped into a nameless bucket'
);

SELECT _assert_eq(
  (SELECT count(DISTINCT computed_at)::text FROM public.cross_collection_ts_set_overlap_mat),
  '1',
  'every row of a rebuild shares ONE computed_at'
);

-- ── The step1 coupling, both halves ────────────────────────────────────────
-- ⚠ There is no check that step1 ran. An EMPTY cohort yields an EMPTY overlap
-- table — quietly, with ok. Pinned so the failure mode is a known property: the
-- realistic version is not this but "yesterday's cohort", because step1
-- truncates inside its own transaction and a rolled-back step1 leaves the
-- previous cohort standing.
DELETE FROM public.cross_collection_cohort_mat;

SELECT _assert_eq(
  (public.refresh_cross_collection_cohort_step2() ->> 'set_overlap_rows'), '0',
  'an EMPTY cohort yields an EMPTY overlap table — there is no guard that step1 ran'
);

SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_ts_set_overlap_mat),
  '0',
  '...and the previous contents are gone, because the TRUNCATE happens first'
);

ROLLBACK;
