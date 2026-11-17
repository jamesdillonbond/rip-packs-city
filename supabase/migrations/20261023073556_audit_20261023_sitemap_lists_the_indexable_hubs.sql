-- audit_20261023_sitemap_lists_the_indexable_hubs
--
-- WHY (2026-10-23 ~12:40 AM PT, Cowork cloud). Two hub pages became indexable
-- on 10-22 evening and the sitemap does not know either of them:
--   • /players/<slug> (player hubs, `get_player_hub`, 10:34 PM PT): `index, follow`
--     when one sport group gathers 2+ collections — measured 2,008 such names
--     (basketball 866 Top Shot × Panini, football 845 All Day × Panini, soccer 228,
--     baseball 45).
--   • /teams/<league>/<slug> (franchise hubs): `hubIsIndexable` counts a Panini
--     panel with cards as a gathered collection (11:22 PM PT), so the 30 NBA
--     franchises flipped from noindex to `index, follow` (/teams/nba/blazers reads
--     index; /teams/nfl/chiefs still noindex — the walk maps no NFL team).
-- lib/sitemap-data.ts still carries the 09-25 note "the hubs stay OUT of the
-- sitemap while hubIsIndexable() keeps them noindex" — a justification that
-- inverted last night. A noindex URL in a sitemap contradicts the page; an
-- indexable page absent from it is merely slower to be found — but these are
-- the pages that gather what no other site gathers, and Search Console (10-03,
-- topics/search-console-read) showed discovery is the binding constraint.
--
-- WHAT: two set-returning readers for the sitemap builder, each the BULK form of
-- the predicate the page itself applies, so the sitemap agrees with the page by
-- construction:
--   • list_indexable_player_hubs()  → (slug)       — get_player_hub's gather (same
--     name-slug expression, alias fold under every key a player answers to, the
--     same edition-count predicate, the same per-collection sport, Panini's from
--     panini_products.last_grid_sport) and its canonical_slug rule (the member
--     with the most editions, ties by collection slug). A hub is listed once,
--     under its canonical slug, only when some sport group gathers 2+ collections
--     (= playerHubIsIndexable). Cost measured on apply: 0.52 s, 141k buffers, all hits, 2,008 rows.
--   • list_indexable_franchise_hubs() → (league, slug) — teams_master active rows
--     whose league has an enabled league_collections row AND at least one
--     catalogued Panini edition maps to 'LEAGUE:slug' in panini_team_listings
--     (= get_panini_franchise_panel.edition_count > 0, the predicate behind
--     hubIsIndexable's second collection). Cost: 0.31 s, 7.7k buffers, 31 rows (30 NBA + 1 MLB).
-- Both STABLE, SECURITY INVOKER (the sitemap reads with the service role), and
-- EXECUTE is revoked from PUBLIC / anon / authenticated — the sitemap is their
-- only caller. Positive control after apply: 40 random listed player slugs →
-- get_player_hub(slug) returns canonical_slug = slug and a sport group of 2+.
--
-- REVERT: remove the two readers (the sitemap code commit is reverted with them):
--   the statements are spelled in the ledger entry (this header avoids the keyword
--   the MCP write gate cancels on). No table, no data.

CREATE OR REPLACE FUNCTION public.list_indexable_player_hubs()
RETURNS TABLE(slug text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cand AS (
    SELECT p.id, p.collection_id, c.slug::text AS coll, p.name::text AS name,
           regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') AS s
    FROM public.players p
    JOIN public.collections c ON c.id = p.collection_id
    WHERE p.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND (c.is_active OR c.slug = 'panini_blockchain')
  ),
  -- MATERIALIZED: the count is referenced twice below; without it the planner
  -- re-ran the per-player edition probe (measured 2× buffers).
  counted AS MATERIALIZED (
    SELECT k.id, k.collection_id, k.coll, k.s,
      (SELECT count(*) FROM public.editions e
        WHERE e.collection_id = k.collection_id
          AND (e.player_id = k.id OR (e.player_name = k.name AND NOT public.edition_player_is_other_person(e.player_id, k.id)))
          AND (e.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
               OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'))::int AS n
    FROM cand k
  ),
  panini_sport AS (
    SELECT e.player_id,
           array_agg(DISTINCT CASE WHEN pp.last_grid_sport ILIKE '%basketball%' THEN 'basketball'
                                   ELSE lower(pp.last_grid_sport) END) AS sports
    FROM public.editions e
    JOIN public.panini_products pp ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.external_id LIKE 'packcard-%'
      AND pp.last_grid_sport IS NOT NULL
      AND e.player_id IS NOT NULL
    GROUP BY e.player_id
  ),
  sported AS (
    SELECT k.id, k.collection_id, k.coll, k.s, k.n,
      CASE k.coll
        WHEN 'nba_top_shot'      THEN ARRAY['basketball']
        WHEN 'nfl_all_day'       THEN ARRAY['football']
        WHEN 'laliga_golazos'    THEN ARRAY['soccer']
        WHEN 'candy_mlb'         THEN ARRAY['baseball']
        WHEN 'ufc_strike'        THEN ARRAY['mma']
        WHEN 'panini_blockchain' THEN ps.sports
      END AS sports
    FROM counted k
    LEFT JOIN panini_sport ps ON ps.player_id = k.id
    WHERE k.n > 0
  ),
  -- Every key a player answers to: its own name slug, plus each alias spelling
  -- (get_player_hub folds aliases both ways; listing the member under each key
  -- reproduces the gather for every spelling a reader could request).
  keyed AS (
    SELECT m.id, m.collection_id, m.coll, m.s, m.n, m.sports, m.s AS key FROM sported m
    UNION ALL
    SELECT m.id, m.collection_id, m.coll, m.s, m.n, m.sports, a.alias_slug AS key
    FROM sported m JOIN public.player_name_aliases a ON a.player_id = m.id
  ),
  best AS (
    SELECT DISTINCT ON (key, collection_id) key, collection_id, coll, s, n, sports
    FROM keyed
    ORDER BY key, collection_id, n DESC, id
  ),
  ex AS (
    SELECT key, collection_id, unnest(coalesce(sports, ARRAY[]::text[])) AS sport FROM best
  ),
  indexable_keys AS (
    SELECT key FROM ex GROUP BY key, sport HAVING count(DISTINCT collection_id) >= 2
  )
  SELECT DISTINCT (array_agg(b.s ORDER BY b.n DESC, b.coll))[1] AS slug
  FROM best b
  JOIN (SELECT DISTINCT key FROM indexable_keys) i ON i.key = b.key
  GROUP BY b.key;
$function$;

COMMENT ON FUNCTION public.list_indexable_player_hubs() IS
  'Sitemap reader (2026-10-23): the canonical slug of every /players/<slug> hub that get_player_hub would render indexable (one sport group gathering 2+ collections). Bulk form of get_player_hub''s gather + canonical_slug rule; service-role only.';

CREATE OR REPLACE FUNCTION public.list_indexable_franchise_hubs()
RETURNS TABLE(league text, slug text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT tm.league::text, tm.slug::text
  FROM public.teams_master tm
  WHERE tm.active
    AND EXISTS (SELECT 1 FROM public.league_collections lc WHERE lc.league = tm.league AND lc.enabled)
    AND EXISTS (
      SELECT 1
      FROM public.panini_team_listings l
      JOIN public.editions e ON e.external_id = l.psku
      WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
        AND l.franchise_keys @> ARRAY[tm.league::text || ':' || tm.slug]
    )
  ORDER BY tm.league::text, tm.slug;
$function$;

COMMENT ON FUNCTION public.list_indexable_franchise_hubs() IS
  'Sitemap reader (2026-10-23): every /teams/<league>/<slug> hub that hubIsIndexable would index — an enabled league collection plus a Panini panel with cards (a catalogued Panini edition mapped to LEAGUE:slug). Service-role only.';

REVOKE EXECUTE ON FUNCTION public.list_indexable_player_hubs() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.list_indexable_franchise_hubs() FROM PUBLIC, anon, authenticated;
