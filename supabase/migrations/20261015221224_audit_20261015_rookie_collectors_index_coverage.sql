-- audit_20261015_rookie_collectors_index_coverage
-- anon-exec: NOT intentional for get_topshot_rookie_index_coverage — read by the player page through the service role only.
--
-- The player-page Top Collectors panel ranks holders from topshot_ownership, which covers only the
-- sets it was built from: its Dune lane has been dead since 2026-09-10 (free tier ended; reservation
-- zeroed 09-07) and ownership-onchain-walk only re-confirms rows it already has. Every Series 8 set
-- through 265 is covered; nothing after it is, and Series 2026-27 (tip-off Oct 20) will add sets where
-- 2025 AND 2026 rookies appear. Once that happens a 2025 rookie's panel would rank collectors over a
-- SUBSET of his editions while saying "this player's moments held".
--
-- This function returns {total_editions, indexed_editions} for a Top Shot player name (canonical,
-- minted editions); the page states the gap when indexed < total (lib/entity/index-coverage-note.ts).
-- Measured on apply: Cooper Flagg 21/21 (no note today).
--
-- REVERT: DROP FUNCTION public.get_topshot_rookie_index_coverage(text); and revert the page commit.

CREATE FUNCTION public.get_topshot_rookie_index_coverage(p_player_name text)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH eds AS (
    SELECT e.external_id::text AS ext
      FROM public.editions e
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND e.player_name = p_player_name
       AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
       AND COALESCE(e.circulation_count, 0) > 0
  )
  SELECT jsonb_build_object(
    'total_editions', count(*),
    'indexed_editions', count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.topshot_ownership o WHERE o.edition_external_id = eds.ext)))
  FROM eds;
$function$;

COMMENT ON FUNCTION public.get_topshot_rookie_index_coverage(text) IS
  'How many of a Top Shot player''s editions (canonical, minted) the ownership index covers. The player-page Top Collectors panel states the gap when indexed < total: the index is frozen to the sets Dune covered (lane dead since 2026-09-10) and the walk only re-confirms rows, so editions minted later are not counted. audit_20261015.';

REVOKE ALL ON FUNCTION public.get_topshot_rookie_index_coverage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_rookie_index_coverage(text) TO service_role;
