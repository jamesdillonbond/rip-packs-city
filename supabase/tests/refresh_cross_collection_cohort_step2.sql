-- DB invariant: public.refresh_cross_collection_cohort_step2 — pg_cron
-- `rpc-ccm-step2` @ `25 23 * * *` (moved from `25 4 * * *` on 2026-08-22 with the
-- lock-window rewrite below; step1 moved with it, to `10 23`).
--
-- WHAT IT DOES. Rebuilds `cross_collection_ts_set_overlap_mat`: for each Top
-- Shot SET, how many of the cross-collection cohort hold it and how many of
-- their moments it accounts for. It is the DOWNSTREAM half of an ordered pair —
-- step1 rebuilds the cohort at `10 23`, this reads it 15 minutes later.
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
--   6. Atomic replace in one transaction, same as step1: a mid-run failure
--      leaves the previous table intact. ⚠ Since 2026-08-22 the TRUNCATE no
--      longer happens FIRST — the aggregate builds into a temp table and the
--      truncate lands immediately before the insert, so the ACCESS EXCLUSIVE
--      lock a reader can see is milliseconds rather than the whole run. The
--      replace semantics are unchanged; only the lock window moved.
--
-- ⚠ ONE BEHAVIOUR CHANGED WITH THE REWRITE and is asserted below: the body is NOT
-- RE-ENTRANT WITHIN ONE TRANSACTION. `CREATE TEMP TABLE _ccm_step2_next ON COMMIT
-- DROP` survives until COMMIT, so a second call in the same transaction raises
-- 42P07. Harmless in production — pg_cron gives each run its own transaction — but
-- it is a real difference from the pre-08-22 body, which could be called
-- repeatedly. Output equivalence between the two bodies is pinned separately, by
-- set comparison in both directions, in
-- supabase/tests/refresh_cross_collection_cohort_lock_window.sql.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822013000_audit_20260821_cross_collection_refresh_lock_window.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-23
-- (md5 596b1a465985f82ffbfb9e9713388ee7, verified against the DB's own md5 rather
-- than by eye). __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
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
  CREATE TEMP TABLE _ccm_step2_next ON COMMIT DROP AS
  SELECT
    e.set_id,
    MAX(e.set_name) AS set_name,
    COUNT(DISTINCT w.wallet_address) AS cohort_holders,
    COUNT(*) AS moments_in_cohort
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

  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT set_id, set_name, cohort_holders, moments_in_cohort, v_started
  FROM _ccm_step2_next;

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

-- ── NOT RE-ENTRANT INSIDE ONE TRANSACTION (new with the lock-window rewrite) ──
-- The temp table from the call above is ON COMMIT DROP, so it is still here and a
-- second call in the same transaction must fail with duplicate_table (42P07).
-- Pinned as a REAL behaviour change, not endorsed.
DO $reentrancy$
BEGIN
  PERFORM public.refresh_cross_collection_cohort_step2();
  RAISE EXCEPTION 'a second call in the same transaction SUCCEEDED — the temp table is no longer ON COMMIT DROP, or the body stopped creating it';
EXCEPTION
  WHEN duplicate_table THEN NULL;  -- expected
END
$reentrancy$;

-- ⚠ TEST SCAFFOLDING, not a property of the function: everything here runs in one
-- rolled-back transaction, so the temp table must be cleared before the coupling
-- assertions below can call step2 again.
DROP TABLE IF EXISTS _ccm_step2_next;

SELECT _assert_eq(
  (public.refresh_cross_collection_cohort_step2() ->> 'set_overlap_rows'), '0',
  'an EMPTY cohort yields an EMPTY overlap table — there is no guard that step1 ran'
);

-- ⚠ The REASON here changed on 2026-08-22 and the old wording ("because the
-- TRUNCATE happens first") now describes a body that no longer exists. The
-- previous contents are gone because the rebuild is still a full REPLACE — an
-- empty cohort produces an empty temp table, the TRUNCATE lands immediately
-- before the insert, and the insert adds nothing. Same outcome, different reason,
-- and the reason is the part a reader would have carried forward as fact.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_ts_set_overlap_mat),
  '0',
  '...and the previous contents are gone: the rebuild is a full replace, not a merge'
);

ROLLBACK;
