-- Bulk-buy planner: cost to complete a Top Shot set (2026-07-12).
--
-- Companion to the bulk-purchasing reverse-engineering work
-- (docs/research/topshot-bulk-purchasing-reverse-engineering-2026-07-12.md).
-- In-app bulk EXECUTION is blocked by the Dapper co-signer wall (same as Cart),
-- so the on-brand play is a read-side planner: given a wallet + a TS set, return
-- the editions the wallet is missing with the current floor ask (badge_editions.low_ask,
-- the app's canonical ask source) and FMV per moment, plus set totals — "what would
-- it cost to Quick-Buy the rest of this set at floor, and what's it worth?".
--
-- Universe + FMV come from mv_topshot_set_play_catalog (one row per set play,
-- refreshed every 3h). Ownership is wmc.edition_key = external_id for the wallet.
-- Floor is the min non-zero low_ask across an edition's badge_editions rows
-- (deduped — badge_editions has one row per (external_id, badge)).
--
-- SECDEF, service_role only (called from the server route /api/topshot/set-plan).
-- Revert: DROP FUNCTION get_topshot_set_completion_plan(text,uuid,integer);

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
    SELECT be.external_id, MIN(NULLIF(be.low_ask, 0)) AS low_ask
    FROM badge_editions be
    WHERE be.collection_id = v_ts
    GROUP BY be.external_id
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

REVOKE ALL ON FUNCTION public.get_topshot_set_completion_plan(text,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_topshot_set_completion_plan(text,uuid,integer) TO service_role;
