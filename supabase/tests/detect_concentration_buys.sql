-- DB invariant: public.detect_concentration_buys(text, integer) → json — the
-- whale-accumulation insider-signal detector. Pins the guards that stop a
-- fabricated signal: >= p_min_copies of ONE edition by ONE buyer in 24h; known
-- marketplace/custodian contract addresses excluded; a tier-scaled minimum spend
-- (RARE 250 / FANDOM 25 / LEGENDARY 1500 / else 50); exactly ONE alert per buyer
-- (their top edition by severity → copies → spend, rn=1); severity bands on
-- copies (>=13 → 3, >=8 → 2, else 1); and a 12h dedup on (edition, buyer).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802200500_audit_20260802_snapshot_detect_concentration_buys.sql);
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
  buyer_address text,
  price_usd     numeric,
  sold_at       timestamptz,
  collection_id uuid
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

-- >>> BEGIN verbatim detect_concentration_buys (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.detect_concentration_buys(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_copies integer DEFAULT 5)
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

  WITH whale_buys AS (
    SELECT
      s.edition_id, s.buyer_address,
      COUNT(*) AS copies_bought_24h,
      SUM(s.price_usd) AS total_spent,
      AVG(s.price_usd) AS avg_price,
      MIN(s.sold_at) AS first_buy,
      MAX(s.sold_at) AS last_buy
    FROM sales s
    WHERE s.collection_id = v_collection_id
      AND s.sold_at > NOW() - INTERVAL '24 hours'
      AND s.edition_id IS NOT NULL AND s.buyer_address IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
    GROUP BY s.edition_id, s.buyer_address
    HAVING COUNT(*) >= p_min_copies
  ),
  filtered AS (
    SELECT wb.*, e.player_name, e.set_name, e.tier
    FROM whale_buys wb
    JOIN editions e ON e.id = wb.edition_id
    WHERE wb.total_spent >= CASE UPPER(COALESCE(e.tier::text, ''))
        WHEN 'FANDOM'    THEN 25
        WHEN 'COMMON'    THEN 50
        WHEN 'RARE'      THEN 250
        WHEN 'LEGENDARY' THEN 1500
        WHEN 'ULTIMATE'  THEN 0
        ELSE 50
      END
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'concentration_buy'
          AND a.evidence_jsonb->>'edition_id' = wb.edition_id::text
          AND a.evidence_jsonb->>'buyer_address' = wb.buyer_address
          AND a.generated_at > NOW() - INTERVAL '12 hours'
      )
  ),
  ranked AS (
    SELECT f.*,
      (CASE
        WHEN f.copies_bought_24h >= 13 THEN 3
        WHEN f.copies_bought_24h >= 8  THEN 2
        ELSE 1
      END)::smallint AS sev,
      ROW_NUMBER() OVER (
        PARTITION BY f.buyer_address
        ORDER BY
          (CASE
            WHEN f.copies_bought_24h >= 13 THEN 3
            WHEN f.copies_bought_24h >= 8  THEN 2
            ELSE 1
          END) DESC,
          f.copies_bought_24h DESC,
          f.total_spent DESC
      ) AS rn
    FROM filtered f
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'concentration_buy',
    format('Whale buy: %s · %s · %s copies in 24h ($%s)',
           ranked.player_name, ranked.set_name, ranked.copies_bought_24h, ROUND(ranked.total_spent, 0)),
    format('%s acquired %s copies in 24h. Avg price $%s, total $%s.',
           COALESCE(
             NULLIF(wu.username, '') || ' (' || SUBSTRING(ranked.buyer_address, 1, 10) || '…)',
             'Wallet ' || SUBSTRING(ranked.buyer_address, 1, 10) || '...'
           ),
           ranked.copies_bought_24h, ROUND(ranked.avg_price, 2), ROUND(ranked.total_spent, 2)),
    jsonb_build_object(
      'edition_id', ranked.edition_id, 'buyer_address', ranked.buyer_address,
      'buyer_username', NULLIF(wu.username, ''),
      'collection_slug', p_collection_slug,
      'copies_bought_24h', ranked.copies_bought_24h, 'total_spent', ranked.total_spent,
      'avg_price', ranked.avg_price, 'tier', ranked.tier, 'player_name', ranked.player_name, 'set_name', ranked.set_name
    ),
    ranked.sev,
    NOW(), NOW() + INTERVAL '48 hours'
  FROM ranked
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = ranked.buyer_address
  WHERE ranked.rn = 1;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;
-- <<< END verbatim detect_concentration_buys <<<

INSERT INTO collections (id, slug) VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
INSERT INTO editions (id, player_name, set_name, tier) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'P1', 'S', 'RARE'),       -- B1 qualifies
  ('00000000-0000-0000-0000-0000000000e2', 'P2', 'S', 'RARE'),       -- B2 below spend
  ('00000000-0000-0000-0000-0000000000e3', 'P3', 'S', 'FANDOM'),     -- B3 qualifies (low tier threshold)
  ('00000000-0000-0000-0000-0000000000e4', 'P4', 'S', 'RARE'),       -- B4 too few copies
  ('00000000-0000-0000-0000-0000000000e5', 'P5', 'S', 'RARE'),       -- contract buyer
  ('00000000-0000-0000-0000-0000000000e6', 'P6', 'S', 'LEGENDARY'),  -- B6 qualifies, sev 2
  ('00000000-0000-0000-0000-000000000e7a', 'P7', 'S', 'RARE'),       -- B7 lower-signal edition
  ('00000000-0000-0000-0000-000000000e7b', 'P7', 'S', 'RARE'),       -- B7 higher-signal edition (wins rn=1)
  ('00000000-0000-0000-0000-0000000000e8', 'P8', 'S', 'RARE'),       -- B8 deduped
  ('00000000-0000-0000-0000-0000000000e9', 'P9', 'S', 'RARE');       -- B9 qualifies, sev 3

-- Expand each (edition, buyer, per-copy price, n copies) into n sale rows in-window.
INSERT INTO sales (edition_id, buyer_address, price_usd, sold_at, collection_id)
SELECT v.edition::uuid, v.buyer, v.price, now() - interval '2 hours', '95f28a17-224a-4025-96ad-adf8a4c63bfd'
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1','0x00000000000000b1', 50,  6),   -- 300 >= 250 RARE, sev 1
  ('00000000-0000-0000-0000-0000000000e2','0x00000000000000b2', 40,  5),   -- 200 < 250 RARE → filtered
  ('00000000-0000-0000-0000-0000000000e3','0x00000000000000b3', 6,   5),   -- 30 >= 25 FANDOM, sev 1
  ('00000000-0000-0000-0000-0000000000e4','0x00000000000000b4', 100, 4),   -- 4 < 5 copies → HAVING
  ('00000000-0000-0000-0000-0000000000e5','0xedf9df96c92f4595', 100, 10),  -- contract → excluded
  ('00000000-0000-0000-0000-0000000000e6','0x00000000000000b6', 250, 8),   -- 2000 >= 1500 LEGENDARY, sev 2
  ('00000000-0000-0000-0000-000000000e7a','0x00000000000000b7', 50,  6),   -- B7 edition A, sev 1
  ('00000000-0000-0000-0000-000000000e7b','0x00000000000000b7', 40,  10),  -- B7 edition B, sev 2 (wins)
  ('00000000-0000-0000-0000-0000000000e8','0x00000000000000b8', 50,  6),   -- B8 qualifies but deduped
  ('00000000-0000-0000-0000-0000000000e9','0x00000000000000b9', 100, 13)   -- 1300, 13 copies, sev 3
) v(edition, buyer, price, n)
CROSS JOIN LATERAL generate_series(1, v.n);

-- Fresh dupe alert for (E8, B8) within 12h → suppresses a new one.
INSERT INTO topshot_insider_alerts (alert_type, evidence_jsonb, severity, generated_at)
VALUES ('concentration_buy',
        jsonb_build_object('edition_id','00000000-0000-0000-0000-0000000000e8','buyer_address','0x00000000000000b8'),
        1, now() - interval '1 hour');

-- Unknown collection → error.
SELECT _assert_eq(detect_concentration_buys('does_not_exist')->>'error', 'collection not found', 'unknown collection → error');

-- Run: B1, B3, B6, B7(one), B9 fire = 5.
SELECT _assert_eq(detect_concentration_buys('nba_top_shot')->>'alerts_inserted', '5', 'exactly the 5 real whale buys fire');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b1' AND generated_at > now() - interval '1 minute'), '1', 'B1 6 copies → severity 1');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b6' AND generated_at > now() - interval '1 minute'), '2', 'B6 8 copies → severity 2');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b9' AND generated_at > now() - interval '1 minute'), '3', 'B9 13 copies → severity 3');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b2'), '0', 'B2 below tier spend → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b4'), '0', 'B4 below min copies → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0xedf9df96c92f4595'), '0', 'contract-address buyer excluded → no alert');
-- B7: exactly one alert, and it is the higher-signal edition E7b.
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b7' AND generated_at > now() - interval '1 minute'), '1', 'B7 → exactly one alert (rn=1, not one per edition)');
SELECT _assert_eq((SELECT evidence_jsonb->>'edition_id' FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b7' AND generated_at > now() - interval '1 minute'), '00000000-0000-0000-0000-000000000e7b', 'B7 alert is the higher-signal edition E7b (10 copies)');
-- B8 deduped: still only the pre-existing alert.
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='concentration_buy' AND evidence_jsonb->>'buyer_address'='0x00000000000000b8'), '1', 'B8 deduped → no new alert');

SELECT '✓ detect_concentration_buys invariants pass' AS result;
ROLLBACK;
