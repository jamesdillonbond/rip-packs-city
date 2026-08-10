-- deep-audit D3 — the Top Shot Set Tracker could not load for ANY wallet.
--
-- get_topshot_set_progress carries `SET statement_timeout TO '25s'` and was
-- exceeding it for every wallet tested, INCLUDING one holding a single Top Shot
-- moment — so the cost was fixed and catalogue-wide, not wallet-size-dependent.
-- The page then rendered the resulting Postgres error verbatim to end users
-- ("ERROR / canceling statement due to statement timeout"); the API-side leak is
-- fixed separately in lib/api-error.ts.
--
-- Root cause: `lower(wmc.wallet_address) = lower(p_wallet)` is NOT sargable.
-- Wrapping the COLUMN in lower() means no index on wallet_address can serve the
-- predicate, so the planner inverted the join — driving from `editions` (8,579
-- rows matching the NOT NULL conditions) and probing wallet_moments_cache once
-- per edition, applying the wallet as a post-index FILTER against 2.2M rows.
--
--   before: Nested Loop, Parallel Index Scan on editions (8,579 rows), cost 124,243
--   after:  Nested Loop, Index Scan using idx_wmc_wallet_collection,   cost   2,551
--   => 48x cheaper, and it now drives from the wallet as intended.
--
-- Safety: lower() on the column is redundant here. Verified live 2026-08-09 —
-- across all 2,211,030 wmc rows, the ONLY non-lowercase wallet_address values
-- are the 25,375 candy_mlb rows (Solana base58 is case-sensitive by design).
-- Every Flow collection, Top Shot included, is 0. This function is hard-scoped
-- to the Top Shot catalogue (it reads mv_topshot_set_play_catalog), so the two
-- predicates are equivalent on every row it can ever see. lower() is kept on the
-- PARAMETER so a caller passing mixed case still matches.
--
-- Note: migration 20260704000200 was supposed to add a lower(wallet_address)
-- functional index, but that index does NOT exist in prod (repo<->DB drift) —
-- which is why the predicate had nothing to use. Making the predicate sargable
-- is the better fix regardless: it needs no index build on a 2.2M-row hot table,
-- and it avoids adding a third wallet_address index whose extra write cost would
-- work against the HOT-update headroom that was only just recovered.
--
-- Only the WHERE clause changed; every other line is byte-identical to the prior
-- live definition, so output is unchanged. Verified after apply: Trevor's wallet
-- returns 254 sets (102 complete + 90 in progress + 62 not started = 254), and a
-- 1-moment wallet that previously errored now returns.
--
-- Revert: re-apply this function with `lower(wmc.wallet_address) = lower(p_wallet)`.

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
  WHERE wmc.wallet_address = lower(p_wallet)
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
