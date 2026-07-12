-- Make Top Shot set "cost to complete" reflect the actual current FLOOR ask, not
-- FMV. The /api/sets route mapped each missing play's fmvUsd into a field named
-- lowestAsk, so the Sets page's "Cost to Complete" was really summed FMV (theoretical
-- value) — not what you'd pay to Quick-Buy the missing pieces right now. On "The Gift"
-- that's $9.29 FMV vs $12.17 real floor; the two genuinely differ.
--
-- Add the real floor (min non-zero badge_editions.low_ask per edition) to both set
-- RPCs, expose it as `lowAsk` alongside `fmvUsd`, and base cost-to-complete on
-- COALESCE(low_ask, fmv_usd) — real floor where a listing exists, FMV estimate where
-- none does. Output stays a superset of the old shape (adds `lowAsk`), so the route +
-- client keep working; the route now reads the real floor.
--
-- Revert: CREATE OR REPLACE both back to the fmv_usd-only bodies (20260704000500 for
-- get_topshot_set_detail; prior get_topshot_set_progress def in migration history).

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
  SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask
  FROM badge_editions be WHERE be.collection_id = p_collection_id
  GROUP BY be.external_id
),
universe AS (
  SELECT mv.play_id_onchain, mv.edition_id, mv.player_name, mv.tier, mv.thumbnail_url, mv.fmv_usd,
         f.low_ask
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
      'topshotUrl', 'https://nbatopshot.com/search?query=' || COALESCE(u.player_name, ''))
      ORDER BY COALESCE(u.low_ask, u.fmv_usd) ASC NULLS LAST, u.player_name)
    FROM universe u
    WHERE u.play_id_onchain NOT IN (SELECT play_id_onchain FROM best_owned)
  ), '[]'::jsonb)
)
FROM sets s WHERE s.id = p_set_id AND s.collection_id = p_collection_id;
$function$;

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
  SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask
  FROM badge_editions be WHERE be.collection_id = p_collection_id
  GROUP BY be.external_id
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
