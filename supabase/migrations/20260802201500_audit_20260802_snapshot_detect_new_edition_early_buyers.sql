-- Snapshot migration: public.detect_new_edition_early_buyers(text, integer, integer).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- An insider-signal detector: flags a buyer who grabbed >= p_min_copies of a
-- NEWLY-launched edition (first-ever sale < 7d ago) within p_window_hours of its
-- first sale. Guards against a false signal: the edition must be new (no sale
-- older than 7d); only buys inside the launch window count; known contract
-- addresses are excluded; a tier-scaled spend floor applies; and a 24h dedup on
-- (edition, buyer). Severity bands on early copies.
--
-- Pinned by supabase/tests/detect_new_edition_early_buyers.sql.

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
