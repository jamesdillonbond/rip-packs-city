-- Snapshot migration: public.detect_concentration_buys(text, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- An insider-signal detector: emits a 'concentration_buy' alert when one buyer
-- accumulates >= p_min_copies of a single edition in 24h with enough spend for
-- the edition's tier. Guards that stop a fabricated signal: known marketplace/
-- custodian contract addresses are excluded (not real collectors), a tier-scaled
-- minimum spend filters noise, only ONE alert per buyer fires (their highest-
-- signal edition, via ROW_NUMBER rn=1), severity bands on copies, and a 12h
-- dedup suppresses repeats. A regression mislabels ordinary volume as a whale
-- signal or double-alerts a buyer.
--
-- Pinned by supabase/tests/detect_concentration_buys.sql.

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
