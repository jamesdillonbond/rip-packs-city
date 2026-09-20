-- DB invariant: public.rpc_thp_leg_impossible_parallel — one leg of the trust-board precompute.
--
-- Counts Top Shot sales whose serial number exceeds the edition's circulation —
-- physically impossible, and the tell for the parallel/base conflation family that
-- mis-keys sales onto the wrong edition. It is stalest-by-position in the old
-- monolith and now runs alone on pg_cron jobid 324 (`48 0,6,12,18 * * *`).
--
-- Two filters carry the meaning and each is asserted in BOTH directions, because a
-- guard that only ever sees inputs it accepts is unobservable:
--   `external_id ~ '::'`  — PARALLEL printings only. A base-keyed edition with an
--                           impossible serial is deliberately NOT counted; the arm
--                           is named for, and thresholded against, parallels.
--   `circulation_count>0` — an edition whose circulation we do not know is 0, and
--                           without this guard EVERY serial would exceed it, so a
--                           catalog gap would masquerade as mass conflation.
-- The function DDL below is VERBATIM from its committed migration, whose body was
-- verified against live prod prosrc (whitespace-collapsed md5, both comment-stripped
-- and not) on 2026-08-16. __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.rpc_trust_health_precompute (
  metric      text PRIMARY KEY,
  value       numeric,
  computed_at timestamptz,
  duration_ms numeric
);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id text, circulation_count int
);
CREATE TABLE public.sales (
  edition_id uuid, serial_number int
);

INSERT INTO public.editions (id, collection_id, external_id, circulation_count) VALUES
  -- parallel, known circulation — the only shape that can be counted
  ('11111111-1111-1111-1111-111111111111','95f28a17-224a-4025-96ad-adf8a4c63bfd','12:34::7', 100),
  -- BASE-keyed edition, same impossible serial: must NOT count
  ('22222222-2222-2222-2222-222222222222','95f28a17-224a-4025-96ad-adf8a4c63bfd','12:34',    100),
  -- parallel with UNKNOWN circulation (0): must NOT count, or a catalog gap reads
  -- as mass conflation
  ('33333333-3333-3333-3333-333333333333','95f28a17-224a-4025-96ad-adf8a4c63bfd','56:78::1',   0),
  -- AllDay parallel, impossible serial: must NOT count (the arm is Top-Shot-scoped)
  ('44444444-4444-4444-4444-444444444444','dee28451-5d62-409e-a1ad-a83f763ac070','9:9::9',   100);

INSERT INTO public.sales (edition_id, serial_number) VALUES
  ('11111111-1111-1111-1111-111111111111', 101),  -- impossible  -> COUNTS
  ('11111111-1111-1111-1111-111111111111', 250),  -- impossible  -> COUNTS
  ('11111111-1111-1111-1111-111111111111', 100),  -- exactly at circulation: LEGAL
  ('11111111-1111-1111-1111-111111111111',  50),  -- legal
  ('22222222-2222-2222-2222-222222222222', 999),  -- base-keyed  -> excluded
  ('33333333-3333-3333-3333-333333333333',   1),  -- circ 0      -> excluded
  ('44444444-4444-4444-4444-444444444444', 999);  -- AllDay      -> excluded

-- >>> BEGIN verbatim rpc_thp_leg_impossible_parallel (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_impossible_parallel()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '480s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v
    FROM public.editions e
    JOIN public.sales s ON s.edition_id = e.id
    WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
      AND e.external_id::text ~ '::'::text
      AND e.circulation_count > 0
      AND s.serial_number > e.circulation_count;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('topshot_impossible_parallel_serials', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_impossible_parallel <<<

SELECT public.rpc_thp_leg_impossible_parallel();

SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_impossible_parallel_serials'), '2',
  'only the two genuinely-impossible PARALLEL sales count; base-keyed, unknown-circulation '
  'and non-Top-Shot rows are all excluded');

-- The boundary is `>`, not `>=`: serial N of an edition of N is the LAST MINT, the
-- most collectible serial there is. Counting it would flag every last mint on the
-- platform as evidence of conflation.
SELECT _assert((SELECT count(*) FROM public.sales s JOIN public.editions e ON e.id = s.edition_id
                 WHERE s.serial_number = e.circulation_count) = 1,
  'the fixture really does contain a serial exactly AT circulation, so the > boundary is observable');

-- Idempotent + refreshes computed_at (the max-age arm is the only freshness instrument).
UPDATE public.rpc_trust_health_precompute SET computed_at = now() - interval '20 hours';
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '1',
  're-running updates in place (ON CONFLICT), it does not append');
SELECT _assert((SELECT now() - computed_at FROM public.rpc_trust_health_precompute) < interval '1 minute',
  're-running refreshes computed_at');

-- The 999 sentinel DOES fire on an ordinary error (42P01 here).
SAVEPOINT generic_err;
DROP TABLE public.sales;
SELECT public.rpc_thp_leg_impossible_parallel();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='topshot_impossible_parallel_serials'), '999',
  'an ordinary error flips the arm to the loud 999 sentinel, which is above the breach '
  'threshold of 3 — a failed leg pages rather than publishing a stale value as current');
ROLLBACK TO SAVEPOINT generic_err;

-- ── ✅ THE SENTINEL IS NOW REACHABLE ON A STATEMENT TIMEOUT (R118, 2026-09-20) ──
-- PostgreSQL: "the special condition name OTHERS matches every error type except
-- QUERY_CANCELED and ASSERT_FAILURE" — a statement_timeout raises query_canceled
-- (57014), so until 2026-09-20 every leg's `WHEN OTHERS` handler was structurally
-- blind to the one failure this instance produces, and `WHERE value = 999` had
-- returned zero rows, ever. Catching the cancel was first shipped and reverted on
-- 2026-08-15 (`255e7d24`) because the legs then ran INSIDE ONE orchestrator CALL:
-- a caught cancel in leg N let legs N+1..8 run with the timer already spent. The
-- 2026-08-16 8-way cron split removed that objection — each leg is its own
-- top-level statement under run_thp_leg_logged, and after a caught cancel the only
-- remaining work is this INSERT and one log_pipeline_run row. Re-derived and
-- re-pointed 2026-09-20 (migration 20260920143959): `WHEN query_canceled OR OTHERS`.
-- Live control the same morning: a leg killed under a 3 s prefix budget wrote its
-- terminal thp-leg-* row ok=false '57014: …' (before: only the heartbeat row).
--
-- If a future change makes the sentinel UNREACHABLE again, THIS TEST MUST FAIL.
CREATE FUNCTION public._cancel() RETURNS TABLE(edition_id uuid, serial_number int)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.sales;
CREATE VIEW public.sales AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_impossible_parallel();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(NOT caught, 'a 57014 is CAUGHT inside the leg (WHEN query_canceled OR OTHERS, R118) — it no longer escapes');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '1',
  'the 999 sentinel IS written on a timeout — the arm writes its loud failure value instead of '
  'publishing a frozen number as current (v_rpc_trust_health has no per-metric age column)');

SELECT '✓ rpc_thp_leg_impossible_parallel invariants pass' AS result;

ROLLBACK;
