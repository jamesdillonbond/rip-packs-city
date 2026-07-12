-- Tune the floor-sweep detector (from migration 20260712190000) so the signals
-- panel surfaces only NOTABLE sweeps, not every 7-common $2 burst. Live 24h data
-- showed the initial gate (>=6 moments / >=5 editions) yielded ~71 sessions;
-- retuned to >=8 distinct editions AND (>=15 moments OR >=$75 spent) → ~22
-- sessions / ~18 buyers/24h, which still catches Trevor's 24-moment sweep.
--
-- Same function signature (text,int,int,int) so the 1-arg call in
-- run_all_insider_detectors stays unambiguous and existing grants hold. Adds an
-- internal $75 dollar floor, a tiered severity, and a 24h expiry (sweeps are a
-- recency signal — shorter shelf life keeps the panel current).
--
-- Revert: CREATE OR REPLACE back to the 20260712190000 body.

CREATE OR REPLACE FUNCTION public.detect_topshot_sweeps(
  p_collection_slug text DEFAULT 'nba_top_shot'::text,
  p_min_moments integer DEFAULT 15,
  p_min_distinct_editions integer DEFAULT 8,
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
  v_gap_minutes int := 20;               -- new session after a >20-min gap
  v_min_spend numeric := 75;             -- OR-gate: a pricey sweep qualifies even if small-count
  v_duc_proposer text := '0xead892083b3e2c6c';  -- Dapper DUC = Quick-Buy path
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
          AND al.evidence_jsonb->>'last_buy' = a.last_buy::text
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
