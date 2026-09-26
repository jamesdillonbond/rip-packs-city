-- Batch badge titles for a list of grid route_slugs (player-page Editions badge
-- filter, 2026-09-25). Runs the CANONICAL per-edition get_edition_badges_unified
-- over each edition so the filter matches exactly what the edition page shows.
-- route_slug = COALESCE(external_id, id::text), as returned by the grid RPCs.
-- An edition that is found but carries no badge maps to [] (a KNOWN none); a
-- slug that matches no editions row is ABSENT from the result (unknown).
-- Capped at 500 slugs per call (~0.6 ms / edition measured on 68 Lillard rows).
CREATE FUNCTION public.get_edition_badge_titles(p_collection_id uuid, p_route_slugs text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  WITH slugs AS (
    SELECT DISTINCT s FROM unnest(p_route_slugs[1:500]) AS s WHERE s IS NOT NULL AND s <> ''
  ),
  eds AS (
    SELECT e.id, e.external_id::text AS route_slug
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.external_id = ANY (ARRAY(SELECT s FROM slugs)::varchar[])
    UNION ALL
    SELECT e.id, e.id::text AS route_slug
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.external_id IS NULL
      AND e.id = ANY (ARRAY(
        SELECT s::uuid FROM slugs
        WHERE s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      ))
  )
  SELECT coalesce(jsonb_object_agg(eds.route_slug, b.titles), '{}'::jsonb)
  FROM eds
  CROSS JOIN LATERAL (
    SELECT coalesce(jsonb_agg(DISTINCT t->>'title'), '[]'::jsonb) AS titles
    FROM jsonb_array_elements(get_edition_badges_unified(eds.id)) AS t
    WHERE coalesce(btrim(t->>'title'), '') <> ''
  ) b;
$$;

-- anon-exec: revoked (get_edition_badge_titles) — new function; only the service-role API route calls it, so PUBLIC, anon and authenticated are revoked in one statement.
REVOKE EXECUTE ON FUNCTION public.get_edition_badge_titles(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_edition_badge_titles(uuid, text[]) TO postgres, service_role;
