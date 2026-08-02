-- DB invariant: public.detect_floor_drops(text, numeric, integer) → json — the
-- floor-drop insider-signal detector. Pins that it fires ONLY on a real, liquid
-- drop and never fabricates a signal: prior floor must be > $5 (penny guard), the
-- edition needs >= p_min_recent_sales 24h sales (liquidity gate), the drop must
-- clear p_min_drop_pct, no duplicate alert may exist within 12h, and severity
-- bands on drop size (>60 → 3, >45 → 2, else 1). Unknown collection → error.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802200000_audit_20260802_snapshot_detect_floor_drops.sql);
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

CREATE TABLE fmv_snapshots (
  edition_id      uuid,
  collection_id   uuid,
  floor_price_usd numeric,
  computed_at     timestamptz
);

CREATE TABLE sales (
  edition_id    uuid,
  collection_id uuid,
  sold_at       timestamptz
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

-- >>> BEGIN verbatim detect_floor_drops (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.detect_floor_drops(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_drop_pct numeric DEFAULT 30.0, p_min_recent_sales integer DEFAULT 3)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
BEGIN
  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH
  recent_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS now_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at > NOW() - INTERVAL '6 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  prior_floors AS (
    SELECT DISTINCT ON (edition_id) edition_id, floor_price_usd AS prior_floor, computed_at
    FROM fmv_snapshots
    WHERE collection_id = v_collection_id AND floor_price_usd IS NOT NULL
      AND computed_at BETWEEN NOW() - INTERVAL '36 hours' AND NOW() - INTERVAL '20 hours'
    ORDER BY edition_id, computed_at DESC
  ),
  recent_sales_check AS (
    SELECT edition_id, COUNT(*) AS sales_24h
    FROM sales
    WHERE collection_id = v_collection_id AND sold_at > NOW() - INTERVAL '24 hours'
      AND edition_id IS NOT NULL
    GROUP BY edition_id
    HAVING COUNT(*) >= p_min_recent_sales
  ),
  drops AS (
    SELECT r.edition_id, r.now_floor, p.prior_floor,
      ROUND(100.0 * (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0), 1) AS drop_pct,
      rsc.sales_24h, e.player_name, e.set_name, e.tier
    FROM recent_floors r
    JOIN prior_floors p USING (edition_id)
    JOIN recent_sales_check rsc USING (edition_id)
    JOIN editions e ON e.id = r.edition_id
    WHERE p.prior_floor > r.now_floor
      AND (p.prior_floor - r.now_floor) / NULLIF(p.prior_floor, 0) * 100 >= p_min_drop_pct
      AND p.prior_floor > 5
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'floor_drop'
          AND a.evidence_jsonb->>'edition_id' = r.edition_id::text
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'floor_drop',
    format('%s · %s · floor down %s%% in 24h ($%s → $%s)', player_name, set_name, drop_pct, prior_floor, now_floor),
    format('%s drops floor by %s%% in 24h with %s active sales. Was $%s, now $%s.',
           player_name, drop_pct, sales_24h, prior_floor, now_floor),
    jsonb_build_object(
      'edition_id', edition_id, 'collection_slug', p_collection_slug,
      'now_floor_usd', now_floor, 'prior_floor_usd', prior_floor,
      'drop_pct', drop_pct, 'sales_24h', sales_24h,
      'tier', tier, 'player_name', player_name, 'set_name', set_name
    ),
    CASE WHEN drop_pct > 60 THEN 3 WHEN drop_pct > 45 THEN 2 ELSE 1 END::smallint,
    NOW(), NOW() + INTERVAL '24 hours'
  FROM drops;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;
-- <<< END verbatim detect_floor_drops <<<

INSERT INTO collections (id, slug) VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
INSERT INTO editions (id, player_name, set_name, tier) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'P1', 'S', 'RARE'),
  ('00000000-0000-0000-0000-0000000000e2', 'P2', 'S', 'RARE'),
  ('00000000-0000-0000-0000-0000000000e3', 'P3', 'S', 'RARE'),
  ('00000000-0000-0000-0000-0000000000e4', 'P4', 'S', 'RARE'),
  ('00000000-0000-0000-0000-0000000000e5', 'P5', 'S', 'RARE'),
  ('00000000-0000-0000-0000-0000000000e6', 'P6', 'S', 'RARE');

-- Floors: prior (24h ago, inside the 20-36h window) + now (1h ago).
-- E1 100→60 (40% drop, sev 1) · E2 100→30 (70%, sev 3) · E3 100→90 (10%, below thresh)
-- E4 4→1 (75% but prior<=5, penny guard) · E5 100→50 (50%, but low liquidity)
-- E6 100→50 (50%, but a fresh dupe alert exists)
INSERT INTO fmv_snapshots (edition_id, collection_id, floor_price_usd, computed_at) VALUES
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 60,  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e2', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 30,  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 90,  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 4,   now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 1,   now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 50,  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000e6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 100, now() - interval '24 hours'),
  ('00000000-0000-0000-0000-0000000000e6', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 50,  now() - interval '1 hour');

-- Sales in last 24h: 3 each for E1..E4,E6 (isolates the guard under test); only 2 for E5.
INSERT INTO sales (edition_id, collection_id, sold_at)
SELECT e, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '2 hours'
FROM (VALUES ('00000000-0000-0000-0000-0000000000e1'::uuid),('00000000-0000-0000-0000-0000000000e2'),
             ('00000000-0000-0000-0000-0000000000e3'),('00000000-0000-0000-0000-0000000000e4'),
             ('00000000-0000-0000-0000-0000000000e6')) v(e), generate_series(1,3);
INSERT INTO sales (edition_id, collection_id, sold_at)
SELECT '00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '2 hours'
FROM generate_series(1,2);

-- Pre-existing fresh dupe alert for E6 (within 12h) → suppresses a new E6 alert.
INSERT INTO topshot_insider_alerts (alert_type, evidence_jsonb, severity, generated_at)
VALUES ('floor_drop', jsonb_build_object('edition_id','00000000-0000-0000-0000-0000000000e6'), 1, now() - interval '1 hour');

-- Unknown collection → error, no write.
SELECT _assert_eq(detect_floor_drops('does_not_exist')->>'error', 'collection not found', 'unknown collection → error');

-- Run the detector: exactly E1 + E2 fire.
SELECT _assert_eq(detect_floor_drops('nba_top_shot')->>'alerts_inserted', '2', 'only the 2 real, liquid, un-deduped drops fire');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='floor_drop' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e1'), '1', 'E1 40%% drop → severity 1');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='floor_drop' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e2'), '3', 'E2 70%% drop → severity 3');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e3'), '0', 'E3 10%% drop → no alert (below threshold)');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e4'), '0', 'E4 penny floor (<= $5) → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e5'), '0', 'E5 too few 24h sales → no alert (liquidity gate)');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e6'), '1', 'E6 deduped → still only the pre-existing alert, no new one');

SELECT '✓ detect_floor_drops invariants pass' AS result;
ROLLBACK;
