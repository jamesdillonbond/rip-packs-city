-- audit_20261014 — get_market_filter_options: the Market page's Set / Series /
-- Team dropdowns were built from the 50 listings on screen, and the Player box
-- had no suggestions. This returns every distinct editions.set_name / series /
-- team_name / player_name for a collection — the columns the Top Shot and All Day
-- market RPCs filter on (btrim(set_name) IN, series::text = ANY, team_name ILIKE,
-- player_name ILIKE), so every option offered is matchable there.
-- Supersedes get_market_team_options (20261015020243), dropped in a follow-up
-- once no deployed client calls it.
-- Read only by /api/market/filter-options (service_role).
-- REVERT: DROP FUNCTION public.get_market_filter_options(uuid);
CREATE OR REPLACE FUNCTION public.get_market_filter_options(p_collection_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'sets',    coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT btrim(e.set_name) v FROM public.editions e WHERE e.collection_id = p_collection_id AND btrim(coalesce(e.set_name, '')) <> '') s), '[]'::jsonb),
    'series',  coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT e.series::text v FROM public.editions e WHERE e.collection_id = p_collection_id AND e.series IS NOT NULL) s), '[]'::jsonb),
    'teams',   coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT btrim(e.team_name) v FROM public.editions e WHERE e.collection_id = p_collection_id AND btrim(coalesce(e.team_name, '')) <> '') s), '[]'::jsonb),
    'players', coalesce((SELECT jsonb_agg(v ORDER BY v) FROM (SELECT DISTINCT btrim(e.player_name) v FROM public.editions e WHERE e.collection_id = p_collection_id AND btrim(coalesce(e.player_name, '')) <> '') s), '[]'::jsonb)
  )
$$;

-- anon-exec: revoked (get_market_filter_options) — new fn, service_role-only (verified has_function_privilege anon=false); read by /api/market/filter-options via supabaseAdmin.
REVOKE EXECUTE ON FUNCTION public.get_market_filter_options(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_filter_options(uuid) TO postgres, service_role;

