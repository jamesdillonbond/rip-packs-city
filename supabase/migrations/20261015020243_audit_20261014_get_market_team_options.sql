-- audit_20261014 — get_market_team_options: the Market page's Team dropdown
-- offered only the teams present in the 50 listings on screen, so Portland
-- Fire (70 Top Shot editions with a live ask, 2026-10-14) and ~70 other teams
-- could not be picked. This returns every distinct editions.team_name for a
-- collection — the exact column the market RPCs filter on
-- (`e.team_name ILIKE p_team`), so every option it offers is matchable.
-- Read only by /api/market/teams (service_role).
-- REVERT: DROP FUNCTION public.get_market_team_options(uuid);
CREATE OR REPLACE FUNCTION public.get_market_team_options(p_collection_id uuid)
RETURNS TABLE(team_name text)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT btrim(e.team_name) AS team_name
  FROM public.editions e
  WHERE e.collection_id = p_collection_id
    AND e.team_name IS NOT NULL
    AND btrim(e.team_name) <> ''
  ORDER BY 1
$$;

-- anon-exec: revoked (get_market_team_options) — new fn, service_role-only (verified has_function_privilege anon=false); read by /api/market/teams via supabaseAdmin.
REVOKE EXECUTE ON FUNCTION public.get_market_team_options(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_team_options(uuid) TO postgres, service_role;
