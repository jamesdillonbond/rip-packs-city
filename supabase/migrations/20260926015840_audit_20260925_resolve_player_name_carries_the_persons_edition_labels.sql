-- 2026-09-25 (PT) — resolve_player_name carries the person's edition LABELS.
-- The concierge's label-keyed tools (deal boards on cached_listings, the
-- special-serial board, get_edition_listings) filter `player_name ILIKE
-- '%name%'`: "Joseph Flacco" misses the row Joe Flacco whose editions still
-- say "Joseph Flacco" on four of eight, and "Marvin Harrison" takes the son's
-- rows with the father's. player.labels is the distinct set of
-- editions.player_name for the resolved row (commonest first, capped at 25),
-- so a caller can match the PERSON exactly (`player_name IN (labels)`).
-- Full-body write from the 20260926013254 body (re-read 2026-09-25 7:05 PM
-- PT); pin re-pointed.
--
-- Revert: re-apply _player_identity_summary from 20260926013254.

-- anon-exec: intentional — full-body write of _player_identity_summary; ACL (service_role only, 20260926011020) unchanged
CREATE OR REPLACE FUNCTION public._player_identity_summary(p_collection_id uuid, p_player_id uuid, p_query_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'player', jsonb_build_object(
      'id', p.id, 'name', p.name,
      -- the site's player-URL slug (lib/entity-labels slugifyName: a trailing
      -- "." keeps its dash — /player/marvin-harrison-jr-), so a caller can
      -- hand it straight to get_player_editions and the page route
      'slug', regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
      'team', p.team,
      'edition_count', (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id),
      -- every LABEL this person's editions carry (a merged first-name variant
      -- keeps its editions' spelling: Joe Flacco's rows say "Joseph Flacco" on
      -- 4 of 8), so a label-keyed reader can match the person EXACTLY instead
      -- of ILIKE-ing a name that also matches a namesake — capped at 25
      'labels', (SELECT COALESCE(jsonb_agg(l.player_name ORDER BY l.n DESC, l.player_name), '[]'::jsonb)
                   FROM (SELECT e.player_name, count(*) AS n FROM public.editions e
                          WHERE e.player_id = p.id AND e.player_name IS NOT NULL AND e.player_name <> ''
                          GROUP BY e.player_name ORDER BY count(*) DESC, e.player_name LIMIT 25) l)),
    'aliases', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', a.alias_slug, 'note', a.note) ORDER BY a.alias_slug), '[]'::jsonb)
        FROM public.player_name_aliases a WHERE a.player_id = p.id),
    'identity', (
      SELECT jsonb_build_object(
        'league', i.league, 'league_player_id', i.league_player_id, 'espn_id', i.espn_id,
        'league_name', i.display_name,
        'league_name_differs', regexp_replace(lower(trim(extensions.unaccent(i.display_name))), '[^a-z0-9]+', '-', 'g')
                               <> regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
        'position', i.position, 'status', i.status,
        'rookie_season', i.rookie_season, 'last_season', i.last_season, 'latest_team', i.latest_team,
        'matched_by', i.matched_by,
        'stats_seasons', (SELECT count(DISTINCT s.season) FROM public.player_season_stats s WHERE s.league = i.league AND s.espn_id = i.espn_id AND i.espn_id IS NOT NULL),
        'stats_refreshed_at', i.stats_refreshed_at)
        FROM public.player_identities i WHERE i.player_id = p.id LIMIT 1),
    'relations', (
      SELECT COALESCE(jsonb_agg(x.rel ORDER BY x.rel->>'relation', x.rel->>'name'), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object('relation', 'parent_of', 'name', o.name,
                   'slug', regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g'), 'note', r.note) AS rel
            FROM public.player_relations r JOIN public.players o ON o.id = r.related_player_id
           WHERE r.player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'child_of', 'name', o.name,
                   'slug', regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g'), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = r.player_id
           WHERE r.related_player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'unrelated_namesake', 'name', o.name,
                   'slug', regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g'), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = CASE WHEN r.player_id = p.id THEN r.related_player_id ELSE r.player_id END
           WHERE r.relation = 'namesake' AND (r.player_id = p.id OR r.related_player_id = p.id)
          UNION ALL
          SELECT jsonb_build_object('relation', 'also_known_as', 'name', r.name,
                   'slug', regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g'), 'note', r.note)
            FROM public.player_relations r
           WHERE r.player_id = p.id AND r.relation = 'name_change'
        ) x),
    'matched_query_as', CASE
      WHEN trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')) = p_query_slug THEN 'exact'
      WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = p.id AND a.alias_slug = p_query_slug) THEN 'alias'
      WHEN EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = p.id AND trim(both '-' from i.name_slug) = p_query_slug) THEN 'league_spelling'
      WHEN EXISTS (SELECT 1 FROM public.player_relations r WHERE r.player_id = p.id AND r.relation = 'name_change'
                      AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = p_query_slug) THEN 'former_name'
      WHEN regexp_replace(trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')), '-(jr|sr|ii|iii|iv|v)$', '')
           = regexp_replace(p_query_slug, '-(jr|sr|ii|iii|iv|v)$', '') THEN 'base_name'
      ELSE 'partial' END)
    FROM public.players p WHERE p.id = p_player_id;
$function$;

-- Post-condition on the live catalog: Joe Flacco's labels carry both spellings
DO $$
DECLARE r jsonb;
BEGIN
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Joseph Flacco');
  IF NOT (r->'player'->'labels' ? 'Joe Flacco') THEN RAISE EXCEPTION 'labels: %', r->'player'->'labels'; END IF;
  r := public.resolve_player_name('dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison');
  IF (r->'player'->'labels') ? 'Marvin Harrison Jr.' THEN RAISE EXCEPTION 'the father''s labels carry the son: %', r->'player'->'labels'; END IF;
END $$;
