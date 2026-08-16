-- DB invariant: public.rpc_thp_leg_serial_supply — one leg of the trust-board precompute.
--
-- The share of recently-ingested sales that landed with NO serial number, taken as
-- the WORST across collections. Serial number is what every serial-keyed FMV
-- multiplier, special-serial board and #1-premium keys on, so a silent collapse to
-- serial-less rows corrupts pricing rather than breaking it.
--
-- ⚠ TWO DELIBERATE BLIND SPOTS, BOTH PINNED HERE BECAUSE THEY LOOK LIKE HEALTH:
--   `HAVING count(*) >= 200` — a collection below the sample floor is INVISIBLE, not
--     zero-risk. Combined with `COALESCE(max(...), 0)` an entirely dead ingest (no
--     qualifying rows at all) publishes 0, which reads as PERFECT.
--   the ingest window is `[now-10d, now-3d)` — rows younger than 3 days are excluded
--     ON PURPOSE (serials are backfilled asynchronously, so fresh rows are legitimately
--     serial-less). The cost is that a brand-new outage is invisible for three days.
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
CREATE TABLE public.sales (
  collection    text,
  serial_number int,
  nft_id        text,
  sold_at       timestamptz,
  ingested_at   timestamptz
);

-- nba_top_shot: 300 qualifying rows, 60 of them serial-less -> 20.0%
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'nba_top_shot', CASE WHEN g <= 60 THEN NULL ELSE g END, 'n'||g,
       now() - interval '5 days', now() - interval '5 days'
FROM generate_series(1, 300) g;

-- nfl_all_day: 250 qualifying rows, 100 of them carrying serial ZERO (not NULL) -> 40.0%.
-- ⚠ This is deliberately the WORST collection, and it must be, or `COALESCE(serial,0)=0`
-- is unobservable: with a NULL-based collection ahead of it, treating 0 as a real serial
-- would change AllDay's own percentage and leave the arm's MAX untouched.
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'nfl_all_day', CASE WHEN g <= 100 THEN 0 ELSE g END, 'a'||g,
       now() - interval '5 days', now() - interval '5 days'
FROM generate_series(1, 250) g;

-- laliga_golazos: 199 rows, ALL serial-less. One row below the floor, so it is
-- 100% broken and completely invisible to the arm.
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'laliga_golazos', NULL, 'g'||g, now() - interval '5 days', now() - interval '5 days'
FROM generate_series(1, 199) g;

-- disney_pinnacle: 400 rows, all serial-less, but ingested 1 DAY ago — inside the
-- 3-day lag, so excluded. A brand-new total outage reads as nothing at all.
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'disney_pinnacle', NULL, 'p'||g, now() - interval '1 day', now() - interval '1 day'
FROM generate_series(1, 400) g;

-- ufc_strike: 400 rows, all serial-less, nft_id NULL — no on-chain identity to recover a
-- serial from, so not evidence of supply loss.
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'ufc_strike', NULL, NULL, now() - interval '5 days', now() - interval '5 days'
FROM generate_series(1, 400) g;

-- candy_mlb: the same shape but with an EMPTY-STRING nft_id. ⚠ The two identity clauses
-- (`nft_id IS NOT NULL` and `nft_id <> ''`) MASK EACH OTHER for a NULL row — `NULL <> ''`
-- is NULL, so the row is rejected either way and dropping the IS NOT NULL alone changes
-- nothing observable. This collection makes the SECOND clause independently observable;
-- the first is redundant-behind-the-second and is asserted only as part of the composite.
INSERT INTO public.sales (collection, serial_number, nft_id, sold_at, ingested_at)
SELECT 'candy_mlb', NULL, '', now() - interval '5 days', now() - interval '5 days'
FROM generate_series(1, 400) g;

-- >>> BEGIN verbatim rpc_thp_leg_serial_supply (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rpc_thp_leg_serial_supply()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public','pg_temp' SET statement_timeout TO '180s'
AS $fn$
DECLARE t1 timestamptz := clock_timestamp(); v numeric;
BEGIN
  BEGIN
    SELECT COALESCE(max(q.pct), 0)::numeric INTO v
    FROM (
      SELECT (100.0 * count(*) FILTER (WHERE COALESCE(s.serial_number, 0) = 0)) / count(*) AS pct
        FROM public.sales s
       WHERE s.sold_at >= now() - '30 days'::interval
         AND s.ingested_at >= now() - '10 days'::interval
         AND s.ingested_at <  now() - '3 days'::interval
         AND s.nft_id IS NOT NULL
         AND s.nft_id <> ''
       GROUP BY s.collection
      HAVING count(*) >= 200
    ) q;
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('sales_serial_supply_worst_pct', v, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.rpc_trust_health_precompute (metric, value, computed_at, duration_ms)
    VALUES ('sales_serial_supply_worst_pct', 999, now(),
            round(EXTRACT(epoch FROM clock_timestamp() - t1) * 1000))
    ON CONFLICT (metric) DO UPDATE
      SET value = EXCLUDED.value, computed_at = EXCLUDED.computed_at, duration_ms = EXCLUDED.duration_ms;
  END;
END;
$fn$;
-- <<< END verbatim rpc_thp_leg_serial_supply <<<

SELECT public.rpc_thp_leg_serial_supply();

SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='sales_serial_supply_worst_pct'), '40.0000000000000000',
  'the arm reports the WORST collection (AllDay 40%), not an average — an average would '
  'let a healthy high-volume collection mask a broken one. The worst collection is the '
  'ZERO-serial one, so COALESCE(serial_number,0)=0 is what decides the published value');

-- ⚠ A serial of 0 is NOT a serial. Real ingest writes both shapes, and treating 0 as a
-- valid serial would silently halve the measured loss on any collection that uses it.
SELECT _assert((SELECT count(*) FROM public.sales WHERE collection='nfl_all_day' AND serial_number = 0) = 100,
  'the fixture really does use 0 (not NULL) for the worst collection');

-- ⚠ THE INVISIBLE COLLECTIONS. Golazos is 100% serial-less and Pinnacle is a fresh
-- total outage; neither moves the arm at all.
SELECT _assert((SELECT value FROM public.rpc_trust_health_precompute
                 WHERE metric='sales_serial_supply_worst_pct') < 100,
  'a collection that is 100% serial-less but one row under the 200-sample floor is '
  'INVISIBLE — the floor buys stability against small samples and pays for it in blindness');

-- And with NOTHING qualifying, absence publishes 0 — which reads as perfect health.
SAVEPOINT all_below_floor;
DELETE FROM public.sales WHERE collection IN ('nba_top_shot','nfl_all_day');
SELECT public.rpc_thp_leg_serial_supply();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='sales_serial_supply_worst_pct'), '0',
  'with no collection over the sample floor the arm publishes 0 — i.e. a platform-wide '
  'ingest stop is indistinguishable from perfect serial supply. Manufactured from absence.');
ROLLBACK TO SAVEPOINT all_below_floor;

-- ⚠ The row must carry an on-chain identity to count as lost supply. A sale we cannot
-- key to an NFT is not evidence the serial pipeline dropped anything.
SELECT _assert((SELECT count(*) FROM public.sales WHERE nft_id = '') = 400,
  'the fixture contains an empty-string nft_id collection, so the non-empty check is '
  'observable on its own. Its sibling NOT-NULL check is REDUNDANT for a NULL row — '
  'comparing NULL to the empty string yields NULL, so such a row is rejected by either '
  'clause alone and dropping the NOT-NULL one changes nothing. It is covered only as '
  'part of the composite. What would make it load-bearing again: an ingest that writes '
  'NULL nft_id rows which the non-empty check would otherwise admit.');

-- The 999 sentinel DOES fire on an ordinary error.
SAVEPOINT generic_err;
DROP TABLE public.sales;
SELECT public.rpc_thp_leg_serial_supply();
SELECT _assert_eq((SELECT value::text FROM public.rpc_trust_health_precompute
                    WHERE metric='sales_serial_supply_worst_pct'), '999',
  'an ordinary error flips the arm to 999, above the breach threshold of 5');
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

CREATE FUNCTION public._cancel() RETURNS TABLE(collection text, serial_number int, nft_id text,
                                               sold_at timestamptz, ingested_at timestamptz)
LANGUAGE plpgsql AS $c$
BEGIN RAISE EXCEPTION SQLSTATE '57014' USING MESSAGE = 'canceling statement due to statement timeout'; END $c$;
DROP TABLE public.sales;
CREATE VIEW public.sales AS SELECT * FROM public._cancel();

UPDATE public.rpc_trust_health_precompute SET value = -1;
DO $cancel$
DECLARE caught boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_thp_leg_serial_supply();
  EXCEPTION WHEN query_canceled THEN caught := true;
  END;
  PERFORM _assert(caught, 'a 57014 escapes the leg — WHEN OTHERS does not match QUERY_CANCELED');
END $cancel$;
SELECT _assert_eq((SELECT count(*)::text FROM public.rpc_trust_health_precompute WHERE value = 999), '0',
  'no 999 is written on a timeout, so the arm keeps its previous value and publishes it as '
  'current — and v_rpc_trust_health has no per-metric age column to expose that');

SELECT '✓ rpc_thp_leg_serial_supply invariants pass' AS result;

ROLLBACK;
