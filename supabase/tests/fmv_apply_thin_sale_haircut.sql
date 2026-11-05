-- DB invariant: public.fmv_apply_thin_sale_haircut(uuid,boolean) — an FMV-INTEGRITY
-- writer. For the LATEST snapshot per edition it haircuts fmv_usd on thin-liquidity
-- editions where FMV has collapsed onto the ask floor (fmv ~= floor within $0.01,
-- sales_count_30d <= 2, confidence LOW/ASK_ONLY) — the "an ask masquerading as a
-- sale-backed price" class. Pinned: the candidate gate (all four exclusions), the
-- liquidity-depth multiplier ladder (0.85/0.75/0.65/0.55 — and, since 2026-10-23, 0.75 for a
-- Top Shot LOW row whose depth is unknown, because `listing_count` is NULL on every haircut row
-- and the 0.55 cut backtested worst in both 30-day halves; other collections and ASK_ONLY keep
-- 0.55), latest-per-edition
-- selection, the collection scope, the dollars-removed accounting, the
-- algo_version '..._haircut' stamp, and above all the DRY-RUN contract (computes
-- the same counts but writes NOTHING — the operator preview).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261105044500_audit_20261104_fmv_haircut_stops_at_the_live_bid.sql — both writers, the Top
-- Shot cut stops at the best open edition offer; before that 20261023235545_audit_20261023_fmv_haircut_topshot_low_unknown_depth_is_075_not_055.sql;
-- previously 20260801230600_audit_20260801_snapshot_fmv_apply_thin_sale_haircut.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts, and the
-- md5 of pg_get_functiondef was confirmed byte-identical to LIVE prod on 2026-08-01
-- (67d33fe865c082fc6ca1b74a7a3dac14).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE fmv_snapshots (
  id             bigint GENERATED ALWAYS AS IDENTITY,
  edition_id     uuid,
  collection_id  uuid,
  fmv_usd        numeric,
  floor_price_usd numeric,
  sales_count_30d int,
  listing_count  int,
  confidence     text,
  computed_at    timestamptz,
  algo_version   text
);
-- The haircut's Top Shot bid read (2026-11-04): only the columns it uses.
CREATE TABLE offers (
  collection_id uuid, edition_id uuid, offer_amount_usd numeric, status text, offer_type text, expires_at timestamptz);

-- >>> BEGIN verbatim fmv_apply_thin_sale_haircut (keep byte-identical to the migration) >>>
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
-- <<< END verbatim fmv_apply_thin_sale_haircut <<<

-- >>> BEGIN verbatim fmv_apply_thin_sale_haircut_for_editions (keep byte-identical to the migration) >>>
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
-- <<< END verbatim fmv_apply_thin_sale_haircut_for_editions <<<

-- Collections: C = target, D = bystander. Editions e1..e9.
INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, floor_price_usd, sales_count_30d, listing_count, confidence, computed_at, algo_version) VALUES
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-00000000cccc', 100,100, 0,0,'LOW',     now(), 'v1'),  -- 0.55 -> 55, -45
  ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-00000000cccc', 100,100, 2,0,'ASK_ONLY', now(), 'v1'),  -- sale present -> 0.85 -> 85, -15
  ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-00000000cccc', 100,100, 0,5,'LOW',     now(), 'v1'),  -- 5 sellers -> 0.75 -> 75, -25
  ('00000000-0000-0000-0000-0000000000e4','00000000-0000-0000-0000-00000000cccc', 100,100, 0,3,'LOW',     now(), 'v1'),  -- 2-4 sellers -> 0.65 -> 65, -35
  ('00000000-0000-0000-0000-0000000000e5','00000000-0000-0000-0000-00000000cccc', 100,100, 0,0,'HIGH',    now(), 'v1'),  -- excluded: not LOW/ASK_ONLY
  ('00000000-0000-0000-0000-0000000000e6','00000000-0000-0000-0000-00000000cccc', 100, 90, 0,0,'LOW',     now(), 'v1'),  -- excluded: fmv != floor
  ('00000000-0000-0000-0000-0000000000e7','00000000-0000-0000-0000-00000000cccc', 100,100, 3,0,'LOW',     now(), 'v1'),  -- excluded: sales > 2
  ('00000000-0000-0000-0000-0000000000e8','00000000-0000-0000-0000-00000000cccc', 100,100, 0,0,'LOW',     now() - interval '2 days', 'v1'),  -- OLDER qualifying
  ('00000000-0000-0000-0000-0000000000e8','00000000-0000-0000-0000-00000000cccc', 100,100, 0,0,'HIGH',    now(), 'v1'),  -- NEWER, not qualifying -> latest wins -> excluded
  ('00000000-0000-0000-0000-0000000000e9','00000000-0000-0000-0000-00000000dddd', 100,100, 0,0,'LOW',     now(), 'v1'),  -- qualifies but OTHER collection
  -- Top Shot (the real collection uuid, 2026-10-23): LOW with unknown depth takes 0.75; ASK_ONLY still 0.55.
  ('00000000-0000-0000-0000-0000000000f1','95f28a17-224a-4025-96ad-adf8a4c63bfd', 100,100, 0,NULL,'LOW',     now(), 'v1'),  -- TS LOW, depth NULL -> 0.75 -> 75, -25
  ('00000000-0000-0000-0000-0000000000f2','95f28a17-224a-4025-96ad-adf8a4c63bfd', 100,100, 0,NULL,'ASK_ONLY', now(), 'v1'),  -- TS ASK_ONLY, depth NULL -> 0.55 -> 55, -45
  ('00000000-0000-0000-0000-0000000000f3','95f28a17-224a-4025-96ad-adf8a4c63bfd', 100,100, 1,NULL,'LOW',     now(), 'v1');  -- TS LOW with a sale -> 0.85 -> 85, -15 (the sale arm wins)

-- 1) DRY RUN over collection C: examines 4, haircuts 4, removes $120 — and writes NOTHING.
SELECT _assert_eq((SELECT rows_examined::text  FROM fmv_apply_thin_sale_haircut('00000000-0000-0000-0000-00000000cccc'::uuid, true)), '4', 'dry-run examines the 4 qualifying editions');
SELECT _assert_eq((SELECT rows_haircut::text   FROM fmv_apply_thin_sale_haircut('00000000-0000-0000-0000-00000000cccc'::uuid, true)), '4', 'dry-run counts 4 haircuts');
SELECT _assert((SELECT total_dollars_removed FROM fmv_apply_thin_sale_haircut('00000000-0000-0000-0000-00000000cccc'::uuid, true)) = 120, 'dry-run totals $120 removed');
SELECT _assert_eq((SELECT sum(fmv_usd)::text FROM fmv_snapshots WHERE collection_id='00000000-0000-0000-0000-00000000cccc'), '900', 'dry-run wrote NOTHING (9 C-rows x 100 = 900)');

-- 2) LIVE over collection C (call ONCE, capture the return).
CREATE TEMP TABLE live_r AS SELECT * FROM fmv_apply_thin_sale_haircut('00000000-0000-0000-0000-00000000cccc'::uuid, false);
SELECT _assert_eq((SELECT rows_haircut::text FROM live_r), '4', 'live run reports 4 haircuts');
SELECT _assert((SELECT total_dollars_removed FROM live_r) = 120, 'live run reports $120 removed');
-- each multiplier applied exactly + algo_version stamped
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e1') = 55, 'e1 0.55 haircut');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e2') = 85, 'e2 0.85 haircut (a sale present)');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e3') = 75, 'e3 0.75 haircut (5 sellers)');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e4') = 65, 'e4 0.65 haircut (few sellers)');
SELECT _assert_eq((SELECT algo_version FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e1'), 'v1_haircut', 'haircut stamps algo_version');
-- non-qualifying rows untouched
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e5') = 100, 'HIGH confidence untouched');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e6') = 100, 'fmv!=floor untouched');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e7') = 100, 'sales>2 untouched');
-- latest-per-edition: e8 newest is HIGH -> whole edition skipped; the older qualifying snapshot is NOT haircut.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e8' AND fmv_usd = 100), '2', 'e8 both snapshots untouched (latest HIGH shadows the older qualifying one)');
-- collection scope: the C-run must not touch collection D's qualifying edition.
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e9') = 100, 'collection-scoped run leaves other collections untouched');

-- 3) TOP SHOT (2026-10-23): a LOW row with unknown depth takes 0.75, not the 0.55 "unknown" default;
--    ASK_ONLY and the sale arm are unchanged. Collection C's e1 (0.55 above) is the other-collection control.
SELECT _assert_eq((SELECT rows_haircut::text FROM fmv_apply_thin_sale_haircut('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, true)), '3', 'TS dry-run counts 3 haircuts');
SELECT _assert((SELECT total_dollars_removed FROM fmv_apply_thin_sale_haircut('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, true)) = 85, 'TS dry-run totals $85 removed (25 + 45 + 15)');
SELECT _assert_eq((SELECT sum(fmv_usd)::text FROM fmv_snapshots WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'), '300', 'TS dry-run wrote NOTHING');
CREATE TEMP TABLE live_ts AS SELECT * FROM fmv_apply_thin_sale_haircut('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, false);
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000f1') = 75, 'f1 Top Shot LOW with unknown depth takes 0.75 (2026-10-23)');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000f2') = 55, 'f2 Top Shot ASK_ONLY keeps 0.55');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000f3') = 85, 'f3 Top Shot LOW with a sale keeps 0.85');
SELECT _assert((SELECT total_dollars_removed FROM live_ts) = 85, 'TS live run reports $85 removed');
SELECT _assert((SELECT fmv_usd FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000e1') = 55, 'e1 (another collection, LOW, unknown depth) still 0.55 — the 0.75 arm is Top Shot only');

-- 2026-11-04: a Top Shot cut STOPS at the best open edition offer (<= 3x the cut), never raising the price.
--   a1 LOW 10.00 -> cut 7.50, open offer 9.00              -> 9.00, …_haircut_bidfloor
--   a2 LOW 10.00 -> cut 7.50, offer 12.00 (above the price) -> LEAST(bid, price) = 10.00 = unchanged -> NOT counted / stamped
--   a3 LOW 10.00 -> cut 7.50, offer 30.00 (> 3x the cut)    -> ignored, 7.50 …_haircut
--   a4 LOW 10.00 -> cut 7.50, offer 9.00 but CANCELLED      -> ignored, 7.50
--   a5 LOW 10.00 -> cut 7.50, offer 9.00 but EXPIRED        -> ignored, 7.50
--   a6 LOW 10.00 -> cut 7.50, a SERIAL offer 9.00           -> ignored, 7.50
--   a7 OTHER collection, 0.55 cut 5.50, open offer 9.00     -> the floor is Top Shot only: 5.50
--   a8 LOW 10.00 -> cut 7.50, offer 7.00 (under the cut)    -> 7.50
-- The twin (_for_editions) runs first on fresh editions b1..b3 mirroring a1 / a2 / a3 (the a* rows are a1..a8).
DELETE FROM fmv_snapshots;
INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, floor_price_usd, sales_count_30d, listing_count, confidence, computed_at, algo_version) VALUES
  ('00000000-0000-0000-0000-0000000000a1','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a2','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a3','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a4','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a5','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a6','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-00000000cccc', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000a8','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000b1','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000b2','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2'),
  ('00000000-0000-0000-0000-0000000000b3','95f28a17-224a-4025-96ad-adf8a4c63bfd', 10,10, 0,NULL,'LOW', now(), 'v2');
INSERT INTO offers VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a1', 9,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a1', 6,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a2',12,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a3',30,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a4', 9,'cancelled','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a5', 9,'open','edition', now() - interval '1 hour'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a6', 9,'open','serial',NULL),
  ('00000000-0000-0000-0000-00000000cccc','00000000-0000-0000-0000-0000000000a7', 9,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000a8', 7,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000b1', 9,'open','edition', now() + interval '1 day'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000b2',12,'open','edition',NULL),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd','00000000-0000-0000-0000-0000000000b3',30,'open','edition',NULL);

-- dry run over Top Shot (a1..a6, a8 — b* belong to the twin below and are Top Shot too, so they count here):
-- a-candidates 7 + b 3 = 10 examined; changed = all but a2/b2 (held at price) = 8; removed = 6 rows x 2.50 + a1 1.00 + b1 1.00 = 17.00
SELECT _assert_eq((SELECT rows_examined::text||'|'||rows_haircut||'|'||total_dollars_removed FROM fmv_apply_thin_sale_haircut('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, true)),
  '10|8|17.00', 'bid-aware dry run: examined, changed (held-at-price rows not counted), dollars');
SELECT _assert_eq((SELECT sum(fmv_usd)::text FROM fmv_snapshots), '110', 'dry run wrote nothing');

-- the twin over b1..b3 only
SELECT _assert_eq((SELECT rows_examined::text||'|'||rows_haircut||'|'||dollars_removed FROM fmv_apply_thin_sale_haircut_for_editions(
    ARRAY['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b3']::uuid[], false)),
  '3|2|3.50', 'twin: 3 examined, b2 held at price, removed 1.00 + 2.50');
SELECT _assert_eq((SELECT string_agg(right(edition_id::text,2)||'='||fmv_usd||'|'||algo_version, ' ' ORDER BY edition_id) FROM fmv_snapshots WHERE edition_id::text LIKE '%0000b_'),
  'b1=9.00|v2_haircut_bidfloor b2=10|v2 b3=7.50|v2_haircut', 'twin: stops at a live unexpired bid, never raises, ignores > 3x');

-- the daily writer over Top Shot (b* already handled; b2 still held, so it is examined but not changed)
SELECT _assert_eq((SELECT rows_haircut::text FROM fmv_apply_thin_sale_haircut('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, false)), '6',
  'daily writer changes a1, a3, a4, a5, a6, a8');
SELECT _assert_eq((SELECT string_agg(right(edition_id::text,2)||'='||fmv_usd||'|'||algo_version, ' ' ORDER BY edition_id) FROM fmv_snapshots WHERE edition_id::text LIKE '%0000a_'),
  'a1=9.00|v2_haircut_bidfloor a2=10|v2 a3=7.50|v2_haircut a4=7.50|v2_haircut a5=7.50|v2_haircut a6=7.50|v2_haircut a7=10|v2 a8=7.50|v2_haircut',
  'best open edition bid; above-price, >3x, cancelled, expired, serial and under-cut offers ignored; other collection untouched by a Top Shot run');
SELECT fmv_apply_thin_sale_haircut('00000000-0000-0000-0000-00000000cccc'::uuid, false);
SELECT _assert_eq((SELECT fmv_usd::text||'|'||algo_version FROM fmv_snapshots WHERE edition_id='00000000-0000-0000-0000-0000000000a7'),
  '5.50|v2_haircut', 'the bid stop is Top Shot only (a7: 0.55 cut under a 9.00 offer)');

SELECT '✓ fmv_apply_thin_sale_haircut invariants pass' AS result;
ROLLBACK;
