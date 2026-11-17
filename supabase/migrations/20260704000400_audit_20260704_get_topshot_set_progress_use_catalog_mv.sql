-- Bug 6 (perf): rewrite get_topshot_set_progress to read the wallet-independent
-- scaffold from mv_topshot_set_play_catalog and compute only the wallet's `owned`
-- set live (fast via idx_wmc_lower_wallet_coll_edkey; MATERIALIZED so it runs once).
-- Output jsonb byte-identical to the prior definition. 25s fn statement_timeout so a
-- pathological wallet fails cleanly under the route's 30s cap. No set/FMV math changed.
-- Measured 114,700ms -> 143ms warm.
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
set_stats AS (
  SELECT
    c.set_id, c.set_id_onchain, c.set_name, c.series, c.set_tier,
    COUNT(DISTINCT c.play_id_onchain)  AS total_plays,
    COUNT(DISTINCT o.play_id_onchain)  AS owned_plays,
    COALESCE(SUM(CASE WHEN o.play_id_onchain IS NULL THEN c.fmv_usd ELSE 0 END), 0)::numeric(12,2) AS estimated_cost_to_complete
  FROM mv_topshot_set_play_catalog c
  LEFT JOIN owned o ON o.set_id_onchain = c.set_id_onchain AND o.play_id_onchain = c.play_id_onchain
  GROUP BY c.set_id, c.set_id_onchain, c.set_name, c.series, c.set_tier
),
missing_ranked AS (
  SELECT c.set_id_onchain, c.play_id_onchain, c.player_name, c.tier, c.thumbnail_url, c.fmv_usd,
    ROW_NUMBER() OVER (PARTITION BY c.set_id_onchain ORDER BY c.fmv_usd ASC NULLS LAST, c.player_name) AS rk
  FROM mv_topshot_set_play_catalog c
  LEFT JOIN owned o ON o.set_id_onchain = c.set_id_onchain AND o.play_id_onchain = c.play_id_onchain
  WHERE o.play_id_onchain IS NULL
),
missing_preview AS (
  SELECT set_id_onchain,
    jsonb_agg(jsonb_build_object(
      'playId', play_id_onchain, 'playerName', player_name, 'tier', tier,
      'fmvUsd', fmv_usd, 'thumbnailUrl', thumbnail_url,
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
