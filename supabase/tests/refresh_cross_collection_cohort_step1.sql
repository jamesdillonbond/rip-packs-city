-- DB invariant: public.refresh_cross_collection_cohort_step1 — pg_cron
-- `rpc-ccm-step1` @ `10 23 * * *` (moved from `10 4 * * *` on 2026-08-22 with the
-- lock-window rewrite below; the healthy window is the Pacific afternoon).
--
-- WHAT IT DOES. Rebuilds `cross_collection_cohort_mat`: one row per wallet that
-- holds moments in THREE OR MORE published collections, with a per-collection
-- moment breakdown and an approximate portfolio FMV.
--
-- ⚠ THE THRESHOLD IS THE PRODUCT DEFINITION. `HAVING COUNT(DISTINCT
-- collection_id) >= 3` is not a tuning constant — it is what "cross-collection
-- collector" MEANS on this platform, and every downstream figure (step2's set
-- overlap, and anything reading this table) is a statement about that cohort.
-- Moving it silently changes what every one of those numbers is about.
--
-- ⚠ TRUNCATE-THEN-INSERT IN ONE TRANSACTION. That is what makes the rebuild
-- atomic: a reader either sees the whole old cohort or the whole new one, never
-- an empty table. It also means a FAILURE part-way rolls the truncate back —
-- so a failed run leaves the previous cohort intact rather than an empty one.
-- Asserted, because "TRUNCATE then rebuild" is exactly the shape that looks
-- dangerous and is safe only because of the surrounding transaction.
--
-- THE OTHER PROPERTIES:
--   • ⚠ `SUM(COALESCE(w.fmv_usd, 0))` — and what this ACTUALLY does is not what
--     it looks like. SQL's `SUM` already IGNORES NULLs, so for a wallet with any
--     priced moment the COALESCE changes nothing (mutation-confirmed: removing
--     it leaves every total identical). The ONE case it changes is a wallet
--     whose moments are ALL unpriced: `SUM(NULL)` is NULL, and the COALESCE
--     turns that into a hard **0.00**.
--     ⚠ That is a claim, not an absence — a cross-collection collector holding
--     seven unpriced moments is published as owning $0.00 rather than "we could
--     not price this". It is the same shape as the `?? 0` findings CLAUDE.md
--     records on `/rewards` and the overview panels. Recorded and asserted as
--     the CURRENT behaviour, not endorsed; changing it is a product decision
--     about what every consumer of `approx_fmv_usd` should render.
--   • The five per-collection counters are `FILTER`ed by hardcoded collection
--     uuids, so a NEW published collection counts toward `n_collections` and
--     `total_moments` but has no column of its own. That is a real consequence
--     worth knowing before a sixth collection publishes.
--   • `computed_at` is a single `NOW()` captured once, so every row in a rebuild
--     carries the SAME timestamp — that is what makes the table's freshness
--     answerable with one value rather than a range.
--
-- ⚠ THE LOCK WINDOW IS THE 2026-08-22 REWRITE, and it is why the body no longer
-- opens with TRUNCATE. The old body truncated first and then ran a 105–350 s
-- aggregate, holding the ACCESS EXCLUSIVE lock for the whole run against a public,
-- crawlable board. The live body computes into a TEMP TABLE first and truncates
-- immediately before a tiny insert, so the reader-visible lock is milliseconds.
-- Output equivalence between the two bodies is pinned separately and directly, by
-- set comparison in both directions, in
-- supabase/tests/refresh_cross_collection_cohort_lock_window.sql.
--
-- ⚠ ONE BEHAVIOUR DID CHANGE, and it is asserted below: the new body is NOT
-- RE-ENTRANT WITHIN ONE TRANSACTION. `CREATE TEMP TABLE _ccm_step1_next ON COMMIT
-- DROP` survives until COMMIT, so a second call in the same transaction raises
-- 42P07. Harmless in production — pg_cron gives each run its own transaction — but
-- it is a real difference from the old body, which could be called repeatedly, and
-- an unpinned behaviour change is how the next caller finds out the hard way.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260822013000_audit_20260821_cross_collection_refresh_lock_window.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-23
-- (md5 d7712cf95a85a210e494c822e8cdd324, verified against the DB's own md5 rather
-- than by eye). __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.wallet_moments_cache (
  wallet_address text,
  collection_id  uuid,
  fmv_usd        numeric
);

CREATE TABLE public.cross_collection_cohort_mat (
  wallet_address    text,
  n_collections     int,
  total_moments     int,
  ts_moments        int,
  allday_moments    int,
  golazos_moments   int,
  pinnacle_moments  int,
  ufc_moments       int,
  approx_fmv_usd    numeric,
  computed_at       timestamptz
);

-- >>> BEGIN verbatim refresh_cross_collection_cohort_step1 (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.refresh_cross_collection_cohort_step1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '180s'
AS $function$
DECLARE
  v_cohort_count int := 0;
  v_started timestamptz := NOW();
BEGIN
  -- Expensive scan FIRST, holding no lock on the reader-facing table.
  CREATE TEMP TABLE _ccm_step1_next ON COMMIT DROP AS
  SELECT
    w.wallet_address,
    COUNT(DISTINCT w.collection_id) AS n_collections,
    COUNT(*) AS total_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd') AS ts_moments,
    COUNT(*) FILTER (WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070') AS allday_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75') AS golazos_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714') AS pinnacle_moments,
    COUNT(*) FILTER (WHERE w.collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023') AS ufc_moments,
    ROUND(SUM(COALESCE(w.fmv_usd, 0))::numeric, 2) AS approx_fmv_usd
  FROM wallet_moments_cache w
  GROUP BY w.wallet_address
  HAVING COUNT(DISTINCT w.collection_id) >= 3;

  -- Lock window starts here and ends at COMMIT, a few rows later.
  TRUNCATE TABLE public.cross_collection_cohort_mat;

  INSERT INTO public.cross_collection_cohort_mat (
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, computed_at
  )
  SELECT
    wallet_address, n_collections, total_moments,
    ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments,
    approx_fmv_usd, v_started
  FROM _ccm_step1_next;

  GET DIAGNOSTICS v_cohort_count = ROW_COUNT;
  RETURN jsonb_build_object('cohort_size', v_cohort_count, 'computed_at', v_started);
END;
$function$;
-- <<< END verbatim refresh_cross_collection_cohort_step1 <<<

\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set GZ '''06248cc4-b85f-47cd-af67-1855d14acd75'''
\set PN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set UF '''9b4824a8-736d-4a96-b450-8dcc0c46b023'''
\set CANDY '''209ade70-32c5-4470-bc7c-4793d660f713'''

-- W3  : exactly 3 collections           -> IN the cohort (the boundary)
-- W2  : exactly 2 collections           -> OUT (the other side of it)
-- W5  : all five, with an UNPRICED moment
-- WDUP: 3 moments but only 1 collection -> OUT (DISTINCT, not COUNT(*))
INSERT INTO public.wallet_moments_cache (wallet_address, collection_id, fmv_usd) VALUES
  ('W3', :TS::uuid, 10.00),
  ('W3', :AD::uuid, 20.00),
  ('W3', :GZ::uuid, 30.00),

  ('W2', :TS::uuid, 100.00),
  ('W2', :AD::uuid, 200.00),

  ('W5', :TS::uuid, 1.00),
  ('W5', :TS::uuid, NULL),      -- unpriced: must contribute 0, not NULL the sum
  ('W5', :AD::uuid, 2.00),
  ('W5', :GZ::uuid, 3.00),
  ('W5', :PN::uuid, 4.00),
  ('W5', :UF::uuid, 5.00),
  -- ⚠ an UNPUBLISHED collection (candy_mlb) still counts toward n_collections.
  -- It has no FILTERed column of its own, so it is invisible in the breakdown
  -- while being visible in the totals — the consequence of hardcoded uuids.
  ('W5', :CANDY::uuid, 6.00),

  ('WDUP', :TS::uuid, 7.00),
  ('WDUP', :TS::uuid, 8.00),
  ('WDUP', :TS::uuid, 9.00),

  -- ⚠ WNULL is in the cohort and every one of its moments is UNPRICED. This is
  -- the only fixture where the COALESCE changes the answer, and it is what makes
  -- the mutation observable at all — without it, removing the COALESCE passes,
  -- because SUM already skips NULLs.
  ('WNULL', :TS::uuid, NULL),
  ('WNULL', :AD::uuid, NULL),
  ('WNULL', :GZ::uuid, NULL);

SELECT _assert_eq(
  (public.refresh_cross_collection_cohort_step1() ->> 'cohort_size'), '3',
  'only the wallets spanning 3+ collections enter the cohort'
);

-- ⚠ THE THRESHOLD, from both sides. It is the product definition of a
-- cross-collection collector, not a tuning constant.
SELECT _assert_eq(
  (SELECT n_collections::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'W3'),
  '3',
  'EXACTLY 3 collections is IN — the boundary is >=, and this is where an off-by-one lives'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'W2'),
  '0',
  'exactly 2 collections is OUT'
);

-- ⚠ COUNT(DISTINCT collection_id), not COUNT(*): three moments in ONE
-- collection is a single-collection wallet, not a cross-collection one.
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'WDUP'),
  '0',
  'three moments in ONE collection is not a cross-collection wallet'
);

-- ⚠ An unpriced moment contributes 0. Without the COALESCE a single NULL fmv
-- erases the wallet's ENTIRE portfolio value — and a NULL renders as nothing,
-- which is more misleading than a total that is honest about what it could price.
-- SUM ignores NULLs, so ONE unpriced moment among priced ones is simply skipped
-- and the total is the sum of what could be priced. (This assertion holds with
-- or without the COALESCE — stated so nobody reads it as pinning the COALESCE.)
SELECT _assert_eq(
  (SELECT approx_fmv_usd::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'W5'),
  '21.00',
  'one unpriced moment among priced ones does not disturb the total'
);

-- ⚠ THE CASE THE COALESCE ACTUALLY GOVERNS, and it publishes a CLAIM out of an
-- absence: a cohort wallet whose every moment is unpriced reads $0.00, not NULL.
-- Same shape as the `?? 0` findings on /rewards and the overview panels. Pinned
-- as the CURRENT behaviour, not endorsed — changing it is a product decision
-- about what every consumer of approx_fmv_usd renders.
SELECT _assert_eq(
  (SELECT approx_fmv_usd::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'WNULL'),
  '0.00',
  'a wallet whose moments are ALL unpriced is published as $0.00 rather than NULL'
);

SELECT _assert_eq(
  (SELECT total_moments::text || '/' || n_collections::text || '/' ||
          ts_moments::text || '/' || allday_moments::text || '/' || golazos_moments::text || '/' ||
          pinnacle_moments::text || '/' || ufc_moments::text
     FROM public.cross_collection_cohort_mat WHERE wallet_address = 'W5'),
  '7/6/2/1/1/1/1',
  'the per-collection breakdown sums to LESS than total_moments when an unlisted collection is held'
);

SELECT _assert_eq(
  (SELECT count(DISTINCT computed_at)::text FROM public.cross_collection_cohort_mat),
  '1',
  'every row of a rebuild shares ONE computed_at, so freshness is a single value'
);

-- ── NOT RE-ENTRANT INSIDE ONE TRANSACTION (new with the lock-window rewrite) ──
-- The temp table is ON COMMIT DROP, so it is still there. A second call in the
-- same transaction must therefore fail with duplicate_table (42P07). Pinned as a
-- REAL behaviour change, not endorsed: production is unaffected because pg_cron
-- runs each tick in its own transaction, but anything that calls step1 twice in
-- one transaction — a retry wrapper, a DO block, a test — now errors where the
-- pre-08-22 body succeeded.
DO $reentrancy$
BEGIN
  PERFORM public.refresh_cross_collection_cohort_step1();
  RAISE EXCEPTION 'a second call in the same transaction SUCCEEDED — the temp table is no longer ON COMMIT DROP, or the body stopped creating it';
EXCEPTION
  WHEN duplicate_table THEN NULL;  -- expected
END
$reentrancy$;

-- Clear it so the replace/atomicity assertions below can call the function again.
-- ⚠ This DROP is TEST SCAFFOLDING, not a property of the function. It exists only
-- because everything here runs in one rolled-back transaction.
DROP TABLE IF EXISTS _ccm_step1_next;

-- ── The rebuild is a full replace, and it is atomic ────────────────────────
DELETE FROM public.wallet_moments_cache WHERE wallet_address = 'W3';

SELECT _assert_eq(
  (public.refresh_cross_collection_cohort_step1() ->> 'cohort_size'), '2',
  'a wallet that leaves the cohort is REMOVED, not left behind — TRUNCATE then rebuild'
);
SELECT _assert_eq(
  (SELECT count(*)::text FROM public.cross_collection_cohort_mat WHERE wallet_address = 'W3'),
  '0',
  '...so no stale cohort member survives a rebuild'
);

ROLLBACK;
