-- audit_20261023_fmv_haircut_topshot_low_unknown_depth_is_075_not_055
--
-- WHAT: the thin-sale haircut's "single seller / unknown" multiplier is 0.75, not 0.55, for a
-- Top Shot LOW snapshot (0 sales in 30 d, FMV at the ask floor). Everything else in the ladder
-- is unchanged: 0.85 with a sale, 0.75 / 0.65 by listing depth, 0.55 for every other collection
-- and for ASK_ONLY. Both the daily two-argument function (cron-job.org "RPC Apply FMV Haircut",
-- /api/admin/apply-fmv-haircut) and the inline _for_editions twin that /api/fmv-recalc calls
-- carry the identical ladder, so both change here.
--
-- WHY (measured 2026-10-23 ~4:45–5:15 PM PT, Cowork cloud, autonomous pass under Trevor's
-- "work on roadmap tasks, known issues … autonomously"):
--   1. The depth term has never had a depth input. `fmv_snapshots.listing_count` is NULL on
--      every one of the 1,774 current haircut rows across Top Shot and All Day (0.2 % of all
--      snapshots in 30 d carry a value), so the 0.75 / 0.65 "multi-seller" arms are dead code and
--      every 0-sale edition took the deepest cut as "unknown" — the defaulted-NULL-column
--      fabricated-value shape CLAUDE.md names.
--   2. Out of sample against realised Top Shot sales (`sales_market`, serial > 25, the snapshot
--      in force >= 1 day before the sale and no newer sale behind it), the 0.55 cut is the worst
--      multiplier in BOTH 30-day halves of the last 60 days, on both within-±25 % and WAPE:
--        TS LOW, 0 sales, haircut rows   0.55            0.75            0.85            1.00
--          days 0–30  (n 123)           11.4 % / 54.0   30.9 % / 39.3   35.0 % / 34.7   48.0 % / 30.1
--          days 30–60 (n 15)            33.3 % / 38.6   60.0 % / 21.7   46.7 % / 22.8   (ratio 1.33)
--        pooled with ASK_ONLY, 30–60 d (n 67): 0.55 20.9 / 51.1 · 0.75 44.8 / 39.0 · 1.00 40.3 / 51.7.
--      0.75 wins both halves against 0.55 on both metrics and is the existing "multi-seller" tier.
--      1.00 (no cut) wins the recent half but loses WAPE in the older one, so the cut stays.
--   3. NOT changed, by the same measurement: Top Shot ASK_ONLY (0.75 lifts within-±25 % 17 → 40
--      but WAPE 164 → 195 on n 52 — a few large misses); All Day LOW (n 25 recent: WAPE favours
--      0.55, hit-rate favours higher — inconclusive, re-read with more sales); the 0.85 "mild"
--      band (a wash: haircut wins WAPE in 3 of 5 fortnights on TS).
--   The published LOW tier read ratio 0.892 vs the naive last-3 median's 0.962 in today's
--   `fmv_sales_backtest('nba_top_shot', 7)`; the haircut-with-0-sales sub-class (n 104) read
--   0.441 / 5.8 % within ±25 % and was the single worst cell in the LOW split.
--
-- EFFECT: 497 current latest Top Shot LOW haircut rows (all at the 0.55 cut; $3,455.95 summed)
-- would read $4,712.67 at 0.75. A companion migration re-stamps them (backup
-- audit_20261023_ts_low_haircut_075_backup); new rows take 0.75 from the next inline / daily run.
-- Not a label change: confidence stays LOW; `floor_price_usd` / `ask_proxy_fmv` untouched.
--
-- EXIT (read ~10-30, then weekly beside the R125 read): the TS LOW row of
-- `fmv_sales_backtest('nba_top_shot', 7)` moves toward the naive last-3 median on median_ratio
-- (0.892 → ≥ 0.93) without losing within-±25 %. FALSIFIER: the haircut-0-sales sub-class
-- (algo_version LIKE '%haircut', sales_count_30d = 0) reads median_ratio > 1.10 on two
-- consecutive weekly reads → revert.
--
-- REVERT: re-apply the previous bodies —
--   supabase/migrations/20260801230600_audit_20260801_snapshot_fmv_apply_thin_sale_haircut.sql
--   supabase/migrations/20260830040739_audit_20260830_haircut_and_clamp_for_editions_scope_the_inline_fmv_recalc_step_to_what_it_just_wrote.sql
--   (the _for_editions block) — and
--   UPDATE fmv_snapshots f SET fmv_usd = b.old_fmv_usd FROM audit_20261023_ts_low_haircut_075_backup b WHERE f.id = b.snapshot_id;
--
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege('anon', …, 'EXECUTE') = false verified after apply.
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut_for_editions) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, has_function_privilege('anon', …, 'EXECUTE') = false verified after apply.

CREATE OR REPLACE FUNCTION public.fmv_apply_thin_sale_haircut(p_collection_id uuid DEFAULT NULL::uuid, p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_haircut bigint, total_dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_examined bigint := 0;
  v_haircut  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  -- Build a CTE of latest-per-edition snapshots that need haircut, with computed adjusted FMV
  WITH latest AS (
    SELECT DISTINCT ON (edition_id) *
    FROM fmv_snapshots
    WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
    ORDER BY edition_id, computed_at DESC
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.computed_at,
      l.edition_id,
      l.fmv_usd AS old_fmv,
      l.floor_price_usd,
      l.sales_count_30d,
      l.listing_count,
      -- Haircut multiplier based on sales + listing depth
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00  -- no haircut
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85  -- mild
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75  -- multi-seller, no sales
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65  -- few sellers, no sales
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23, see migration header)
        ELSE 0.55                                            -- single seller / unknown
      END AS haircut
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01  -- fmv ≈ floor (within $0.01)
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  to_apply AS (
    SELECT *,
      ROUND(old_fmv * haircut, 2) AS new_fmv
    FROM candidates
    WHERE haircut < 1.0
  )
  SELECT 
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM to_apply),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM to_apply)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    -- Apply: in-place UPDATE of fmv_usd (preserves history; floor_price stays as-is for transparency)
    WITH latest AS (
      SELECT DISTINCT ON (edition_id) id, edition_id, fmv_usd, floor_price_usd,
        sales_count_30d, listing_count, confidence
      FROM fmv_snapshots
      WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
      ORDER BY edition_id, computed_at DESC
    )
    UPDATE fmv_snapshots fs
    SET fmv_usd = ROUND(fs.fmv_usd *
      CASE
        WHEN COALESCE(fs.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(fs.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(fs.listing_count, 0)  >= 2 THEN 0.65
        WHEN fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND fs.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23, see migration header)
        ELSE 0.55
      END, 2),
      algo_version = fs.algo_version || '_haircut'
    FROM latest l
    WHERE fs.id = l.id
      AND fs.fmv_usd IS NOT NULL
      AND fs.floor_price_usd IS NOT NULL
      AND COALESCE(fs.sales_count_30d, 0) <= 2
      AND ABS(fs.fmv_usd - fs.floor_price_usd) < 0.01
      AND fs.confidence IN ('LOW','ASK_ONLY');
  END IF;

  RETURN QUERY SELECT v_examined, v_haircut, v_dollars;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(p_edition_ids uuid[], p_dry_run boolean DEFAULT false)
 RETURNS TABLE(rows_examined bigint, rows_haircut bigint, dollars_removed numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_examined bigint := 0;
  v_haircut  bigint := 0;
  v_dollars  numeric := 0;
BEGIN
  IF p_edition_ids IS NULL OR cardinality(p_edition_ids) = 0 THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint, 0::numeric;
    RETURN;
  END IF;

  WITH ids AS (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)),
  latest AS (
    SELECT lf.*
    FROM ids
    JOIN LATERAL (
      SELECT fs.* FROM fmv_snapshots fs
      WHERE fs.edition_id = ids.id
      ORDER BY fs.computed_at DESC
      LIMIT 1
    ) lf ON true
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23, see migration header)
        ELSE 0.55
      END AS haircut
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  to_apply AS (
    SELECT *, ROUND(old_fmv * haircut, 2) AS new_fmv FROM candidates WHERE haircut < 1.0
  )
  SELECT
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM to_apply),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM to_apply)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    WITH ids AS (SELECT DISTINCT u.id FROM unnest(p_edition_ids) AS u(id)),
    latest AS (
      SELECT lf.id
      FROM ids
      JOIN LATERAL (
        SELECT fs.id FROM fmv_snapshots fs
        WHERE fs.edition_id = ids.id
        ORDER BY fs.computed_at DESC
        LIMIT 1
      ) lf ON true
    )
    UPDATE fmv_snapshots fs
    SET fmv_usd = ROUND(fs.fmv_usd *
      CASE
        WHEN COALESCE(fs.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(fs.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(fs.listing_count, 0)  >= 2 THEN 0.65
        WHEN fs.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND fs.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23, see migration header)
        ELSE 0.55
      END, 2),
      algo_version = fs.algo_version || '_haircut'
    FROM latest l
    WHERE fs.id = l.id
      AND fs.fmv_usd IS NOT NULL
      AND fs.floor_price_usd IS NOT NULL
      AND COALESCE(fs.sales_count_30d, 0) <= 2
      AND ABS(fs.fmv_usd - fs.floor_price_usd) < 0.01
      AND fs.confidence IN ('LOW','ASK_ONLY');
  END IF;

  RETURN QUERY SELECT v_examined, v_haircut, v_dollars;
END;
$function$;
