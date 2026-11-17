-- 2026-10-26: Panini leg of the concierge's analyze_wallet_holdings (it refused Panini: "Panini has
-- no wallets"). One read over a Panini USERNAME, with the same filters and group-bys the Top Shot
-- breakdown (concierge_wallet_breakdown) offers where Panini has the data: player, set, sport, team.
--
-- Source, never mixed: the collector's public PROFILE as of the last walk (panini_user_holdings, minus
-- cards the marketplace now shows under another owner — the panini_profile_holdings rule) when a walk
-- read the profile; otherwise the cards RPC has SEEN under the name (panini_card_serials.owner). The
-- caller says which. Team comes from panini_edition_team_keys; a card on no team is counted in
-- cards_not_on_a_team, never dropped silently. FMV totals cover priced cards only and say how many;
-- no confidence leaves (concierge rule 3).
--
-- v2 (same day): one sport vocabulary — the profile stores 'WOMENS BASKETBALL', the team map
-- 'Womens Basketball' — shown as WNBA / Basketball / Football / Soccer …; a card whose sport is
-- unknown is counted in cards_sport_unknown on a sport breakdown, never dropped silently. Sport
-- comes from the profile, else the team map, else the card's product (panini_product_rollup).
CREATE OR REPLACE FUNCTION public.panini_holdings_breakdown(
  p_username text,
  p_group_by text DEFAULT NULL,
  p_player text DEFAULT NULL,
  p_set text DEFAULT NULL,
  p_sport text DEFAULT NULL,
  p_franchise_key text DEFAULT NULL,
  p_limit integer DEFAULT 10
)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH u AS (SELECT lower(btrim(p_username)) AS username),
  walk AS (
    SELECT w.last_walk_at, w.last_complete_at, w.profile_state, w.reported_total
    FROM panini_collector_walks w, u WHERE w.username = u.username
  ),
  use_profile AS (
    SELECT EXISTS (SELECT 1 FROM panini_user_holdings h, u WHERE h.username = u.username) AS yes
  ),
  prof AS (
    SELECT coalesce(s.edition_external_id, h.psku) AS ed, h.url_key AS sku,
           coalesce(pe.player_name, h.athlete) AS player_name,
           coalesce(pe.set_name, h.cardset) AS set_name,
           h.sport AS sport, pe.product_set_id
    FROM panini_user_holdings h
    JOIN u ON u.username = h.username
    LEFT JOIN panini_card_serials s ON s.sku = h.url_key
    LEFT JOIN panini_editions pe ON pe.external_id = coalesce(s.edition_external_id, h.psku)
    WHERE (SELECT yes FROM use_profile)
      AND NOT (coalesce(s.owner, '') <> '' AND lower(s.owner) <> u.username AND s.captured_at > h.last_seen_at)
  ),
  seen AS (
    SELECT s.edition_external_id AS ed, s.sku, pe.player_name, pe.set_name, NULL::text AS sport, pe.product_set_id
    FROM panini_card_serials s
    JOIN u ON s.owner <> '' AND lower(s.owner) = u.username
    LEFT JOIN panini_editions pe ON pe.external_id = s.edition_external_id
    WHERE NOT (SELECT yes FROM use_profile)
      AND s.serial_state IS DISTINCT FROM 'BURNT'
  ),
  allc AS (SELECT * FROM prof UNION ALL SELECT * FROM seen),
  product_sport AS (
    SELECT DISTINCT ON (x.set_id) x.set_id, r.sport
    FROM panini_product_rollup r CROSS JOIN LATERAL unnest(r.product_set_ids) AS x(set_id)
    WHERE r.sport IS NOT NULL
    ORDER BY x.set_id, r.sport
  ),
  priced AS (
    SELECT a.ed, a.sku, a.player_name, a.set_name,
           CASE WHEN upper(coalesce(a.sport, tk.sport, pr.sport)) = 'WOMENS BASKETBALL' THEN 'WNBA'
                WHEN upper(coalesce(a.sport, tk.sport, pr.sport)) IN ('WWE', 'NBA', 'NFL', 'MLB', 'NASCAR', 'UFC', 'WNBA') THEN upper(coalesce(a.sport, tk.sport, pr.sport))
                ELSE initcap(lower(coalesce(a.sport, tk.sport, pr.sport))) END AS sport,
           f.fmv_usd, tk.franchise_keys
    FROM allc a
    LEFT JOIN editions e ON e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid AND e.external_id = a.ed
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
    LEFT JOIN panini_edition_team_keys tk ON tk.external_id = a.ed
    LEFT JOIN product_sport pr ON pr.set_id = a.product_set_id
  ),
  slice AS (
    SELECT * FROM priced p
    WHERE (p_player IS NULL OR p.player_name ILIKE '%' || p_player || '%')
      AND (p_set IS NULL OR p.set_name ILIKE '%' || p_set || '%')
      AND (p_sport IS NULL OR p.sport ILIKE btrim(p_sport)
           OR (lower(btrim(p_sport)) IN ('womens basketball', 'women''s basketball') AND p.sport = 'WNBA'))
      AND (p_franchise_key IS NULL OR p.franchise_keys @> ARRAY[p_franchise_key])
  ),
  grp AS (
    SELECT g.key, count(*) AS cards, round(sum(g.fmv_usd) FILTER (WHERE g.fmv_usd > 0), 2) AS fmv_usd,
           count(*) FILTER (WHERE g.fmv_usd > 0) AS fmv_priced_cards
    FROM (
      SELECT CASE lower(p_group_by)
               WHEN 'player' THEN s.player_name
               WHEN 'set' THEN s.set_name
               WHEN 'sport' THEN s.sport
             END AS key, s.fmv_usd
      FROM slice s WHERE lower(p_group_by) IN ('player', 'set', 'sport')
      UNION ALL
      SELECT coalesce(tm.team_name, k.fk) AS key, s.fmv_usd
      FROM slice s
      CROSS JOIN LATERAL unnest(s.franchise_keys) AS k(fk)
      LEFT JOIN teams_master tm ON tm.league || ':' || tm.slug = k.fk
      WHERE lower(p_group_by) = 'team'
    ) g
    WHERE g.key IS NOT NULL
    GROUP BY g.key
  )
  SELECT jsonb_build_object(
    'username', (SELECT username FROM u),
    'source', CASE WHEN (SELECT yes FROM use_profile) THEN 'profile' ELSE 'seen' END,
    'last_walk_at', (SELECT last_walk_at FROM walk),
    'last_complete_at', (SELECT last_complete_at FROM walk),
    'profile_state', (SELECT profile_state FROM walk),
    'reported_total', (SELECT reported_total FROM walk),
    'total_cards', (SELECT count(*) FROM priced),
    'cards', (SELECT count(*) FROM slice),
    'fmv_usd', (SELECT round(sum(fmv_usd), 2) FROM slice WHERE fmv_usd > 0),
    'fmv_priced_cards', (SELECT count(*) FROM slice WHERE fmv_usd > 0),
    'cards_not_on_a_team', CASE WHEN lower(p_group_by) = 'team'
                                THEN (SELECT count(*) FROM slice WHERE coalesce(cardinality(franchise_keys), 0) = 0) END,
    'cards_sport_unknown', CASE WHEN lower(p_group_by) = 'sport'
                                THEN (SELECT count(*) FROM slice WHERE sport IS NULL) END,
    'groups', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('key', key, 'cards', cards, 'fmv_usd', fmv_usd, 'fmv_priced_cards', fmv_priced_cards)
                       ORDER BY cards DESC, fmv_usd DESC NULLS LAST, key)
      FROM (SELECT * FROM grp ORDER BY cards DESC, fmv_usd DESC NULLS LAST, key
            LIMIT LEAST(GREATEST(coalesce(p_limit, 10), 1), 25)) gg
    ), '[]'::jsonb),
    'top_cards', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('player', player_name, 'set', set_name, 'sport', sport, 'fmv_usd', fmv_usd, 'edition_key', ed)
                       ORDER BY fmv_usd DESC NULLS LAST, sku)
      FROM (SELECT * FROM slice WHERE fmv_usd > 0 ORDER BY fmv_usd DESC, sku LIMIT 5) t
    ), '[]'::jsonb)
  )
$function$;

-- anon-exec: revoked — panini_holdings_breakdown is service-role only (the concierge calls it).
REVOKE EXECUTE ON FUNCTION public.panini_holdings_breakdown(text, text, text, text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_holdings_breakdown(text, text, text, text, text, text, integer) TO service_role;
