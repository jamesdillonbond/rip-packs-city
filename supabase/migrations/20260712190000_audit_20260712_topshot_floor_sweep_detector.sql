-- Top Shot floor-sweep detector (2026-07-12) — bulk-buy / Quick Buy intelligence.
--
-- Reverse-engineering Top Shot's bulk-purchase UI (see
-- docs/research/topshot-bulk-purchasing-reverse-engineering-2026-07-12.md) showed
-- it is NOT an atomic multi-buy: Dapper's backend fires N independent
-- single-moment purchase transactions back-to-back, each co-signed with
-- proposer = 0xead892083b3e2c6c (the DapperUtilityCoin account) and payer =
-- 0x18eb4ee6b3c026d2. That proposer is the Quick-Buy discriminator and is already
-- captured on sales.proposer_address by the on-chain decode.
--
-- The existing insider detectors group by (edition_id, buyer): detect_concentration_buys
-- catches a whale accumulating MANY COPIES of ONE edition. A floor sweep is the
-- orthogonal pattern — one buyer taking the cheapest listing across MANY DISTINCT
-- editions in a tight burst (e.g. sweeping a set's commons floor). Nothing detected
-- that. This adds detect_topshot_sweeps, sessionizing Quick-Buy purchases per buyer
-- by a time gap and emitting a 'floor_sweep' alert into topshot_insider_alerts (which
-- the InsiderSignals panels render generically by alert_type — zero UI change), plus
-- a per-edition read RPC get_edition_sweep_signal for the accumulation signal on an
-- edition page.
--
-- TS-only for now: the Quick-Buy proposer account is Top Shot-specific; the detector
-- no-ops (alerts_inserted 0) for any other collection slug until the AllDay/UFC
-- Quick-Buy proposer accounts are characterized.
--
-- Revert: DROP FUNCTION detect_topshot_sweeps(text,int,int,int),
--         get_edition_sweep_signal(uuid,int,int,int);
--         and CREATE OR REPLACE run_all_insider_detectors back to the 4-detector body
--         (prior definition in migration history / pg_get_functiondef).

-- ── 1. Platform-wide floor-sweep detector → topshot_insider_alerts ──────────────
CREATE OR REPLACE FUNCTION public.detect_topshot_sweeps(
  p_collection_slug text DEFAULT 'nba_top_shot'::text,
  p_min_moments integer DEFAULT 6,
  p_min_distinct_editions integer DEFAULT 5,
  p_lookback_hours integer DEFAULT 24
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted int := 0;
  v_collection_id uuid;
  v_gap_minutes int := 20;              -- new session after a >20-min gap between buys
  v_duc_proposer text := '0xead892083b3e2c6c';  -- Dapper DUC = Quick-Buy path
BEGIN
  -- Quick-Buy proposer account is Top Shot-specific; no-op elsewhere.
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
    WHERE a.moments >= p_min_moments
      AND a.distinct_editions >= p_min_distinct_editions
      -- not already emitted for this exact sweep (keyed on the session's last_buy)
      AND NOT EXISTS (
        SELECT 1 FROM topshot_insider_alerts al
        WHERE al.alert_type = 'floor_sweep'
          AND al.evidence_jsonb->>'buyer_address' = a.buyer_address
          AND al.evidence_jsonb->>'last_buy' = a.last_buy::text
          AND al.generated_at > NOW() - INTERVAL '48 hours'
      )
  ),
  ranked AS (
    SELECT q.*,
      (CASE WHEN q.moments >= 25 THEN 3 WHEN q.moments >= 12 THEN 2 ELSE 1 END)::smallint AS sev,
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
    NOW(), NOW() + INTERVAL '48 hours'
  FROM ranked
  LEFT JOIN wallet_usernames wu ON wu.wallet_addr = ranked.buyer_address
  WHERE ranked.rn = 1;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN json_build_object('collection', p_collection_slug, 'alerts_inserted', v_inserted);
END;
$function$;

-- ── 2. Per-edition sweep / accumulation signal (read-only, for edition pages) ───
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
    FROM sales s
    WHERE s.edition_id = p_edition_id
      AND s.proposer_address = v_duc_proposer
      AND s.sold_at > NOW() - make_interval(days => p_days)
      AND s.buyer_address IS NOT NULL
      AND s.buyer_address NOT IN ('0x3cdbb3d569211ff3', '0xedf9df96c92f4595', '0xc1e4f4f4c4257510')
  ),
  tagged AS (
    SELECT es.*,
      (
        SELECT COUNT(*) FROM sales s2
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

-- ── 3. Wire the sweep detector into the hourly run_all_insider_detectors fan-out ─
CREATE OR REPLACE FUNCTION public.run_all_insider_detectors(
  p_collection_slugs text[] DEFAULT ARRAY['nba_top_shot'::text, 'nfl_all_day'::text]
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_results jsonb := '{}'::jsonb;
  v_slug text;
  v_volume json;
  v_drop json;
  v_concentration json;
  v_early_buyer json;
  v_sweep json;
BEGIN
  FOREACH v_slug IN ARRAY p_collection_slugs
  LOOP
    SELECT public.detect_unusual_edition_volume(v_slug) INTO v_volume;
    SELECT public.detect_floor_drops(v_slug) INTO v_drop;
    SELECT public.detect_concentration_buys(v_slug) INTO v_concentration;
    SELECT public.detect_new_edition_early_buyers(v_slug) INTO v_early_buyer;
    SELECT public.detect_topshot_sweeps(v_slug) INTO v_sweep;

    v_results := jsonb_set(
      v_results, ARRAY[v_slug],
      jsonb_build_object(
        'unusual_volume', v_volume::jsonb,
        'floor_drops', v_drop::jsonb,
        'concentration_buys', v_concentration::jsonb,
        'early_buyers', v_early_buyer::jsonb,
        'floor_sweeps', v_sweep::jsonb
      )
    );
  END LOOP;

  RETURN v_results;
END;
$function$;

-- ── 4. Grants — service_role only (called from server routes / cron), anon-revoked
REVOKE ALL ON FUNCTION public.detect_topshot_sweeps(text,integer,integer,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_edition_sweep_signal(uuid,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.detect_topshot_sweeps(text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_edition_sweep_signal(uuid,integer,integer,integer) TO service_role;
