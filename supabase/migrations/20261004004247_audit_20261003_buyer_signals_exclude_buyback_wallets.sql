-- audit_20261003_buyer_signals_exclude_buyback_wallets
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (get_whale_watch_7d)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (get_top_accumulators)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (detect_topshot_sweeps)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (detect_concentration_buys)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (get_edition_sweep_signal)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (get_topshot_hot_floors)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (detect_new_edition_early_buyers)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (count_insider_detector_candidates)
-- anon-exec: intentional — existing function, ACL unchanged by CREATE OR REPLACE; not anon-executable (verified 2026-10-03) (analytics_sales_leaderboard)
--
-- 2026-10-03 (known-issues #169, follow-on; Trevor: "Keep going"). Eight BUYER-BEHAVIOUR signals — whale
-- watch, top accumulators, the sweep / concentration / new-edition early-buyer detectors, the edition
-- sweep signal, hot floors and the insider-detector candidate count — each hand-maintain a NOT IN list
-- of system wallets (marketplace contracts, placeholders), and NONE of those lists carries Dapper's
-- buy-back wallet 0xe1f2a091f7bb5245 — the CLAUDE.md "hardcoded allowlist beside a registry goes stale
-- silently" shape. It does not surface today only by luck: 0xe1f2 made 29 buys / $247 this week but
-- 4,987 in 90 days — it buys in BURSTS right after drops, which is exactly when a burst of instant
-- sell-backs would read as a whale, a sweep, a concentration buy, unusual volume or an early buyer.
--
-- WHAT. Every FROM/JOIN of `sales` in these eight now reads public.sales_market (20261004002116):
-- sales minus buyers in the buyback_wallets REGISTRY for that collection. Each body is the live one
-- with ONLY those references changed (6 verified against their newest migration, 2 that existed only
-- live — get_whale_watch_7d, get_top_accumulators — captured from pg_get_functiondef and md5-checked
-- against live prosrc). All eight are SECURITY DEFINER owned by postgres, so the service-role-only
-- view is readable inside them; none is anon/authenticated-executable. The hand lists stay (they
-- cover non-buy-back system wallets); the registry now covers buy-backs for all of them.
--
-- analytics_sales_leaderboard gets a BUYER-SIDE-ONLY predicate instead of the swap: its seller side
-- rightly counts sell-back proceeds (real money to the seller). One added line excludes registry
-- buy-back wallets from the BUYER board under the existing p_include_contracts switch — the board
-- already treated one buy-back wallet (0xe4cf…, All Day's issuer) as a "contract".
--
-- APPLIED 2026-10-03 ~5:43 PM PT as version 20261004004247 by an equivalent server-side rewrite (the same
-- substitution / one-line insertion on each live definition), every result md5-checked against the
-- bodies in THIS file (9/9 equal); any mismatch would have aborted.
--
-- REVERT: re-apply each function's previous definition (named next to it below); the two live-only
-- functions' previous text is the same body with `public.sales_market` read back as `sales`.

-- get_whale_watch_7d: 1 sales read(s) repointed. Previous definition: (live only — no prior migration)
CREATE OR REPLACE FUNCTION public.get_whale_watch_7d(p_collection_slug text DEFAULT NULL::text, p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.volume_7d_usd DESC), '[]'::jsonb)
  FROM (
    SELECT 
      s.buyer_address,
      c.slug AS collection,
      COUNT(*) AS purchases_7d,
      ROUND(SUM(s.price_usd)::numeric, 2) AS volume_7d_usd,
      ROUND(AVG(s.price_usd)::numeric, 2) AS avg_purchase_usd,
      COUNT(DISTINCT s.edition_id) AS distinct_editions
    FROM public.sales_market s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.sold_at > NOW() - INTERVAL '7 days'
      AND s.price_usd > 0
      AND s.buyer_address IS NOT NULL
      -- Filter out known marketplace contract addresses
      AND s.buyer_address NOT IN (
        '0x3cdbb3d569211ff3',  -- Flowty NFTStorefrontV2 fork
        '0xedf9df96c92f4595',  -- AllDay buyer placeholder
        '0xc1e4f4f4c4257510'   -- Dapper merchant
      )
      AND (p_collection_slug IS NULL OR c.slug = p_collection_slug)
    GROUP BY s.buyer_address, c.slug
    HAVING COUNT(*) >= 3  -- minimum activity threshold
    ORDER BY volume_7d_usd DESC
    LIMIT p_limit
  ) r;
$function$;

-- get_top_accumulators: 1 sales read(s) repointed. Previous definition: (live only — no prior migration)
CREATE OR REPLACE FUNCTION public.get_top_accumulators(p_collection_slug text DEFAULT 'nba_top_shot'::text, p_days integer DEFAULT 7, p_limit integer DEFAULT 25)
 RETURNS TABLE(rank integer, buyer_address text, buy_count bigint, spend_usd numeric, avg_price_usd numeric, distinct_editions bigint, top_edition_id text, top_edition_buys bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH win AS (
    SELECT s.buyer_address, s.edition_id, s.price_usd
    FROM public.sales_market s
    JOIN collections c ON c.id = s.collection_id
    WHERE s.sold_at > now() - make_interval(days => p_days)
      AND s.buyer_address IS NOT NULL
      AND s.price_usd > 0
      AND (p_collection_slug IS NULL OR c.slug = p_collection_slug)
      AND s.buyer_address NOT IN (
        '0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510',
        '0x0b2a3299cc857e29','0xe4cf4bdc1751c65d','0x87ca73a41bb50ad5',
        '0x4eb8a10cb9f87357','0xb8ea91944fd51c43','0xead892083b3e2c6c',
        '0x18eb4ee6b3c026d2')
  ),
  agg AS (
    SELECT buyer_address,
           COUNT(*)::bigint AS buy_count, ROUND(SUM(price_usd),2) AS spend_usd,
           ROUND(AVG(price_usd),2) AS avg_price_usd,
           COUNT(DISTINCT edition_id)::bigint AS distinct_editions
    FROM win GROUP BY buyer_address
  ),
  sweep AS (
    SELECT DISTINCT ON (buyer_address)
           buyer_address, edition_id AS top_edition_id, COUNT(*)::bigint AS top_edition_buys
    FROM win GROUP BY buyer_address, edition_id
    ORDER BY buyer_address, COUNT(*) DESC
  )
  SELECT ROW_NUMBER() OVER (ORDER BY a.spend_usd DESC, a.buy_count DESC)::int AS rank,
         a.buyer_address, a.buy_count, a.spend_usd, a.avg_price_usd,
         a.distinct_editions, sw.top_edition_id::text, sw.top_edition_buys
  FROM agg a JOIN sweep sw USING (buyer_address)
  ORDER BY a.spend_usd DESC, a.buy_count DESC
  LIMIT p_limit;
$function$;

-- detect_topshot_sweeps: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260925165425_audit_20260925_snapshot_five_spliced_functions_so_their_pins_can_be_repointed.sql
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
    FROM public.sales_market s
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
           to_char(ranked.first_buy AT TIME ZONE 'America/Los_Angeles', 'Mon DD HH12:MI AM') || '–' || to_char(ranked.last_buy AT TIME ZONE 'America/Los_Angeles', 'HH12:MI AM PT'),
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

-- detect_concentration_buys: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260802200500_audit_20260802_snapshot_detect_concentration_buys.sql
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
    FROM public.sales_market s
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

-- get_edition_sweep_signal: 2 sales read(s) repointed. Previous definition: supabase/migrations/20260712190000_audit_20260712_topshot_floor_sweep_detector.sql
CREATE OR REPLACE FUNCTION public.get_edition_sweep_signal(
  p_edition_id uuid,
  p_days integer DEFAULT 14,
  p_min_moments integer DEFAULT 6,
  p_window_minutes integer DEFAULT 20
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_duc_proposer text := '0xead892083b3e2c6c';
  v_result json;
BEGIN
  WITH ed_sales AS (
    SELECT s.buyer_address, s.sold_at, s.price_usd
    FROM public.sales_market s
    WHERE s.edition_id = p_edition_id
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(days => p_days)
      AND s.buyer_address IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
  ),
  tagged AS (
    SELECT es.*,
      (
        SELECT COUNT(*) FROM public.sales_market s2
        WHERE s2.buyer_address = es.buyer_address
          AND s2.collection = 'nba_top_shot'
          AND s2.proposer_address = v_duc_proposer
          AND s2.sold_at BETWEEN es.sold_at - make_interval(mins => p_window_minutes)
                             AND es.sold_at + make_interval(mins => p_window_minutes)
      ) AS session_moments
    FROM ed_sales es
  )
  SELECT json_build_object(
    'edition_id', p_edition_id,
    'window_days', p_days,
    'quick_buy_sales', COUNT(*),
    'swept_sales', COUNT(*) FILTER (WHERE session_moments >= p_min_moments),
    'swept_share', CASE WHEN COUNT(*) > 0
                        THEN ROUND((COUNT(*) FILTER (WHERE session_moments >= p_min_moments))::numeric / COUNT(*), 3)
                        ELSE 0 END,
    'distinct_sweep_buyers', COUNT(DISTINCT buyer_address) FILTER (WHERE session_moments >= p_min_moments),
    'last_swept_at', MAX(sold_at) FILTER (WHERE session_moments >= p_min_moments)
  ) INTO v_result
  FROM tagged;

  RETURN COALESCE(v_result, json_build_object('edition_id', p_edition_id, 'window_days', p_days, 'quick_buy_sales', 0));
END;
$function$;

-- get_topshot_hot_floors: 1 sales read(s) repointed. Previous definition: supabase/migrations/20260712200000_audit_20260712_floor_source_edition_offers.sql
CREATE OR REPLACE FUNCTION public.get_topshot_hot_floors(
  p_days integer DEFAULT 3,
  p_min_session_moments integer DEFAULT 6,
  p_min_session_editions integer DEFAULT 4,
  p_limit integer DEFAULT 40
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_duc_proposer text := '0xead892083b3e2c6c';
  v_gap_minutes int := 20;
  v_result json;
BEGIN
  WITH base AS (
    SELECT s.buyer_address, s.sold_at, s.edition_id, s.price_usd
    FROM public.sales_market s
    WHERE s.collection_id = v_ts
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(days => p_days)
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
  sess_size AS (
    SELECT buyer_address, sess,
      COUNT(*) AS moments, COUNT(DISTINCT edition_id) AS distinct_editions
    FROM sessioned GROUP BY buyer_address, sess
  ),
  swept AS (
    SELECT s.edition_id, s.buyer_address, s.sold_at, s.price_usd
    FROM sessioned s
    JOIN sess_size z ON z.buyer_address = s.buyer_address AND z.sess = s.sess
    WHERE z.moments >= p_min_session_moments AND z.distinct_editions >= p_min_session_editions
  ),
  per_edition AS (
    SELECT edition_id,
      COUNT(*) AS swept_sales,
      COUNT(DISTINCT buyer_address) AS sweep_buyers,
      ROUND(SUM(price_usd), 2) AS swept_spend,
      MAX(sold_at) AS last_swept_at
    FROM swept GROUP BY edition_id
  ),
  floor AS (
    SELECT external_id, MIN(low_ask) AS low_ask
    FROM (
      SELECT external_id, low_ask FROM edition_offers WHERE collection_id = v_ts AND low_ask > 0
      UNION ALL
      SELECT external_id, MIN(NULLIF(low_ask, 0)) FROM badge_editions WHERE collection_id = v_ts AND low_ask > 0 GROUP BY external_id
    ) s GROUP BY external_id
  )
  SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.sweep_buyers DESC, t.swept_sales DESC), '[]'::json)
  INTO v_result
  FROM (
    SELECT
      e.external_id, e.set_id_onchain, e.play_id_onchain,
      e.player_name, e.set_name, e.tier::text AS tier, e.thumbnail_url,
      pe.swept_sales, pe.sweep_buyers, pe.swept_spend, pe.last_swept_at,
      f.low_ask AS floor_ask,
      fs.fmv_usd
    FROM per_edition pe
    JOIN editions e ON e.id = pe.edition_id
    LEFT JOIN floor f ON f.external_id = e.external_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd FROM fmv_snapshots fsx
      WHERE fsx.edition_id = pe.edition_id ORDER BY computed_at DESC LIMIT 1
    ) fs ON true
    ORDER BY pe.sweep_buyers DESC, pe.swept_sales DESC
    LIMIT p_limit
  ) t;

  RETURN json_build_object('window_days', p_days, 'generated_at', NOW(), 'editions', v_result);
END;
$function$;

-- detect_new_edition_early_buyers: 4 sales read(s) repointed. Previous definition: supabase/migrations/20260802201500_audit_20260802_snapshot_detect_new_edition_early_buyers.sql
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
  edition_first_sale AS (
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

-- count_insider_detector_candidates: 5 sales read(s) repointed. Previous definition: supabase/migrations/20260517130000_insider_detector_candidate_count_rpc.sql
CREATE OR REPLACE FUNCTION public.count_insider_detector_candidates(
  p_slug text,
  p_detector text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_collection_id uuid;
  v_count int := 0;
BEGIN
  SELECT id INTO v_collection_id FROM public.collections WHERE slug = p_slug;
  IF v_collection_id IS NULL THEN
    RETURN -1;
  END IF;

  IF p_detector = 'unusual_volume' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'floor_drops' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
      GROUP BY s.edition_id
      HAVING COUNT(*) >= 3
    ) t;
  ELSIF p_detector = 'concentration_buys' THEN
    SELECT COUNT(*) INTO v_count FROM (
      SELECT s.edition_id, s.buyer_address
      FROM public.sales_market s
      WHERE s.collection_id = v_collection_id
        AND s.sold_at > NOW() - INTERVAL '24 hours'
        AND s.edition_id IS NOT NULL
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 5
    ) t;
  ELSIF p_detector = 'early_buyers' THEN
    SELECT COUNT(*) INTO v_count FROM (
      WITH efs AS (
        SELECT s.edition_id, MIN(s.sold_at) AS first_sale_at
        FROM public.sales_market s
        WHERE s.collection_id = v_collection_id AND s.edition_id IS NOT NULL
        GROUP BY s.edition_id
        HAVING MIN(s.sold_at) > NOW() - INTERVAL '7 days'
      )
      SELECT s.edition_id, s.buyer_address
      FROM public.sales_market s
      JOIN efs ON efs.edition_id = s.edition_id
      WHERE s.collection_id = v_collection_id
        AND s.sold_at <= efs.first_sale_at + INTERVAL '48 hours'
        AND s.buyer_address IS NOT NULL
        AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3','0xedf9df96c92f4595','0xc1e4f4f4c4257510')
      GROUP BY s.edition_id, s.buyer_address
      HAVING COUNT(*) >= 3
    ) t;
  ELSE
    RETURN -1;
  END IF;

  RETURN v_count;
END;
$function$;

-- analytics_sales_leaderboard: one buyer-side buy-back predicate added (marked #169). Previous definition: supabase/migrations/20260829234203_audit_20260829_leaderboard_collection_pushdown_and_per_row_returning_probe.sql
CREATE OR REPLACE FUNCTION public.analytics_sales_leaderboard(p_role text, p_start_at timestamptz DEFAULT NULL, p_end_at timestamptz DEFAULT NULL, p_collections text[] DEFAULT NULL, p_limit integer DEFAULT 25, p_min_volume numeric DEFAULT 100, p_include_contracts boolean DEFAULT false)
RETURNS TABLE(rank integer, addr text, sale_count bigint, total_volume_usd numeric, avg_price_usd numeric, is_returning boolean, first_seen_at timestamptz, last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  contract_addrs text[] := ARRAY[
    '0x3cdbb3d569211ff3',  -- NFTStorefrontV2 (Flowty fork)
    '0x4eb8a10cb9f87357',  -- NFTStorefrontV2 (Dapper)
    '0xb8ea91944fd51c43',  -- DapperOffersV2
    '0xc1e4f4f4c4257510',  -- Dapper merchant
    '0xead892083b3e2c6c',  -- DUC vault
    '0xedf9df96c92f4595',  -- Pinnacle contract
    '0x5c57f79c6694797f',  -- Flowty lending contract
    '0x0b2a3299cc857e29',  -- Top Shot contract
    '0xe4cf4bdc1751c65d',  -- AllDay contract
    '0x87ca73a41bb50ad5'   -- Golazos contract
  ];
  -- analytics_sales floors its sales leg at 2025-01-01 and carries no floor on pinnacle_sales. Preserved verbatim.
  sales_floor constant timestamptz := '2025-01-01 00:00:00+00';
  v_long text[];
  v_pinnacle boolean;
  v_start timestamptz;
BEGIN
  IF p_role NOT IN ('buyer', 'seller') THEN
    RAISE EXCEPTION 'p_role must be ''buyer'' or ''seller''';
  END IF;

  -- Push the collection filter down to sales.collection (long-form; covered by idx_sales_2026_pulse_window) instead
  -- of the CASE-mapped analytics_sales.collection, which can never be an Index Cond. Short-form names map back to
  -- long-form; 'pinnacle' selects the pinnacle_sales leg; anything else passes through unmapped like the view's ELSE.
  IF p_collections IS NULL THEN
    v_long := NULL; v_pinnacle := true;
  ELSE
    v_long := ARRAY(SELECT CASE x WHEN 'topshot' THEN 'nba_top_shot' WHEN 'allday' THEN 'nfl_all_day'
                                  WHEN 'golazos' THEN 'laliga_golazos' WHEN 'ufc' THEN 'ufc_strike' ELSE x END
                    FROM unnest(p_collections) AS x);
    v_pinnacle := ('pinnacle' = ANY(p_collections));
  END IF;
  v_start := GREATEST(COALESCE(p_start_at, sales_floor), sales_floor);

  RETURN QUERY
  WITH window_sales AS (
    SELECT (CASE WHEN p_role = 'buyer' THEN s.buyer_address ELSE s.seller_address END)::text AS w_addr,
           s.price_usd, s.sold_at
    FROM sales s
    WHERE s.sold_at >= v_start
      AND (p_end_at IS NULL OR s.sold_at < p_end_at)
      AND (v_long IS NULL OR s.collection = ANY(v_long))
      AND (CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END) IS NOT NULL
      AND (p_include_contracts OR NOT ((CASE WHEN p_role='buyer' THEN s.buyer_address ELSE s.seller_address END)::text = ANY(contract_addrs)))
      AND (p_include_contracts OR p_role <> 'buyer' OR NOT EXISTS (SELECT 1 FROM public.buyback_wallets b WHERE b.collection_id = s.collection_id AND b.wallet_address = s.buyer_address))  -- #169: an issuer buy-back is not a buyer; a seller's sell-back proceeds still count
    UNION ALL
    SELECT (CASE WHEN p_role = 'buyer' THEN ps.buyer_address ELSE ps.seller_address END)::text,
           ps.sale_price_usd, ps.sold_at
    FROM pinnacle_sales ps
    WHERE v_pinnacle
      AND (p_start_at IS NULL OR ps.sold_at >= p_start_at)
      AND (p_end_at IS NULL OR ps.sold_at < p_end_at)
      AND (CASE WHEN p_role='buyer' THEN ps.buyer_address ELSE ps.seller_address END) IS NOT NULL
      AND (p_include_contracts OR NOT ((CASE WHEN p_role='buyer' THEN ps.buyer_address ELSE ps.seller_address END)::text = ANY(contract_addrs)))
  ),
  agg AS (
    SELECT w_addr,
           COUNT(*)::bigint                                AS w_sale_count,
           COALESCE(ROUND(SUM(price_usd)::numeric, 2), 0)  AS w_volume_usd,
           COALESCE(ROUND(AVG(price_usd)::numeric, 2), 0)  AS w_avg_price,
           MIN(sold_at)                                    AS w_first_seen,
           MAX(sold_at)                                    AS w_last_seen
    FROM window_sales
    GROUP BY w_addr
    HAVING COALESCE(SUM(price_usd), 0) >= p_min_volume
  ),
  top AS (
    SELECT a.* FROM agg a ORDER BY a.w_volume_usd DESC, a.w_sale_count DESC LIMIT p_limit
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY t.w_volume_usd DESC, t.w_sale_count DESC)::int AS rank,
    t.w_addr, t.w_sale_count, t.w_volume_usd, t.w_avg_price,
    -- is_returning: <= p_limit index probes on the address indexes, instead of a DISTINCT over every prior sale.
    (p_start_at IS NOT NULL AND (
       (p_role = 'buyer'  AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.buyer_address  = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (p_role = 'seller' AND EXISTS (SELECT 1 FROM sales s2 WHERE s2.seller_address = t.w_addr AND s2.sold_at >= sales_floor AND s2.sold_at < p_start_at AND (v_long IS NULL OR s2.collection = ANY(v_long))))
       OR (v_pinnacle AND p_role = 'buyer'  AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.buyer_address  = t.w_addr AND p2.sold_at < p_start_at))
       OR (v_pinnacle AND p_role = 'seller' AND EXISTS (SELECT 1 FROM pinnacle_sales p2 WHERE p2.seller_address = t.w_addr AND p2.sold_at < p_start_at))
    )) AS is_returning,
    t.w_first_seen AS first_seen_at,
    t.w_last_seen  AS last_seen_at
  FROM top t
  ORDER BY t.w_volume_usd DESC, t.w_sale_count DESC;
END;
$function$;
