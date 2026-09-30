-- DB invariant: public.compute_topshot_parallel_ratio_cells() and
-- public.refresh_edition_fmv_estimates(), the separate, labelled ESTIMATE for thin Top
-- Shot parallels (base FMV x typical parallel premium). It is never an FMV.
--
-- Pins, cells:
--   - time-matched ratio: a parallel's monthly median over the SAME month's base median;
--     a base month with < 3 sales, or a sale older than 365 days, contributes nothing
--   - per-(subedition, tier) median / p25 / p75, and the LEAVE-ONE-EDITION-OUT error,
--     checked exactly on both parity branches (n=4 and n=5 cells)
--   - eligible = n >= 30 AND error <= ln(1.5); a 30-edition cell that is too noisy
--     and a 5-edition cell are both ineligible
--   - write first, then delete only the cells this run did not write (a retired cell
--     goes); a run that computes ZERO cells keeps the previous set and reports ok=false
-- Pins, estimates:
--   - STALE / NO_DATA parallel + HIGH / MEDIUM base + eligible cell: base x median,
--     range base x p25 .. base x p75
--   - capped at the parallel's own FRESH live ask (edition_offers, <= 7 days);
--     a stale ask caps nothing
--   - own HIGH / MEDIUM, base LOW, ineligible cell, a non-`::` edition and another
--     collection all get NO row
--   - a row that no longer qualifies is deleted; a qualifying row is updated in place
--   - cells older than 15 days: fail closed, rows untouched, ok=false
--   - a statement_timeout (57014) inside the write is recorded, not swallowed:
--     ok=false with the cancel text, and the run is still logged
--
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260930133000_audit_20260930_edition_fmv_estimates_from_parallel_ratios.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TYPE fmv_confidence AS ENUM ('HIGH','MEDIUM','LOW','ASK_ONLY','SALES_ONLY','STALE','NO_DATA');
CREATE TYPE tier_type AS ENUM ('COMMON','FANDOM','RARE','LEGENDARY','ULTIMATE');

CREATE TABLE editions (
  id uuid PRIMARY KEY, collection_id uuid, external_id varchar, subedition_name text, tier tier_type,
  circulation_count int DEFAULT 10,
  UNIQUE (external_id, collection_id));
CREATE TABLE sales (id bigserial PRIMARY KEY, edition_id uuid, price_usd numeric, sold_at timestamptz);
CREATE TABLE edition_fmv_current (
  edition_id uuid PRIMARY KEY, collection_id uuid, fmv_usd numeric, floor_price_usd numeric,
  confidence fmv_confidence, computed_at timestamptz DEFAULT now());
CREATE TABLE edition_offers (
  collection_id uuid, external_id text, low_ask numeric, updated_at timestamptz,
  PRIMARY KEY (collection_id, external_id));
CREATE TABLE pipeline_runs (
  id bigserial PRIMARY KEY, pipeline text, collection_slug text, started_at timestamptz,
  finished_at timestamptz, rows_found int, rows_written int, rows_skipped int,
  cursor_before text, cursor_after text, ok boolean, error text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(
  p_pipeline text, p_started_at timestamptz, p_rows_found int DEFAULT 0, p_rows_written int DEFAULT 0,
  p_rows_skipped int DEFAULT 0, p_ok boolean DEFAULT true, p_error text DEFAULT NULL,
  p_collection_slug text DEFAULT NULL, p_cursor_before text DEFAULT NULL, p_cursor_after text DEFAULT NULL,
  p_extra jsonb DEFAULT NULL) RETURNS bigint LANGUAGE sql AS
'INSERT INTO pipeline_runs (pipeline, collection_slug, started_at, finished_at, rows_found, rows_written,
   rows_skipped, cursor_before, cursor_after, ok, error, extra)
 VALUES (p_pipeline, p_collection_slug, p_started_at, clock_timestamp(), p_rows_found, p_rows_written,
   p_rows_skipped, p_cursor_before, p_cursor_after, p_ok, p_error, p_extra) RETURNING id';

-- The two tables, as the migration creates them (constraints included: the CHECKs are
-- part of what the writer must satisfy).
CREATE TABLE public.topshot_parallel_ratio_cells (
  subedition_name        text        NOT NULL,
  tier                   text        NOT NULL,
  n_editions             int         NOT NULL CHECK (n_editions > 0),
  median_ratio           numeric     NOT NULL CHECK (median_ratio > 0),
  p25_ratio              numeric     NOT NULL CHECK (p25_ratio > 0),
  p75_ratio              numeric     NOT NULL CHECK (p75_ratio > 0),
  loo_median_abs_log_err numeric,
  eligible               boolean     NOT NULL,
  computed_at            timestamptz NOT NULL,
  PRIMARY KEY (subedition_name, tier)
);
CREATE TABLE public.edition_fmv_estimates (
  edition_id      uuid        PRIMARY KEY,
  collection_id   uuid        NOT NULL,
  estimate_usd    numeric     NOT NULL CHECK (estimate_usd > 0),
  range_low_usd   numeric,
  range_high_usd  numeric,
  basis           text        NOT NULL CHECK (basis IN ('parallel_ratio')),
  base_edition_id uuid        NOT NULL,
  base_fmv_usd    numeric     NOT NULL,
  ratio           numeric     NOT NULL,
  subedition_name text        NOT NULL,
  tier            text,
  cell_n          int         NOT NULL,
  cell_err        numeric,
  own_fmv_usd     numeric,
  own_confidence  text,
  capped_at_ask   boolean     NOT NULL DEFAULT false,
  computed_at     timestamptz NOT NULL,
  CHECK (range_low_usd IS NULL OR range_low_usd <= estimate_usd),
  CHECK (range_high_usd IS NULL OR estimate_usd <= range_high_usd)
);

-- >>> BEGIN verbatim compute_topshot_parallel_ratio_cells (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.compute_topshot_parallel_ratio_cells()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll       constant uuid    := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_min_n      constant int     := 30;
  v_max_err    constant float8  := ln(1.5::float8);
  v_started    timestamptz := clock_timestamp();
  v_stamp      timestamptz := clock_timestamp();
  v_obs        int;            -- NULL = not measured (the read failed)
  v_cells      int;            -- NULL = not measured
  v_written    int := 0;       -- rows that LANDED; a rolled-back write is 0, truly
  v_eligible   int;
  v_deleted    int;            -- NULL = the delete did not run
  v_err        text;
  v_delete_err text;
  v_ok         boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('compute_topshot_parallel_ratio_cells')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    WITH par AS (
      SELECT e.id AS pid, e.subedition_name AS sub, e.tier::text AS tier, be.id AS bid
      FROM editions e
      JOIN editions be
        ON be.collection_id = e.collection_id
       AND be.external_id = split_part(e.external_id, '::', 1)
      WHERE e.collection_id = v_coll
        AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
        AND e.subedition_name IS NOT NULL
        AND e.tier IS NOT NULL
    ), pm AS (
      SELECT p.pid, p.sub, p.tier, p.bid, date_trunc('month', s.sold_at) AS m,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::float8) AS pmed
      FROM par p
      JOIN sales s ON s.edition_id = p.pid
      WHERE s.sold_at >= now() - interval '365 days'
        AND s.price_usd > 0
      GROUP BY 1, 2, 3, 4, 5
    ), bm AS (
      SELECT s.edition_id AS bid, date_trunc('month', s.sold_at) AS m,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY s.price_usd::float8) AS bmed,
             count(*) AS bn
      FROM sales s
      WHERE s.edition_id IN (SELECT DISTINCT bid FROM pm)
        AND s.sold_at >= now() - interval '365 days'
        AND s.price_usd > 0
      GROUP BY 1, 2
    ), obs AS (
      SELECT pm.pid, pm.sub, pm.tier, pm.pmed / bm.bmed AS ratio
      FROM pm
      JOIN bm ON bm.bid = pm.bid AND bm.m = pm.m
      WHERE bm.bn >= 3 AND bm.bmed > 0
    ), per_ed AS (
      SELECT pid, sub, tier, percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS r
      FROM obs
      GROUP BY 1, 2, 3
    ), ranked AS (
      SELECT pe.*,
             (row_number() OVER (PARTITION BY sub, tier ORDER BY r, pid))::int AS k,
             (count(*)     OVER (PARTITION BY sub, tier))::int                 AS n
      FROM per_ed pe
    ), arr AS (
      SELECT sub, tier, array_agg(r ORDER BY r, pid) AS a
      FROM per_ed
      GROUP BY 1, 2
    ), loo AS (
      -- The median of the cell WITHOUT this edition, read off the sorted array with
      -- the edition's own slot (k) skipped: remaining slot j is a[j] if j < k, else
      -- a[j+1]. Same definition as percentile_cont(0.5) on the n-1 survivors.
      SELECT rk.sub, rk.tier, rk.r AS actual,
             CASE
               WHEN rk.n < 2 THEN NULL
               WHEN (rk.n - 1) % 2 = 1 THEN
                 CASE WHEN (rk.n / 2) < rk.k THEN arr.a[rk.n / 2] ELSE arr.a[rk.n / 2 + 1] END
               ELSE (
                 (CASE WHEN ((rk.n - 1) / 2) < rk.k THEN arr.a[(rk.n - 1) / 2] ELSE arr.a[(rk.n - 1) / 2 + 1] END)
               + (CASE WHEN ((rk.n - 1) / 2 + 1) < rk.k THEN arr.a[(rk.n - 1) / 2 + 1] ELSE arr.a[(rk.n - 1) / 2 + 2] END)
               ) / 2
             END AS pred
      FROM ranked rk
      JOIN arr ON arr.sub = rk.sub AND arr.tier = rk.tier
    ), err AS (
      SELECT sub, tier,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(ln(pred / actual))) AS e
      FROM loo
      WHERE pred > 0 AND actual > 0
      GROUP BY 1, 2
    ), cells AS (
      SELECT pe.sub, pe.tier, count(*)::int AS n,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY pe.r) AS med,
             percentile_cont(0.25) WITHIN GROUP (ORDER BY pe.r) AS p25,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY pe.r) AS p75,
             max(err.e) AS e
      FROM per_ed pe
      LEFT JOIN err ON err.sub = pe.sub AND err.tier = pe.tier
      GROUP BY 1, 2
    ), up AS (
      INSERT INTO topshot_parallel_ratio_cells AS t (
        subedition_name, tier, n_editions, median_ratio, p25_ratio, p75_ratio,
        loo_median_abs_log_err, eligible, computed_at)
      SELECT c.sub, c.tier, c.n,
             round(c.med::numeric, 4), round(c.p25::numeric, 4), round(c.p75::numeric, 4),
             round(c.e::numeric, 4),
             (c.n >= v_min_n AND c.e IS NOT NULL AND c.e <= v_max_err),
             v_stamp
      FROM cells c
      ON CONFLICT (subedition_name, tier) DO UPDATE SET
        n_editions             = EXCLUDED.n_editions,
        median_ratio           = EXCLUDED.median_ratio,
        p25_ratio              = EXCLUDED.p25_ratio,
        p75_ratio              = EXCLUDED.p75_ratio,
        loo_median_abs_log_err = EXCLUDED.loo_median_abs_log_err,
        eligible               = EXCLUDED.eligible,
        computed_at            = EXCLUDED.computed_at
      RETURNING t.eligible
    )
    SELECT (SELECT count(*) FROM obs), (SELECT count(*) FROM cells),
           count(*), count(*) FILTER (WHERE up.eligible)
      INTO v_obs, v_cells, v_written, v_eligible
      FROM up;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  IF v_err IS NULL AND v_written = 0 THEN
    -- Zero cells is a broken read, never "no parallel carries a premium": keep the
    -- previous set rather than let the delete below empty the table.
    v_err := 'no cells computed; previous cell set kept';
  END IF;

  IF v_err IS NULL THEN
    BEGIN
      DELETE FROM topshot_parallel_ratio_cells WHERE computed_at IS DISTINCT FROM v_stamp;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_delete_err := left(SQLERRM, 300);
    END;
  END IF;

  v_ok := v_err IS NULL AND v_delete_err IS NULL AND v_written = v_cells;

  PERFORM public.log_pipeline_run(
    'topshot-parallel-ratio-cells', v_started, v_cells, v_written, 0,
    v_ok, coalesce(v_err, v_delete_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('observations', v_obs, 'cells', v_cells, 'cells_written', v_written,
                       'write_error', v_err, 'cells_eligible', v_eligible,
                       'cells_deleted', v_deleted, 'delete_error', v_delete_err,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_ok, 'observations', v_obs, 'cells', v_cells,
                            'cells_written', v_written, 'write_error', v_err,
                            'cells_eligible', v_eligible, 'cells_deleted', v_deleted,
                            'delete_error', v_delete_err);
END
$function$;
-- <<< END verbatim compute_topshot_parallel_ratio_cells <<<

-- >>> BEGIN verbatim refresh_edition_fmv_estimates (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_estimates()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_coll           constant uuid     := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_cell_max_age   constant interval := interval '15 days';
  v_ask_max_age    constant interval := interval '7 days';
  v_started        timestamptz := clock_timestamp();
  v_stamp          timestamptz := clock_timestamp();
  v_cells_eligible int;
  v_cells_newest   timestamptz;
  v_cand           int;            -- NULL = not measured (the read failed or was skipped)
  v_written        int := 0;       -- rows that LANDED
  v_capped         int;
  v_deleted        int;            -- NULL = the delete did not run
  v_err            text;
  v_delete_err     text;
  v_ok             boolean;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('refresh_edition_fmv_estimates')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  SELECT count(*) FILTER (WHERE eligible), max(computed_at)
    INTO v_cells_eligible, v_cells_newest
    FROM topshot_parallel_ratio_cells;

  IF v_cells_newest IS NULL OR v_cells_newest < now() - v_cell_max_age THEN
    -- Fail closed: no fresh ratios, no new estimates. Existing rows keep their own
    -- computed_at, so a reader can see how old they are.
    v_err := 'ratio cells missing or older than 15 days; estimates left untouched';
  ELSE
    BEGIN
      WITH cand AS (
        SELECT e.id AS edition_id, e.collection_id, e.subedition_name, e.tier::text AS tier,
               be.id AS base_edition_id, bf.fmv_usd AS base_fmv,
               c.median_ratio, c.p25_ratio, c.p75_ratio, c.n_editions, c.loo_median_abs_log_err,
               own.fmv_usd AS own_fmv, own.confidence::text AS own_conf,
               round(ask.low_ask, 2) AS ask
        FROM editions e
        JOIN edition_fmv_current own
          ON own.edition_id = e.id
         AND own.confidence::text IN ('STALE', 'NO_DATA')
        JOIN editions be
          ON be.collection_id = e.collection_id
         AND be.external_id = split_part(e.external_id, '::', 1)
        JOIN edition_fmv_current bf
          ON bf.edition_id = be.id
         AND bf.confidence::text IN ('HIGH', 'MEDIUM')
         AND bf.fmv_usd > 0
        JOIN topshot_parallel_ratio_cells c
          ON c.subedition_name = e.subedition_name
         AND c.tier = e.tier::text
         AND c.eligible
         AND c.computed_at >= now() - v_cell_max_age
        LEFT JOIN edition_offers ask
          ON ask.collection_id = e.collection_id
         AND ask.external_id = e.external_id
         AND ask.low_ask > 0
         AND ask.updated_at >= now() - v_ask_max_age
        WHERE e.collection_id = v_coll
          AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
          -- No estimate for a one-of-one (Trevor, 2026-09-30): a 1/1 is priced by
          -- who wants THAT card, not by a multiple of its full edition.
          AND e.circulation_count > 1
      ), priced AS (
        SELECT cand.*,
               round(base_fmv * median_ratio, 2) AS raw_est,
               round(base_fmv * p25_ratio, 2)    AS raw_lo,
               round(base_fmv * p75_ratio, 2)    AS raw_hi
        FROM cand
      ), up AS (
        INSERT INTO edition_fmv_estimates AS t (
          edition_id, collection_id, estimate_usd, range_low_usd, range_high_usd, basis,
          base_edition_id, base_fmv_usd, ratio, subedition_name, tier, cell_n, cell_err,
          own_fmv_usd, own_confidence, capped_at_ask, computed_at)
        SELECT p.edition_id, p.collection_id,
               least(p.raw_est, coalesce(p.ask, p.raw_est)),
               least(p.raw_lo,  coalesce(p.ask, p.raw_lo)),
               least(p.raw_hi,  coalesce(p.ask, p.raw_hi)),
               'parallel_ratio',
               p.base_edition_id, p.base_fmv, p.median_ratio, p.subedition_name, p.tier,
               p.n_editions, p.loo_median_abs_log_err,
               p.own_fmv, p.own_conf,
               (p.ask IS NOT NULL AND p.raw_est > p.ask),
               v_stamp
        FROM priced p
        ON CONFLICT (edition_id) DO UPDATE SET
          collection_id   = EXCLUDED.collection_id,
          estimate_usd    = EXCLUDED.estimate_usd,
          range_low_usd   = EXCLUDED.range_low_usd,
          range_high_usd  = EXCLUDED.range_high_usd,
          basis           = EXCLUDED.basis,
          base_edition_id = EXCLUDED.base_edition_id,
          base_fmv_usd    = EXCLUDED.base_fmv_usd,
          ratio           = EXCLUDED.ratio,
          subedition_name = EXCLUDED.subedition_name,
          tier            = EXCLUDED.tier,
          cell_n          = EXCLUDED.cell_n,
          cell_err        = EXCLUDED.cell_err,
          own_fmv_usd     = EXCLUDED.own_fmv_usd,
          own_confidence  = EXCLUDED.own_confidence,
          capped_at_ask   = EXCLUDED.capped_at_ask,
          computed_at     = EXCLUDED.computed_at
        RETURNING t.capped_at_ask
      )
      SELECT (SELECT count(*) FROM priced), count(*), count(*) FILTER (WHERE up.capped_at_ask)
        INTO v_cand, v_written, v_capped
        FROM up;
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_err := left(SQLERRM, 300);
    END;

    -- Write first, then retire only what this run did NOT write (R123). A failed write
    -- skips the delete, so the previous estimates survive a broken run.
    IF v_err IS NULL THEN
      BEGIN
        DELETE FROM edition_fmv_estimates WHERE computed_at IS DISTINCT FROM v_stamp;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;
      EXCEPTION WHEN query_canceled OR OTHERS THEN
        v_delete_err := left(SQLERRM, 300);
      END;
    END IF;
  END IF;

  v_ok := v_err IS NULL AND v_delete_err IS NULL AND v_written = v_cand;

  PERFORM public.log_pipeline_run(
    'edition-fmv-estimates', v_started, v_cand, v_written, 0,
    v_ok, coalesce(v_err, v_delete_err), 'nba_top_shot', NULL, NULL,
    jsonb_build_object('candidates', v_cand, 'estimates_written', v_written, 'write_error', v_err,
                       'capped_at_ask', v_capped, 'estimates_deleted', v_deleted,
                       'delete_error', v_delete_err, 'cells_eligible', v_cells_eligible,
                       'cells_computed_at', v_cells_newest,
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_ok, 'candidates', v_cand, 'estimates_written', v_written,
                            'write_error', v_err, 'capped_at_ask', v_capped,
                            'estimates_deleted', v_deleted, 'delete_error', v_delete_err,
                            'cells_eligible', v_cells_eligible, 'cells_computed_at', v_cells_newest);
END
$function$;
-- <<< END verbatim refresh_edition_fmv_estimates <<<

-- ── Fixtures: ratio cells ─────────────────────────────────────────────────────
-- Cell c, edition i: base external 'c:i' with 3 sales at 10 in month M; parallel
-- 'c:i::s' with one sale at 10 x ratio in month M, so its ratio is exactly `ratio`.
CREATE FUNCTION _mk_cell(c int, sub text, t tier_type, ratios numeric[], base_sales int DEFAULT 3,
                         sold timestamptz DEFAULT date_trunc('month', now() - interval '40 days') + interval '3 days')
RETURNS void LANGUAGE plpgsql AS $mk$
DECLARE i int; b uuid; p uuid; ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  FOR i IN 1 .. cardinality(ratios) LOOP
    b := md5('b' || c || ':' || i)::uuid;
    p := md5('p' || c || ':' || i)::uuid;
    INSERT INTO editions VALUES (b, ts, c || ':' || i, NULL, t);
    INSERT INTO editions VALUES (p, ts, c || ':' || i || '::20', sub, t);
    INSERT INTO sales (edition_id, price_usd, sold_at) SELECT b, 10, sold FROM generate_series(1, base_sales);
    INSERT INTO sales (edition_id, price_usd, sold_at) VALUES (p, 10 * ratios[i], sold);
  END LOOP;
END $mk$;

-- 1 Jukebox/RARE: 30 editions, ratios 3,4,5 x 10 → median 4, p25 3, p75 5, LOO error
--   = median of {0.2877 x10, 0 x10, 0.2231 x10} = 0.2231 → eligible.
SELECT _mk_cell(1, 'Jukebox', 'RARE', (SELECT array_agg(3 + (g % 3)) FROM generate_series(0, 29) g));
-- 2 Hexwave/FANDOM: 5 editions at ratio 2 → error 0 but n < 30 → ineligible.
SELECT _mk_cell(2, 'Hexwave', 'FANDOM', ARRAY[2,2,2,2,2]);
-- 3 Noisy/RARE: 30 editions alternating 1 and 16 → LOO error ln 16 → ineligible.
SELECT _mk_cell(3, 'Noisy', 'RARE', (SELECT array_agg(CASE WHEN g % 2 = 0 THEN 1 ELSE 16 END) FROM generate_series(0, 29) g));
-- 4 LooA/RARE [1,2,4,8]: n-1 = 3 (odd branch) → errors ln4, ln2, ln2, ln4 → 1.5 ln2 = 1.0397.
SELECT _mk_cell(4, 'LooA', 'RARE', ARRAY[1,2,4,8]);
-- 5 LooB/RARE [1,2,4,8,16]: n-1 = 4 (even branch) → errors ln6, ln3, ln1.25, ln(8/3), ln(16/3) → ln3 = 1.0986.
SELECT _mk_cell(5, 'LooB', 'RARE', ARRAY[1,2,4,8,16]);
-- 6 Thin/RARE: the base has only 2 sales that month → no observation → no cell.
SELECT _mk_cell(6, 'Thin', 'RARE', ARRAY[4], 2);
-- 7 Old/LEGENDARY: every sale is 400 days old → no cell.
SELECT _mk_cell(7, 'Old', 'LEGENDARY', ARRAY[4], 3, now() - interval '400 days');
-- A cell from an earlier run whose parallels no longer trade → retired by this run.
INSERT INTO topshot_parallel_ratio_cells VALUES ('Retired', 'RARE', 40, 2, 1, 3, 0.1, true, now() - interval '7 days');

SELECT _assert_eq((SELECT (r->>'ok') || '/' || (r->>'observations') || '/' || (r->>'cells') || '/' || (r->>'cells_written')
                          || '/' || (r->>'cells_eligible') || '/' || (r->>'cells_deleted')
                   FROM compute_topshot_parallel_ratio_cells() r),
  'true/74/5/5/1/1', 'cells: 74 observations, 5 cells written, 1 eligible, the retired cell deleted');

SELECT _assert_eq((SELECT string_agg(subedition_name || '/' || tier, ',' ORDER BY subedition_name) FROM topshot_parallel_ratio_cells),
  'Hexwave/FANDOM,Jukebox/RARE,LooA/RARE,LooB/RARE,Noisy/RARE',
  'thin base month, 400-day-old sales and the retired cell contribute no cell');
SELECT _assert_eq((SELECT n_editions || ':' || median_ratio || ':' || p25_ratio || ':' || p75_ratio || ':' || loo_median_abs_log_err || ':' || eligible
                   FROM topshot_parallel_ratio_cells WHERE subedition_name = 'Jukebox'),
  '30:4.0000:3.0000:5.0000:0.2231:true', 'Jukebox: time-matched median/p25/p75, LOO error 0.2231, eligible');
SELECT _assert_eq((SELECT loo_median_abs_log_err || ':' || eligible FROM topshot_parallel_ratio_cells WHERE subedition_name = 'Hexwave'),
  '0.0000:false', 'Hexwave: a perfect 5-edition cell is still ineligible (n < 30)');
SELECT _assert_eq((SELECT n_editions || ':' || loo_median_abs_log_err || ':' || eligible FROM topshot_parallel_ratio_cells WHERE subedition_name = 'Noisy'),
  '30:2.7726:false', 'Noisy: 30 editions but LOO error ln16 → ineligible');
SELECT _assert_eq((SELECT loo_median_abs_log_err::text FROM topshot_parallel_ratio_cells WHERE subedition_name = 'LooA'),
  '1.0397', 'LOO median, odd survivor count (n=4): 1.5 ln2');
SELECT _assert_eq((SELECT loo_median_abs_log_err::text FROM topshot_parallel_ratio_cells WHERE subedition_name = 'LooB'),
  '1.0986', 'LOO median, even survivor count (n=5): ln3');
SELECT _assert_eq((SELECT ok || ':' || rows_found || ':' || rows_written || ':' || collection_slug FROM pipeline_runs WHERE pipeline = 'topshot-parallel-ratio-cells'),
  'true:5:5:nba_top_shot', 'the cells run is logged with counts that match what landed');

-- ── Fixtures: estimates (no sales needed; they read edition_fmv_current + cells) ──
DO $seed$
DECLARE
  ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
BEGIN
  INSERT INTO editions VALUES
    ('e0000001-0000-0000-0000-000000000001', ts, '50:1', NULL, 'RARE'),
    ('e0000001-0000-0000-0000-000000000011', ts, '50:1::20', 'Jukebox', 'RARE'),
    ('e0000002-0000-0000-0000-000000000001', ts, '50:2', NULL, 'RARE'),
    ('e0000002-0000-0000-0000-000000000011', ts, '50:2::20', 'Jukebox', 'RARE'),
    ('e0000003-0000-0000-0000-000000000001', ts, '50:3', NULL, 'RARE'),
    ('e0000003-0000-0000-0000-000000000011', ts, '50:3::20', 'Jukebox', 'RARE'),
    ('e0000004-0000-0000-0000-000000000001', ts, '50:4', NULL, 'RARE'),
    ('e0000004-0000-0000-0000-000000000011', ts, '50:4::20', 'Jukebox', 'RARE'),
    ('e0000005-0000-0000-0000-000000000001', ts, '50:5', NULL, 'RARE'),
    ('e0000005-0000-0000-0000-000000000011', ts, '50:5::20', 'Jukebox', 'RARE'),
    ('e0000006-0000-0000-0000-000000000001', ts, '50:6', NULL, 'FANDOM'),
    ('e0000006-0000-0000-0000-000000000011', ts, '50:6::19', 'Hexwave', 'FANDOM'),
    ('e0000007-0000-0000-0000-000000000001', ts, '50:7', NULL, 'RARE'),
    ('e0000007-0000-0000-0000-000000000011', ts, '50:7::20', 'Jukebox', 'RARE'),
    ('e0000008-0000-0000-0000-000000000001', ts, '50:8', 'Jukebox', 'RARE'),
    ('e0000009-0000-0000-0000-000000000001', ad, '50:9', NULL, 'RARE'),
    ('e0000009-0000-0000-0000-000000000011', ad, '50:9::20', 'Jukebox', 'RARE');
  -- E10: a ONE-OF-ONE STALE parallel in an eligible cell with a HIGH base → no row.
  INSERT INTO editions (id, collection_id, external_id, subedition_name, tier, circulation_count) VALUES
    ('e0000010-0000-0000-0000-000000000001', ts, '50:10', NULL, 'RARE', 99),
    ('e0000010-0000-0000-0000-000000000011', ts, '50:10::20', 'Jukebox', 'RARE', 1);
  INSERT INTO edition_fmv_current (edition_id, collection_id, fmv_usd, floor_price_usd, confidence) VALUES
    -- E1: STALE parallel, HIGH base 10 → 40.00 (30.00 .. 50.00). Its old floor 30 is a
    --     historical sale and must NOT cap anything.
    ('e0000001-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000001-0000-0000-0000-000000000011', ts, 45, 30, 'STALE'),
    -- E2: NO_DATA parallel, MEDIUM base, fresh ask 35 → capped at 35.
    ('e0000002-0000-0000-0000-000000000001', ts, 10, 9, 'MEDIUM'),
    ('e0000002-0000-0000-0000-000000000011', ts, NULL, NULL, 'NO_DATA'),
    -- E3: STALE parallel, ask 20 last seen 8 days ago → not a cap.
    ('e0000003-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000003-0000-0000-0000-000000000011', ts, 45, 30, 'STALE'),
    -- E4: the parallel is itself HIGH → no row (and its old estimate row is retired).
    ('e0000004-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000004-0000-0000-0000-000000000011', ts, 44, 40, 'HIGH'),
    -- E5: the parallel is itself MEDIUM → no row.
    ('e0000005-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000005-0000-0000-0000-000000000011', ts, 44, 40, 'MEDIUM'),
    -- E6: STALE parallel in an INELIGIBLE cell (Hexwave/FANDOM) → no row.
    ('e0000006-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000006-0000-0000-0000-000000000011', ts, 45, 30, 'STALE'),
    -- E7: base is only LOW → no row.
    ('e0000007-0000-0000-0000-000000000001', ts, 10, 9, 'LOW'),
    ('e0000007-0000-0000-0000-000000000011', ts, 45, 30, 'STALE'),
    -- E8: a STALE non-`::` edition that even carries a subedition name → no row.
    ('e0000008-0000-0000-0000-000000000001', ts, 45, 30, 'STALE'),
    -- E9: another collection → no row.
    ('e0000009-0000-0000-0000-000000000001', ad, 10, 9, 'HIGH'),
    ('e0000009-0000-0000-0000-000000000011', ad, 45, 30, 'STALE'),
    -- E10: 1/1 → no row.
    ('e0000010-0000-0000-0000-000000000001', ts, 10, 9, 'HIGH'),
    ('e0000010-0000-0000-0000-000000000011', ts, 45, 30, 'STALE');
  INSERT INTO edition_offers VALUES
    (ts, '50:2::20', 35, now() - interval '1 hour'),
    (ts, '50:3::20', 20, now() - interval '8 days');
  -- Rows from an earlier run: E1 (re-qualifies, must be updated) and E4 (no longer qualifies).
  INSERT INTO edition_fmv_estimates (edition_id, collection_id, estimate_usd, basis, base_edition_id,
    base_fmv_usd, ratio, subedition_name, cell_n, computed_at) VALUES
    ('e0000001-0000-0000-0000-000000000011', ts, 99, 'parallel_ratio', 'e0000001-0000-0000-0000-000000000001', 10, 9.9, 'Jukebox', 30, now() - interval '1 day'),
    ('e0000004-0000-0000-0000-000000000011', ts, 99, 'parallel_ratio', 'e0000004-0000-0000-0000-000000000001', 10, 9.9, 'Jukebox', 30, now() - interval '1 day');
END $seed$;

SELECT _assert_eq((SELECT (r->>'ok') || '/' || (r->>'candidates') || '/' || (r->>'estimates_written') || '/' || (r->>'capped_at_ask')
                          || '/' || (r->>'estimates_deleted') || '/' || coalesce(r->>'write_error', 'null')
                   FROM refresh_edition_fmv_estimates() r),
  'true/3/3/1/1/null', 'estimates: 3 qualify, 3 land, 1 capped, 1 retired');

SELECT _assert_eq((SELECT estimate_usd || ':' || range_low_usd || ':' || range_high_usd || ':' || ratio || ':' || base_fmv_usd || ':'
                          || base_edition_id || ':' || own_fmv_usd || ':' || own_confidence || ':' || capped_at_ask || ':' || cell_n || ':' || cell_err || ':' || basis
                   FROM edition_fmv_estimates WHERE edition_id = 'e0000001-0000-0000-0000-000000000011'),
  '40.00:30.00:50.00:4.0000:10:e0000001-0000-0000-0000-000000000001:45:STALE:false:30:0.2231:parallel_ratio',
  'E1: base x median, range base x p25..p75, the old 99 updated in place, a historical floor caps nothing');
SELECT _assert_eq((SELECT estimate_usd || ':' || range_low_usd || ':' || range_high_usd || ':' || capped_at_ask || ':' || coalesce(own_fmv_usd::text, 'null') || ':' || own_confidence
                   FROM edition_fmv_estimates WHERE edition_id = 'e0000002-0000-0000-0000-000000000011'),
  '35.00:30.00:35.00:true:null:NO_DATA', 'E2: estimate and range_high capped at the fresh live ask');
SELECT _assert_eq((SELECT estimate_usd || ':' || capped_at_ask FROM edition_fmv_estimates WHERE edition_id = 'e0000003-0000-0000-0000-000000000011'),
  '40.00:false', 'E3: an 8-day-old ask caps nothing');
SELECT _assert((SELECT count(*) = 3 FROM edition_fmv_estimates
                WHERE edition_id IN ('e0000001-0000-0000-0000-000000000011','e0000002-0000-0000-0000-000000000011','e0000003-0000-0000-0000-000000000011')),
  'the three rows are exactly E1, E2, E3 (own HIGH/MEDIUM, base LOW, ineligible cell, non-::, All Day and a 1/1 get none; E4 deleted)');
SELECT _assert_eq((SELECT ok || ':' || rows_found || ':' || rows_written || ':' || (extra->>'estimates_deleted') FROM pipeline_runs WHERE pipeline = 'edition-fmv-estimates'),
  'true:3:3:1', 'the estimates run is logged with counts that match what landed');

-- ── Fail closed on stale cells ─────────────────────────────────────────────────
UPDATE topshot_parallel_ratio_cells SET computed_at = now() - interval '20 days';
UPDATE edition_fmv_current SET confidence = 'HIGH' WHERE edition_id = 'e0000001-0000-0000-0000-000000000011';
SELECT _assert_eq((SELECT (r->>'ok') || '/' || coalesce(r->>'candidates', 'null') || '/' || (r->>'write_error') FROM refresh_edition_fmv_estimates() r),
  'false/null/ratio cells missing or older than 15 days; estimates left untouched', 'stale cells: ok=false, candidates not measured');
SELECT _assert_eq((SELECT count(*)::text FROM edition_fmv_estimates), '3', 'stale cells: existing estimates untouched (not deleted, not rewritten)');
UPDATE topshot_parallel_ratio_cells SET computed_at = now();
UPDATE edition_fmv_current SET confidence = 'STALE' WHERE edition_id = 'e0000001-0000-0000-0000-000000000011';

-- ── A 57014 inside the write is RECORDED, not swallowed ─────────────────────────
CREATE FUNCTION _slow() RETURNS trigger LANGUAGE plpgsql AS $sl$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $sl$;
CREATE TRIGGER _slow BEFORE INSERT ON edition_fmv_estimates FOR EACH ROW EXECUTE FUNCTION _slow();
CREATE TEMP TABLE _r57 (r jsonb);
SET LOCAL statement_timeout = '300ms';
INSERT INTO _r57 SELECT refresh_edition_fmv_estimates();
SET LOCAL statement_timeout = 0;
SELECT _assert_eq((SELECT (r->>'ok') || '/' || (r->>'estimates_written') || '/' || coalesce(r->>'estimates_deleted', 'null') FROM _r57),
  'false/0/null', '57014: the run reports ok=false, 0 written, and does not run the delete');
SELECT _assert((SELECT r->>'write_error' LIKE '%statement timeout%' FROM _r57), '57014: the cancel text is recorded as write_error');
SELECT _assert_eq((SELECT count(*)::text FROM edition_fmv_estimates), '3', '57014: the rolled-back write left the previous rows intact');
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_runs WHERE pipeline = 'edition-fmv-estimates' AND NOT ok AND error LIKE '%statement timeout%'),
  '1', '57014: the killed run is still logged');
DROP TRIGGER _slow ON edition_fmv_estimates;

-- ── Zero cells keeps the previous set ──────────────────────────────────────────
DELETE FROM sales;
SELECT _assert_eq((SELECT (r->>'ok') || '/' || (r->>'cells') || '/' || (r->>'cells_written') || '/' || coalesce(r->>'cells_deleted', 'null') || '/' || (r->>'write_error')
                   FROM compute_topshot_parallel_ratio_cells() r),
  'false/0/0/null/no cells computed; previous cell set kept', 'zero cells: ok=false and nothing deleted');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_parallel_ratio_cells), '5', 'zero cells: the previous 5 cells survive');

\echo '✓ refresh_edition_fmv_estimates + compute_topshot_parallel_ratio_cells: all invariants hold'

ROLLBACK;
