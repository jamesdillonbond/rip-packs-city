-- DB invariant: public.rpc_thp_leg_pinnacle_fmv_share — one leg of the trust-board precompute.
--
-- Pinnacle's share of renders priced at HIGH or MEDIUM confidence — Pinnacle's half
-- of the platform's headline accuracy metric (roadmap-2026-08-03 §3.1).
--
-- ⚠ ITS SOURCE IS NOT AN INDEPENDENT ONE. `pinnacle_fmv_history` is written by an
-- AFTER INSERT/UPDATE TRIGGER on `pinnacle_catalog`, and that trigger silently drops
-- the ASK_ONLY revision for 776 renders (`NOW()` is transaction-stable, the recalc
-- writes each render twice per transaction, and `ON CONFLICT (render_id, computed_at)
-- DO NOTHING` discards the second). So this arm is computed over a copy that is known
-- to be missing rows for a specific confidence label. That is a real open defect, not
-- something this test can fix — it is recorded here so the next reader knows the arm's
-- denominator is not the catalogue.
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
CREATE TABLE public.pinnacle_fmv_history (
  render_id text, fmv_confidence text, computed_at timestamptz
);
INSERT INTO public.pinnacle_fmv_history (render_id, fmv_confidence, computed_at) VALUES
  ('r1','HIGH',    now() - interval '1 day'),
  ('r2','MEDIUM',  now() - interval '1 day'),
  ('r3','LOW',     now() - interval '1 day'),
  ('r4','ASK_ONLY',now() - interval '1 day'),
  -- r5 has TWO revisions: an old HIGH superseded by a newer LOW. DISTINCT ON must take
  -- the newest, so this render must NOT count toward the confident share.
  ('r5','HIGH',    now() - interval '9 days'),
  ('r5','LOW',     now() - interval '2 days');

-- >>> BEGIN verbatim rpc_thp_leg_pinnacle_fmv_share (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pinnacle_fmv_share()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '90s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (render_id) render_id, fmv_confidence
      FROM public.pinnacle_fmv_history
      ORDER BY render_id, computed_at DESC
    )
    SELECT round(100.0 * count(*) FILTER (WHERE fmv_confidence IN ('HIGH','MEDIUM'))::numeric
                 / NULLIF(count(*), 0)::numeric, 1)
      INTO v FROM latest;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', COALESCE(v, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pinnacle_fmv_high_med_share_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_pinnacle_fmv_share <<<

SELECT public.rpc_thp_leg_pinnacle_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pinnacle_fmv_high_med_share_pct'), '40.0',
  'HIGH + MEDIUM over 5 DISTINCT renders — the superseded HIGH on r5 does not count, '
  'and ASK_ONLY is not confidence');

-- ⚠ Absence publishes 0, i.e. the WORST possible reading, rather than being withheld.
-- Here that direction is the safe one (a total Pinnacle FMV outage looks terrible,
-- which is true) — the opposite of rpc_thp_leg_fmv_coverage's stale% arm, where the
-- same COALESCE(...,0) makes an outage look PERFECT. Same idiom, opposite consequence.
SAVEPOINT no_rows;
DELETE FROM public.pinnacle_fmv_history;
SELECT public.rpc_thp_leg_pinnacle_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pinnacle_fmv_high_med_share_pct'), '0',
  'no rows publishes 0% confident — loud here, but the identical idiom in the stale% arm '
  'publishes 0 meaning PERFECT. The direction is luck, not design');
ROLLBACK TO SAVEPOINT no_rows;

SAVEPOINT generic_err;
DROP TABLE public.pinnacle_fmv_history;
SELECT public.rpc_thp_leg_pinnacle_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pinnacle_fmv_high_med_share_pct'), '999',
  'an ordinary error flips the arm to 999');
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
CREATE FUNCTION public._cancel() RETURNS TABLE(render_id text, fmv_confidence text, computed_at timestamptz)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.pinnacle_fmv_history;
CREATE VIEW public.pinnacle_fmv_history AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_pinnacle_fmv_share();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(NOT caught, 'a 57014 is CAUGHT inside the leg (WHEN query_canceled OR OTHERS, R118) — it no longer escapes');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '1',
  'the 999 sentinel IS written on a timeout — the arm writes its loud failure value instead of '
  'publishing a frozen number as current (v_rpc_trust_health has no per-metric age column)');

SELECT '✓ rpc_thp_leg_pinnacle_fmv_share invariants pass' AS result;

ROLLBACK;
