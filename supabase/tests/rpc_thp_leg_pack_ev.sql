-- DB invariant: public.rpc_thp_leg_pack_ev — one leg of the trust-board precompute.
--
-- The share of packs that have an EV row in history but do NOT appear in the
-- published `pack_ev_latest` view — i.e. packs the pipeline priced and the product
-- then failed to surface. It guards the public +EV badge from being quietly
-- under-published.
--
-- ⚠ THIS IS THE ONE LEG WHOSE SENTINEL IS REACHABLE WITHOUT AN EXCEPTION. With an
-- empty history the NULLIF makes the divisor NULL, the whole expression NULL, and the
-- explicit `COALESCE(..., 999)` writes the sentinel directly. That is the correct
-- design — "I could not compute this" is louder than a fabricated 0 — and it is the
-- opposite choice from `rpc_thp_leg_fmv_coverage`, which publishes 0 for the same
-- absence. Both are pinned; the divergence is real and worth knowing before anyone
-- "harmonises" them.
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
CREATE TABLE public.pack_ev_history ( pack_listing_id text );
CREATE TABLE public.pack_ev_latest  ( pack_listing_id text );

INSERT INTO public.pack_ev_history (pack_listing_id) VALUES
  ('p1'),('p1'),('p2'),('p3'),('p4');   -- 4 DISTINCT packs, 5 rows
INSERT INTO public.pack_ev_latest (pack_listing_id) VALUES
  ('p1'),('p2'),('p3');                 -- 3 published -> 25.00% shortfall

-- >>> BEGIN verbatim rpc_thp_leg_pack_ev (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_pack_ev()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '120s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(
             round(100.0 * (1.0
               - (SELECT count(*) FROM public.pack_ev_latest)::numeric
                 / NULLIF((SELECT count(DISTINCT h.pack_listing_id) FROM public.pack_ev_history h), 0)::numeric
             ), 2), 999)
      INTO v;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('pack_ev_publish_shortfall_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_pack_ev <<<

SELECT public.rpc_thp_leg_pack_ev();

SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pack_ev_publish_shortfall_pct'), '25.00',
  'shortfall is over DISTINCT packs in history (4), not history ROWS (5) — history keeps '
  'one row per recompute, so a row-based denominator would fall as the pipeline runs more');

-- ⚠ ABSENCE IS THE SENTINEL HERE, NOT A ZERO.
SAVEPOINT empty_history;
DELETE FROM public.pack_ev_history;
SELECT public.rpc_thp_leg_pack_ev();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pack_ev_publish_shortfall_pct'), '999',
  'an empty history divides by NULLIF(0) -> NULL -> COALESCE 999. "Cannot compute" is '
  'published as loud, NOT as a 0% shortfall — contrast rpc_thp_leg_fmv_coverage, which '
  'publishes 0 for its own absence case');
ROLLBACK TO SAVEPOINT empty_history;

-- ⚠ MUTATION SURVIVOR, DOCUMENTED RATHER THAN CONTRIVED AWAY: removing the NULLIF
-- divide-guard changes NOTHING OBSERVABLE. Without it an empty history divides by zero,
-- which raises 22012, which WHEN OTHERS catches, which writes 999 — the same value the
-- COALESCE writes on the clean path. The two routes are indistinguishable in the
-- published arm, so no fixture can separate them.
--   It is still not dead code. What would make it load-bearing: this leg writing more
--   than one metric (the error path would clobber the siblings with 999 rather than
--   letting them compute), or the handler being narrowed so 22012 escapes. Both are
--   plausible edits, which is why the guard should stay.

-- ⚠ THE ARM CAN GO NEGATIVE, AND NEGATIVE IS NOT HEALTHY. If the published view holds
-- MORE packs than history has distinct ids, the arm dips below zero. It is thresholded
-- as an upper bound (breach at 10), so a negative reading is very green — while meaning
-- the published board is showing packs the EV pipeline has no record of pricing.
SAVEPOINT published_exceeds_history;
INSERT INTO public.pack_ev_latest (pack_listing_id) VALUES ('p4'),('ghost1'),('ghost2');
SELECT public.rpc_thp_leg_pack_ev();
SELECT _assert((SELECT value FROM public.rpc_trust_health_precompute
                 WHERE metric='pack_ev_publish_shortfall_pct') < 0,
  'more published than priced yields a NEGATIVE shortfall, which reads as very healthy '
  'against an upper-bound threshold — the arm cannot express over-publication');
ROLLBACK TO SAVEPOINT published_exceeds_history;

-- The 999 sentinel also fires on an ordinary error — so 999 has TWO causes here
-- (empty history, and a failed read) and they are indistinguishable in the value.
SAVEPOINT generic_err;
DROP TABLE public.pack_ev_latest;
SELECT public.rpc_thp_leg_pack_ev();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='pack_ev_publish_shortfall_pct'), '999',
  'an ordinary error also writes 999 — the sentinel is overloaded: "no history" and '
  '"read failed" produce the identical published value');
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

CREATE FUNCTION public._cancel() RETURNS TABLE(pack_listing_id text)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.pack_ev_history;
CREATE VIEW public.pack_ev_history AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_pack_ev();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(caught, 'a 57014 escapes the leg — WHEN OTHERS does not match QUERY_CANCELED');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'no 999 is written on a timeout, so the arm keeps its previous value and publishes it as '
  'current — and v_rpc_trust_health has no per-metric age column to expose that');

SELECT '✓ rpc_thp_leg_pack_ev invariants pass' AS result;

ROLLBACK;
