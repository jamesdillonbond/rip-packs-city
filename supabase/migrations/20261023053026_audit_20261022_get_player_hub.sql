-- Player hubs (2026-10-22, Trevor: "general player, team, etc pages that are
-- agnostic and in Damian Lillard's case, show both Top Shot and Panini").
--
-- get_player_hub(slug) resolves ONE player name to every collection that
-- carries it, for the public /players/<slug> page. Searching "damian lillard"
-- returned two separate player rows (Panini 129 editions, Top Shot 68), and
-- Enter opened whichever scored higher — Panini, by 0.012.
--
-- ⚠ A NAME IS NOT A PERSON (CLAUDE.md concierge rule 2). There is no shared
-- person key across collections: Panini's 4,884 players carry 0
-- player_identities rows. So the hub matches by NAME and reports a SPORT per
-- collection, and the page groups by sport. Measured 2026-10-22: 1,985 slugs
-- appear in 2+ collections, all but 3 a single-league collection + Panini of
-- the same sport; larry-johnson, matt-ryan and joe-johnson span NBA and NFL —
-- different people, which the sport grouping keeps apart.
--
--   sport per collection: the registry's league for the single-league
--   collections; for Panini, the distinct panini_products.last_grid_sport of
--   the player's editions (keyed by the packcard-<set_id>_ prefix; all 38,893
--   player-linked Panini editions resolve, 4 players span two sports). "Womens
--   Basketball" folds into basketball, as Top Shot carries the WNBA.
--
-- Disney Pinnacle is excluded: its "players" are characters.
-- Edition counts use rpc_search_catalog's own expression, so the hub and the
-- search row that links to it state the same number.
-- A collection with 0 editions for the name is omitted (not "empty"): the hub
-- lists where the player IS. NULL = no collection carries the name (404).
--
-- Revert: DROP FUNCTION public.get_player_hub(text);

CREATE OR REPLACE FUNCTION public.get_player_hub(p_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  -- Every spelling of the name the alias registry links to the requested one,
  -- in either direction, so /players/steph-curry and /players/stephen-curry
  -- gather the same collections (Top Shot "Steph Curry", Panini "Stephen Curry").
  WITH seed AS (
    SELECT lower(btrim(p_slug)) AS sl
    UNION
    SELECT regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')
    FROM public.player_name_aliases a
    JOIN public.players p ON p.id = a.player_id
    WHERE a.alias_slug = lower(btrim(p_slug))
    UNION
    SELECT a.alias_slug
    FROM public.player_name_aliases a
    JOIN public.players p ON p.id = a.player_id
    WHERE regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = lower(btrim(p_slug))
  ),
  cand AS (
    SELECT p.id, p.collection_id, p.name::text AS name, p.headshot_url, c.slug::text AS collection_slug,
           regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') AS player_slug
    FROM public.players p
    JOIN public.collections c ON c.id = p.collection_id
    WHERE p.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND (c.is_active OR c.slug = 'panini_blockchain')
      AND (regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') IN (SELECT sl FROM seed)
           OR EXISTS (SELECT 1 FROM public.player_name_aliases a
                       WHERE a.player_id = p.id AND a.alias_slug IN (SELECT sl FROM seed)))
  ),
  counted AS (
    SELECT k.*,
      (SELECT count(*) FROM public.editions e
        WHERE e.collection_id = k.collection_id
          AND (e.player_id = k.id OR (e.player_name = k.name AND NOT public.edition_player_is_other_person(e.player_id, k.id)))
          AND (e.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
               OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'))::int AS n
    FROM cand k
  ),
  best AS (
    SELECT DISTINCT ON (collection_id) *
    FROM counted
    WHERE n > 0
    ORDER BY collection_id, n DESC, id
  ),
  sported AS (
    SELECT b.*,
      CASE b.collection_slug
        WHEN 'nba_top_shot'   THEN ARRAY['basketball']
        WHEN 'nfl_all_day'    THEN ARRAY['football']
        WHEN 'laliga_golazos' THEN ARRAY['soccer']
        WHEN 'candy_mlb'      THEN ARRAY['baseball']
        WHEN 'ufc_strike'     THEN ARRAY['mma']
        WHEN 'panini_blockchain' THEN (
          SELECT array_agg(s ORDER BY s) FROM (
            SELECT DISTINCT CASE WHEN pp.last_grid_sport ILIKE '%basketball%' THEN 'basketball'
                                 ELSE lower(pp.last_grid_sport) END AS s
            FROM public.editions e
            JOIN public.panini_products pp
              ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
            WHERE e.collection_id = b.collection_id
              AND e.player_id = b.id
              AND e.external_id LIKE 'packcard-%'
              AND pp.last_grid_sport IS NOT NULL
          ) q)
      END AS sports
    FROM best b
  )
  SELECT CASE WHEN count(*) = 0 THEN NULL ELSE jsonb_build_object(
    'slug',           lower(btrim(p_slug)),
    'canonical_slug', (array_agg(player_slug ORDER BY n DESC, collection_slug))[1],
    'name',           (array_agg(name ORDER BY n DESC, collection_slug))[1],
    'collections',    jsonb_agg(jsonb_build_object(
                        'collection_id',   collection_id,
                        'collection_slug', collection_slug,
                        'name',            name,
                        'player_slug',     player_slug,
                        'edition_count',   n,
                        'headshot_url',    headshot_url,
                        'sports',          to_jsonb(coalesce(sports, ARRAY[]::text[])))
                      ORDER BY n DESC, collection_slug)
  ) END
  FROM sported;
$function$;

-- anon-exec: revoked (get_player_hub) — new function, service_role only like get_franchise_hub; the page reads it via supabaseAdmin.
REVOKE ALL ON FUNCTION public.get_player_hub(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_hub(text) TO service_role;
