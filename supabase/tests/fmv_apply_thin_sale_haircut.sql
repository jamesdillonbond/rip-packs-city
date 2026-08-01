-- DB invariant: public.fmv_apply_thin_sale_haircut(uuid,boolean) — an FMV-INTEGRITY
-- writer. For the LATEST snapshot per edition it haircuts fmv_usd on thin-liquidity
-- editions where FMV has collapsed onto the ask floor (fmv ~= floor within $0.01,
-- sales_count_30d <= 2, confidence LOW/ASK_ONLY) — the "an ask masquerading as a
-- sale-backed price" class. Pinned: the candidate gate (all four exclusions), the
-- liquidity-depth multiplier ladder (0.85/0.75/0.65/0.55), latest-per-edition
-- selection, the collection scope, the dollars-removed accounting, the
-- algo_version '..._haircut' stamp, and above all the DRY-RUN contract (computes
-- the same counts but writes NOTHING — the operator preview).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801230600_audit_20260801_snapshot_fmv_apply_thin_sale_haircut.sql);
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
-- <<< END verbatim fmv_apply_thin_sale_haircut <<<

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
  ('00000000-0000-0000-0000-0000000000e9','00000000-0000-0000-0000-00000000dddd', 100,100, 0,0,'LOW',     now(), 'v1');  -- qualifies but OTHER collection

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

SELECT '✓ fmv_apply_thin_sale_haircut invariants pass' AS result;
ROLLBACK;
