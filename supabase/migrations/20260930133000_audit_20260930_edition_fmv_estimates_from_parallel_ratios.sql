-- 2026-09-30 (PT): a separate, clearly-labelled ESTIMATE for thin Top Shot parallels,
-- priced from the base edition's FMV times the typical premium of that parallel type.
-- It is NOT an FMV.
--
-- WHY. A collector holding 9 of 10 copies of Ausar Thompson Metallic Gold LE [Jukebox]
-- (233:8127::20) sees FMV $45 STALE. That $45 is the median of the edition's 8 sales
-- (Mar-May 2026), and all 8 went to ONE buyer, so the number is essentially that
-- collector's own cost basis. A longer lookback cannot fix this, because the cold-FMV
-- writers already price from the edition's latest market regime, however old
-- (20260926032039). The base edition (/199) is MEDIUM at $8.71, and across 491 RARE
-- Jukebox parallels a Jukebox sells for about 4x its base in the same month. That is a
-- real comp, just not a sale of THIS edition.
--
-- WHAT.
--   1. topshot_parallel_ratio_cells: one row per (subedition_name, tier), computed
--      weekly. For every Top Shot `::` parallel with sales in the last 365 days, each
--      month's parallel median sale is divided by the SAME month's base-edition median
--      (base needs >= 3 sales that month). The per-edition median ratio is taken, then
--      the cell's median, p25 and p75. Accuracy is measured LEAVE-ONE-EDITION-OUT: each
--      edition's ratio is predicted by the median of the OTHER editions in its cell, and
--      the cell error is the median |ln(pred/actual)|. A cell is eligible only with
--      >= 30 editions AND error <= ln(1.5). This excludes the FANDOM cells, whose
--      in-sample error measured ~2x-3x on 2026-09-29.
--   2. edition_fmv_estimates: one row per Top Shot `::` parallel whose OWN current FMV
--      (edition_fmv_current) is STALE or NO_DATA, whose base edition is HIGH or MEDIUM,
--      and whose cell is eligible. estimate = base FMV x cell median ratio;
--      range = base x p25 .. base x p75. Everything is capped at the parallel's own live
--      ask when one exists (capped_at_ask). One-of-ones (circulation 1 — every Omega)
--      get no estimate: a 1/1 is priced by who wants that card, not by a multiple.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH. fmv_snapshots, edition_fmv_current, the
-- confidence-share metrics and every deal/sniper board read none of these tables, so the
-- HIGH/MEDIUM share cannot move and no board can show a "discount" against an estimate.
-- The estimate never replaces the FMV. It sits beside it, with its basis.
--
-- THE ASK CAP'S SOURCE. The live per-parallel ask is edition_offers.low_ask on the
-- parallel's own `::` external_id, dated by updated_at (7-day gate, the same bound
-- MAX_ASK_AGE_HOURS_CORROBORATION uses). It is NOT edition_fmv_current.floor_price_usd,
-- which for a sales-priced row is the MIN HISTORICAL SALE: Jukebox reads $30 there from a
-- March print. Capping at that would publish an old sale as a ceiling. Nor is it
-- topshot_parallel_asks, which fmv-recalc Step 5e reads but which has not been written
-- since 2026-08-27 (0 rows updated in 7 days, measured 2026-09-30).
--
-- HONESTY (CLAUDE.md write side, R120/R123). Each function writes first (upsert stamped
-- with this run's clock_timestamp) and then deletes only the rows it did NOT write, so no
-- delete-then-insert window exists. `ok` is derived from rows landed == rows computed,
-- and every count is paired with its own _error. A run that computes ZERO cells keeps the
-- previous cell set (ok=false): zero cells means the read broke, not that no parallel
-- has a premium. The estimate refresh fails closed when the cells are missing or older
-- than 15 days (ok=false, rows untouched). Handlers are `WHEN query_canceled OR OTHERS`,
-- and after each catch only a bounded log_pipeline_run follows.
--
-- ACCESS. Both tables have RLS ON and are revoked from PUBLIC, anon and authenticated in
-- one statement. service_role gets SELECT. Both functions are new SECURITY DEFINER
-- writers: EXECUTE is revoked from PUBLIC, anon and authenticated in one statement and
-- granted to postgres and service_role only. The REVOKE is stated as the decision, with no
-- marker, so the anon-EXECUTE guard checks the REVOKE itself.
--
-- pg_cron: NOT scheduled here. The statements are in the hand-off.
--
-- Revert:
--   DROP FUNCTION IF EXISTS public.refresh_edition_fmv_estimates();
--   DROP FUNCTION IF EXISTS public.compute_topshot_parallel_ratio_cells();
--   DROP TABLE IF EXISTS public.edition_fmv_estimates;
--   DROP TABLE IF EXISTS public.topshot_parallel_ratio_cells;
--   (and cron.unschedule the two jobs if they were scheduled)

CREATE TABLE IF NOT EXISTS public.topshot_parallel_ratio_cells (
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

COMMENT ON TABLE public.topshot_parallel_ratio_cells IS
  'Typical price multiple of a Top Shot parallel over its base edition, per (subedition_name, tier). Time-matched monthly medians over 365 days; loo_median_abs_log_err is leave-one-edition-out. Written only by compute_topshot_parallel_ratio_cells(). Feeds edition_fmv_estimates, never an FMV.';

ALTER TABLE public.topshot_parallel_ratio_cells ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_parallel_ratio_cells FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.topshot_parallel_ratio_cells TO service_role;

CREATE TABLE IF NOT EXISTS public.edition_fmv_estimates (
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

COMMENT ON TABLE public.edition_fmv_estimates IS
  'LOW-confidence ESTIMATE for thin Top Shot parallels (own FMV STALE/NO_DATA): base FMV x typical parallel premium, capped at the live ask. NOT an FMV; never read by fmv_snapshots / edition_fmv_current / confidence-share metrics / deal boards. Written only by refresh_edition_fmv_estimates().';

ALTER TABLE public.edition_fmv_estimates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.edition_fmv_estimates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.edition_fmv_estimates TO service_role;

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

REVOKE ALL ON FUNCTION public.compute_topshot_parallel_ratio_cells() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_topshot_parallel_ratio_cells() TO postgres, service_role;

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

REVOKE ALL ON FUNCTION public.refresh_edition_fmv_estimates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_edition_fmv_estimates() TO postgres, service_role;
