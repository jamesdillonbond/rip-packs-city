-- Item E (2026-07-06 handoff): resolve wallet addresses to usernames in the
-- insider-signal summaries rendered by the overview INSIDER SIGNALS panel
-- (and the analytics surface, which reads the same topshot_insider_alerts.summary).
-- Both concentration_buy and early_buyer summaries baked a bare "Wallet 0x…"
-- string at detection time; the panel renders summary verbatim, so the fix
-- belongs in the detector summary-builders. wallet_usernames (wallet_addr,
-- username) resolves 100% of recent alert wallets; fall back to the abbreviated
-- address when no username exists. Also stamps buyer_username into evidence_jsonb
-- so downstream consumers get the name without a re-join.
--
-- The edge fn topshot-insider-detect-patterns is intentionally NOT changed: its
-- buyback alerts describe Top Shot's own buybacks (set/serial), never a bare
-- user wallet, so there is nothing to resolve there.
--
-- Revert: CREATE OR REPLACE both functions back to the SUBSTRING(...)||'...'
-- summary form with no wallet_usernames join and no buyer_username in evidence
-- (prior definitions in migration history / pg_get_functiondef).

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
  edition_first_sale AS (
    SELECT edition_id, MIN(sold_at) AS first_sale_at
    FROM sales
    WHERE collection_id = v_collection_id AND edition_id IS NOT NULL
    GROUP BY edition_id
    HAVING MIN(sold_at) > NOW() - INTERVAL '7 days'
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
