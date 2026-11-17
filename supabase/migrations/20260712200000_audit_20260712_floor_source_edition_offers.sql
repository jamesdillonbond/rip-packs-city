-- Widen the ask-floor source from badge_editions.low_ask (6,212 TS editions, ~33%)
-- to COALESCE(edition_offers.low_ask, badge_editions.low_ask) (10,122, ~53%) across
-- the four floor-consuming read RPCs. Investigation (Trevor-requested) found
-- edition_offers is the same current-ask value on 100% of the overlap sample, but
-- with 63% more coverage, refreshed <48h for 10,000 rows, and it carries
-- low_ask_nft_id (the cheapest listing's moment id → a DIRECT floor-listing deep
-- link instead of a name search). Only 7 editions are in badge_editions but not
-- edition_offers, so the COALESCE loses nothing. Pure read-side source swap — no
-- ingest / pricing write path touched (edition_offers is populated by the existing
-- offers-sweep; we only READ it).
--
-- Also: get_topshot_set_detail missing pieces now deep-link to the actual cheapest
-- listing (nbatopshot.com/listings/moment/<nft_id>) when known, else the name search.
--
-- Revert: CREATE OR REPLACE the four fns back to their badge_editions-only floor
-- CTEs (migrations 20260712195000 / 196000 / 192000).

-- ── get_topshot_set_detail ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_topshot_set_detail(p_wallet text, p_set_id uuid, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH target AS (
  SELECT set_id_onchain FROM sets WHERE id = p_set_id AND collection_id = p_collection_id
),
owned_raw AS MATERIALIZED (
  SELECT e.play_id_onchain, e.player_name, e.tier::text AS tier, e.thumbnail_url, wmc.moment_id, wmc.serial_number
  FROM wallet_moments_cache wmc
  JOIN editions e ON e.external_id = wmc.edition_key
  WHERE lower(wmc.wallet_address) = lower(p_wallet) AND wmc.collection_id = p_collection_id
    AND e.set_id_onchain = (SELECT set_id_onchain FROM target) AND e.play_id_onchain IS NOT NULL
),
best_owned AS (
  SELECT DISTINCT ON (play_id_onchain) play_id_onchain, moment_id, serial_number, player_name, tier, thumbnail_url
  FROM owned_raw ORDER BY play_id_onchain, COALESCE(serial_number, 99999) ASC
),
floor AS (
  SELECT external_id,
         MIN(low_ask) AS low_ask,
         (ARRAY_AGG(nft_id ORDER BY src, low_ask))[1] AS low_ask_nft_id
  FROM (
    SELECT external_id, low_ask, low_ask_nft_id::text AS nft_id, 0 AS src
      FROM edition_offers WHERE collection_id = p_collection_id AND low_ask > 0
    UNION ALL
    SELECT external_id, MIN(NULLIF(low_ask, 0)) AS low_ask, NULL::text AS nft_id, 1 AS src
      FROM badge_editions WHERE collection_id = p_collection_id AND low_ask > 0 GROUP BY external_id
  ) s GROUP BY external_id
),
universe AS (
  SELECT mv.play_id_onchain, mv.edition_id, mv.external_id, mv.player_name, mv.tier, mv.thumbnail_url, mv.fmv_usd,
         f.low_ask, f.low_ask_nft_id
  FROM mv_topshot_set_play_catalog mv
  LEFT JOIN floor f ON f.external_id = mv.external_id
  WHERE mv.set_id = p_set_id
)
SELECT jsonb_build_object(
  'setId', s.id, 'setName', s.name, 'series', s.series, 'setTier', s.tier, 'wallet', p_wallet,
  'totalPlays', (SELECT COUNT(*) FROM universe), 'ownedPlays', (SELECT COUNT(*) FROM best_owned),
  'owned', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('playId', bo.play_id_onchain, 'playerName', bo.player_name, 'tier', bo.tier,
      'serialNumber', bo.serial_number, 'thumbnailUrl', bo.thumbnail_url,
      'topshotUrl', 'https://nbatopshot.com/listings/moment/' || bo.moment_id) ORDER BY bo.player_name) FROM best_owned bo
  ), '[]'::jsonb),
  'missing', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('playId', u.play_id_onchain, 'playerName', u.player_name, 'tier', u.tier,
      'fmvUsd', u.fmv_usd, 'lowAsk', u.low_ask, 'thumbnailUrl', u.thumbnail_url,
      'topshotUrl', CASE WHEN u.low_ask_nft_id IS NOT NULL
                         THEN 'https://nbatopshot.com/listings/moment/' || u.low_ask_nft_id
                         ELSE 'https://nbatopshot.com/search?query=' || COALESCE(u.player_name, '') END)
      ORDER BY COALESCE(u.low_ask, u.fmv_usd) ASC NULLS LAST, u.player_name)
    FROM universe u
    WHERE u.play_id_onchain NOT IN (SELECT play_id_onchain FROM best_owned)
  ), '[]'::jsonb)
)
FROM sets s WHERE s.id = p_set_id AND s.collection_id = p_collection_id;
$function$;

-- ── get_topshot_set_progress ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_topshot_set_progress(p_wallet text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
WITH owned AS MATERIALIZED (
  SELECT DISTINCT e.set_id_onchain, e.play_id_onchain
  FROM wallet_moments_cache wmc
  JOIN editions e ON e.external_id = wmc.edition_key
  WHERE lower(wmc.wallet_address) = lower(p_wallet)
    AND wmc.collection_id = p_collection_id
    AND e.play_id_onchain IS NOT NULL
    AND e.set_id_onchain IS NOT NULL
),
floor AS (
  SELECT external_id, MIN(low_ask) AS low_ask
  FROM (
    SELECT external_id, low_ask FROM edition_offers WHERE collection_id = p_collection_id AND low_ask > 0
    UNION ALL
    SELECT external_id, MIN(NULLIF(low_ask, 0)) FROM badge_editions WHERE collection_id = p_collection_id AND low_ask > 0 GROUP BY external_id
  ) s GROUP BY external_id
),
set_stats AS (
  SELECT
    c.set_id, c.set_id_onchain, c.set_name, c.series, c.set_tier,
    COUNT(DISTINCT c.play_id_onchain)  AS total_plays,
    COUNT(DISTINCT o.play_id_onchain)  AS owned_plays,
    COALESCE(SUM(CASE WHEN o.play_id_onchain IS NULL THEN COALESCE(f.low_ask, c.fmv_usd) ELSE 0 END), 0)::numeric(12,2) AS estimated_cost_to_complete
  FROM mv_topshot_set_play_catalog c
  LEFT JOIN owned o ON o.set_id_onchain = c.set_id_onchain AND o.play_id_onchain = c.play_id_onchain
  LEFT JOIN floor f ON f.external_id = c.external_id
  GROUP BY c.set_id, c.set_id_onchain, c.set_name, c.series, c.set_tier
),
missing_ranked AS (
  SELECT c.set_id_onchain, c.play_id_onchain, c.player_name, c.tier, c.thumbnail_url, c.fmv_usd, f.low_ask,
    ROW_NUMBER() OVER (PARTITION BY c.set_id_onchain ORDER BY COALESCE(f.low_ask, c.fmv_usd) ASC NULLS LAST, c.player_name) AS rk
  FROM mv_topshot_set_play_catalog c
  LEFT JOIN owned o ON o.set_id_onchain = c.set_id_onchain AND o.play_id_onchain = c.play_id_onchain
  LEFT JOIN floor f ON f.external_id = c.external_id
  WHERE o.play_id_onchain IS NULL
),
missing_preview AS (
  SELECT set_id_onchain,
    jsonb_agg(jsonb_build_object(
      'playId', play_id_onchain, 'playerName', player_name, 'tier', tier,
      'fmvUsd', fmv_usd, 'lowAsk', low_ask, 'thumbnailUrl', thumbnail_url,
      'topshotUrl', 'https://nbatopshot.com/search?query=' || COALESCE(player_name, '')
    ) ORDER BY rk) AS missing_json
  FROM missing_ranked WHERE rk <= 5 GROUP BY set_id_onchain
)
SELECT jsonb_build_object(
  'wallet', p_wallet,
  'totalSets',      COUNT(*),
  'completeSets',   COUNT(*) FILTER (WHERE ss.owned_plays = ss.total_plays),
  'inProgressSets', COUNT(*) FILTER (WHERE ss.owned_plays > 0 AND ss.owned_plays < ss.total_plays),
  'notStartedSets', COUNT(*) FILTER (WHERE ss.owned_plays = 0),
  'generatedAt', now(),
  'sets', jsonb_agg(jsonb_build_object(
    'setId', ss.set_id, 'setName', ss.set_name, 'series', ss.series, 'setTier', ss.set_tier,
    'totalPlays', ss.total_plays, 'ownedPlays', ss.owned_plays,
    'missingPlays', ss.total_plays - ss.owned_plays,
    'completionPct', ROUND(100.0 * ss.owned_plays::numeric / NULLIF(ss.total_plays, 0), 1),
    'estimatedCostToComplete', ss.estimated_cost_to_complete,
    'missingPreview', COALESCE(mp.missing_json, '[]'::jsonb)
  ) ORDER BY
    CASE WHEN ss.owned_plays = ss.total_plays THEN 0
         WHEN ss.owned_plays > 0 THEN 1 ELSE 2 END,
    ss.owned_plays::numeric / NULLIF(ss.total_plays, 0) DESC NULLS LAST,
    ss.set_name)
)
FROM set_stats ss
LEFT JOIN missing_preview mp ON mp.set_id_onchain = ss.set_id_onchain;
$function$;

-- ── get_topshot_set_completion_plan ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_topshot_set_completion_plan(
  p_wallet text,
  p_set_id uuid,
  p_limit integer DEFAULT 400
)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_wallet text := lower(COALESCE(p_wallet, ''));
  v_result json;
BEGIN
  WITH floor AS (
    SELECT external_id, MIN(low_ask) AS low_ask
    FROM (
      SELECT external_id, low_ask FROM edition_offers WHERE collection_id = v_ts AND low_ask > 0
      UNION ALL
      SELECT external_id, MIN(NULLIF(low_ask, 0)) FROM badge_editions WHERE collection_id = v_ts AND low_ask > 0 GROUP BY external_id
    ) s GROUP BY external_id
  ),
  owned AS (
    SELECT DISTINCT wmc.edition_key
    FROM wallet_moments_cache wmc
    WHERE wmc.wallet_address = v_wallet AND wmc.collection_id = v_ts
  ),
  universe AS (
    SELECT
      mv.external_id, mv.play_id_onchain, mv.player_name, mv.tier,
      mv.thumbnail_url, mv.fmv_usd, f.low_ask,
      (o.edition_key IS NOT NULL) AS is_owned
    FROM mv_topshot_set_play_catalog mv
    LEFT JOIN floor f ON f.external_id = mv.external_id
    LEFT JOIN owned o ON o.edition_key = mv.external_id
    WHERE mv.set_id = p_set_id
  ),
  missing AS (
    SELECT * FROM universe WHERE NOT is_owned
  ),
  meta AS (
    SELECT set_name, series, set_tier, set_id_onchain
    FROM mv_topshot_set_play_catalog WHERE set_id = p_set_id LIMIT 1
  )
  SELECT json_build_object(
    'set_id', p_set_id,
    'set_name', (SELECT set_name FROM meta),
    'series', (SELECT series FROM meta),
    'set_tier', (SELECT set_tier FROM meta),
    'set_id_onchain', (SELECT set_id_onchain FROM meta),
    'wallet', v_wallet,
    'total_plays', (SELECT COUNT(*) FROM universe),
    'owned_plays', (SELECT COUNT(*) FROM universe WHERE is_owned),
    'missing_plays', (SELECT COUNT(*) FROM missing),
    'missing_with_listing', (SELECT COUNT(*) FROM missing WHERE low_ask IS NOT NULL AND low_ask > 0),
    'total_floor_cost', (SELECT COALESCE(ROUND(SUM(low_ask), 2), 0) FROM missing WHERE low_ask IS NOT NULL AND low_ask > 0),
    'total_fmv_missing', (SELECT COALESCE(ROUND(SUM(fmv_usd), 2), 0) FROM missing WHERE fmv_usd IS NOT NULL),
    'cheapest_missing', (SELECT ROUND(MIN(low_ask), 2) FROM missing WHERE low_ask IS NOT NULL AND low_ask > 0),
    'missing', COALESCE((
      SELECT json_agg(m) FROM (
        SELECT
          external_id, play_id_onchain, player_name, tier, thumbnail_url,
          ROUND(fmv_usd, 2) AS fmv_usd,
          ROUND(low_ask, 2) AS low_ask,
          (low_ask IS NOT NULL AND low_ask > 0) AS has_listing
        FROM missing
        ORDER BY (low_ask IS NULL OR low_ask <= 0), low_ask ASC NULLS LAST, fmv_usd DESC NULLS LAST
        LIMIT p_limit
      ) m
    ), '[]'::json)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ── get_topshot_hot_floors ───────────────────────────────────────────────────
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
    FROM sales s
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
