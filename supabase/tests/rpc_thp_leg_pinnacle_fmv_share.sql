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
  EXCEPTION WHEN OTHERS THEN
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
  PERFORM _assert(caught, 'a 57014 escapes the leg — WHEN OTHERS does not match QUERY_CANCELED');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'no 999 is written on a timeout, so the arm keeps its previous value and publishes it as '
  'current — and v_rpc_trust_health has no per-metric age column to expose that');

SELECT '✓ rpc_thp_leg_pinnacle_fmv_share invariants pass' AS result;

ROLLBACK;
