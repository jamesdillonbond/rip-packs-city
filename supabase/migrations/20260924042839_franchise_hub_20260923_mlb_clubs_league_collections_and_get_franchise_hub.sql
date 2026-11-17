-- Franchise hubs, step 2 of 2 (2026-09-23, Trevor: "Both, foundation first").
-- ⚠ ALREADY APPLIED (prod version 20260924042839). The two `anon-exec:` marker
-- comments below were added to this repo record AFTER the apply; every
-- statement is byte-identical to prod's schema_migrations row.
--
-- A franchise hub is ONE page per real-world team that gathers every collection
-- carrying that team (Blazers = Top Shot + later Panini NBA; Tigers = Candy MLB
-- + later Panini MLB). Three pieces:
--
--   1. teams_master gains the 30 MLB clubs. team_name is spelled EXACTLY as
--      Candy MLB's editions.team_name ("Angels", "Athletics") because
--      get_team_detail's branding lookup and get_my_fan_teams' route_slug both
--      key on slugify(team_name) — a nicer spelling would silently unbrand them.
--   2. league_collections replaces the league -> collection CASE that was
--      hardcoded in get_my_fan_teams and get_teams_for_league. A league can now
--      map to MORE THAN ONE collection, which is the whole point of a hub.
--      `enabled` lets a collection be mapped before it is shown (Panini NBA/MLB
--      stays disabled until it clears the accuracy gate).
--   3. get_franchise_hub(league, short_slug) resolves one franchise + its
--      enabled collections for the public /teams/<league>/<slug> page.
--
-- Revert: DROP FUNCTION public.get_franchise_hub(text, text); restore the two
-- pre-image function bodies recorded verbatim in docs/features/franchise-hubs.md;
-- DROP TABLE public.league_collections;
-- DELETE FROM public.teams_master WHERE league = 'MLB';
-- (league_t keeps 'MLB' — enum values cannot be dropped, and an unused value is inert.)

-- ── 1. MLB clubs ─────────────────────────────────────────────────────────────
INSERT INTO public.teams_master (league, slug, team_name, abbreviation, external_id, primary_color, secondary_color, display_order, active)
VALUES
  ('MLB','angels','Angels','LAA',NULL,'#BA0021','#003263',1,true),
  ('MLB','diamondbacks','Arizona Diamondbacks','ARI',NULL,'#A71930','#E3D4AD',2,true),
  ('MLB','athletics','Athletics','ATH',NULL,'#003831','#EFB21E',3,true),
  ('MLB','braves','Atlanta Braves','ATL',NULL,'#CE1141','#13274F',4,true),
  ('MLB','orioles','Baltimore Orioles','BAL',NULL,'#DF4601','#000000',5,true),
  ('MLB','red-sox','Boston Red Sox','BOS',NULL,'#BD3039','#0C2340',6,true),
  ('MLB','cubs','Chicago Cubs','CHC',NULL,'#0E3386','#CC3433',7,true),
  ('MLB','white-sox','Chicago White Sox','CWS',NULL,'#27251F','#C4CED4',8,true),
  ('MLB','reds','Cincinnati Reds','CIN',NULL,'#C6011F','#000000',9,true),
  ('MLB','guardians','Cleveland Guardians','CLE',NULL,'#00385D','#E50022',10,true),
  ('MLB','rockies','Colorado Rockies','COL',NULL,'#33006F','#C4CED4',11,true),
  ('MLB','tigers','Detroit Tigers','DET',NULL,'#0C2340','#FA4616',12,true),
  ('MLB','astros','Houston Astros','HOU',NULL,'#002D62','#EB6E1F',13,true),
  ('MLB','royals','Kansas City Royals','KC',NULL,'#004687','#BD9B60',14,true),
  ('MLB','dodgers','Los Angeles Dodgers','LAD',NULL,'#005A9C','#EF3E42',15,true),
  ('MLB','marlins','Miami Marlins','MIA',NULL,'#00A3E0','#EF3340',16,true),
  ('MLB','brewers','Milwaukee Brewers','MIL',NULL,'#12284B','#FFC52F',17,true),
  ('MLB','twins','Minnesota Twins','MIN',NULL,'#002B5C','#D31145',18,true),
  ('MLB','mets','New York Mets','NYM',NULL,'#002D72','#FF5910',19,true),
  ('MLB','yankees','New York Yankees','NYY',NULL,'#0C2340','#C4CED4',20,true),
  ('MLB','phillies','Philadelphia Phillies','PHI',NULL,'#E81828','#002D72',21,true),
  ('MLB','pirates','Pittsburgh Pirates','PIT',NULL,'#27251F','#FDB827',22,true),
  ('MLB','padres','San Diego Padres','SD',NULL,'#2F241D','#FFC425',23,true),
  ('MLB','giants','San Francisco Giants','SF',NULL,'#FD5A1E','#27251F',24,true),
  ('MLB','mariners','Seattle Mariners','SEA',NULL,'#0C2C56','#005C5C',25,true),
  ('MLB','cardinals','St. Louis Cardinals','STL',NULL,'#C41E3A','#0C2340',26,true),
  ('MLB','rays','Tampa Bay Rays','TB',NULL,'#092C5C','#8FBCE6',27,true),
  ('MLB','rangers','Texas Rangers','TEX',NULL,'#003278','#C0111F',28,true),
  ('MLB','blue-jays','Toronto Blue Jays','TOR',NULL,'#134A8E','#1D2D5C',29,true),
  ('MLB','nationals','Washington Nationals','WSH',NULL,'#AB0003','#14225A',30,true)
ON CONFLICT (league, slug) DO NOTHING;

-- ── 2. league -> collection map ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.league_collections (
  league        public.league_t NOT NULL,
  collection_id uuid NOT NULL REFERENCES public.collections(id),
  display_order integer NOT NULL DEFAULT 1,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (league, collection_id)
);
COMMENT ON TABLE public.league_collections IS
  'Which collections carry a league''s teams. Read by get_my_fan_teams, get_teams_for_league and get_franchise_hub. enabled=false maps a collection without showing it (Panini NBA/MLB until it clears the accuracy gate). The lowest display_order enabled row is a league''s PRIMARY collection (the one /my-teams cards read).';
ALTER TABLE public.league_collections ENABLE ROW LEVEL SECURITY;
CREATE POLICY league_collections_read_all ON public.league_collections FOR SELECT USING (true);
GRANT SELECT ON public.league_collections TO anon, authenticated, service_role;

INSERT INTO public.league_collections (league, collection_id, display_order) VALUES
  ('NBA',    '95f28a17-224a-4025-96ad-adf8a4c63bfd', 1),
  ('WNBA',   '95f28a17-224a-4025-96ad-adf8a4c63bfd', 1),
  ('NFL',    'dee28451-5d62-409e-a1ad-a83f763ac070', 1),
  ('LALIGA', '06248cc4-b85f-47cd-af67-1855d14acd75', 1),
  ('MLB',    '209ade70-32c5-4470-bc7c-4793d660f713', 1)
ON CONFLICT (league, collection_id) DO NOTHING;

-- ── 3a. get_my_fan_teams: primary collection from the map, + team_slug ──────
-- Same output keys as before PLUS team_slug (the teams_master short slug, the
-- franchise hub's URL key). A league with no enabled mapping yields a NULL
-- collection — the page already renders a card with no stats in that case.
-- anon-exec: intentional — CREATE OR REPLACE keeps the live ACL (authenticated + service_role; anon never had it) (get_my_fan_teams)
CREATE OR REPLACE FUNCTION public.get_my_fan_teams()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(jsonb_agg(to_jsonb(t.*) ORDER BY t.is_primary DESC, t.league, t.team_name), '[]'::jsonb)
  FROM (
    SELECT uft.league::text AS league,
           pc.slug AS collection_slug,
           pc.id   AS collection_id,
           tm.team_name,
           tm.slug AS team_slug,
           trim(both '-' from regexp_replace(lower(trim(tm.team_name)),'[^a-z0-9]+','-','g')) AS route_slug,
           tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id,
           uft.is_primary
    FROM user_favorite_teams uft
    JOIN teams_master tm ON tm.league = uft.league AND tm.slug = uft.team_slug
    LEFT JOIN LATERAL (
      SELECT c.id, c.slug
      FROM league_collections lc
      JOIN collections c ON c.id = lc.collection_id
      WHERE lc.league = uft.league AND lc.enabled
      ORDER BY lc.display_order, c.slug
      LIMIT 1
    ) pc ON true
    WHERE uft.user_id = auth.uid()
  ) t;
$function$;

-- ── 3b. get_teams_for_league: has_moments over EVERY enabled mapped collection
-- anon-exec: intentional — CREATE OR REPLACE keeps the live ACL (service_role only) (get_teams_for_league)
CREATE OR REPLACE FUNCTION public.get_teams_for_league(p_league league_t)
 RETURNS TABLE(slug text, team_name text, abbreviation text, external_id text, primary_color text, secondary_color text, has_moments boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    tm.slug, tm.team_name, tm.abbreviation, tm.external_id,
    tm.primary_color, tm.secondary_color,
    (
      (tm.league IN ('NBA','WNBA') AND EXISTS (
        SELECT 1 FROM badge_editions be WHERE be.team_nba_id = tm.external_id))
      OR EXISTS (
        SELECT 1 FROM league_collections lc
        JOIN editions e ON e.collection_id = lc.collection_id
        WHERE lc.league = tm.league AND lc.enabled AND e.team_name = tm.team_name)
    ) AS has_moments
  FROM teams_master tm
  WHERE tm.league = p_league AND tm.active = true
  ORDER BY tm.display_order, tm.team_name;
$function$;

-- ── 3c. get_franchise_hub ────────────────────────────────────────────────────
-- NULL when the franchise does not exist (the page 404s on that, and ONLY on
-- that). `collections` lists every ENABLED mapped collection in display order;
-- the page reads each one's get_team_detail(collection_id, route_slug).
CREATE OR REPLACE FUNCTION public.get_franchise_hub(p_league text, p_team_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'league',          tm.league::text,
    'team_slug',       tm.slug,
    'team_name',       tm.team_name,
    'route_slug',      trim(both '-' from regexp_replace(lower(trim(tm.team_name)),'[^a-z0-9]+','-','g')),
    'abbreviation',    tm.abbreviation,
    'external_id',     tm.external_id,
    'primary_color',   tm.primary_color,
    'secondary_color', tm.secondary_color,
    'collections', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('collection_id', c.id, 'collection_slug', c.slug)
                       ORDER BY lc.display_order, c.slug)
      FROM league_collections lc
      JOIN collections c ON c.id = lc.collection_id
      WHERE lc.league = tm.league AND lc.enabled
    ), '[]'::jsonb)
  )
  FROM teams_master tm
  WHERE tm.active
    AND tm.league::text = upper(p_league)
    AND tm.slug = lower(p_team_slug);
$function$;
COMMENT ON FUNCTION public.get_franchise_hub(text, text) IS
  'Franchise hub resolver for /teams/<league>/<slug>: teams_master branding + every ENABLED league_collections row. NULL = no such franchise (404). Cheap: two indexed lookups, no edition scan.';
REVOKE ALL ON FUNCTION public.get_franchise_hub(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_franchise_hub(text, text) TO service_role;