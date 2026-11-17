-- Bug 6 (perf): get_topshot_set_detail had the same wallet-independent, unscoped
-- edition_fmv DISTINCT-ON over all ~434k TS fmv_snapshots (~18s). Source the set's
-- universe + latest FMV from mv_topshot_set_play_catalog (filtered to p_set_id) and
-- read only the wallet's owned rows (scoped to the set) live. Output jsonb identical.
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
universe AS (
  SELECT play_id_onchain, edition_id, player_name, tier, thumbnail_url, fmv_usd
  FROM mv_topshot_set_play_catalog WHERE set_id = p_set_id
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
      'fmvUsd', u.fmv_usd, 'thumbnailUrl', u.thumbnail_url,
      'topshotUrl', 'https://nbatopshot.com/search?query=' || COALESCE(u.player_name, '')) ORDER BY u.fmv_usd ASC NULLS LAST, u.player_name)
    FROM universe u
    WHERE u.play_id_onchain NOT IN (SELECT play_id_onchain FROM best_owned)
  ), '[]'::jsonb)
)
FROM sets s WHERE s.id = p_set_id AND s.collection_id = p_collection_id;
$function$;
