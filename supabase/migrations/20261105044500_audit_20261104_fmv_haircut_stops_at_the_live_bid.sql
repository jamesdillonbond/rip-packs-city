-- audit_20261104_fmv_haircut_stops_at_the_live_bid — 2026-11-04 ~8:15 PM PT (Claude Code cloud; Trevor: "We need to get
-- confidence on pricing" → "do it all" → "Okay done keep going"; the finding is Cowork's, ledger 11-04 "APPLIED (3
-- migrations)": the thin-sale haircut is an in-place UPDATE AFTER the insert, so the BEFORE INSERT offer floor
-- (20261105033000) never sees it — 1 of 342 new rows sat at $3.40 …_haircut under a $4.00 open offer).
--
-- WHAT: in BOTH haircut writers — the daily two-argument fmv_apply_thin_sale_haircut (cron-job.org "RPC Apply FMV
-- Haircut", /api/admin/apply-fmv-haircut) and the inline fmv_apply_thin_sale_haircut_for_editions twin that
-- /api/fmv-recalc step 8 calls — a TOP SHOT cut stops at the best OPEN, unexpired edition-level offer when that offer
-- is above the cut price and at most 3x it (the floor trigger's own bound). It never RAISES a price (LEAST(bid, the
-- pre-cut price)); a row the bid holds at its current price is no longer counted or stamped. A cut the bid stops is
-- stamped …_haircut_bidfloor. The ladder, the gate and every other collection are byte-for-byte the same rules.
--
-- WHY (measured 2026-11-04 ~8:05 PM PT): every clean Top Shot sale since 10-23 (sales_market, serial > 25) whose
-- snapshot in force >= 1 day before was a …_haircut row, n 461; with the best edition offer OPEN at that instant
-- (reconstructed from offers.created_at / resolved_at / expires_at) above the cut and <= 3x it, n 189:
--   within +/-25 %   cut 50.3 -> stopped at the bid 72.5      median price/sale ratio 0.75 -> 1.00
--   all 461 haircut rows: 49.7 -> 58.8 within +/-25 %.
-- Today it binds 1 of 1,104 latest Top Shot haircut rows (20261105033000 already lifted the rest); this keeps the next
-- ticks from re-creating the class.
--
-- Cost: one indexed probe on idx_offers_open_edition_rollup per Top Shot CANDIDATE (fmv at the ask floor, <= 2 sales,
-- LOW/ASK_ONLY) — the bid column is only evaluated for Top Shot rows.
--
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut, fmv_apply_thin_sale_haircut_for_editions) — CREATE OR REPLACE of existing functions, same signatures; ACL preserved (postgres + service_role EXECUTE only, read 11-04 8:10 PM PT).
--
-- REVERT: re-apply both bodies from 20261023235545 (the two-argument one) and its _for_editions block.

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut(uuid,boolean)'::regprocedure) <> '1e659bcbf698686cd8e9a27cafbda088'
  OR (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut_for_editions(uuid[],boolean)'::regprocedure) <> 'bb49a577a6844d1e1c91e94ea81a1ea6'
  THEN
    RAISE EXCEPTION 'a haircut body changed since 11-04 8:10 PM PT; re-read the live bodies and re-base';
  END IF;
END
$guard$;

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
  WITH latest AS (
    SELECT DISTINCT ON (edition_id) *
    FROM fmv_snapshots
    WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
    ORDER BY edition_id, computed_at DESC
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.edition_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23)
        ELSE 0.55
      END AS haircut,
      -- 2026-11-04: Top Shot only — the best OPEN, unexpired edition-level offer; the cut never goes under it
      -- (bounded at 3x the cut price, the same bound as fmv_snapshots_floor_topshot_at_best_offer).
      CASE WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN (
        SELECT max(o.offer_amount_usd) FROM public.offers o
         WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
           AND o.edition_id = l.edition_id
           AND o.status = 'open'
           AND o.offer_type = 'edition'
           AND (o.expires_at IS NULL OR o.expires_at > now())) END AS bid
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  cut AS (
    SELECT c.*, ROUND(c.old_fmv * c.haircut, 2) AS cut_fmv FROM candidates c WHERE c.haircut < 1.0
  ),
  to_apply AS (
    SELECT x.*,
      (x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv) AS floored,
      CASE WHEN x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv
           THEN ROUND(LEAST(x.bid, x.old_fmv), 2) ELSE x.cut_fmv END AS new_fmv
    FROM cut x
  ),
  changed AS (SELECT * FROM to_apply WHERE new_fmv < old_fmv)
  SELECT
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM changed),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM changed)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    -- in-place UPDATE of the latest snapshot (floor_price stays as-is for transparency); the rows and the
    -- prices are the ones counted above, recomputed in the same shape.
  WITH latest AS (
    SELECT DISTINCT ON (edition_id) *
    FROM fmv_snapshots
    WHERE (p_collection_id IS NULL OR collection_id = p_collection_id)
    ORDER BY edition_id, computed_at DESC
  ),
  candidates AS (
    SELECT
      l.id AS snapshot_id,
      l.edition_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23)
        ELSE 0.55
      END AS haircut,
      -- 2026-11-04: Top Shot only — the best OPEN, unexpired edition-level offer; the cut never goes under it
      -- (bounded at 3x the cut price, the same bound as fmv_snapshots_floor_topshot_at_best_offer).
      CASE WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN (
        SELECT max(o.offer_amount_usd) FROM public.offers o
         WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
           AND o.edition_id = l.edition_id
           AND o.status = 'open'
           AND o.offer_type = 'edition'
           AND (o.expires_at IS NULL OR o.expires_at > now())) END AS bid
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  cut AS (
    SELECT c.*, ROUND(c.old_fmv * c.haircut, 2) AS cut_fmv FROM candidates c WHERE c.haircut < 1.0
  ),
  to_apply AS (
    SELECT x.*,
      (x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv) AS floored,
      CASE WHEN x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv
           THEN ROUND(LEAST(x.bid, x.old_fmv), 2) ELSE x.cut_fmv END AS new_fmv
    FROM cut x
  ),
  changed AS (SELECT * FROM to_apply WHERE new_fmv < old_fmv)
    UPDATE fmv_snapshots fs
    SET fmv_usd = ch.new_fmv,
        algo_version = fs.algo_version || '_haircut' || CASE WHEN ch.floored THEN '_bidfloor' ELSE '' END
    FROM changed ch
    WHERE fs.id = ch.snapshot_id;
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
      l.edition_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23)
        ELSE 0.55
      END AS haircut,
      -- 2026-11-04: Top Shot only — the best OPEN, unexpired edition-level offer; the cut never goes under it
      -- (bounded at 3x the cut price, the same bound as fmv_snapshots_floor_topshot_at_best_offer).
      CASE WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN (
        SELECT max(o.offer_amount_usd) FROM public.offers o
         WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
           AND o.edition_id = l.edition_id
           AND o.status = 'open'
           AND o.offer_type = 'edition'
           AND (o.expires_at IS NULL OR o.expires_at > now())) END AS bid
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  cut AS (
    SELECT c.*, ROUND(c.old_fmv * c.haircut, 2) AS cut_fmv FROM candidates c WHERE c.haircut < 1.0
  ),
  to_apply AS (
    SELECT x.*,
      (x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv) AS floored,
      CASE WHEN x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv
           THEN ROUND(LEAST(x.bid, x.old_fmv), 2) ELSE x.cut_fmv END AS new_fmv
    FROM cut x
  ),
  changed AS (SELECT * FROM to_apply WHERE new_fmv < old_fmv)
  SELECT
    (SELECT COUNT(*) FROM candidates),
    (SELECT COUNT(*) FROM changed),
    (SELECT COALESCE(SUM(old_fmv - new_fmv), 0) FROM changed)
  INTO v_examined, v_haircut, v_dollars;

  IF NOT p_dry_run THEN
    -- in-place UPDATE of the latest snapshot (floor_price stays as-is for transparency); the rows and the
    -- prices are the ones counted above, recomputed in the same shape.
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
      l.edition_id,
      l.fmv_usd AS old_fmv,
      CASE
        WHEN COALESCE(l.sales_count_30d, 0) >= 3 THEN 1.00
        WHEN COALESCE(l.sales_count_30d, 0) >= 1 THEN 0.85
        WHEN COALESCE(l.listing_count, 0)  >= 5 THEN 0.75
        WHEN COALESCE(l.listing_count, 0)  >= 2 THEN 0.65
        WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot LOW, depth unknown: 0.75 (measured 2026-10-23)
        ELSE 0.55
      END AS haircut,
      -- 2026-11-04: Top Shot only — the best OPEN, unexpired edition-level offer; the cut never goes under it
      -- (bounded at 3x the cut price, the same bound as fmv_snapshots_floor_topshot_at_best_offer).
      CASE WHEN l.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN (
        SELECT max(o.offer_amount_usd) FROM public.offers o
         WHERE o.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
           AND o.edition_id = l.edition_id
           AND o.status = 'open'
           AND o.offer_type = 'edition'
           AND (o.expires_at IS NULL OR o.expires_at > now())) END AS bid
    FROM latest l
    WHERE l.fmv_usd IS NOT NULL
      AND l.floor_price_usd IS NOT NULL
      AND COALESCE(l.sales_count_30d, 0) <= 2
      AND ABS(l.fmv_usd - l.floor_price_usd) < 0.01
      AND l.confidence IN ('LOW','ASK_ONLY')
  ),
  cut AS (
    SELECT c.*, ROUND(c.old_fmv * c.haircut, 2) AS cut_fmv FROM candidates c WHERE c.haircut < 1.0
  ),
  to_apply AS (
    SELECT x.*,
      (x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv) AS floored,
      CASE WHEN x.bid IS NOT NULL AND x.bid > x.cut_fmv AND x.bid <= 3 * x.cut_fmv
           THEN ROUND(LEAST(x.bid, x.old_fmv), 2) ELSE x.cut_fmv END AS new_fmv
    FROM cut x
  ),
  changed AS (SELECT * FROM to_apply WHERE new_fmv < old_fmv)
    UPDATE fmv_snapshots fs
    SET fmv_usd = ch.new_fmv,
        algo_version = fs.algo_version || '_haircut' || CASE WHEN ch.floored THEN '_bidfloor' ELSE '' END
    FROM changed ch
    WHERE fs.id = ch.snapshot_id;
  END IF;

  RETURN QUERY SELECT v_examined, v_haircut, v_dollars;
END;
$function$;
COMMENT ON FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean) IS 'Inline twin of fmv_apply_thin_sale_haircut for the editions one fmv-recalc tick just wrote (identical ladder and gate). Since 2026-11-04 a Top Shot cut stops at the best open edition offer (<= 3x the cut), stamped _haircut_bidfloor.';
