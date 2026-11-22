-- audit_20261122_allday_haircut_stops_recutting_rows_its_bid_floor_holds — 2026-11-22 ~1:44 PM PT (Claude Code cloud,
-- autonomous 4 h pass; Trevor: "Fix any issues you encounter").
--
-- DEFECT (measured 11-22): the thin-sale haircut re-"cut" the same NFL All Day rows on EVERY run and reported cuts that
-- never landed. Both haircut writers (the daily fmv_apply_thin_sale_haircut and fmv-recalc's inline twin
-- _for_editions) compute a bid only for Top Shot. On All Day the bid stop lives in a BEFORE UPDATE trigger
-- (fmv_snapshots_floor_allday_at_best_offer, 20261112163400): a cut that lands under an open offer <= 3x the cut is
-- held at least(offer, old price). When the offer is >= the old price the trigger puts the price back where it was —
-- so the row still sits on its ask floor, is still a candidate, and the next run "cuts" it again. Each pass appends
-- `_haircut` (function) + `_bidfloor` (trigger: the row no longer ends in _bidfloor when it sees it), so algo_version
-- grows without bound: 882 latest-era rows read `1.8.3_haircut_bidfloor_haircut_bidfloor`, the longest 7 repeats.
-- Dry run 11-22 ~1:38 PM PT: 177 All Day rows "haircut", **171 of them held at price by the trigger** (phantom cuts,
-- $75.65 of the reported dollars), 6 real. The price was never wrong — the trigger held it — but the writer's
-- rows_haircut / total_dollars_removed counted rows it did not change (R120: a count must mean rows WRITTEN), and
-- every run re-wrote ~170 snapshots for nothing.
--
-- FIX: the bid CASE gains an All Day arm reading exactly the trigger's source (allday_open_offers joined on
-- editions.external_id, idx_allday_open_offers_edition). The existing ladder then decides as the trigger would:
-- bid >= price -> new_fmv = old -> not in `changed` (not written, not counted); cut < bid < price (<= 3x) -> written
-- at the bid, stamped _haircut_bidfloor by the function (the trigger then sees new = bid and does nothing); no bid /
-- bid > 3x -> the plain cut, as before. Top Shot arm, ladder, gate and every other line are byte-identical to
-- 20261105050000. Already-grown algo_version strings are left as written (history; the next snapshot per edition is
-- written fresh by fmv-recalc).
--
-- PIN: supabase/tests/fmv_apply_thin_sale_haircut.sql (All Day bid fixtures: held-at-price not written, stop at the
-- bid, > 3x ignored, Top Shot `offers` rows still ignored for All Day).
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut, fmv_apply_thin_sale_haircut_for_editions) — CREATE OR REPLACE of existing functions, same signatures; ACL preserved.
-- REVERT: re-apply both bodies from 20261105050000_audit_20261104_allday_low_haircut_075.sql.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut(uuid,boolean)'::regprocedure) <> '7d212ee7c33406371373e153e92ad681'
  OR (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.fmv_apply_thin_sale_haircut_for_editions(uuid[],boolean)'::regprocedure) <> 'f56d58033c7519879f3c6222bcca4957'
  THEN
    RAISE EXCEPTION 'a haircut body is not the 20261105050000 body; re-read the live bodies and re-base';
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
           AND (o.expires_at IS NULL OR o.expires_at > now()))
      -- 2026-11-22: NFL All Day reads the SAME best open offer its BEFORE UPDATE trigger
      -- (fmv_snapshots_floor_allday_at_best_offer) holds a cut at, so `changed` is what actually lands.
      WHEN l.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN (
        SELECT max(o.amount) FROM public.editions e
          JOIN public.allday_open_offers o ON o.edition_id = e.external_id
         WHERE e.id = l.edition_id
           AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) END AS bid
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
           AND (o.expires_at IS NULL OR o.expires_at > now()))
      -- 2026-11-22: NFL All Day reads the SAME best open offer its BEFORE UPDATE trigger
      -- (fmv_snapshots_floor_allday_at_best_offer) holds a cut at, so `changed` is what actually lands.
      WHEN l.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN (
        SELECT max(o.amount) FROM public.editions e
          JOIN public.allday_open_offers o ON o.edition_id = e.external_id
         WHERE e.id = l.edition_id
           AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) END AS bid
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
           AND (o.expires_at IS NULL OR o.expires_at > now()))
      -- 2026-11-22: NFL All Day reads the SAME best open offer its BEFORE UPDATE trigger
      -- (fmv_snapshots_floor_allday_at_best_offer) holds a cut at, so `changed` is what actually lands.
      WHEN l.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN (
        SELECT max(o.amount) FROM public.editions e
          JOIN public.allday_open_offers o ON o.edition_id = e.external_id
         WHERE e.id = l.edition_id
           AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) END AS bid
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
           AND (o.expires_at IS NULL OR o.expires_at > now()))
      -- 2026-11-22: NFL All Day reads the SAME best open offer its BEFORE UPDATE trigger
      -- (fmv_snapshots_floor_allday_at_best_offer) holds a cut at, so `changed` is what actually lands.
      WHEN l.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid THEN (
        SELECT max(o.amount) FROM public.editions e
          JOIN public.allday_open_offers o ON o.edition_id = e.external_id
         WHERE e.id = l.edition_id
           AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid) END AS bid
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
COMMENT ON FUNCTION public.fmv_apply_thin_sale_haircut_for_editions(uuid[], boolean) IS 'Inline twin of fmv_apply_thin_sale_haircut for the editions one fmv-recalc tick just wrote (identical ladder and gate). Since 2026-11-04 a Top Shot cut stops at the best open edition offer (<= 3x the cut), stamped _haircut_bidfloor; since 2026-11-22 an All Day cut reads the same allday_open_offers bid its BEFORE UPDATE trigger holds it at, so a row held at its price is neither written nor counted.';
