-- DB invariant: public.apply_fmv_thin_sales_guard — classifies inflated FMVs
-- (> $200, not already ASK_ONLY, not already capped) into three caps: a
-- COMMON/FANDOM outlier vs its set siblings, a thin-sales WAP outlier, and a
-- stale-30d holdover. This test pins the DETECTION logic via dry-run (which
-- computes every cap + count but writes nothing), plus the p_mode validation and
-- the read-only guarantee. The live-mode WRITE targets base-schema tables
-- (fmv_calibration_caps) not reproduced here, so it is intentionally out of scope.
-- DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261029153057_audit_20261029_ultimate_and_thin_sales_guard_publish_the_last_sale_age.sql;
-- before it, 20260831151141). ⚠ Re-pointed 2026-10-29: the live-mode INSERT now states the last market sale's age
-- and the basis age (out of this dry-run test's scope, like the rest of the write); the cursor also reads basis_days_since_sale.
-- ⚠ Re-pointed 2026-08-31: that migration replaced the driving cursor (a DISTINCT ON
-- over the WHOLE partitioned fmv_snapshots history) with `FROM editions CROSS JOIN
-- LATERAL (newest snapshot)`. The assertions below still EXERCISE the change rather
-- than going vacuous: `total_examined` is the count of rows that cursor yields, so a
-- cursor regression moves it. Cap logic, INSERTs, return object and signature are
-- unchanged by that migration.
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE editions (id uuid PRIMARY KEY, collection_id uuid, tier text, set_name text, external_id text);
CREATE TABLE badge_editions (external_id text, collection_id uuid, low_ask numeric);
-- fmv_snapshots with every column the guard's `latest` CTE selects.
CREATE TABLE fmv_snapshots (
  id bigserial PRIMARY KEY, edition_id uuid, collection_id uuid, fmv_usd numeric,
  asp_usd numeric, asp_without_outliers numeric, ask_proxy_fmv numeric,
  top_shot_ask numeric, flowty_ask numeric, cross_market_ask numeric,
  sales_count_7d int, sales_count_30d int, confidence text, algo_version text,
  computed_at timestamptz DEFAULT now(), floor_price_usd numeric, listing_count int,
  days_since_sale int, basis_days_since_sale int, unique_buyers_30d int, offer_count int,
  velocity_factor numeric, utility_factor numeric, loan_factor numeric);

-- >>> BEGIN verbatim apply_fmv_thin_sales_guard (byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.apply_fmv_thin_sales_guard(p_mode text DEFAULT 'dry_run'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_thin_sales_count INT := 0;
  v_stale_count INT := 0;
  v_common_outlier_count INT := 0;
  v_skipped_already_capped INT := 0;
  v_total_examined INT := 0;
  rec RECORD;
  v_cap NUMERIC;
  v_reason TEXT;
  v_new_confidence TEXT;
  v_can_use_ask BOOLEAN;
  v_fresh_ask NUMERIC;
BEGIN
  IF p_mode NOT IN ('dry_run','live') THEN
    RAISE EXCEPTION 'p_mode must be dry_run or live, got %', p_mode;
  END IF;

  -- 2026-08-31: the cursor used to materialise the newest snapshot for EVERY edition first (a full
  -- 1.35 M-row pass over the whole partitioned history) and then keep 796 rows. Driving from editions
  -- with a LATERAL newest-snapshot lookup returns the same 796 rows (symmetric difference 0 over all
  -- 26 columns, verified live) for 168,886 buffers instead of 1,300,773.
  FOR rec IN
    SELECT
      fs.edition_id, fs.collection_id, fs.fmv_usd, fs.asp_usd AS wap_usd,
      fs.asp_without_outliers AS wap_without_outliers, fs.ask_proxy_fmv,
      fs.top_shot_ask, fs.flowty_ask, fs.cross_market_ask,
      fs.sales_count_7d, fs.sales_count_30d, fs.confidence,
      fs.algo_version, fs.computed_at, fs.floor_price_usd, fs.listing_count,
      fs.days_since_sale, fs.basis_days_since_sale, fs.unique_buyers_30d, fs.offer_count,
      fs.velocity_factor, fs.utility_factor, fs.loan_factor,
      e.tier, e.set_name, e.external_id, c.slug AS collection_slug
    FROM editions e
    CROSS JOIN LATERAL (
      SELECT s.*
      FROM fmv_snapshots s
      WHERE s.edition_id = e.id
      ORDER BY s.computed_at DESC
      LIMIT 1
    ) fs
    JOIN collections c ON c.id = fs.collection_id
    WHERE fs.fmv_usd > 200
      AND fs.confidence::text <> 'ASK_ONLY'
  LOOP
    v_total_examined := v_total_examined + 1;
    IF rec.algo_version IN ('thin-sales-guard-v1', 'thin-sales-guard-v2', 'thin-sales-guard-v3') THEN
      v_skipped_already_capped := v_skipped_already_capped + 1;
      CONTINUE;
    END IF;

    v_cap := NULL;
    v_reason := NULL;
    v_new_confidence := NULL;

    SELECT b.low_ask INTO v_fresh_ask
    FROM editions e3
    JOIN badge_editions b ON b.external_id = e3.external_id AND b.collection_id = e3.collection_id
    WHERE e3.id = rec.edition_id AND b.low_ask > 0 AND b.low_ask <= 10000
    ORDER BY b.low_ask ASC
    LIMIT 1;

    IF rec.tier IN ('COMMON','FANDOM') AND rec.fmv_usd > 500 AND COALESCE(rec.sales_count_7d, 0) <= 1 THEN
      SELECT PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY l2.fmv_usd) INTO v_cap
      FROM (
        SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
        FROM fmv_snapshots fs2
        JOIN editions e2 ON e2.id = fs2.edition_id
        WHERE e2.set_name = rec.set_name AND e2.tier = rec.tier
          AND fs2.collection_id = rec.collection_id
          AND fs2.edition_id <> rec.edition_id
          AND fs2.fmv_usd IS NOT NULL AND fs2.fmv_usd > 0
        ORDER BY edition_id, computed_at DESC
      ) l2;
      IF v_cap IS NOT NULL AND v_cap < rec.fmv_usd THEN
        v_cap := GREATEST(v_cap * 5, 50);
        v_cap := LEAST(v_cap, rec.fmv_usd);
        IF v_fresh_ask IS NOT NULL AND ROUND(v_fresh_ask * 0.90, 2) >= v_cap THEN
          v_cap := NULL;
        ELSE
          v_reason := 'common_fandom_outlier';
          v_new_confidence := 'LOW';
          v_common_outlier_count := v_common_outlier_count + 1;
        END IF;
      END IF;
    END IF;

    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_7d, 0) <= 3 AND rec.wap_without_outliers IS NOT NULL THEN
      IF rec.fmv_usd > rec.wap_without_outliers * 5 THEN
        v_can_use_ask := rec.ask_proxy_fmv IS NOT NULL
                       AND rec.ask_proxy_fmv > rec.fmv_usd * 0.30
                       AND rec.ask_proxy_fmv < rec.fmv_usd;
        IF v_can_use_ask THEN
          v_cap := rec.ask_proxy_fmv * 1.5;
          v_reason := 'thin_sales_ask_capped';
        ELSE
          v_cap := rec.wap_without_outliers;
          v_reason := 'thin_sales_wap_capped';
        END IF;
        v_cap := LEAST(v_cap, rec.fmv_usd);
        v_new_confidence := 'MEDIUM';
        v_thin_sales_count := v_thin_sales_count + 1;
      END IF;
    END IF;

    IF v_cap IS NULL AND v_reason IS NULL AND COALESCE(rec.sales_count_30d, 0) = 0 AND rec.fmv_usd > 200 THEN
      IF v_fresh_ask IS NOT NULL THEN
        v_cap := ROUND(v_fresh_ask * 0.90, 2);
        v_reason := 'stale_30d_fresh_ask';
        v_new_confidence := 'ASK_ONLY';
      ELSIF rec.ask_proxy_fmv IS NOT NULL AND rec.ask_proxy_fmv > 50 THEN
        v_cap := LEAST(rec.ask_proxy_fmv * 1.5, rec.fmv_usd);
        v_reason := 'stale_30d_ask_capped';
        v_new_confidence := 'STALE';
      ELSE
        v_cap := rec.fmv_usd;
        v_reason := 'stale_30d_no_ask';
        v_new_confidence := 'STALE';
      END IF;
      v_stale_count := v_stale_count + 1;
    END IF;

    IF v_cap IS NOT NULL AND v_reason IS NOT NULL AND p_mode = 'live' THEN
      INSERT INTO fmv_snapshots (
        edition_id, collection_id, fmv_usd, floor_price_usd,
        asp_usd, asp_without_outliers, ask_proxy_fmv, confidence,
        top_shot_ask, flowty_ask, cross_market_ask,
        sales_count_7d, sales_count_30d, unique_buyers_30d, offer_count, listing_count,
        days_since_sale, basis_days_since_sale, velocity_factor, utility_factor, loan_factor,
        algo_version, computed_at
      ) VALUES (
        rec.edition_id, rec.collection_id, v_cap, rec.floor_price_usd,
        rec.wap_usd, rec.wap_without_outliers, COALESCE(v_fresh_ask, rec.ask_proxy_fmv),
        v_new_confidence::fmv_confidence,
        COALESCE(v_fresh_ask, rec.top_shot_ask), rec.flowty_ask, rec.cross_market_ask,
        rec.sales_count_7d, rec.sales_count_30d, rec.unique_buyers_30d,
        rec.offer_count, rec.listing_count,
        -- 2026-10-29: a row dated NOW states NOW's facts. days_since_sale is the edition's LAST market sale (the
        -- source row may be ultimate-v1's, which ages from its last NON-special sale); the source's own age,
        -- advanced to now, is the price's basis age.
        COALESCE((SELECT round(EXTRACT(EPOCH FROM (now() - max(m.sold_at))) / 86400)::int
                    FROM sales_market m WHERE m.edition_id = rec.edition_id AND m.price_usd > 0),
                 rec.days_since_sale + floor(EXTRACT(EPOCH FROM (now() - rec.computed_at)) / 86400)::int),
        COALESCE(rec.basis_days_since_sale, rec.days_since_sale) + floor(EXTRACT(EPOCH FROM (now() - rec.computed_at)) / 86400)::int,
        rec.velocity_factor, rec.utility_factor, rec.loan_factor,
        'thin-sales-guard-v3', NOW()
      );

      INSERT INTO fmv_calibration_caps (
        edition_id, collection_id, reason, fmv_before, fmv_after,
        confidence_before, confidence_after, inputs
      ) VALUES (
        rec.edition_id, rec.collection_id, v_reason, rec.fmv_usd, v_cap,
        rec.confidence::TEXT, v_new_confidence,
        jsonb_build_object(
          'tier', rec.tier, 'set_name', rec.set_name,
          'collection_slug', rec.collection_slug,
          'wap_without_outliers', rec.wap_without_outliers,
          'ask_proxy_fmv', rec.ask_proxy_fmv,
          'fresh_ask', v_fresh_ask,
          'sales_count_7d', rec.sales_count_7d,
          'sales_count_30d', rec.sales_count_30d
        )
      )
      ON CONFLICT (edition_id, reason, applied_date) DO UPDATE
        SET applied_at = NOW(),
            fmv_before = EXCLUDED.fmv_before,
            fmv_after = EXCLUDED.fmv_after,
            confidence_before = EXCLUDED.confidence_before,
            confidence_after = EXCLUDED.confidence_after,
            inputs = EXCLUDED.inputs;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'mode', p_mode, 'ran_at', NOW(),
    'algo_version', 'thin-sales-guard-v3',
    'total_examined', v_total_examined,
    'skipped_already_capped', v_skipped_already_capped,
    'thin_sales_count', v_thin_sales_count,
    'stale_count', v_stale_count,
    'common_outlier_count', v_common_outlier_count,
    'total_caps_applied', v_thin_sales_count + v_stale_count + v_common_outlier_count
  );
END;
$function$;
-- <<< END verbatim apply_fmv_thin_sales_guard <<<

DO $seed$
DECLARE
  ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  INSERT INTO collections VALUES (ts, 'nba-top-shot');
  INSERT INTO editions (id, collection_id, tier, set_name, external_id) VALUES
    ('e0000001-0000-0000-0000-000000000001', ts, 'COMMON', 'SetA', 'X1'),  -- E1 outlier
    ('e0000010-0000-0000-0000-000000000010', ts, 'COMMON', 'SetA', 'X1b'), -- sibling
    ('e0000011-0000-0000-0000-000000000011', ts, 'COMMON', 'SetA', 'X1c'), -- sibling
    ('e0000002-0000-0000-0000-000000000002', ts, 'RARE',   'SetB', 'X2'),  -- E2 thin-sales
    ('e0000003-0000-0000-0000-000000000003', ts, 'RARE',   'SetC', 'X3'),  -- E3 stale-30d
    ('e0000004-0000-0000-0000-000000000004', ts, 'RARE',   'SetD', 'X4'),  -- E4 ASK_ONLY (skip)
    ('e0000005-0000-0000-0000-000000000005', ts, 'RARE',   'SetE', 'X5'),  -- E5 fmv<=200 (skip)
    ('e0000006-0000-0000-0000-000000000006', ts, 'COMMON', 'SetF', 'X6');  -- E6 already capped

  -- E1: COMMON, $600, 1 sale/7d → outlier vs siblings ($20/$30, p90≈29 → cap 145)
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, sales_count_7d, sales_count_30d, confidence, algo_version)
    VALUES ('e0000001-0000-0000-0000-000000000001', ts, 600, 1, 5, 'LOW', 'fmv_v1');
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence) VALUES
    ('e0000010-0000-0000-0000-000000000010', ts, 20, 'LOW'),   -- sibling (not examined, fmv<=200)
    ('e0000011-0000-0000-0000-000000000011', ts, 30, 'LOW');
  -- E2: RARE, $1000, 0 sales/7d, wap 100 → fmv > wap*5=500 → thin-sales WAP cap
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, sales_count_7d, sales_count_30d, asp_without_outliers, confidence, algo_version)
    VALUES ('e0000002-0000-0000-0000-000000000002', ts, 1000, 0, 4, 100, 'LOW', 'fmv_v1');
  -- E3: RARE, $300, 10 sales/7d (skips thin-sales), 0 sales/30d → stale-30d
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, sales_count_7d, sales_count_30d, confidence, algo_version)
    VALUES ('e0000003-0000-0000-0000-000000000003', ts, 300, 10, 0, 'LOW', 'fmv_v1');
  -- E4: ASK_ONLY → never examined
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES ('e0000004-0000-0000-0000-000000000004', ts, 500, 'ASK_ONLY', 'ask_v1');
  -- E5: $150 (<= $200) → never examined
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, confidence, algo_version)
    VALUES ('e0000005-0000-0000-0000-000000000005', ts, 150, 'LOW', 'fmv_v1');
  -- E6: already capped (thin-sales-guard-v3) → examined but skipped
  INSERT INTO fmv_snapshots (edition_id, collection_id, fmv_usd, sales_count_7d, confidence, algo_version)
    VALUES ('e0000006-0000-0000-0000-000000000006', ts, 600, 1, 'LOW', 'thin-sales-guard-v3');
END $seed$;

-- p_mode validation: anything but dry_run/live raises.
DO $chk$
BEGIN
  PERFORM apply_fmv_thin_sales_guard('bogus');
  RAISE EXCEPTION 'expected apply_fmv_thin_sales_guard to reject an invalid mode';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM NOT LIKE '%p_mode must be%' THEN RAISE; END IF;
END $chk$;

-- Dry-run detection: 4 examined (E1,E2,E3,E6; E4 ASK_ONLY + E5 <=200 excluded),
-- 1 skipped-already-capped (E6), and one of each cap reason (E1/E2/E3).
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'mode'), 'dry_run', 'echoes the mode');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'total_examined'), '4', 'examines only >200 non-ASK_ONLY rows');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'skipped_already_capped'), '1', 'skips the already thin-sales-guard-v3 row');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'common_outlier_count'), '1', 'flags the COMMON set-sibling outlier');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'thin_sales_count'), '1', 'flags the thin-sales WAP outlier');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'stale_count'), '1', 'flags the stale-30d holdover');
SELECT _assert_eq((apply_fmv_thin_sales_guard('dry_run')->>'total_caps_applied'), '3', 'three caps detected in total');

-- Read-only guarantee: dry-run adds no rows (no thin-sales-guard-v3 writes beyond
-- the one seeded E6) — snapshot count is unchanged after several dry-runs.
SELECT _assert_eq((SELECT count(*)::text FROM fmv_snapshots), '8', 'dry-run wrote nothing (still the 8 seeded rows)');

SELECT '✓ apply_fmv_thin_sales_guard invariants pass' AS result;
ROLLBACK;
