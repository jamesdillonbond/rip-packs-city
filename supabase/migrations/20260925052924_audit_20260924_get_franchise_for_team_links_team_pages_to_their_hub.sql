-- 2026-09-24 (PT) — franchise hubs: the per-collection team page
-- (/nba-top-shot/team/portland-trail-blazers) had no way to reach its
-- cross-collection hub (/teams/nba/blazers). This is the reverse lookup the
-- page needs: collection + team route slug → the hub's league + short slug.
--
-- Resolution: league_collections (which leagues this collection carries)
-- ⋈ teams_master (active teams in those leagues) matched on the SAME
-- slugified team_name get_franchise_hub publishes as route_slug. NULL when the
-- team is not a registered franchise (exhibition rosters, unmapped teams).
--
-- Grants: service_role only, like get_franchise_hub (read via supabaseAdmin).
-- Revert: DROP FUNCTION public.get_franchise_for_team(uuid, text);

CREATE OR REPLACE FUNCTION public.get_franchise_for_team(p_collection_id uuid, p_route_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'league',    tm.league::text,
    'team_slug', tm.slug,
    'team_name', tm.team_name,
    'collections_enabled', (
      SELECT count(*) FROM league_collections lc2 WHERE lc2.league = tm.league AND lc2.enabled
    )
  )
  FROM teams_master tm
  WHERE tm.active
    AND tm.league IN (SELECT lc.league FROM league_collections lc WHERE lc.collection_id = p_collection_id AND lc.enabled)
    AND trim(both '-' from regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g')) = lower(p_route_slug)
  ORDER BY tm.display_order NULLS LAST, tm.slug
  LIMIT 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_franchise_for_team(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_franchise_for_team(uuid, text) TO service_role;

COMMENT ON FUNCTION public.get_franchise_for_team(uuid, text) IS
  'Reverse lookup for the franchise hub: (collection, team route slug) → {league, team_slug, team_name, collections_enabled}. NULL for non-franchise teams. Read by app/(collections)/[collection]/team/[slug]/page.tsx to link the hub. 2026-09-24.';

-- Post-condition: the two seeded hubs resolve from their team pages.
DO $$
BEGIN
  IF (public.get_franchise_for_team('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'portland-trail-blazers')->>'team_slug') IS DISTINCT FROM 'blazers' THEN
    RAISE EXCEPTION 'get_franchise_for_team: Blazers did not resolve to /teams/nba/blazers';
  END IF;
  IF (public.get_franchise_for_team('209ade70-32c5-4470-bc7c-4793d660f713', 'detroit-tigers')->>'team_slug') IS DISTINCT FROM 'tigers' THEN
    RAISE EXCEPTION 'get_franchise_for_team: Tigers did not resolve to /teams/mlb/tigers';
  END IF;
END $$;
