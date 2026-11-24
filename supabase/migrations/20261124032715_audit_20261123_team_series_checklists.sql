-- 2026-11-23 (Trevor, "Can we build something like this?" + "Do what you think is best"):
-- Top Shot-style TEAM SERIES CHECKLISTS — one row per series, "collect a Moment of every
-- <team> player from a series". Progress counts PLAYERS (any one Moment of the player, for
-- this team, in this series, parallels included), not editions.
--
-- public.get_team_series_checklists(p_collection_id, p_team_slug, p_wallet) -> jsonb
--   { wallet_cached, series: [ { series_num, players_total, players_owned, to_go,
--       cost_to_go_usd, unlisted, complete, players: [ { player_key, player_name, owned,
--       owned_count, cheapest_ask_usd, cheapest_route_slug, cheapest_name, thumbnail_url,
--       edition_count } ] } ] }
--
-- Rules (each one measured or inherited, not new):
--   * Roster = distinct PERSON (player_id; the lowercased name only when player_id is NULL)
--     with an edition whose team_name is one of the franchise's labels
--     (team_franchise_slugs, as get_team_checklist) in that series.
--   * TEAM Moments are not players: player_name = team_name rows (player_id NULL — 21 on the
--     Mavericks) are left out. With that rule the Mavericks rosters equal Top Shot's own
--     Team Checklists in all 9 series (9/13/2/14/19/19/20/19/6, read 2026-11-23).
--   * "Cost to go" = for each MISSING player, the cheapest LIVE ask among their editions in
--     the series, using get_team_checklist's ask rule verbatim (All Day live floor ->
--     edition_offers.low_ask -> badge_editions.low_ask, <= 7 d, and only when an FMV exists
--     and ask <= 3x FMV — a-historical-minimum-sale-is-not-a-cost-to-buy). Never the
--     historical floor, never FMV dressed as a price: a missing player with no such ask is
--     counted in `unlisted` and NOT in cost_to_go_usd (never $0).
--   * Pinnacle has no player roster per series -> empty series list (the UI hides itself).
--
-- Read-only, STABLE, SECURITY DEFINER, service_role only (same grants as get_team_checklist).

CREATE OR REPLACE FUNCTION public.get_team_series_checklists(
  p_collection_id uuid,
  p_team_slug     text,
  p_wallet        text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_allday_uuid   CONSTANT uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_team_variants text[];
  v_wallet_cached boolean := false;
  result          jsonb;
BEGIN
  IF p_collection_id = v_pinnacle_uuid THEN
    RETURN jsonb_build_object('wallet_cached', NULL, 'series', '[]'::jsonb);
  END IF;

  SELECT array_agg(DISTINCT team_name) INTO v_team_variants
  FROM editions
  WHERE collection_id = p_collection_id
    AND team_name IS NOT NULL
    AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g')
        = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));
  IF v_team_variants IS NULL THEN
    RETURN jsonb_build_object('wallet_cached', NULL, 'series', '[]'::jsonb);
  END IF;

  IF p_wallet IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM wallet_moments_cache w
      WHERE w.wallet_address = p_wallet AND w.collection_id = p_collection_id
    ) INTO v_wallet_cached;
  END IF;

  WITH owned_keys AS (
    SELECT w.edition_key AS ek, COUNT(*)::int AS cnt
    FROM wallet_moments_cache w
    WHERE p_wallet IS NOT NULL
      AND w.wallet_address = p_wallet
      AND w.collection_id = p_collection_id
    GROUP BY w.edition_key
  ),
  base AS (
    SELECT
      e.series                                             AS series_num,
      COALESCE(e.player_id::text, 'name:' || lower(btrim(e.player_name))) AS player_key,
      btrim(e.player_name)                                 AS player_name,
      COALESCE(e.external_id, e.id::text)                  AS route_slug,
      e.name,
      e.thumbnail_url,
      COALESCE(ok.cnt, 0)                                  AS owned_count,
      ask.live_ask
    FROM editions e
    LEFT JOIN owned_keys ok ON ok.ek = e.external_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    -- get_team_checklist's live-ask rule, verbatim (20261003180606 / 20261010130955).
    LEFT JOIN LATERAL (
      SELECT a.ask AS live_ask
      FROM (
        SELECT afa.floor_ask AS ask, 1 AS pri
        FROM allday_edition_floor_ask afa
        WHERE e.collection_id = v_allday_uuid
          AND afa.edition_id = e.id
        UNION ALL
        SELECT eo.low_ask, 2
        FROM edition_offers eo
        WHERE eo.collection_id = e.collection_id AND eo.external_id = e.external_id
          AND eo.low_ask > 0 AND eo.low_ask_confirmed_at > now() - interval '7 days'
        UNION ALL
        SELECT be.low_ask, 3
        FROM badge_editions be
        WHERE be.collection_id = e.collection_id AND be.external_id = e.external_id
          AND be.low_ask > 0 AND be.updated_at > now() - interval '7 days'
        ORDER BY pri
        LIMIT 1
      ) a
      WHERE fmv.fmv_usd IS NOT NULL AND a.ask <= fmv.fmv_usd * 3
    ) ask ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY (v_team_variants)
      AND e.thumbnail_url IS NOT NULL
      AND e.series IS NOT NULL
      AND e.player_name IS NOT NULL
      AND btrim(e.player_name) <> ''
      -- a TEAM Moment (player_name = the team) is not a player on the roster
      AND NOT (e.player_id IS NULL AND btrim(e.player_name) = ANY (v_team_variants))
  ),
  per_player AS (
    SELECT
      b.series_num,
      b.player_key,
      (array_agg(b.player_name ORDER BY b.owned_count DESC, b.route_slug))[1] AS player_name,
      COUNT(*)::int                                         AS edition_count,
      SUM(b.owned_count)::int                               AS owned_count,
      MIN(b.live_ask)                                       AS cheapest_ask_usd,
      (array_agg(b.route_slug    ORDER BY b.live_ask ASC NULLS LAST, b.route_slug))[1] AS cheapest_route_slug,
      (array_agg(b.name          ORDER BY b.live_ask ASC NULLS LAST, b.route_slug))[1] AS cheapest_name,
      (array_agg(b.thumbnail_url ORDER BY b.live_ask ASC NULLS LAST, b.route_slug))[1] AS thumbnail_url
    FROM base b
    GROUP BY b.series_num, b.player_key
  ),
  per_series AS (
    SELECT
      p.series_num,
      COUNT(*)::int                                                     AS players_total,
      COUNT(*) FILTER (WHERE p.owned_count > 0)::int                    AS players_owned,
      COUNT(*) FILTER (WHERE p.owned_count = 0)::int                    AS to_go,
      COALESCE(SUM(p.cheapest_ask_usd) FILTER (WHERE p.owned_count = 0), 0)::numeric(12,2) AS cost_to_go_usd,
      COUNT(*) FILTER (WHERE p.owned_count = 0 AND p.cheapest_ask_usd IS NULL)::int AS unlisted,
      jsonb_agg(jsonb_build_object(
        'player_key',          p.player_key,
        'player_name',         p.player_name,
        'owned',               CASE WHEN p_wallet IS NULL THEN NULL ELSE p.owned_count > 0 END,
        'owned_count',         p.owned_count,
        'cheapest_ask_usd',    p.cheapest_ask_usd,
        'cheapest_route_slug', p.cheapest_route_slug,
        'cheapest_name',       p.cheapest_name,
        'thumbnail_url',       p.thumbnail_url,
        'edition_count',       p.edition_count
      ) ORDER BY (p.owned_count > 0), p.cheapest_ask_usd ASC NULLS LAST, p.player_name) AS players
    FROM per_player p
    GROUP BY p.series_num
  )
  SELECT jsonb_build_object(
    'wallet_cached', CASE WHEN p_wallet IS NULL THEN NULL ELSE v_wallet_cached END,
    'series', COALESCE(jsonb_agg(jsonb_build_object(
      'series_num',     s.series_num,
      'players_total',  s.players_total,
      'players_owned',  CASE WHEN p_wallet IS NULL THEN NULL ELSE s.players_owned END,
      'to_go',          s.to_go,
      'cost_to_go_usd', s.cost_to_go_usd,
      'unlisted',       s.unlisted,
      'complete',       CASE WHEN p_wallet IS NULL THEN NULL ELSE s.to_go = 0 END,
      'players',        s.players
    ) ORDER BY s.series_num DESC), '[]'::jsonb))
  INTO result
  FROM per_series s;

  RETURN result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_team_series_checklists(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_team_series_checklists(uuid, text, text) TO service_role;

COMMENT ON FUNCTION public.get_team_series_checklists(uuid, text, text) IS
  'Team Series Checklists (2026-11-23): per series, one Moment of every franchise player. Roster excludes team Moments; cost_to_go = cheapest live ask (<=3x FMV, FMV required) per missing player; players with no such ask are `unlisted`, never $0. Migration 20261124032715.';
