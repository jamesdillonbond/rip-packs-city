-- DB invariant: public.rpc_thp_leg_fmv_sanity — one leg of the trust-board precompute.
--
-- The thinnest leg: a straight count of `v_fmv_sanity_flags`, breach at 1. What it is
-- worth pinning for is not arithmetic but the two ways it can publish a green zero
-- that means something else entirely — an empty view and a successfully-emptied view
-- are the same number, and only the ERROR path is distinguishable.
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
-- A settable stand-in for the real view.
CREATE TABLE public._flags (id int);
CREATE VIEW public.v_fmv_sanity_flags AS SELECT id FROM public._flags;
INSERT INTO public._flags VALUES (1),(2),(3);

-- >>> BEGIN verbatim rpc_thp_leg_fmv_sanity (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_fmv_sanity()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT count(*)::numeric INTO v FROM public.v_fmv_sanity_flags;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('fmv_sanity_flags', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_fmv_sanity <<<

SELECT public.rpc_thp_leg_fmv_sanity();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='fmv_sanity_flags'), '3',
  'the arm is a straight count of the sanity view');

-- A genuinely clean platform publishes 0, and so does a view that has been emptied by
-- a broken upstream. Nothing in the value distinguishes them; only the 999 does.
SAVEPOINT emptied;
DELETE FROM public._flags;
SELECT public.rpc_thp_leg_fmv_sanity();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='fmv_sanity_flags'), '0',
  'an empty view publishes 0 = healthy. A view that stopped being populated publishes '
  'the same 0. This arm cannot tell "nothing is wrong" from "nothing is looking"');
ROLLBACK TO SAVEPOINT emptied;

SAVEPOINT generic_err;
DROP VIEW public.v_fmv_sanity_flags;
SELECT public.rpc_thp_leg_fmv_sanity();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='fmv_sanity_flags'), '999',
  'a MISSING view is the one failure the arm can express — it flips to 999, well above '
  'the breach threshold of 1');
ROLLBACK TO SAVEPOINT generic_err;

UPDATE public.rpc_trust_health_precompute SET computed_at = now() - interval '20 hours';
SELECT public.rpc_thp_leg_fmv_sanity();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '1',
  're-running updates in place, it does not append');
SELECT _assert((SELECT now() - computed_at FROM public.rpc_trust_health_precompute) < interval '1 minute',
  're-running refreshes computed_at');

-- ── ⚠ THE SENTINEL IS UNREACHABLE ON THE ONLY FAILURE THIS INSTANCE PRODUCES ──
-- Every leg carries an `EXCEPTION WHEN OTHERS` handler whose whole purpose is the
-- loud 999. PostgreSQL: "the special condition name OTHERS matches every error type
-- except QUERY_CANCELED and ASSERT_FAILURE" — and a statement_timeout raises
-- query_canceled (57014). Live `WHERE value = 999` has returned zero rows, ever.
--
-- Pinned as CURRENT BEHAVIOUR, deliberately NOT fixed here: catching the cancel was
-- shipped and reverted the same session (2026-08-15, `255e7d24`) because the timer is
-- not re-armed afterwards, so every remaining statement would run unbounded on the
-- 2 GB instance whose saturation caused the timeout. The structural remedy was the
-- 2026-08-16 8-way cron split. If a change makes the sentinel reachable, THIS FAILS.

DROP VIEW public.v_fmv_sanity_flags;
CREATE FUNCTION public._cancel() RETURNS TABLE(id int)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
CREATE VIEW public.v_fmv_sanity_flags AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_fmv_sanity();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(caught, 'a 57014 escapes the leg — WHEN OTHERS does not match QUERY_CANCELED');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'no 999 is written on a timeout, so the arm keeps its previous value and publishes it as '
  'current — and v_rpc_trust_health has no per-metric age column to expose that');

SELECT '✓ rpc_thp_leg_fmv_sanity invariants pass' AS result;

ROLLBACK;
