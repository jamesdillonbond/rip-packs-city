-- DB invariant: public.rpc_thp_leg_board_liveness — one leg of the trust-board precompute.
--
-- Sweeps the PUBLIC insights boards and reports how many came back empty/errored and
-- how many were slow. `public_board_slow_count` is one of the five arms currently
-- breached, so this leg's honesty is load-bearing for how that breach is read.
--
-- ⚠ THE PROPERTY WORTH THE PIN IS THE ONE THE OTHER LEGS GET WRONG: AN INCOMPLETE
-- SWEEP IS PUBLISHED AS INCONCLUSIVE (999), NOT AS GREEN. If the probe runs out of
-- budget it has looked at only some boards, so a low `empty_or_error` from a partial
-- sweep is a claim the data cannot support. This leg refuses to make it. Compare
-- rpc_thp_leg_fmv_coverage, which publishes a hard 0 for its own absence case and so
-- reads as perfect. Both behaviours are pinned; this one is the model.
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
-- Stub probe. The real one sweeps the live boards; what this test pins is how the
-- LEG interprets the payload, which is where the honesty decision lives.
CREATE TABLE public._probe_mode (mode text);
INSERT INTO public._probe_mode VALUES ('ok');

CREATE FUNCTION public.public_board_liveness_probe() RETURNS jsonb
LANGUAGE plpgsql AS $p$
DECLARE m text;
BEGIN
  SELECT mode INTO m FROM public._probe_mode;
  IF m = 'raise' THEN
    RAISE EXCEPTION 'probe blew up';
  ELSIF m = 'exhausted' THEN
    -- A PARTIAL sweep that happens to have seen only healthy boards so far.
    RETURN jsonb_build_object('budget_exhausted', true, 'empty_or_error', 0, 'slow', 0);
  ELSIF m = 'null_fields' THEN
    RETURN jsonb_build_object('budget_exhausted', false);
  ELSIF m = 'no_key' THEN
    -- A well-formed reading that simply omits the completeness flag.
    RETURN jsonb_build_object('empty_or_error', 4, 'slow', 5);
  END IF;
  RETURN jsonb_build_object('budget_exhausted', false, 'empty_or_error', 2, 'slow', 12);
END $p$;

-- >>> BEGIN verbatim rpc_thp_leg_board_liveness (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_board_liveness()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '300s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v_board jsonb; v_empty numeric; v_slow numeric;
BEGIN
  BEGIN
    BEGIN
      SELECT public.public_board_liveness_probe() INTO v_board;
      IF COALESCE((v_board->>'budget_exhausted')::boolean, false) THEN
        v_empty := 999; v_slow := 999;   -- incomplete sweep is INCONCLUSIVE, not green
      ELSE
        v_empty := (v_board->>'empty_or_error')::numeric;
        v_slow  := (v_board->>'slow')::numeric;
      END IF;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_empty := 999; v_slow := 999;
    END;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('public_board_empty_count', v_empty, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)),
           ('public_board_slow_count',  v_slow, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    SELECT m, 999, now(), round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000)
    FROM unnest(ARRAY['public_board_empty_count','public_board_slow_count']) AS m
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_board_liveness <<<

SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='public_board_empty_count'), '2',
  'a complete sweep publishes the probe reading verbatim');
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='public_board_slow_count'), '12',
  'both arms come from the SAME probe call — two calls could disagree with each other');

-- ⚠ THE HEADLINE: a partial sweep is 999 on BOTH arms even though the fields it did
-- fill say 0/0. Reporting 0 would be publishing "no board is broken" on the strength
-- of the boards it never reached.
UPDATE public._probe_mode SET mode = 'exhausted';
SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '2',
  'budget_exhausted publishes 999 on BOTH arms — an incomplete sweep is INCONCLUSIVE, '
  'never green, even though the payload literally contains empty_or_error = 0');

-- A probe that throws is likewise inconclusive, not zero.
UPDATE public._probe_mode SET mode = 'raise';
UPDATE public.rpc_trust_health_precompute SET value = -1;
SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '2',
  'the INNER handler catches a throwing probe and writes 999 to both arms');

-- A payload missing its fields yields NULL, not 0 — the arm is withheld rather than
-- fabricated. (v_rpc_trust_health compares NULL against the threshold, which is never
-- true, so this is a silent hole; recorded, not endorsed.)
UPDATE public._probe_mode SET mode = 'null_fields';
SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert((SELECT value FROM public.rpc_trust_health_precompute
                 WHERE metric='public_board_empty_count') IS NULL,
  'a payload with the keys absent writes NULL — NOT 0. It does not fabricate a healthy '
  'reading, but a NULL never breaches either, so this case is silent rather than loud');

-- ⚠ A payload with NO `budget_exhausted` key at all is treated as COMPLETE, and its
-- numbers are published. That is the right default only because the probe always sets
-- the flag today; flipping the COALESCE default to true would make every reading
-- inconclusive and the two arms permanently 999.
UPDATE public._probe_mode SET mode = 'no_key';
UPDATE public.rpc_trust_health_precompute SET value = -1;
SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='public_board_empty_count'), '4',
  'an absent budget_exhausted key COALESCEs to FALSE — the sweep is assumed complete and '
  'its numbers are published rather than sentinelled');

-- Idempotent + refreshes computed_at.
UPDATE public._probe_mode SET mode = 'ok';
UPDATE public.rpc_trust_health_precompute SET computed_at = now() - interval '20 hours';
SELECT public.rpc_thp_leg_board_liveness();
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute), '2',
  're-running updates in place, it does not append');
SELECT _assert((SELECT max(now() - computed_at) FROM public.rpc_trust_health_precompute) < interval '1 minute',
  're-running refreshes computed_at on both arms');

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
DROP FUNCTION public.public_board_liveness_probe();
CREATE FUNCTION public.public_board_liveness_probe() RETURNS jsonb
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_board_liveness();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(NOT caught, 'a 57014 is CAUGHT inside the leg (WHEN query_canceled OR OTHERS, R118) — it no longer escapes');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '2',
  'the 999 sentinel IS written on a timeout — both arms write their loud failure value instead of '
  'publishing a frozen number as current (v_rpc_trust_health has no per-metric age column)');

SELECT '✓ rpc_thp_leg_board_liveness invariants pass' AS result;

ROLLBACK;
