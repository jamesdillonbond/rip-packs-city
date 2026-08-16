-- DB invariant: public.rollup_allday_rip_pull_value — pg_cron
-- `rpc-allday-rollup-rip-value` @ `14 * * * *`.
--
-- WHAT IT DOES. Denormalizes each All Day pack rip's TOTAL PULL VALUE onto
-- `pack_rips.pull_value_usd`, from the per-moment FMVs in `allday_pack_pull`.
-- That figure is what a collector reads as "what this pack was worth".
--
-- ── THE TWO PROPERTIES ─────────────────────────────────────────────────────
--
--   1. ⚠ ALL-OR-NOTHING: `agg.valued_pulls = agg.total_pulls`. A rip's value is
--      written only when EVERY pull in it is priced. This is the important one,
--      and it fails in the reassuring direction if removed: a partial sum is a
--      SMALLER number that reads exactly like a real one — a 5-moment rip with
--      2 priced pulls would publish those 2 as the pack's total value, making a
--      good pull look like a bad pack, with nothing anywhere reporting it.
--      ⚠ The `total_fmv IS NOT NULL` beside it is UNREACHABLE, and my own first
--      draft of this comment had it wrong — it does NOT "cover the zero-pull
--      edge". A rip with no pulls never enters `agg` at all (the CTE groups over
--      `allday_pack_pull` rows), so every group has at least one row; and
--      `valued_pulls = total_pulls >= 1` already guarantees at least one
--      non-NULL, hence a non-NULL SUM. Removing it changes nothing
--      (mutation-confirmed). Kept as intent, documented rather than asserted,
--      and load-bearing again the moment guard 1 is relaxed.
--   2. ⚠ THE WATERMARK IS CAPTURED BEFORE THE READ, NOT AFTER. `t_start` is
--      `clock_timestamp()` at entry, and it is what gets stored — so a pull
--      updated WHILE the rollup runs has `updated_at >= t_start` and is picked
--      up on the NEXT tick. Storing `now()` at the end instead would skip that
--      row permanently: it changed after the read but before the watermark
--      moved past it. The window is small and the failure is silent and
--      unrecoverable, which is the worst combination.
--      ⚠ Paired with `updated_at >= w` (INCLUSIVE), so the boundary row is
--      re-processed rather than skipped. Re-processing is free because the
--      UPDATE carries `IS DISTINCT FROM` change-detection; skipping is not.
--      ⚠ The INCLUSIVE half IS asserted below. The before-vs-after half is NOT
--      and cannot be: the difference only appears when another session writes
--      DURING the run, which a single-session rolled-back test cannot produce.
--      Swapping `t_start` for `clock_timestamp()` at the end passes every
--      assertion here. Recorded so the omission is a known limit of the harness
--      rather than an oversight — same treatment as the concurrency backstops in
--      attribute_topshot_rips_empirical and fill_ts_artless_from_rep_moments.
--
-- ALSO: `COALESCE(w, '-infinity')` makes a never-run state a FULL sweep rather
-- than a no-op, and the update is scoped to the All Day collection_id.
--
-- ⚠ The watermark advances even when zero rips are updated — deliberately.
-- Nothing left to do is not a reason to re-scan the same window next hour.
--
-- The function DDL below is VERBATIM from the committed snapshot migration
-- (supabase/migrations/20260816080000_audit_20260816_snapshot_remaining_scheduled_mv_and_rollup_writers.sql),
-- pulled from live prod via pg_get_functiondef on 2026-08-16
-- (md5 0f851e5c9f249eb08a18fdaa1c9ece1a).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.allday_rip_rollup_state (
  singleton   boolean PRIMARY KEY DEFAULT true,
  last_run_at timestamptz
);

CREATE TABLE public.allday_pack_pull (
  pack_nft_id text,
  fmv_usd     numeric,
  updated_at  timestamptz
);

CREATE TABLE public.pack_rips (
  collection_id       uuid,
  pack_nft_id         text,
  pull_value_usd      numeric,
  metadata_updated_at timestamptz
);

-- >>> BEGIN verbatim rollup_allday_rip_pull_value (byte-identical to the migration/prod) >>>
CREATE OR REPLACE FUNCTION public.rollup_allday_rip_pull_value()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  n int;
  w timestamptz;
  t_start timestamptz := clock_timestamp();
BEGIN
  SELECT last_run_at INTO w FROM allday_rip_rollup_state WHERE singleton;
  w := COALESCE(w, '-infinity'::timestamptz);

  WITH changed AS (
    SELECT DISTINCT pack_nft_id
    FROM allday_pack_pull
    WHERE updated_at >= w
  ),
  agg AS (
    SELECT p.pack_nft_id,
           sum(p.fmv_usd)                                 AS total_fmv,
           count(*) FILTER (WHERE p.fmv_usd IS NOT NULL)  AS valued_pulls,
           count(*)                                       AS total_pulls
    FROM allday_pack_pull p
    JOIN changed c ON c.pack_nft_id = p.pack_nft_id
    GROUP BY p.pack_nft_id
  )
  UPDATE pack_rips r
  SET pull_value_usd = round(agg.total_fmv,2), metadata_updated_at = now()
  FROM agg
  WHERE r.collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'
    AND r.pack_nft_id = agg.pack_nft_id
    AND agg.valued_pulls = agg.total_pulls AND agg.total_fmv IS NOT NULL
    AND r.pull_value_usd IS DISTINCT FROM round(agg.total_fmv,2);
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE allday_rip_rollup_state SET last_run_at = t_start WHERE singleton;

  RETURN n;
END
$function$;
-- <<< END verbatim rollup_allday_rip_pull_value <<<

\set AD '''dee28451-5d62-409e-a1ad-a83f763ac070'''
\set TS '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''

INSERT INTO public.allday_rip_rollup_state (singleton, last_run_at) VALUES (true, NULL);

-- P-FULL    : 3 pulls, ALL priced        -> written
-- P-PARTIAL : 3 pulls, ONE unpriced      -> NOT written (the important case)
-- P-EMPTY   : 0 pulls                    -> not written (SUM over no rows is NULL)
-- P-SAME    : already carries the value  -> not rewritten
-- P-WRONGC  : a Top Shot rip             -> never touched
INSERT INTO public.allday_pack_pull (pack_nft_id, fmv_usd, updated_at) VALUES
  ('P-FULL',    10.00, '2026-06-01T00:00:00Z'),
  ('P-FULL',    20.00, '2026-06-01T00:00:00Z'),
  ('P-FULL',     5.505,'2026-06-01T00:00:00Z'),
  ('P-PARTIAL', 10.00, '2026-06-01T00:00:00Z'),
  ('P-PARTIAL', 20.00, '2026-06-01T00:00:00Z'),
  ('P-PARTIAL', NULL,  '2026-06-01T00:00:00Z'),
  ('P-SAME',    50.00, '2026-06-01T00:00:00Z'),
  ('P-WRONGC',  99.00, '2026-06-01T00:00:00Z');

INSERT INTO public.pack_rips (collection_id, pack_nft_id, pull_value_usd) VALUES
  (:AD::uuid, 'P-FULL',    NULL),
  (:AD::uuid, 'P-PARTIAL', NULL),
  (:AD::uuid, 'P-EMPTY',   NULL),
  (:AD::uuid, 'P-SAME',    50.00),
  (:TS::uuid, 'P-WRONGC',  NULL);

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '1',
  'only the fully-priced rip is written — P-SAME is unchanged, so it does not count'
);

SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-FULL'),
  '35.51',
  'a fully-priced rip gets the ROUNDED sum of its pulls'
);

-- ⚠ THE ASSERTION THIS FILE EXISTS FOR. A partial sum is a smaller number that
-- reads exactly like a real one: 30.00 would say this pack was worth $30 when
-- one of its three moments is simply unpriced. It fails in the reassuring
-- direction, so nothing downstream would ever report it.
SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-PARTIAL'),
  'NULL',
  'a rip with ANY unpriced pull is left NULL — a partial sum would understate the pack and look real'
);

SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-EMPTY'),
  'NULL',
  'a rip with no pulls at all is left NULL, not written as 0'
);

SELECT _assert_eq(
  (SELECT coalesce(metadata_updated_at::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-SAME'),
  'NULL',
  'an unchanged value is not rewritten — metadata_updated_at stays meaningful'
);

SELECT _assert_eq(
  (SELECT coalesce(pull_value_usd::text, 'NULL') FROM public.pack_rips WHERE pack_nft_id = 'P-WRONGC'),
  'NULL',
  'another collection is never touched'
);

-- ── The watermark ──────────────────────────────────────────────────────────
SELECT _assert_eq(
  (SELECT (last_run_at IS NOT NULL)::text FROM public.allday_rip_rollup_state),
  'true',
  'the watermark advances after a run'
);

-- A second run with nothing new does nothing, and still advances.
SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '0',
  'a second run with no new pulls writes nothing'
);

-- ⚠ THE WATERMARK IS INCLUSIVE (`updated_at >= w`), so a pull stamped EXACTLY at
-- the stored watermark is re-processed rather than skipped. Re-processing is
-- free — the UPDATE carries change-detection — while skipping loses the row for
-- good. This is the boundary where an off-by-one silently drops data.
UPDATE public.allday_pack_pull SET fmv_usd = 11.00, updated_at =
  (SELECT last_run_at FROM public.allday_rip_rollup_state)
WHERE pack_nft_id = 'P-FULL' AND fmv_usd = 10.00;

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '1',
  'a pull stamped EXACTLY at the watermark is re-processed, not skipped'
);
SELECT _assert_eq(
  (SELECT pull_value_usd::text FROM public.pack_rips WHERE pack_nft_id = 'P-FULL'),
  '36.51',
  '...and the new total lands'
);

-- ⚠ A never-run state is a FULL sweep, not a no-op: COALESCE(NULL, '-infinity')
-- makes the first-ever tick see everything rather than nothing.
UPDATE public.allday_rip_rollup_state SET last_run_at = NULL;
UPDATE public.pack_rips SET pull_value_usd = NULL WHERE pack_nft_id = 'P-FULL';

SELECT _assert_eq(
  public.rollup_allday_rip_pull_value()::text, '1',
  'a NULL watermark sweeps everything — the first-ever run is not a silent no-op'
);

ROLLBACK;
