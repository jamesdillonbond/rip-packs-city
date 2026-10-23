-- Franchise hubs gain Panini cards; search team rows resolve to their hub
-- (2026-10-22, Trevor: "general player, team, etc pages that are agnostic …
-- Do it all"). Follows 20261023053026 (player hubs).
--
-- WHY. /teams/nba/blazers showed Top Shot alone: Panini's editions carry NO
-- team (editions.team_name NULL on every Panini row), so get_team_detail has
-- nothing to match and league_collections never mapped Panini. The team walk
-- (panini_team_listings, filled by /api/cron/panini-team-walk) records, per
-- card, the franchise Panini's own marketplace team filter lists it under —
-- `franchise_keys` = '<LEAGUE>:<teams_master.slug>' ('NBA:blazers'). Nothing
-- on the site read it.
--
-- COVERAGE, measured 2026-10-22 ~11:00 PM PT (catalogued Panini editions with
-- a team key / catalogued in that sport): Basketball 10,329 / 10,898 (94.8 %,
-- all 30 NBA franchises) · Baseball 24 / 732 (one club) · Football, Soccer,
-- Womens Basketball, Racing 0. No card carries two keys. The walk also sees
-- ~24k listed cards the catalogue does not hold; those have no edition page,
-- so they are not counted. Because the mapping is PARTIAL, the panel states
-- its league's live coverage, and a franchise with no mapped card gets NO
-- Panini panel (an unmeasured absence must not read as "no Panini cards").
--
--   get_panini_franchise_panel(league, team_slug) -> NULL when no catalogued
--     Panini edition maps to the franchise; else edition/player counts, total
--     mint, FMV total (latest fmv_snapshots row, the same rule get_team_detail
--     uses) and the league's coverage {sport, catalogued, mapped} (sport NULL
--     for a league Panini's grid has no sport for).
--   get_panini_franchise_editions(league, team_slug, limit, offset) -> tiles
--     in get_team_top_editions' shape (EditionsGridPaginated), FMV desc, with
--     e.id as the unique tiebreak so offset paging cannot repeat or skip.
--     set_slug is the edition's own PRODUCT key (#204: a set name can span
--     products), not the name slug.
--   franchise_hub_keys(pairs jsonb) -> for each {collection_id, team_slug},
--     the franchise hub it belongs to {league, hub_slug, team_name}, by the
--     same resolution get_team_detail uses (team_franchise_primary_name ->
--     teams_master by slugified name), so a historic label (SuperSonics)
--     reaches the current franchise's hub. Batch: one call per search.
--
-- Revert: DROP FUNCTION public.get_panini_franchise_panel(text, text),
--   public.get_panini_franchise_editions(text, text, integer, integer),
--   public.franchise_hub_keys(jsonb);

CREATE OR REPLACE FUNCTION public.get_panini_franchise_panel(p_league text, p_team_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH mapped AS (
    SELECT DISTINCT l.psku
    FROM public.panini_team_listings l
    WHERE l.franchise_keys @> ARRAY[upper(btrim(p_league)) || ':' || lower(btrim(p_team_slug))]
  ),
  ed AS (
    SELECT e.id, e.player_id, e.player_name, e.circulation_count
    FROM public.editions e
    JOIN mapped m ON e.external_id = m.psku
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  ),
  stats AS (
    SELECT count(*)::int AS n,
           count(DISTINCT coalesce(ed.player_id::text, ed.player_name))::int AS players,
           sum(ed.circulation_count)::bigint AS mint,
           sum(fmv.fmv_usd) FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total
    FROM ed
    LEFT JOIN LATERAL (
      SELECT fmv_usd FROM public.fmv_snapshots
      WHERE edition_id = ed.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
  ),
  sport AS (
    SELECT CASE upper(btrim(p_league))
             WHEN 'NBA'  THEN 'Basketball'
             WHEN 'WNBA' THEN 'Womens Basketball'
             WHEN 'NFL'  THEN 'Football'
             WHEN 'MLB'  THEN 'Baseball'
           END AS s
  ),
  league_mapped AS (
    SELECT DISTINCT l.psku
    FROM public.panini_team_listings l
    WHERE EXISTS (SELECT 1 FROM unnest(l.franchise_keys) k WHERE k LIKE upper(btrim(p_league)) || ':%')
  ),
  coverage AS (
    SELECT count(*)::int AS catalogued,
           count(*) FILTER (WHERE e.external_id IN (SELECT psku FROM league_mapped))::int AS mapped
    FROM public.editions e
    JOIN public.panini_products pp
      ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.external_id LIKE 'packcard-%'
      AND pp.last_grid_sport = (SELECT s FROM sport)
  )
  SELECT CASE WHEN st.n = 0 THEN NULL ELSE jsonb_build_object(
    'edition_count',     st.n,
    'player_count',      st.players,
    'total_circulation', st.mint,
    'fmv_total_usd',     st.fmv_total,
    'coverage', jsonb_build_object(
      'sport',      (SELECT s FROM sport),
      'catalogued', CASE WHEN (SELECT s FROM sport) IS NULL THEN NULL ELSE (SELECT catalogued FROM coverage) END,
      'mapped',     CASE WHEN (SELECT s FROM sport) IS NULL THEN NULL ELSE (SELECT mapped FROM coverage) END)
  ) END
  FROM stats st;
$function$;

CREATE OR REPLACE FUNCTION public.get_panini_franchise_editions(p_league text, p_team_slug text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH mapped AS (
    SELECT DISTINCT l.psku
    FROM public.panini_team_listings l
    WHERE l.franchise_keys @> ARRAY[upper(btrim(p_league)) || ':' || lower(btrim(p_team_slug))]
  ),
  ed AS (
    SELECT
      COALESCE(e.external_id, e.id::text)                AS route_slug,
      e.player_name,
      e.name,
      e.set_name,
      CASE WHEN s.external_id LIKE 'panini-%' THEN substring(s.external_id FROM 8) END AS set_slug,
      e.tier::text                                       AS tier,
      CASE e.tier::text
        WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
        WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
        WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
        ELSE 99
      END                                                AS tier_rank,
      e.series::text                                     AS series_label,
      e.series                                           AS series_num,
      e.circulation_count,
      e.thumbnail_url,
      public.entity_rep_nft_id(e.collection_id, e.external_id, e.id) AS rep_nft_id,
      e.video_url,
      e.team_name,
      e.subedition_name,
      e.play_category,
      e.game_date,
      e.play_type,
      fmv.fmv_usd,
      fmv.floor_price_usd                                AS floor_usd,
      fmv.confidence::text                               AS fmv_confidence,
      fmv.computed_at                                    AS fmv_computed_at,
      e.first_minted_at,
      e.id                                               AS edition_id
    FROM public.editions e
    JOIN mapped m ON e.external_id = m.psku
    LEFT JOIN public.sets s ON s.id = e.set_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd, confidence, computed_at FROM public.fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.thumbnail_url IS NOT NULL
    ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST, e.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(ed.*) - 'first_minted_at' - 'edition_id'
                            ORDER BY ed.fmv_usd DESC NULLS LAST, ed.first_minted_at DESC NULLS LAST, ed.edition_id),
                  '[]'::jsonb)
  FROM ed;
$function$;

CREATE OR REPLACE FUNCTION public.franchise_hub_keys(p_pairs jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'collection_id', x.collection_id,
           'team_slug',     x.team_slug,
           'league',        tm.league,
           'hub_slug',      tm.slug,
           'team_name',     tm.team_name)), '[]'::jsonb)
  FROM jsonb_to_recordset(CASE WHEN jsonb_typeof(p_pairs) = 'array' THEN p_pairs ELSE '[]'::jsonb END)
       AS x(collection_id uuid, team_slug text)
  -- The name is computed ONCE per pair (OFFSET 0 fences it): inlined into the
  -- teams_master filter it re-ran per scanned row — 901 ms for 5 pairs vs 17.6 ms.
  CROSS JOIN LATERAL (
    SELECT regexp_replace(lower(trim(public.team_franchise_primary_name(x.collection_id, x.team_slug))), '[^a-z0-9]+', '-', 'g') AS nk
    OFFSET 0
  ) n
  CROSS JOIN LATERAL (
    SELECT t.league::text AS league, t.slug, t.team_name
    FROM public.teams_master t
    WHERE t.active
      AND regexp_replace(lower(trim(t.team_name)), '[^a-z0-9]+', '-', 'g') = n.nk
    ORDER BY t.slug
    LIMIT 1
  ) tm;
$function$;

-- anon-exec: revoked (get_panini_franchise_panel) — new function, service_role only like get_franchise_hub.
-- anon-exec: revoked (get_panini_franchise_editions) — new function, service_role only like get_team_top_editions' callers.
-- anon-exec: revoked (franchise_hub_keys) — new function, service_role only; /api/search calls it via supabaseAdmin.
REVOKE ALL ON FUNCTION public.get_panini_franchise_panel(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_panini_franchise_editions(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.franchise_hub_keys(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_franchise_panel(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_panini_franchise_editions(text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.franchise_hub_keys(jsonb) TO service_role;
