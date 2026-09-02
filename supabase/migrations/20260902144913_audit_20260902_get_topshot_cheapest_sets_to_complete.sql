-- WHY: the concierge could price ONE named set to completion
-- (get_topshot_set_completion_plan) but could not answer the question a collector
-- actually asks — "which set is cheapest for me to complete right now?" — because
-- get_set_completion_cost is required: [setName, walletAddress]. Measured in the
-- real transcripts: support_conversations ids 4821/4822 (2026-07-12) asked exactly
-- that, twice, and were told "the set completion tool requires a specific set name"
-- both times. A collector does not know which set is cheapest; that IS the question.
--
-- WHAT: one pass over mv_topshot_set_play_catalog, grouped by set, for the sets the
-- wallet already owns at least one play in and has not finished. Floor semantics are
-- COPIED VERBATIM from get_topshot_set_completion_plan (edition_offers UNION ALL
-- badge_editions, MIN(low_ask) per external_id) so the two tools cannot disagree
-- about what a set costs.
--
-- ⚠ THE TRAP THIS FUNCTION EXISTS TO AVOID: summing only the missing plays that HAVE
-- a listing makes an UNCOMPLETABLE set look CHEAP. A set missing 40 plays with 2
-- listed sums to the price of those 2 and would rank first. So `missing_listed` and
-- `fully_buyable` are returned on every row, the ordering puts fully_buyable sets
-- first, and cost_to_complete_at_floor is explicitly documented as covering
-- missing_listed of missing_plays — never as "the cost to finish" when those differ.
--
-- COST: measured 2026-09-02 on a 365-moment Top Shot wallet — 1,879 buffers, 91 ms,
-- 46 candidate sets out of 265. Sequential over a 9,530-row matview; no new index.
--
-- REVERT: DROP FUNCTION public.get_topshot_cheapest_sets_to_complete(text, integer);
--         (nothing else references it; the concierge tool degrades to "not available")

CREATE OR REPLACE FUNCTION public.get_topshot_cheapest_sets_to_complete(
  p_wallet text,
  p_limit  integer DEFAULT 10
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_ts     uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_wallet text := lower(COALESCE(p_wallet, ''));
  v_limit  integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25);
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
    SELECT mv.set_id, mv.set_name, mv.series, mv.set_tier, mv.fmv_usd, f.low_ask,
           (o.edition_key IS NOT NULL) AS is_owned
    FROM mv_topshot_set_play_catalog mv
    LEFT JOIN floor f ON f.external_id = mv.external_id
    LEFT JOIN owned o ON o.edition_key = mv.external_id
  ),
  per_set AS (
    SELECT
      set_id,
      MAX(set_name) AS set_name,
      MAX(series)   AS series,
      MAX(set_tier) AS set_tier,
      COUNT(*)                                                          AS total_plays,
      COUNT(*) FILTER (WHERE is_owned)                                  AS owned_plays,
      COUNT(*) FILTER (WHERE NOT is_owned)                              AS missing_plays,
      COUNT(*) FILTER (WHERE NOT is_owned AND low_ask > 0)              AS missing_listed,
      ROUND(SUM(low_ask) FILTER (WHERE NOT is_owned AND low_ask > 0)::numeric, 2) AS listed_cost,
      ROUND(SUM(fmv_usd) FILTER (WHERE NOT is_owned)::numeric, 2)       AS missing_fmv
    FROM universe
    GROUP BY set_id
    HAVING COUNT(*) FILTER (WHERE is_owned) > 0
       AND COUNT(*) FILTER (WHERE NOT is_owned) > 0
  )
  SELECT json_build_object(
    'wallet', v_wallet,
    'scope', 'Top Shot sets this wallet already owns at least one play in and has NOT finished. Sets it has never touched are not ranked.',
    'sets_in_progress', (SELECT COUNT(*) FROM per_set),
    'sets', COALESCE((
      SELECT json_agg(r) FROM (
        SELECT
          set_id, set_name, series, set_tier,
          total_plays, owned_plays, missing_plays, missing_listed,
          (missing_listed = missing_plays) AS fully_buyable,
          listed_cost AS cost_to_complete_at_floor_usd,
          missing_fmv AS missing_fmv_usd,
          ROUND(100.0 * owned_plays / NULLIF(total_plays, 0), 1) AS pct_complete
        FROM per_set
        ORDER BY (missing_listed = missing_plays) DESC,
                 listed_cost ASC NULLS LAST
        LIMIT v_limit
      ) r
    ), '[]'::json),
    'reading_note', 'cost_to_complete_at_floor_usd sums the current floor ask of the missing plays THAT ARE LISTED (missing_listed of missing_plays). When fully_buyable is false it is a PARTIAL cost and the set cannot be finished today at any price — say so instead of quoting it as the cost to finish. Compare against missing_fmv_usd: below = finishing is +EV at floor, above = a premium.'
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- Service-role only: the concierge route calls this with the service key, and no
-- public /insights board reads it. Deliberately NOT anon-executable.
REVOKE ALL ON FUNCTION public.get_topshot_cheapest_sets_to_complete(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_cheapest_sets_to_complete(text, integer) TO service_role;

COMMENT ON FUNCTION public.get_topshot_cheapest_sets_to_complete(text, integer) IS
'Ranks the Top Shot sets a wallet is part-way through by cost to finish at the current floor. Companion to get_topshot_set_completion_plan (which prices ONE named set); this one answers "which set is cheapest for me to complete". Floor semantics are copied verbatim from that function so the two cannot disagree. fully_buyable=false means only some missing plays are listed and the cost is partial.';
