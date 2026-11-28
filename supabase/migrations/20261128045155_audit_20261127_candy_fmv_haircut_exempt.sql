-- audit_20261127_candy_fmv_haircut_exempt
--
-- WHAT. Candy MLB (collection 209ade70-…) is exempt from the thin-sale haircut, in BOTH writers:
-- the daily full sweep `fmv_apply_thin_sale_haircut` (/api/admin/apply-fmv-haircut, 3:35 PM PT) and
-- the per-recalc twin `fmv_apply_thin_sale_haircut_for_editions` (fmv-recalc step 8). One new FIRST
-- arm in the multiplier CASE (both CASE sites in each function): Candy → 1.00, so a Candy row is still
-- counted as examined but is never in `cut` (haircut < 1.0). No other collection's arm changes.
-- Then the 269 live Candy prices the haircut had cut are restored to their floor (the exact pre-cut
-- value — the haircut only cuts a row whose fmv EQUALS its floor, and floor_price_usd is left as-is).
--
-- WHY (measured 2026-11-27 ~8:40 PM PT, every Candy sale in 60 d paired with the price in force ≥ 1 d
-- before it, serial > 25 — the fmv_sales_backtest pairing):
--     haircut rows (n 22) ......... published/sale median 0.320 · 0.0 % within ±25 % · MdAPE 68.0 %
--     same rows at the uncut floor  floor/sale median 0.572 · 31.8 % within ±25 % · MdAPE 50.6 %
--     every other Candy price (927)  0.900 · 49.1 % · 25.8 %
-- The haircut models "an ask masquerading as a sale-backed price" — a thin market where the ask sits
-- ABOVE what clears. Candy is the opposite: its items sell at or above the floor (e.g. $0.17 sales on a
-- $0.13 floor were published at $0.07). And Candy snapshots carry `listing_count = NULL` on every row,
-- so the depth ladder always fell through to its harshest arm, ×0.55. All 269 cut rows were exactly
-- round(floor × 0.55|0.65|0.75|0.85, 2) — fully reversible.
-- Candy reached the haircut only because the 2026-08-23 leg split derived its legs from `collections`
-- (a coverage fix, route.ts) — no pricing decision ever opted it in.
--
-- ⚠ BASE ASSERTED: both live bodies are md5-checked against the 20261122214417 bodies this file edits
-- (ab7da392… / 433d5710…); a mismatch aborts before any write (another session changed them).
-- Lock profile: CREATE OR REPLACE FUNCTION + a 269-row UPDATE (row locks only; no table-level DDL).
--
-- REVERT: re-apply the two function bodies from
--   supabase/migrations/20261122214417_audit_20261122_allday_haircut_stops_recutting_rows_its_bid_floor_holds.sql
-- and, for the prices:
--   UPDATE public.fmv_snapshots fs SET fmv_usd = a.fmv_usd, algo_version = a.algo_version
--     FROM flowty_archive.audit_20261127_candy_haircut_restore a WHERE fs.id = a.snapshot_id;

-- anon-exec: unchanged (fmv_apply_thin_sale_haircut) — CREATE OR REPLACE, same signature; has_function_privilege read after apply: anon=false, authenticated=false (grants preserved).
-- anon-exec: unchanged (fmv_apply_thin_sale_haircut_for_editions) — CREATE OR REPLACE, same signature; has_function_privilege read after apply: anon=false, authenticated=false (grants preserved).

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_apply_thin_sale_haircut(uuid,boolean)'::regprocedure)
       IS DISTINCT FROM 'ab7da392e100888a5a8a6b4ee6890c59'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.fmv_apply_thin_sale_haircut_for_editions(uuid[],boolean)'::regprocedure)
       IS DISTINCT FROM '433d571012564f506ef248f95f51cc85' THEN
    RAISE EXCEPTION 'haircut base changed since 20261122214417 — re-read the live bodies before applying';
  END IF;
END $$;

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
        -- 2026-11-27: Candy MLB is never cut — its sales clear AT or ABOVE the ask (60 d: cut rows 0.32x the sale, 0 % within ±25 %).
        WHEN l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid THEN 1.00
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
        -- 2026-11-27: Candy MLB is never cut — its sales clear AT or ABOVE the ask (60 d: cut rows 0.32x the sale, 0 % within ±25 %).
        WHEN l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid THEN 1.00
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
        -- 2026-11-27: Candy MLB is never cut — its sales clear AT or ABOVE the ask (60 d: cut rows 0.32x the sale, 0 % within ±25 %).
        WHEN l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid THEN 1.00
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
        -- 2026-11-27: Candy MLB is never cut — its sales clear AT or ABOVE the ask (60 d: cut rows 0.32x the sale, 0 % within ±25 %).
        WHEN l.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid THEN 1.00
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

-- ── Restore the live Candy prices the haircut cut (archive first) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261127_candy_haircut_restore AS
SELECT l.id AS snapshot_id, l.edition_id, l.fmv_usd, l.floor_price_usd, l.algo_version, l.computed_at, now() AS archived_at
FROM (
  SELECT DISTINCT ON (edition_id) id, edition_id, fmv_usd, floor_price_usd, algo_version, computed_at
  FROM public.fmv_snapshots
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  ORDER BY edition_id, computed_at DESC
) l
WHERE l.algo_version LIKE '%\_haircut'
  AND l.floor_price_usd IS NOT NULL
  AND l.fmv_usd < l.floor_price_usd
  AND l.fmv_usd IN (round(l.floor_price_usd * 0.55, 2), round(l.floor_price_usd * 0.65, 2),
                    round(l.floor_price_usd * 0.75, 2), round(l.floor_price_usd * 0.85, 2));

UPDATE public.fmv_snapshots fs
   SET fmv_usd = a.floor_price_usd,
       algo_version = left(a.algo_version, length(a.algo_version) - length('_haircut'))
  FROM flowty_archive.audit_20261127_candy_haircut_restore a
 WHERE fs.id = a.snapshot_id
   AND fs.fmv_usd = a.fmv_usd;   -- untouched since the archive read
