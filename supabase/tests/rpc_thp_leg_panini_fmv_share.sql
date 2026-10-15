-- DB invariant: public.rpc_thp_leg_panini_fmv_share — one leg of the trust-board precompute.
--
-- Panini's share of editions whose LATEST panini_fmv_snapshots row is HIGH or MEDIUM — Panini's
-- half of the headline accuracy metric, which had no owner until 2026-10-14 (roadmap-status.md,
-- "Panini is NOT in the headline table"). A mirror of rpc_thp_leg_pinnacle_fmv_share.
--
-- ⚠ THE PROPERTY WORTH PINNING IS LATEST-PER-EDITION. panini_fmv_snapshots keeps daily history
-- (several rows per edition), so a count over ROWS would weight an edition by how often the walk
-- re-priced it — the liquid editions, which are the confident ones. The share must count each
-- edition once, at its newest row.
--
-- The function DDL below is VERBATIM from its committed migration.
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.rpc_trust_health_precompute (
  metric      text PRIMARY KEY,
  value       numeric,
  computed_at timestamptz,
  duration_ms numeric
);
CREATE TABLE public.panini_fmv_snapshots (
  edition_id text, confidence text, computed_at timestamptz
);
INSERT INTO public.panini_fmv_snapshots (edition_id, confidence, computed_at) VALUES
  ('e1','HIGH',    now() - interval '1 day'),
  ('e2','MEDIUM',  now() - interval '1 day'),
  ('e3','LOW',     now() - interval '1 day'),
  ('e4','ASK_ONLY',now() - interval '1 day'),
  ('e5','NO_DATA', now() - interval '1 day'),
  -- e6 has an old HIGH superseded by a newer LOW: it must NOT count as confident.
  ('e6','HIGH',    now() - interval '9 days'),
  ('e6','LOW',     now() - interval '2 days'),
  -- e1 has EXTRA HIGH history rows; counted per row the share would be 6/11, not 2/6.
  ('e1','HIGH',    now() - interval '3 days'),
  ('e1','HIGH',    now() - interval '5 days'),
  ('e1','HIGH',    now() - interval '7 days');

-- >>> BEGIN verbatim rpc_thp_leg_panini_fmv_share (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_panini_fmv_share()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '90s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    WITH latest AS (
      SELECT DISTINCT ON (edition_id) edition_id, confidence
      FROM public.panini_fmv_snapshots
      ORDER BY edition_id, computed_at DESC
    )
    SELECT round(100.0 * count(*) FILTER (WHERE confidence::text IN ('HIGH','MEDIUM'))::numeric
                 / NULLIF(count(*), 0)::numeric, 1)
      INTO v FROM latest;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_fmv_high_med_share_pct', COALESCE(v, 0), now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('panini_fmv_high_med_share_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_panini_fmv_share <<<

SELECT public.rpc_thp_leg_panini_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_fmv_high_med_share_pct'), '33.3',
  'HIGH + MEDIUM over 6 DISTINCT editions at their newest row (2/6) — e6''s superseded HIGH does '
  'not count, e1''s history does not weight it, and ASK_ONLY / NO_DATA stay in the denominator');

SAVEPOINT no_rows;
DELETE FROM public.panini_fmv_snapshots;
SELECT public.rpc_thp_leg_panini_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_fmv_high_med_share_pct'), '0',
  'no rows publishes 0% confident — the loud direction for an FMV outage');
ROLLBACK TO SAVEPOINT no_rows;

SAVEPOINT generic_err;
DROP TABLE public.panini_fmv_snapshots;
SELECT public.rpc_thp_leg_panini_fmv_share();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='panini_fmv_high_med_share_pct'), '999',
  'an ordinary error flips the arm to 999');
ROLLBACK TO SAVEPOINT generic_err;

-- A statement timeout (57014) must also reach the 999 sentinel (R118: WHEN OTHERS alone is blind
-- to query_canceled). If a future change makes it unreachable again, THIS TEST MUST FAIL.
CREATE FUNCTION public._cancel() RETURNS TABLE(edition_id text, confidence text, computed_at timestamptz)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.panini_fmv_snapshots;
CREATE VIEW public.panini_fmv_snapshots AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_panini_fmv_share();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(NOT caught, 'a 57014 is CAUGHT inside the leg (WHEN query_canceled OR OTHERS, R118)');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '1',
  'the 999 sentinel IS written on a timeout');

SELECT '✓ rpc_thp_leg_panini_fmv_share invariants pass' AS result;

ROLLBACK;
