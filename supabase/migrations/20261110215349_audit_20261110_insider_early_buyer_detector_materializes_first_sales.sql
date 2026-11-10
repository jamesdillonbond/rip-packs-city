-- audit_20261110_insider_early_buyer_detector_materializes_first_sales
--
-- WHY. /api/cron/run-insider-detectors logged "nfl_all_day: upstream request timeout" on 5 of 48 runs (11-08 ->
-- 11-10; those runs took 140-222 s against the ~120 s PostgREST gateway cap). Timed per detector at 1:51 PM PT
-- inside a rolled-back transaction: unusual_volume 0.03 s, floor_drops 0.27 s, concentration_buys 0.01 s,
-- detect_new_edition_early_buyers > 55 s (statement timeout). Its `edition_first_sale` CTE was inlined, so the
-- per-edition min(sold_at) became a SubPlan evaluated inside the early_buys join filter and the planner drove the
-- 2020/2021 partitions through their buyer_address index (every non-null buyer) for each edition.
--
-- WHAT. One token: `edition_first_sale AS MATERIALIZED (`. A CTE fence changes the plan, never the rows. Same query
-- with the fence, All Day, warm: 2.7 s, 34.6k buffers, 19 first-sale editions. Signature, SECURITY DEFINER,
-- search_path, ACL and every other line unchanged. Base = live body (md5 6099abdd14c588085a864c87da522f5c,
-- = 20261004004247's), asserted below.
--
-- anon-exec: unchanged (detect_new_edition_early_buyers) -- CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role).
-- REVERT: re-apply the detect_new_edition_early_buyers block of 20261004004247_audit_20261003_buyer_signals_exclude_buyback_wallets.sql.

DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.detect_new_edition_early_buyers(text,integer,integer)'::regprocedure)
     <> '6099abdd14c588085a864c87da522f5c' THEN
    RAISE EXCEPTION 'detect_new_edition_early_buyers live body drifted from the 20261004004247 base; re-read before replacing';
  END IF;
END $$;

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
    FROM public.sales_market
    WHERE collection_id = v_collection_id AND edition_id IS NOT NULL
      AND sold_at > NOW() - INTERVAL '7 days'
  ),
  -- 2026-11-10: MATERIALIZED. Inlined, the per-edition min() became a SubPlan re-run inside the join filter and the
  -- planner walked sales_2020/2021's whole buyer_address index per edition: > 55 s on All Day, the
  -- run_all_insider_detectors('nfl_all_day') call past the ~120 s gateway cap on 5 of 48 runs. Fenced: 2.7 s.
  edition_first_sale AS MATERIALIZED (
    -- first-ever sale < 7d old == has a recent sale AND no older sale.
    -- Avoids the full-history GROUP BY (parity-verified 2026-07-16).
    SELECT r.edition_id,
           (SELECT min(s2.sold_at) FROM public.sales_market s2
             WHERE s2.edition_id = r.edition_id AND s2.collection_id = v_collection_id) AS first_sale_at
    FROM _efs_recent r
    WHERE NOT EXISTS (
      SELECT 1 FROM public.sales_market s3
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
    FROM public.sales_market s
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
