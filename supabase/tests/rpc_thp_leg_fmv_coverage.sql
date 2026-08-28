-- DB invariant: public.rpc_thp_leg_fmv_coverage — the per-collection FMV
-- coverage leg of the trust-board precompute, on pg_cron jobid 325
-- (`48 1,7,13,19 * * *`) since the 2026-08-16 8-way split.
--
-- WHY THIS LEG IS WORTH PINNING AT ALL. It writes TEN of the board's arms in one
-- statement (`<collection>_fmv_pct_stale_30d` x5, `<collection>_fmv_high_med_share_pct`
-- x5). `v_rpc_trust_health` carries no per-metric age, so a leg that writes a
-- WRONG number is indistinguishable from one that wrote a right one — the only
-- instrument between that and an operator acting on it is the max-age arm, and
-- max-age cannot see a value that is fresh and wrong. The share metric is also
-- the platform's HEADLINE accuracy metric (roadmap-2026-08-03 §3.1).
--
-- ⚠ THE FINDING THIS FILE EXISTS TO RECORD: THE TWO `COALESCE(..., 0)` DEFAULTS
-- POINT IN OPPOSITE DIRECTIONS FOR THE IDENTICAL INPUT. A collection with zero
-- rows in `fmv_snapshots` produces no `agg` row at all, so both LEFT JOINs miss
-- and both metrics publish 0. For `pct_stale_30d`, 0 means "nothing is stale" —
-- it reads as PERFECT, and it is manufactured out of ABSENCE (breach thresholds
-- are upper bounds, so a total FMV outage that also removed the snapshots would
-- publish a green arm). For `high_med_share_pct`, 0 means "no confident price" —
-- it reads as WORST. Same absence, opposite verdicts, one line apart.
--
-- That is the failure-renders-as-data class living inside a trust arm, and it is
-- pinned here as CURRENT BEHAVIOUR, not endorsed. Changing it is a judgement call
-- with real consequences (a NULL would have to be given a meaning by every
-- consumer, and `ufc_fmv_pct_stale_30d` reads 0.0 legitimately today because that
-- market is closed) — so this test locks the behaviour in BOTH directions and
-- names what a future fix would have to decide. Do not "fix" it by making the
-- test expect NULL without changing the function and its consumers together.
--
-- ⚠ CHANGED 2026-08-28 (audit_20260828_r41_fmv_coverage_leg_all_rows_denominator):
-- the 2026-08-04 Top-Shot canonical-only filter is REMOVED per Trevor's R41 decision —
-- the accuracy-gate denominator is ALL ROWS. Both TS metrics changed denominator
-- (share ~55.7 -> ~38.4, stale ~0.0 -> ~31.7 with a ~32.6% structural floor from the
-- 6,426-row non-canonical dead residue; breach_at 50 stands and is MORE sensitive to
-- canonical drift). The editions LEFT JOIN existed only for the filter and is gone;
-- TS orphan snapshots now COUNT, same as every other collection.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260828225605_audit_20260828_r41_fmv_coverage_leg_all_rows_denominator.sql),
-- whose body was verified against live prod prosrc after apply on 2026-08-28.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- Minimal stand-ins. Only the columns the leg reads.
CREATE TABLE public.rpc_trust_health_precompute (
  metric      text PRIMARY KEY,
  value       numeric,
  computed_at timestamptz,
  duration_ms numeric
);

CREATE TABLE public.editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text
);

CREATE TABLE public.fmv_snapshots (
  edition_id    uuid,
  collection_id uuid,
  computed_at   timestamptz,
  confidence    text
);

-- >>> BEGIN verbatim rpc_thp_leg_fmv_coverage (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_coverage()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '240s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp();
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (fs.collection_id, fs.edition_id)
             fs.collection_id, fs.edition_id, fs.computed_at, fs.confidence
      FROM public.fmv_snapshots fs
      ORDER BY fs.collection_id, fs.edition_id, fs.computed_at DESC
    ),
    elig AS (
      SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence
      FROM latest l
    ),
    agg AS (
      SELECT elig.collection_id,
             round(100.0 * count(*) FILTER (WHERE elig.computed_at < (now() - '30 days'::interval))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS pct_stale_30d,
             round(100.0 * count(*) FILTER (WHERE elig.confidence IN ('HIGH','MEDIUM'))::numeric
                   / NULLIF(count(*), 0)::numeric, 1) AS high_med_pct
      FROM elig GROUP BY elig.collection_id
    ),
    want(metric, collection_id) AS (
      VALUES ('topshot_fmv_pct_stale_30d', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_pct_stale_30d',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_pct_stale_30d', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_pct_stale_30d',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_pct_stale_30d',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    want_share(metric, collection_id) AS (
      VALUES ('topshot_fmv_high_med_share_pct', '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
             ('allday_fmv_high_med_share_pct',  'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
             ('golazos_fmv_high_med_share_pct', '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
             ('ufc_fmv_high_med_share_pct',     '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
             ('candy_fmv_high_med_share_pct',   '209ade70-32c5-4470-bc7c-4793d660f713'::uuid)
    ),
    resolved AS (
      SELECT w.metric, COALESCE(a.pct_stale_30d, 0::numeric) AS value
      FROM want w LEFT JOIN agg a ON a.collection_id = w.collection_id
      UNION ALL
      SELECT w.metric, COALESCE(a.high_med_pct, 0::numeric) AS value
      FROM want_share w LEFT JOIN agg a ON a.collection_id = w.collection_id
    )
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT r.metric, r.value, now(),
           round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM resolved r
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['topshot_fmv_pct_stale_30d','allday_fmv_pct_stale_30d','golazos_fmv_pct_stale_30d',
                      'ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                      'topshot_fmv_high_med_share_pct','allday_fmv_high_med_share_pct','golazos_fmv_high_med_share_pct',
                      'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_fmv_coverage <<<

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Kept byte-identical to the pre-2026-08-28 fixture ON PURPOSE: the rows that the
-- old canonical predicate EXCLUDED (the UUID-keyed edition and the orphan
-- snapshot) are exactly what proves the filter is GONE — they must now COUNT.
-- AllDay's non-canonical external_id row proves nothing filters any collection.
-- Golazos/UFC/Candy: NO ROWS AT ALL — the absence-publishes-0 case.
INSERT INTO public.editions (id, collection_id, external_id) VALUES
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd','48:1652'),
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd','121:4255'),
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd','12:34::7'),
  ('44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd','55:66'),
  -- non-canonical Top Shot key (the UUID-pair convention) — since R41 it COUNTS
  ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd','aaaaaaaa-bbbb:cccc-dddd'),
  -- AllDay edition with a non-canonical external_id — counts, as it always did
  ('66666666-6666-6666-6666-666666666666','dee28451-5d62-409e-a1ad-a83f763ac070','not-a-canonical-key');

INSERT INTO public.fmv_snapshots (edition_id, collection_id, computed_at, confidence) VALUES
  -- TS #1: stale AND high-confidence (proves the two FILTERs are independent)
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '40 days','HIGH'),
  -- TS #2: fresh, LOW
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '1 day','LOW'),
  -- TS #3: two snapshots — an OLD HIGH superseded by a NEW LOW. DISTINCT ON must
  -- take the newest, so this edition counts as fresh + not-confident.
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '60 days','HIGH'),
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '2 days','LOW'),
  -- TS #4: fresh MEDIUM (MEDIUM must count toward the share alongside HIGH)
  ('44444444-4444-4444-4444-444444444444','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '3 days','MEDIUM'),
  -- TS non-canonical: stale + HIGH. Since R41 it counts in BOTH TS percentages —
  -- it moves both, so one row asserts the filter's absence twice.
  ('55555555-5555-5555-5555-555555555555','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '90 days','HIGH'),
  -- TS ORPHAN: a snapshot whose edition row does not exist. With no editions join
  -- left in the leg, it COUNTS — identical treatment to every other collection.
  ('99999999-9999-9999-9999-999999999999','95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '90 days','HIGH'),
  -- AllDay: one fresh HIGH + one ORPHAN (no edition row). Both count, as before.
  ('66666666-6666-6666-6666-666666666666','dee28451-5d62-409e-a1ad-a83f763ac070', now() - interval '5 days','HIGH'),
  ('88888888-8888-8888-8888-888888888888','dee28451-5d62-409e-a1ad-a83f763ac070', now() - interval '99 days','NO_DATA');

SELECT public.rpc_thp_leg_fmv_coverage();

-- ── All ten arms are written every run ──────────────────────────────────────
-- A leg that silently wrote fewer would leave the missing arms frozen at their
-- previous value, which no consumer can distinguish from a fresh reading.
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '10',
  'the leg writes all ten arms in one statement (5 stale + 5 share)');

-- ── Top Shot: the arithmetic, on ALL SIX latest-FMV rows (R41, 2026-08-28) ───
-- 6 eligible: #1 stale/HIGH, #2 fresh/LOW, #3 fresh/LOW (newest wins),
-- #4 fresh/MEDIUM, #5 non-canonical stale/HIGH, orphan stale/HIGH.
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_fmv_pct_stale_30d'), '50.0',
  'TS stale% counts ALL rows: 3 of 6 older than 30d (incl. the non-canonical row '
  'and the orphan the pre-R41 predicate excluded)');
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_fmv_high_med_share_pct'), '66.7',
  'TS share counts HIGH and MEDIUM over ALL rows: 4 of 6');

-- ⚠ These exact values are what the OLD pin predicted for "the filter is gone"
-- (its comment: "if the orphan leaked in too, 50.0 and 66.7"). If a canonical
-- filter is ever REINTRODUCED, these read 25.0/50.0 and this pin reddens —
-- the R41 decision (all-rows denominator) is what this asserts, in both directions.

-- ── NO collection is filtered, and orphans count UNIFORMLY ───────────────────
-- AllDay has 2 rows (one non-canonical external_id, one with no edition row at
-- all). Both count — same treatment Top Shot now gets.
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='allday_fmv_pct_stale_30d'), '50.0',
  'a non-Top-Shot collection is NOT filtered by external_id (1 of 2 stale)');
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='allday_fmv_high_med_share_pct'), '50.0',
  'AllDay share: the HIGH row counts, the orphan NO_DATA row does not');

-- ── ⚠ THE HEADLINE: ABSENCE PUBLISHES 0 FOR BOTH, MEANING OPPOSITE THINGS ────
-- Golazos, UFC and Candy have no snapshot rows whatsoever. Neither metric is
-- withheld and neither is NULL; both are a hard 0.
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='golazos_fmv_pct_stale_30d'), '0',
  'a collection with NO FMV rows publishes 0% stale — which reads as PERFECTLY FRESH. '
  'This is manufactured out of absence: the breach threshold is an upper bound, so a '
  'total FMV outage that also removed the snapshots would show a GREEN arm.');
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='golazos_fmv_high_med_share_pct'), '0',
  'the SAME absence publishes 0% high/med share — which reads as the WORST possible '
  'reading. One line apart, one COALESCE(...,0) each, opposite verdicts from identical input.');
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute
                    WHERE metric IN ('ufc_fmv_pct_stale_30d','candy_fmv_pct_stale_30d',
                                     'ufc_fmv_high_med_share_pct','candy_fmv_high_med_share_pct')
                      AND value = 0), '4',
  'every zero-row collection takes the same path — this is the shape, not a Golazos quirk');

-- ── Idempotent: the arms are keyed, not appended ────────────────────────────
-- `trust_precompute_max_age_hours` reads max(computed_at) over this table, so a
-- re-run must REFRESH the timestamp in place. An append would grow the table
-- unboundedly and a non-refresh would make a healthy leg look stalled.
UPDATE public.rpc_trust_health_precompute SET computed_at = now() - interval '20 hours';
SELECT public.rpc_thp_leg_fmv_coverage();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '10',
  're-running the leg updates in place (ON CONFLICT), it does not append');
SELECT _assert((SELECT max(now() - computed_at) FROM public.rpc_trust_health_precompute)
                 < interval '1 minute',
  're-running refreshes computed_at — the max-age arm is the only freshness instrument');

-- ── The 999 sentinel DOES fire on an ordinary error ─────────────────────────
-- Dropping a source table is the cheapest faithful stand-in for "the query could
-- not run": SQLSTATE 42P01, an ordinary error, which WHEN OTHERS catches.
-- ⚠ Since R41 the leg no longer reads `editions` at all, so the table dropped
-- here must be `fmv_snapshots` — dropping `editions` would prove nothing (the
-- leg would SUCCEED, which is itself part of what the R41 change asserts).
SAVEPOINT before_generic_error;
DROP TABLE public.fmv_snapshots;
SELECT public.rpc_thp_leg_fmv_coverage();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '10',
  'an ordinary error flips ALL TEN arms to the loud 999 sentinel — 999 is above every '
  'breach threshold, so a failed leg pages instead of publishing a stale value as current');
ROLLBACK TO SAVEPOINT before_generic_error;

-- ── ⚠ ...BUT IT CANNOT FIRE ON A STATEMENT TIMEOUT, WHICH IS THE ONLY FAILURE
--    THIS INSTANCE ACTUALLY PRODUCES ────────────────────────────────────────
-- PostgreSQL: "the special condition name OTHERS matches every error type except
-- QUERY_CANCELED and ASSERT_FAILURE". A statement_timeout raises query_canceled
-- (57014), so every one of these eight legs has an exception handler that is
-- STRUCTURALLY INCAPABLE of firing on its own real-world failure mode — live
-- `WHERE value = 999` has returned zero rows, ever.
--
-- ⚠ This is pinned as CURRENT BEHAVIOUR and is deliberately NOT "fixed" here.
-- Catching the cancel was shipped and reverted the same session (2026-08-15,
-- `255e7d24`): after a cancel is caught the timer is NOT re-armed, so every
-- remaining statement runs with no bound at all on the 2 GB instance whose
-- saturation caused the timeout — a bounded failure traded for an unbounded one.
-- The structural remedy was the 8-way cron split (shipped 2026-08-16), which
-- gives each leg its own top-level statement and its own budget.
--
-- If a future change makes the sentinel reachable on a timeout, THIS TEST MUST
-- FAIL — that is the point. Re-derive the trade-off before re-pointing it.
CREATE FUNCTION public._cancel() RETURNS TABLE(edition_id uuid, collection_id uuid,
                                               computed_at timestamptz, confidence text)
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout';
END $$;

SAVEPOINT before_cancel;
DROP TABLE public.fmv_snapshots;
CREATE VIEW public.fmv_snapshots AS SELECT * FROM public._cancel();
-- Mark every arm so a sentinel write would be unmistakable.
UPDATE public.rpc_trust_health_precompute SET value = -1;

DO $$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_fmv_coverage();
  EXCEPTION WHEN query_canceled THEN
    caught := true;
  END;
  PERFORM _assert(caught,
    'a statement timeout (57014) ESCAPES the leg entirely — WHEN OTHERS does not match '
    'QUERY_CANCELED, so the handler never runs');
END $$;

SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'and therefore NO 999 sentinel is written on the one failure mode this instance '
  'actually produces — the arms keep their previous values and publish them as current');
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = -1), '10',
  'the arms are left EXACTLY as they were: a frozen value is indistinguishable from a '
  'fresh one in v_rpc_trust_health, which has no per-metric age column');
ROLLBACK TO SAVEPOINT before_cancel;

SELECT '✓ rpc_thp_leg_fmv_coverage invariants pass' AS result;

ROLLBACK;
