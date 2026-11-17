-- DB invariant: refresh_cross_collection_cohort_step1 / _step2 — the 2026-08-21 PT
-- lock-window reorder is OUTPUT-EQUIVALENT to the bodies it replaces.
--
-- ⚠ WHAT THIS PIN IS FOR. The rewrite exists to shrink an ACCESS EXCLUSIVE lock,
-- not to change results: both functions used to `TRUNCATE` first and then run a
-- 105–350 s aggregate, holding the exclusive lock (which blocks readers of a
-- public, crawlable board) for the whole run. The new bodies compute into a temp
-- table first and truncate immediately before a tiny insert. That is only a safe
-- change if the OUTPUT is identical, so this asserts exactly that — the old body
-- and the new body are both defined here, run against the SAME fixture, and their
-- resulting tables are compared as SETS.
--
-- ⚠ Comparing with EXCEPT in BOTH directions, not by row count. A count-only
-- assertion passes when the right NUMBER of wrong rows is produced — the failure
-- this repo keeps recording. `computed_at` is excluded from the comparison
-- because both bodies stamp it from their own `NOW()`, which is transaction-stable
-- but differs between the two runs by construction; its behaviour is pinned
-- separately below.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── Fixtures. Types match information_schema, not intuition. ────────────────
CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  edition_key    text,
  fmv_usd        numeric
);

CREATE TABLE public.editions (
  external_id   text,
  collection_id uuid,
  set_id        text,
  set_name      text
);

CREATE TABLE public.cross_collection_cohort_mat (
  wallet_address   text PRIMARY KEY,
  n_collections    int,
  total_moments    int,
  ts_moments       int,
  allday_moments   int,
  golazos_moments  int,
  pinnacle_moments int,
  ufc_moments      int,
  approx_fmv_usd   numeric,
  computed_at      timestamptz
);

CREATE TABLE public.cross_collection_ts_set_overlap_mat (
  set_id            text PRIMARY KEY,
  set_name          text,
  cohort_holders    int,
  moments_in_cohort int,
  computed_at       timestamptz
);

-- Collection UUIDs are the real ones — a fixture using invented ids would pass
-- while the FILTER predicates in the body pointed anywhere at all.
-- ⚠ EVERY ROW HERE EARNS ITS PLACE — the first version of this fixture let TWO
-- mutants live: dropping COALESCE, and dropping the `set_name IS NOT NULL`
-- filter. Both survived because the fixture never reached the clause.
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, edition_key, fmv_usd) VALUES
  -- 0xA holds 3 collections -> IN the cohort (HAVING >= 3)
  ('0xA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1', 10.00),
  ('0xA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2', 5.50),
  ('0xA', 'dee28451-5d62-409e-a1ad-a83f763ac070', '3', 1.25),
  ('0xA', '06248cc4-b85f-47cd-af67-1855d14acd75', '4', NULL),
  -- 0xB holds exactly 3 -> IN, and lands on the >= 3 BOUNDARY
  ('0xB', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1', 2.00),
  ('0xB', '7dd9dd11-e8b6-45c4-ac99-71331f959714', '9', 3.00),
  ('0xB', '9b4824a8-736d-4a96-b450-8dcc0c46b023', '9', 4.00),
  -- 0xC holds only 2 -> OUT. Its TopShot moments must NOT reach step2.
  ('0xC', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1', 99.00),
  ('0xC', 'dee28451-5d62-409e-a1ad-a83f763ac070', '3', 99.00),
  -- ⚠ 0xD makes COALESCE LOAD-BEARING. `SUM` already skips NULLs, so a single
  -- NULL row proves nothing — COALESCE only changes the answer when EVERY value
  -- is NULL, where SUM returns NULL and COALESCE turns it into 0. A cohort
  -- wallet with no priced moments at all is the only shape that tests it.
  -- ⚠ Its TopShot rows also carry the two edition shapes step2 must FILTER OUT
  -- (edition 7: set_id NULL; edition 8: set_name NULL), which nothing else in
  -- this fixture reaches.
  ('0xD', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '7', NULL),
  ('0xD', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '8', NULL),
  ('0xD', 'dee28451-5d62-409e-a1ad-a83f763ac070', '3', NULL),
  ('0xD', '9b4824a8-736d-4a96-b450-8dcc0c46b023', '9', NULL);

INSERT INTO public.editions (external_id, collection_id, set_id, set_name) VALUES
  ('1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'set-1', 'Base Set'),
  ('2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'set-1', 'Base Set'),
  -- set_id NULL and set_name NULL are both filtered out by the WHERE clause.
  ('7', '95f28a17-224a-4025-96ad-adf8a4c63bfd', NULL,    'Orphan'),
  ('8', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'set-2', NULL);

-- ── The OLD bodies, verbatim in shape: TRUNCATE first, then the aggregate. ──
CREATE FUNCTION public.old_step1() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_cohort_count int := 0; v_started timestamptz := NOW();
BEGIN
  TRUNCATE TABLE public.cross_collection_cohort_mat;
  INSERT INTO public.cross_collection_cohort_mat (
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, computed_at)
  SELECT w.wallet_address, COUNT(DISTINCT w.collection_id), COUNT(*),
    COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
    COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'),
    COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'),
    COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'),
    COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'),
    ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2), v_started
  FROM wallet_moments_cache w GROUP BY w.wallet_address
  HAVING COUNT(DISTINCT w.collection_id) >= 3;
  GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
  RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
END; $f$;

CREATE FUNCTION public.old_step2() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_set_count int := 0; v_started timestamptz := NOW();
BEGIN
  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;
  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT e.set_id, MAX(e.set_name), COUNT(DISTINCT w.wallet_address), COUNT(*), v_started
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL AND e.set_name IS NOT NULL
  GROUP BY e.set_id;
  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END; $f$;

-- ── The NEW bodies, byte-identical to the committed migration's logic. ──────
CREATE FUNCTION public.new_step1() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_cohort_count int := 0; v_started timestamptz := NOW();
BEGIN
  CREATE TEMP TABLE _ccm_step1_next ON COMMIT DROP AS
  SELECT w.wallet_address,
    COUNT(DISTINCT w.collection_id) AS n_collections, COUNT(*) AS total_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd') AS ts_moments,
    COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070') AS allday_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75') AS golazos_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714') AS pinnacle_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023') AS ufc_moments,
    ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2) AS approx_fmv_usd
  FROM wallet_moments_cache w GROUP BY w.wallet_address
  HAVING COUNT(DISTINCT w.collection_id) >= 3;

  TRUNCATE TABLE public.cross_collection_cohort_mat;

  INSERT INTO public.cross_collection_cohort_mat (
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, computed_at)
  SELECT wallet_address, n_collections, total_moments, ts_moments, allday_moments,
         golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd, v_started
  FROM _ccm_step1_next;
  GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
  RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
END; $f$;

CREATE FUNCTION public.new_step2() RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_set_count int := 0; v_started timestamptz := NOW();
BEGIN
  CREATE TEMP TABLE _ccm_step2_next ON COMMIT DROP AS
  SELECT e.set_id, MAX(e.set_name) AS set_name,
         COUNT(DISTINCT w.wallet_address) AS cohort_holders, COUNT(*) AS moments_in_cohort
  FROM public.cross_collection_cohort_mat c
  JOIN wallet_moments_cache w ON w.wallet_address = c.wallet_address
   AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  JOIN editions e ON e.external_id::text = w.edition_key AND e.collection_id = w.collection_id
  WHERE e.set_id IS NOT NULL AND e.set_name IS NOT NULL
  GROUP BY e.set_id;

  TRUNCATE TABLE public.cross_collection_ts_set_overlap_mat;

  INSERT INTO public.cross_collection_ts_set_overlap_mat (set_id, set_name, cohort_holders, moments_in_cohort, computed_at)
  SELECT set_id, set_name, cohort_holders, moments_in_cohort, v_started
  FROM _ccm_step2_next;
  GET DIAGNOSTICS v_set_count = ROW_COUNT;
  RETURN jsonb_build_object('set_overlap_rows', v_set_count, 'computed_at', v_started);
END; $f$;

-- ── Run the OLD pair and snapshot both outputs. ────────────────────────────
SELECT _assert_eq((public.old_step1()->>'cohort_size'), '3',
  'old step1: exactly the three >=3-collection wallets enter the cohort');
SELECT _assert_eq((public.old_step2()->>'set_overlap_rows'), '1',
  'old step2: only set-1 survives the set_id/set_name NOT NULL filter');

CREATE TEMP TABLE old_cohort AS
  SELECT wallet_address, n_collections, total_moments, ts_moments, allday_moments,
         golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd
  FROM public.cross_collection_cohort_mat;
CREATE TEMP TABLE old_overlap AS
  SELECT set_id, set_name, cohort_holders, moments_in_cohort
  FROM public.cross_collection_ts_set_overlap_mat;

-- The fixture must actually exercise the thing, or the comparison below is
-- vacuous — two empty tables are trivially equal.
SELECT _assert((SELECT count(*) FROM old_cohort) = 3,
  'not vacuous: the old body produced the 3 cohort rows being compared');
SELECT _assert((SELECT count(*) FROM old_overlap) = 1,
  'not vacuous: the old body produced the overlap row being compared');

-- ── Run the NEW pair over the same fixture. ────────────────────────────────
SELECT _assert_eq((public.new_step1()->>'cohort_size'), '3',
  'new step1 reports the same cohort size');
SELECT _assert_eq((public.new_step2()->>'set_overlap_rows'), '1',
  'new step2 reports the same overlap row count');

-- ── THE ASSERTION THAT MATTERS: set equality, both directions. ─────────────
SELECT _assert(NOT EXISTS (
  SELECT wallet_address, n_collections, total_moments, ts_moments, allday_moments,
         golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd
    FROM public.cross_collection_cohort_mat
  EXCEPT
  SELECT * FROM old_cohort
), 'cohort: no row the NEW body produced is absent from the OLD result');

SELECT _assert(NOT EXISTS (
  SELECT * FROM old_cohort
  EXCEPT
  SELECT wallet_address, n_collections, total_moments, ts_moments, allday_moments,
         golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd
    FROM public.cross_collection_cohort_mat
), 'cohort: no row the OLD body produced is missing from the NEW result');

SELECT _assert(NOT EXISTS (
  SELECT set_id, set_name, cohort_holders, moments_in_cohort
    FROM public.cross_collection_ts_set_overlap_mat
  EXCEPT SELECT * FROM old_overlap
), 'overlap: no row the NEW body produced is absent from the OLD result');

SELECT _assert(NOT EXISTS (
  SELECT * FROM old_overlap
  EXCEPT SELECT set_id, set_name, cohort_holders, moments_in_cohort
    FROM public.cross_collection_ts_set_overlap_mat
), 'overlap: no row the OLD body produced is missing from the NEW result');

-- Spot-pin the arithmetic so a rewrite that broke BOTH bodies identically would
-- still be caught. 0xA: 4 moments, 3 collections, 10.00+5.50+1.25+NULL -> 16.75.
-- ⚠ 0xA proves SUM's own NULL-skipping (10.00+5.50+1.25, the NULL ignored) —
-- which is NOT what COALESCE is for. 0xD is the one that pins COALESCE: all four
-- of its rows are NULL, so SUM returns NULL and only COALESCE makes it 0.00.
SELECT _assert_eq(
  (SELECT approx_fmv_usd::text FROM public.cross_collection_cohort_mat WHERE wallet_address='0xA'),
  '16.75', 'SUM skips a NULL fmv row rather than nulling the whole total');
SELECT _assert_eq(
  (SELECT approx_fmv_usd::text FROM public.cross_collection_cohort_mat WHERE wallet_address='0xD'),
  '0.00', 'COALESCE(fmv_usd,0): an all-NULL wallet reports 0.00, never NULL');
SELECT _assert_eq(
  (SELECT ts_moments::text FROM public.cross_collection_cohort_mat WHERE wallet_address='0xA'),
  '2', 'the per-collection FILTER counters still key on the real collection UUIDs');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.cross_collection_cohort_mat WHERE wallet_address='0xC'),
  'a 2-collection wallet is still excluded by HAVING >= 3');
SELECT _assert_eq(
  (SELECT moments_in_cohort::text FROM public.cross_collection_ts_set_overlap_mat WHERE set_id='set-1'),
  '3', 'step2 counts only cohort wallets: 0xA''s 2 + 0xB''s 1, never 0xC''s');
SELECT _assert_eq(
  (SELECT cohort_holders::text FROM public.cross_collection_ts_set_overlap_mat WHERE set_id='set-1'),
  '2', 'cohort_holders counts DISTINCT wallets, not rows');
-- ⚠ The two filter clauses, asserted as ABSENCES. 0xD holds both offending
-- editions, so dropping either clause makes a second overlap row appear.
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.cross_collection_ts_set_overlap_mat WHERE set_id IS NULL),
  'an edition with a NULL set_id never becomes an overlap row');
SELECT _assert(
  NOT EXISTS (SELECT 1 FROM public.cross_collection_ts_set_overlap_mat WHERE set_name IS NULL),
  'an edition with a NULL set_name never becomes an overlap row (set-2 is excluded)');

-- computed_at is stamped from the function's own NOW() in both bodies — pin that
-- it is populated and transaction-stable, which is the property the board's new
-- age display depends on.
SELECT _assert(
  (SELECT count(DISTINCT computed_at) FROM public.cross_collection_cohort_mat) = 1,
  'computed_at is one transaction-stable instant across the whole rebuild');
SELECT _assert(
  (SELECT bool_and(computed_at IS NOT NULL) FROM public.cross_collection_ts_set_overlap_mat),
  'computed_at is never NULL — the board renders it as the data age');

ROLLBACK;
