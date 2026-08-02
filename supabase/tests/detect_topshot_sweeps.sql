-- DB invariant: public.detect_topshot_sweeps(text, integer, integer, integer) → json
-- — the quick-buy floor-sweep detector. Pins its distinctive guards: Top-Shot-only
-- (skips other collections); DUC-proposer (quick-buy) sales only; 20-MINUTE-GAP
-- SESSIONIZATION (a longer gap splits a buyer's buys into separate bursts, so
-- unrelated purchases can't be merged into a fake sweep); per-burst gate
-- distinct_editions >= 8 AND (moments >= 15 OR spend >= $75); contract-address
-- exclusion; exactly ONE alert per buyer (rn=1, latest burst); severity bands.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802202000_audit_20260802_snapshot_detect_topshot_sweeps.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);

CREATE TABLE editions (id uuid PRIMARY KEY, set_name text);

CREATE TABLE sales (
  buyer_address    text,
  sold_at          timestamptz,
  edition_id       uuid,
  price_usd        numeric,
  proposer_address text,
  collection_id    uuid
);

CREATE TABLE wallet_usernames (wallet_addr text, username text);

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

-- >>> BEGIN verbatim detect_topshot_sweeps (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.detect_topshot_sweeps(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_moments integer DEFAULT 15, p_min_distinct_editions integer DEFAULT 8, p_lookback_hours integer DEFAULT 24)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
  v_gap_minutes int := 20;
  v_min_spend numeric := 75;
  v_duc_proposer text := '0xead892083b3e2c6c';
BEGIN
  IF p_collection_slug <> 'nba_top_shot' THEN
    RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', 0, 'skipped', 'ts_only');
  END IF;

  SELECT id INTO v_collection_id FROM collections WHERE slug = p_collection_slug;
  IF v_collection_id IS NULL THEN
    RETURN json_build_object('error', 'collection not found');
  END IF;

  WITH base AS (
    SELECT s.buyer_address, s.sold_at, s.edition_id, s.price_usd, e.set_name
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = v_collection_id
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(hours => p_lookback_hours)
      AND s.buyer_address IS NOT NULL
      AND s.edition_id IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
  ),
  marked AS (
    SELECT b.*,
      CASE
        WHEN LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at) IS NULL
          OR b.sold_at - LAG(b.sold_at) OVER (PARTITION BY b.buyer_address ORDER BY b.sold_at)
             > make_interval(mins => v_gap_minutes)
        THEN 1 ELSE 0
      END AS is_new
    FROM base b
  ),
  sessioned AS (
    SELECT m.*,
      SUM(m.is_new) OVER (PARTITION BY m.buyer_address ORDER BY m.sold_at ROWS UNBOUNDED PRECEDING) AS sess
    FROM marked m
  ),
  agg AS (
    SELECT
      buyer_address, sess,
      COUNT(*)                     AS moments,
      COUNT(DISTINCT edition_id)   AS distinct_editions,
      SUM(price_usd)               AS total_spent,
      AVG(price_usd)               AS avg_price,
      MIN(sold_at)                 AS first_buy,
      MAX(sold_at)                 AS last_buy,
      (ARRAY_AGG(DISTINCT set_name))[1:3] AS sample_sets
    FROM sessioned
    GROUP BY buyer_address, sess
  ),
  qualified AS (
    SELECT a.* FROM agg a
    WHERE a.distinct_editions >= p_min_distinct_editions
      AND (a.moments >= p_min_moments OR a.total_spent >= v_min_spend)
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts al
        WHERE al.alert_type = 'floor_sweep'
          AND al.evidence_jsonb->>'buyer_address' = a.buyer_address
          AND (al.evidence_jsonb->>'last_buy')::timestamptz = a.last_buy
          AND al.generated_at > NOW() - INTERVAL '48 hours'
      )
  ),
  ranked AS (
    SELECT q.*,
      (CASE
        WHEN q.moments >= 40 OR q.total_spent >= 250 THEN 3
        WHEN q.moments >= 20 OR q.total_spent >= 100 THEN 2
        ELSE 1
      END)::smallint AS sev,
      ROW_NUMBER() OVER (
        PARTITION BY q.buyer_address
        ORDER BY q.last_buy DESC, q.moments DESC, q.total_spent DESC
      ) AS rn
    FROM qualified q
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'floor_sweep',
    format('Floor sweep: %s moments across %s editions ($%s)',
           ranked.moments, ranked.distinct_editions, ROUND(ranked.total_spent, 0)),
    format('%s swept %s moments across %s editions in one burst (%s). Avg $%s, total $%s.%s',
           COALESCE(
             NULLIF(wu.username, '') || ' (' || SUBSTRING(ranked.buyer_address, 1, 10) || '…)',
             'Wallet ' || SUBSTRING(ranked.buyer_address, 1, 10) || '...'
           ),
           ranked.moments, ranked.distinct_editions,
           to_char(ranked.first_buy, 'Mon DD HH24:MI') || '–' || to_char(ranked.last_buy, 'HH24:MI UTC'),
           ROUND(ranked.avg_price, 2), ROUND(ranked.total_spent, 2),
           CASE WHEN COALESCE(array_length(ranked.sample_sets, 1), 0) > 0
                THEN ' Sets: ' || array_to_string(ranked.sample_sets, ', ') || '.' ELSE '' END),
    jsonb_build_object(
      'buyer_address', ranked.buyer_address,
      'buyer_username', NULLIF(wu.username, ''),
      'collection_slug', p_collection_slug,
      'moments', ranked.moments,
      'distinct_editions', ranked.distinct_editions,
      'total_spent', ranked.total_spent,
      'avg_price', ranked.avg_price,
      'first_buy', ranked.first_buy,
      'last_buy', ranked.last_buy,
      'sample_sets', ranked.sample_sets,
      'via', 'quick_buy'
    ),
    ranked.sev,
    NOW(), NOW() + INTERVAL '24 hours'
  FROM ranked
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = ranked.buyer_address
  WHERE ranked.rn = 1;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;
-- <<< END verbatim detect_topshot_sweeps <<<

INSERT INTO collections (id, slug) VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
INSERT INTO editions (id, set_name) VALUES
  ('00000000-0000-0000-0000-0000000000e1','SetA'),('00000000-0000-0000-0000-0000000000e2','SetA'),
  ('00000000-0000-0000-0000-0000000000e3','SetA'),('00000000-0000-0000-0000-0000000000e4','SetB'),
  ('00000000-0000-0000-0000-0000000000e5','SetB'),('00000000-0000-0000-0000-0000000000e6','SetB'),
  ('00000000-0000-0000-0000-0000000000e7','SetC'),('00000000-0000-0000-0000-0000000000e8','SetC'),
  ('00000000-0000-0000-0000-0000000000e9','SetC'),('00000000-0000-0000-0000-000000000e10','SetC');

-- (buyer, edition, per-copy price, minutes_ago, proposer, copies). All rows in a
-- group share a timestamp → gap 0 → one session; a different minutes_ago for the
-- same buyer that is >20min apart starts a new session.
INSERT INTO sales (buyer_address, edition_id, price_usd, sold_at, proposer_address, collection_id)
SELECT v.buyer, v.edition::uuid, v.price, now() - (v.mins || ' minutes')::interval, v.proposer, '95f28a17-224a-4025-96ad-adf8a4c63bfd'
FROM (VALUES
  -- B1: one burst, 8 distinct, 15 moments, spend 75 → qualifies, sev 1.
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e1', 5, 120, '0xead892083b3e2c6c', 8),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e2', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e3', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e4', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e5', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e6', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e7', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b1','00000000-0000-0000-0000-0000000000e8', 5, 120, '0xead892083b3e2c6c', 1),
  -- B7: 8 distinct, spend 300 → qualifies, sev 3.
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e1', 30, 180, '0xead892083b3e2c6c', 3),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e2', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e3', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e4', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e5', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e6', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e7', 30, 180, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b7','00000000-0000-0000-0000-0000000000e8', 30, 180, '0xead892083b3e2c6c', 1),
  -- B2: 8 distinct but 8 moments & spend 40 → fails the moments/spend gate.
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e1', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e2', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e3', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e4', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e5', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e6', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e7', 5, 240, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b2','00000000-0000-0000-0000-0000000000e8', 5, 240, '0xead892083b3e2c6c', 1),
  -- B3: 5 distinct, 20 moments → fails the distinct-editions gate.
  ('0x00000000000000b3','00000000-0000-0000-0000-0000000000e1', 5, 300, '0xead892083b3e2c6c', 16),
  ('0x00000000000000b3','00000000-0000-0000-0000-0000000000e2', 5, 300, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b3','00000000-0000-0000-0000-0000000000e3', 5, 300, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b3','00000000-0000-0000-0000-0000000000e4', 5, 300, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b3','00000000-0000-0000-0000-0000000000e5', 5, 300, '0xead892083b3e2c6c', 1),
  -- B4: qualifying shape but NON-DUC proposer → excluded.
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e1', 5, 120, '0x1111111111111111', 8),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e2', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e3', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e4', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e5', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e6', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e7', 5, 120, '0x1111111111111111', 1),
  ('0x00000000000000b4','00000000-0000-0000-0000-0000000000e8', 5, 120, '0x1111111111111111', 1),
  -- contract buyer, qualifying shape → excluded.
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e1', 5, 120, '0xead892083b3e2c6c', 8),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e2', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e3', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e4', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e5', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e6', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e7', 5, 120, '0xead892083b3e2c6c', 1),
  ('0xedf9df96c92f4595','00000000-0000-0000-0000-0000000000e8', 5, 120, '0xead892083b3e2c6c', 1),
  -- B6: TWO bursts split by a >20min gap (360 vs 330), each 5 distinct → neither
  -- qualifies. If sessionization were removed, the 10 distinct would qualify.
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e1', 20, 360, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e2', 20, 360, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e3', 20, 360, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e4', 20, 360, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e5', 20, 360, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e6', 20, 330, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e7', 20, 330, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e8', 20, 330, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-0000000000e9', 20, 330, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b6','00000000-0000-0000-0000-000000000e10', 20, 330, '0xead892083b3e2c6c', 1),
  -- B9: TWO qualifying bursts (420 and 120) → exactly ONE alert (rn=1, latest).
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e1', 5, 420, '0xead892083b3e2c6c', 8),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e2', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e3', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e4', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e5', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e6', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e7', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e8', 5, 420, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e1', 5, 120, '0xead892083b3e2c6c', 8),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e2', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e3', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e4', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e5', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e6', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e7', 5, 120, '0xead892083b3e2c6c', 1),
  ('0x00000000000000b9','00000000-0000-0000-0000-0000000000e8', 5, 120, '0xead892083b3e2c6c', 1)
) v(buyer, edition, price, mins, proposer, copies)
CROSS JOIN LATERAL generate_series(1, v.copies);

-- Non-TS collection → skipped, no query run.
SELECT _assert_eq(detect_topshot_sweeps('nfl_all_day')->>'skipped', 'ts_only', 'non-TS collection → skipped ts_only');

-- Run: B1, B7, B9 fire = 3.
SELECT _assert_eq(detect_topshot_sweeps('nba_top_shot')->>'alerts_inserted', '3', 'only the 3 real sweeps fire');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b1'), '1', 'B1 15 moments/$75 → severity 1');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b7'), '3', 'B7 $300 spend → severity 3');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b2'), '0', 'B2 below moments/spend gate → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b3'), '0', 'B3 only 5 distinct editions → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b4'), '0', 'B4 non-DUC proposer → no alert (quick-buy only)');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0xedf9df96c92f4595'), '0', 'contract-address buyer excluded → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b6'), '0', 'B6 two 5-distinct bursts split by a 30min gap → neither qualifies (sessionization)');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='floor_sweep' AND evidence_jsonb->>'buyer_address'='0x00000000000000b9'), '1', 'B9 two qualifying bursts → exactly ONE alert (rn=1)');

SELECT '✓ detect_topshot_sweeps invariants pass' AS result;
ROLLBACK;
