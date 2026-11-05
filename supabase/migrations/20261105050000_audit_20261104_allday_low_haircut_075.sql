-- audit_20261104_allday_low_haircut_075 — 2026-11-04 ~8:50 PM PT (Claude Code cloud; Trevor: "We need to get confidence
-- on pricing" → "Keep going").
--
-- WHAT (both haircut writers, fmv_apply_thin_sale_haircut + its fmv-recalc twin _for_editions): an NFL ALL DAY LOW row with unknown depth (0 sales in 30 d,
-- listing_count NULL — the column is NULL on every haircut row) takes the 0.75 cut Top Shot took on 10-23, not 0.55.
-- 20261023235545 left All Day "inconclusive" on n 25; re-measured on clean All Day sales since 10-05 (snapshot in force
-- >= 1 day before was a LOW …_haircut row with 0 sales in 30 d, priced from its ask floor): n 63 —
--   cut 0.55: 30.2 % within +/-25     0.75: 50.8 %     0.85: 50.8 %     1.00 (no cut): 47.6 %
--   (recent 10-20.. n 51: 27.5 / 56.9 / 56.9 / 51.0; older n 12: 41.7 / 25.0 / 25.0 / 33.3 — the older half is thin
--   and the opposite way; pooled the 0.75 tier wins by 20 points). Median published/sale ratio at 0.55 was 0.56.
-- Today 111 latest All Day rows sit at that cut ($441 -> $602 at 0.75); no backfill — the median haircut row is ~4 h old
-- and the next snapshot per edition re-cuts at 0.75.
--
-- Everything else is byte-identical to 20261105044500 (applied 11-04 evening: the Top Shot bid stop): the only change is
-- the unknown-depth LOW arm's collection list, in all four ladder copies.
--
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut, fmv_apply_thin_sale_haircut_for_editions) — CREATE OR REPLACE of existing functions, same signatures; ACL preserved.
--
-- REVERT: re-apply both bodies from 20261105044500.

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut(uuid,boolean)'::regprocedure) <> '6ef646ad530801441d68c0e61e690612'
  OR (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut_for_editions(uuid[],boolean)'::regprocedure) <> '137550f70c28574d7b9aa4113307867f'
  THEN
    RAISE EXCEPTION 'a haircut body is not the 20261105044500 body; re-read the live bodies and re-base';
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
        WHEN l.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid)
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot (2026-10-23) and All Day (2026-11-04) LOW, depth unknown: 0.75
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
        WHEN l.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid)
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot (2026-10-23) and All Day (2026-11-04) LOW, depth unknown: 0.75
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
        WHEN l.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid)
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot (2026-10-23) and All Day (2026-11-04) LOW, depth unknown: 0.75
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
        WHEN l.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid)
         AND l.confidence = 'LOW'                      THEN 0.75  -- Top Shot (2026-10-23) and All Day (2026-11-04) LOW, depth unknown: 0.75
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
