-- DB invariant: public.detect_new_edition_early_buyers(text, integer, integer) → json
-- — the launch-window concentration detector. Pins: the edition must be NEW
-- (first-ever sale < 7d, no sale older than 7d); only buys within p_window_hours
-- of the first sale count (out-of-window buys are ignored); known contract
-- addresses excluded; >= p_min_copies; a tier-scaled spend floor; and a 24h dedup
-- on (edition, buyer). Severity bands on early copies (>10 → 3, >5 → 2).
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260802201500_audit_20260802_snapshot_detect_new_edition_early_buyers.sql);
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
  buyer_address text,
  price_usd     numeric
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

-- >>> BEGIN verbatim detect_new_edition_early_buyers (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.detect_new_edition_early_buyers(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_min_copies integer DEFAULT 3, p_window_hours integer DEFAULT 48)
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
  _efs_recent AS (
    SELECT DISTINCT edition_id
    FROM sales
    WHERE collection_id = v_collection_id AND edition_id IS NOT NULL
      AND sold_at > NOW() - INTERVAL '7 days'
  ),
  edition_first_sale AS (
    -- first-ever sale < 7d old == has a recent sale AND no older sale.
    -- Avoids the full-history GROUP BY (parity-verified 2026-07-16).
    SELECT r.edition_id,
           (SELECT min(s2.sold_at) FROM sales s2
             WHERE s2.edition_id = r.edition_id AND s2.collection_id = v_collection_id) AS first_sale_at
    FROM _efs_recent r
    WHERE NOT EXISTS (
      SELECT 1 FROM sales s3
      WHERE s3.edition_id = r.edition_id AND s3.collection_id = v_collection_id
        AND s3.sold_at <= NOW() - INTERVAL '7 days'
    )
  ),
  early_buys AS (
    SELECT s.edition_id, s.buyer_address, efs.first_sale_at,
      COUNT(*) AS early_copies,
      AVG(s.price_usd) AS avg_price,
      MIN(s.sold_at) AS first_buy,
      MAX(s.sold_at) AS last_buy
    FROM sales s
    JOIN edition_first_sale efs ON efs.edition_id = s.edition_id
    WHERE s.collection_id = v_collection_id
      AND s.sold_at <= efs.first_sale_at + (p_window_hours || ' hours')::interval
      AND s.buyer_address IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
    GROUP BY s.edition_id, s.buyer_address, efs.first_sale_at
    HAVING COUNT(*) >= p_min_copies
  ),
  filtered AS (
    SELECT eb.*, e.player_name, e.set_name, e.tier
    FROM early_buys eb
    JOIN editions e ON e.id = eb.edition_id
    WHERE eb.early_copies * eb.avg_price >= CASE UPPER(COALESCE(e.tier::text, ''))
        WHEN 'FANDOM'    THEN 25
        WHEN 'COMMON'    THEN 50
        WHEN 'RARE'      THEN 250
        WHEN 'LEGENDARY' THEN 1500
        WHEN 'ULTIMATE'  THEN 0
        ELSE 50
      END
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts a
        WHERE a.alert_type = 'early_buyer'
          AND a.evidence_jsonb->>'edition_id' = eb.edition_id::text
          AND a.evidence_jsonb->>'buyer_address' = eb.buyer_address
          AND a.generated_at > NOW() - INTERVAL '24 hours'
      )
  )
  INSERT INTO topshot_insider_alerts (
    alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at
  )
  SELECT
    'early_buyer',
    format('Early concentration: %s · %s · %s copies in launch window', filtered.player_name, filtered.set_name, filtered.early_copies),
    format('%s grabbed %s copies of newly-launched edition within %sh of first sale. Avg price $%s.',
           COALESCE(
             NULLIF(wu.username, '') || ' (' || SUBSTRING(filtered.buyer_address, 1, 10) || '…)',
             'Wallet ' || SUBSTRING(filtered.buyer_address, 1, 10) || '...'
           ),
           filtered.early_copies, p_window_hours, ROUND(filtered.avg_price, 2)),
    jsonb_build_object(
      'edition_id', filtered.edition_id, 'buyer_address', filtered.buyer_address,
      'buyer_username', NULLIF(wu.username, ''),
      'collection_slug', p_collection_slug, 'early_copies', filtered.early_copies,
      'window_hours', p_window_hours, 'avg_price', filtered.avg_price,
      'total_spent', filtered.early_copies * filtered.avg_price,
      'first_sale_at', filtered.first_sale_at, 'tier', filtered.tier,
      'player_name', filtered.player_name, 'set_name', filtered.set_name
    ),
    CASE WHEN filtered.early_copies > 10 THEN 3 WHEN filtered.early_copies > 5 THEN 2 ELSE 1 END::smallint,
    NOW(), NOW() + INTERVAL '72 hours'
  FROM filtered
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = filtered.buyer_address;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;
-- <<< END verbatim detect_new_edition_early_buyers <<<

INSERT INTO collections (id, slug) VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
INSERT INTO editions (id, player_name, set_name, tier) VALUES
  ('00000000-0000-0000-0000-0000000000e1', 'P1', 'S', 'RARE'),  -- new, B1 qualifies sev 1
  ('00000000-0000-0000-0000-0000000000e2', 'P2', 'S', 'RARE'),  -- new, B2 qualifies sev 2
  ('00000000-0000-0000-0000-0000000000e3', 'P3', 'S', 'RARE'),  -- new, B3 qualifies sev 3
  ('00000000-0000-0000-0000-0000000000e4', 'P4', 'S', 'RARE'),  -- NOT new (old sale) → excluded
  ('00000000-0000-0000-0000-0000000000e5', 'P5', 'S', 'RARE'),  -- new, too few copies
  ('00000000-0000-0000-0000-0000000000e6', 'P6', 'S', 'RARE'),  -- new, low dollar → tier gate
  ('00000000-0000-0000-0000-0000000000e7', 'P7', 'S', 'RARE'),  -- new, contract buyer excluded
  ('00000000-0000-0000-0000-0000000000e8', 'P8', 'S', 'RARE'),  -- new, qualifies but deduped
  ('00000000-0000-0000-0000-0000000000e9', 'P9', 'S', 'RARE'),  -- new, buys OUTSIDE launch window
  ('00000000-0000-0000-0000-000000000e10', 'P10', 'S', 'RARE'); -- OLD edition, burst right after its old first sale

-- In-window early buys (first sale + buys both at now-4d → first_sale_at=now-4d,
-- window +48h = now-2d, all within).
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd)
SELECT v.edition::uuid, '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '4 days', v.buyer, v.price
FROM (VALUES
  ('00000000-0000-0000-0000-0000000000e1','0x00000000000000b1', 70, 4),   -- 280 >= 250, 4 copies sev 1
  ('00000000-0000-0000-0000-0000000000e2','0x00000000000000b2', 50, 6),   -- 300, 6 copies sev 2
  ('00000000-0000-0000-0000-0000000000e3','0x00000000000000b3', 30, 12),  -- 360, 12 copies sev 3
  ('00000000-0000-0000-0000-0000000000e4','0x00000000000000b4', 50, 6),   -- would qualify but E4 not new
  ('00000000-0000-0000-0000-0000000000e5','0x00000000000000b5', 100, 2),  -- 2 < min 3
  ('00000000-0000-0000-0000-0000000000e6','0x00000000000000b6', 10, 4),   -- 40 < 250 tier floor
  ('00000000-0000-0000-0000-0000000000e7','0xedf9df96c92f4595', 50, 6),   -- contract excluded
  ('00000000-0000-0000-0000-0000000000e8','0x00000000000000b8', 70, 4)    -- 280, but deduped
) v(edition, buyer, price, n)
CROSS JOIN LATERAL generate_series(1, v.n);

-- E4's OLD sale (> 7d ago) makes it NOT a new edition → excluded from the detector.
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd) VALUES
  ('00000000-0000-0000-0000-0000000000e4', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '10 days', '0x00000000000000ff', 50);

-- E9: first sale now-5d (one copy), then B9's 4 copies at now-2d, which is OUTSIDE
-- the launch window (now-5d + 48h = now-3d) → not counted → no alert.
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd) VALUES
  ('00000000-0000-0000-0000-0000000000e9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '5 days', '0x00000000000000fa', 50);
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd)
SELECT '00000000-0000-0000-0000-0000000000e9', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '2 days', '0x00000000000000b9', 70
FROM generate_series(1, 4);

-- E10: an OLD edition (first sale now-10d, > 7d ago → NOT new) whose burst
-- happened WITHIN 48h of that old first sale, PLUS a recent sale so it enters the
-- candidate set. This isolates the new-edition guard: only that guard (not the
-- launch-window bound, not the recent-sale candidate filter) keeps E10 from
-- firing — remove the guard and B10's now-10d burst fires a stale alert.
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd)
SELECT '00000000-0000-0000-0000-000000000e10', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '10 days', '0x0000000000000c10', 70
FROM generate_series(1, 4);
INSERT INTO sales (edition_id, collection_id, sold_at, buyer_address, price_usd) VALUES
  ('00000000-0000-0000-0000-000000000e10', '95f28a17-224a-4025-96ad-adf8a4c63bfd', now() - interval '3 days', '0x0000000000000c1f', 70);

-- Fresh dupe alert for (E8, B8) within 24h → suppresses a new one.
INSERT INTO topshot_insider_alerts (alert_type, evidence_jsonb, severity, generated_at)
VALUES ('early_buyer',
        jsonb_build_object('edition_id','00000000-0000-0000-0000-0000000000e8','buyer_address','0x00000000000000b8'),
        1, now() - interval '1 hour');

-- Unknown collection → error.
SELECT _assert_eq(detect_new_edition_early_buyers('does_not_exist')->>'error', 'collection not found', 'unknown collection → error');

-- Run: exactly E1/B1, E2/B2, E3/B3 fire.
SELECT _assert_eq(detect_new_edition_early_buyers('nba_top_shot')->>'alerts_inserted', '3', 'only the 3 real early-buyer concentrations fire');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e1'), '1', 'E1 4 copies → severity 1');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e2'), '2', 'E2 6 copies → severity 2');
SELECT _assert_eq((SELECT severity::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e3'), '3', 'E3 12 copies → severity 3');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e4'), '0', 'E4 not a new edition → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e6'), '0', 'E6 below tier dollar floor → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'buyer_address'='0xedf9df96c92f4595'), '0', 'contract-address buyer excluded → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e9'), '0', 'E9 buys outside launch window → no alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-0000000000e8'), '1', 'E8 deduped → still only the pre-existing alert');
SELECT _assert_eq((SELECT count(*)::text FROM topshot_insider_alerts WHERE alert_type='early_buyer' AND evidence_jsonb->>'edition_id'='00000000-0000-0000-0000-000000000e10'), '0', 'E10 old edition (burst within 48h of its OLD first sale) → new-edition guard blocks it');

SELECT '✓ detect_new_edition_early_buyers invariants pass' AS result;
ROLLBACK;
