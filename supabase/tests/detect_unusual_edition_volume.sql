-- DB invariant: public.detect_unusual_edition_volume(text, integer, numeric) → json
-- — the volume-surge insider-signal detector. Pins the guards that stop a false
-- surge: >= p_min_24h_sales in 24h; a 14-day baseline of >= 0.5 sales/day (a
-- brand-new edition with no history is never a "surge" — the new-edition guard);
-- 24h volume must exceed baseline * p_multiplier; a tier-scaled dollar floor; and
-- a 12h dedup. Severity bands on the observed multiplier (>=50 → 3, >=20 → 2).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802201000_audit_20260802_snapshot_detect_unusual_edition_volume.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);

CREATE TABLE editions (
  id          uuid PRIMARY KEY,
  player_name text,
  set_name    text,
  tier        text
);

CREATE TABLE sales (
  edition_id    uuid,
  collection_id uuid,
  sold_at       timestamptz,
  price_usd     numeric
);

CREATE TABLE topshot_insider_alerts (
  id             bigserial PRIMARY KEY,
  alert_type     text,
  title          text,
  summary        text,
  evidence_jsonb jsonb,
  severity       smallint,
  generated_at   timestamptz,
  expires_at     timestamptz
);

-- >>> BEGIN verbatim detect_unusual_edition_volume (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.detect_unusual_edition_volume(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_24h_sales integer DEFAULT 5, p_multiplier numeric DEFAULT 10.0)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_examined int := 0;
  v_collection_id uuid;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  per_edition_24h AS (
    SELECT s.edition_id, COUNT(*) AS sales_24h, AVG(s.price_usd) AS avg_price_24h
    FROM sales s
    WHERE s.collection_id = v_collection_id
      AND s.sold_at > NOW() - INTERVAL '24 hours'
      AND s.edition_id IS NOT NULL
    GROUP BY s.edition_id
    HAVING COUNT(*) >= p_min_24h_sales
  ),
  per_edition_baseline AS (
    SELECT
      pe.edition_id, pe.sales_24h, pe.avg_price_24h,
      (SELECT COUNT(*)::numeric / 14 FROM sales s
       WHERE s.edition_id = pe.edition_id
         AND s.sold_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '24 hours'
      ) AS baseline_daily_sales
    FROM per_edition_24h pe
  ),
  flagged AS (
    SELECT eb.*, e.player_name, e.set_name, e.tier
    FROM per_edition_baseline eb
    JOIN editions e ON e.id = eb.edition_id
    WHERE eb.baseline_daily_sales >= 0.5
      AND eb.sales_24h > eb.baseline_daily_sales * p_multiplier
      AND eb.avg_price_24h * eb.sales_24h >= CASE UPPER(COALESCE(e.tier::text, ''))
        WHEN 'FANDOM'    THEN 25
        WHEN 'COMMON'    THEN 50
        WHEN 'RARE'      THEN 250
        WHEN 'LEGENDARY' THEN 1500
        WHEN 'ULTIMATE'  THEN 0
        ELSE 50
      END
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'unusual_edition_volume'
          AND a.evidence_jsonb->>'edition_id' = eb.edition_id::text
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'unusual_edition_volume',
    format('%s · %s · %s sales/24h (%sx baseline)',
           player_name, set_name, sales_24h,
           ROUND(sales_24h / NULLIF(baseline_daily_sales, 0), 1)),
    format('%s sales in last 24h vs %s/day baseline (14d) — %sx surge. Avg price $%s.',
           sales_24h, ROUND(baseline_daily_sales, 1),
           ROUND(sales_24h / NULLIF(baseline_daily_sales, 0), 1),
           ROUND(avg_price_24h, 2)),
    jsonb_build_object(
      'edition_id', edition_id, 'collection_slug', p_collection_slug,
      'sales_24h', sales_24h, 'avg_price_24h', avg_price_24h,
      'baseline_daily_sales', baseline_daily_sales,
      'multiplier_observed', sales_24h / NULLIF(baseline_daily_sales, 0),
      'total_24h_dollars', avg_price_24h * sales_24h,
      'tier', tier, 'player_name', player_name, 'set_name', set_name
    ),
    CASE
      WHEN sales_24h / NULLIF(baseline_daily_sales, 0) >= 50 THEN 3
      WHEN sales_24h / NULLIF(baseline_daily_sales, 0) >= 20 THEN 2
      ELSE 1
    END::smallint,
    NOW(),
    NOW() + INTERVAL '48 hours'
  FROM flagged;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  SELECT COUNT(*) INTO v_examined FROM sales
   WHERE collection_id = v_collection_id AND sold_at > NOW() - INTERVAL '24 hours' AND edition_id IS NOT NULL;

  RETURN json_build_object(
    'collection', p_collection_slug,
    'sales_examined_24h', v_examined,
    'alerts_inserted', v_inserted,
    'min_24h_sales_threshold', p_min_24h_sales,
    'baseline_multiplier', p_multiplier
  );
END;
$function$;
-- <<< END verbatim detect_unusual_edition_volume <<<

INSERT INTO collections (id, slug) VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
INSERT INTO editions (id, player_name, set_name, tier) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'P1', 'S', 'RARE'),  -- surge, sev 1
  ('00000000-0000-0000-0000-0000000000e2', 'P2', 'S', 'RARE'),  -- surge, sev 2
  ('00000000-0000-0000-0000-0000000000e3', 'P3', 'S', 'RARE'),  -- surge, sev 3
  ('00000000-0000-0000-0000-0000000000e4', 'P4', 'S', 'RARE'),  -- high baseline → not a surge
  ('00000000-0000-0000-0000-0000000000e5', 'P5', 'S', 'RARE'),  -- below min 24h sales
  ('00000000-0000-0000-0000-0000000000e6', 'P6', 'S', 'RARE'),  -- thin baseline (<0.5/day) → new-edition guard
  ('00000000-0000-0000-0000-0000000000e7', 'P7', 'S', 'RARE'),  -- low dollar → tier gate
  ('00000000-0000-0000-0000-0000000000e8', 'P8', 'S', 'RARE');  -- would surge but deduped

-- 24h sales (at now-2h): (edition, per-copy price, n copies-in-24h).
INSERT INTO sales (edition_id, collection_id, sold_at, price_usd)
SELECT v.edition::uuid, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '2 hours', v.price
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1', 25, 12),  -- 12 sales, $300; mult 12 (baseline 1) → sev 1
  ('00000000-0000-0000-0000-0000000000e2', 20, 25),  -- 25 sales, $500; mult 25 → sev 2
  ('00000000-0000-0000-0000-0000000000e3', 10, 55),  -- 55 sales, $550; mult 55 → sev 3
  ('00000000-0000-0000-0000-0000000000e4', 25, 12),  -- 12 sales; baseline 2/day → 20 > 12, not a surge
  ('00000000-0000-0000-0000-0000000000e5', 25, 4),   -- 4 < min 5
  ('00000000-0000-0000-0000-0000000000e6', 25, 12),  -- baseline 0.14/day (<0.5) → new-edition guard
  ('00000000-0000-0000-0000-0000000000e7', 1,  12),  -- $12 total < $250 RARE floor → tier gate
  ('00000000-0000-0000-0000-0000000000e8', 25, 12)   -- would surge, but a dupe alert exists
) v(edition, price, n)
CROSS JOIN LATERAL generate_series(1, v.n);

-- Baseline sales (in the 14d..24h window, at now-7d): (edition, n baseline rows).
-- baseline_daily = n/14.  E1/E2/E3/E7/E8 → 14 (=1/day); E4 → 28 (=2/day); E6 → 2 (=0.14/day).
INSERT INTO sales (edition_id, collection_id, sold_at, price_usd)
SELECT v.edition::uuid, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '7 days', 25
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1', 14),
  ('00000000-0000-0000-0000-0000000000e2', 14),
  ('00000000-0000-0000-0000-0000000000e3', 14),
  ('00000000-0000-0000-0000-0000000000e4', 28),
  ('00000000-0000-0000-0000-0000000000e6', 2),
  ('00000000-0000-0000-0000-0000000000e7', 14),
  ('00000000-0000-0000-0000-0000000000e8', 14)
) v(edition, n)
CROSS JOIN LATERAL generate_series(1, v.n);

-- Fresh dupe alert for E8 (within 12h) → suppresses a new one.
INSERT INTO topshot_insider_alerts (alert_type, evidence_jsonb, severity, generated_at)
VALUES ('unusual_edition_volume', jsonb_build_object('edition_id','00000000-0000-0000-0000-0000000000e8'), 1, now() - interval '1 hour');

-- Unknown collection → error.
SELECT _assert_eq(detect_unusual_edition_volume('does_not_exist')->>'error', 'collection not found', 'unknown collection → error');

-- Run: exactly E1, E2, E3 surge.
SELECT _assert_eq(detect_unusual_edition_volume('nba_top_shot')->>'alerts_inserted', '3', 'only the 3 real surges fire');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e1'), '1', 'E1 12x → severity 1');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e2'), '2', 'E2 25x → severity 2');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e3'), '3', 'E3 55x → severity 3');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e4'), '0', 'E4 high baseline → not a surge');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e6'), '0', 'E6 thin baseline (<0.5/day) → new-edition guard, no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e7'), '0', 'E7 below tier dollar floor → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='unusual_edition_volume' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e8'), '1', 'E8 deduped → still only the pre-existing alert');

SELECT '✓ detect_unusual_edition_volume invariants pass' AS result;
ROLLBACK;
