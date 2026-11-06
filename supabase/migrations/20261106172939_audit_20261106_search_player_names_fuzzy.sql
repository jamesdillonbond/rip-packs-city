-- audit_20261106_search_player_names_fuzzy
--
-- 2026-11-06 (Cowork cloud, daytime audit pass). Site search answered a typo
-- with NOTHING: "murry" → 0 results, "dontcic" → 0, "wemby" → 0, "jalen bruson"
-- → 0 (measured live on /api/search). rpc_search_catalog's player arm is an
-- accent-folded substring match, so a misspelling finds no player, and a new
-- collector's first search dies on the page.
--
-- This is the candidate list for a "closest matches" fallback that /api/search
-- runs ONLY when the exact search returned no rows (lib/search/fuzzy-players.ts):
-- the DISTINCT player names whose accent-folded form is within pg_trgm
-- word_similarity ≥ 0.45 of the query, best first. The route then re-runs the
-- ordinary rpc_search_catalog with each returned name (≤ 3), so the hits carry
-- the same shape, counts and hub links as a typed exact query — this function
-- never fabricates a result row, it only names what to search for.
--
-- Cost: a 9,162-row seq scan on public.players, 237 buffers, ~40 ms (EXPLAIN
-- ANALYZE 2026-11-06). It runs on the empty-result path only. Measured
-- examples (word_similarity): murry→Jamal/Keegan/Dejounte Murray 0.67;
-- dontcic→Luka Doncic 0.50; wemby→Victor Wembanyama 0.67; jalen bruson→Jalen
-- Brunson 0.69. 0.45 keeps "dontcic" and drops the 0.3-grade noise.
--
-- anon-exec: revoked (rpc_search_players_fuzzy) — called only by the service-role /api/search route, like search_accented_labels; verified has_function_privilege('anon', …, 'EXECUTE') = false after the REVOKE.
-- REVERT: DROP FUNCTION public.rpc_search_players_fuzzy(text, uuid, integer);
CREATE OR REPLACE FUNCTION public.rpc_search_players_fuzzy(p_q text, p_collection_id uuid, p_limit integer)
RETURNS TABLE (name text, similarity real)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH q AS (
    SELECT lower(btrim(extensions.unaccent(coalesce(p_q, '')))) AS t
  )
  SELECT min(p.name)::text AS name,
         max(extensions.word_similarity(q.t, lower(extensions.unaccent(p.name))))::real AS similarity
    FROM public.players p, q
   WHERE length(q.t) >= 3
     AND (p_collection_id IS NULL OR p.collection_id = p_collection_id)
     AND p.name IS NOT NULL
     AND extensions.word_similarity(q.t, lower(extensions.unaccent(p.name))) >= 0.45
   GROUP BY lower(extensions.unaccent(p.name))
   ORDER BY 2 DESC, 1
   LIMIT least(greatest(coalesce(p_limit, 3), 1), 10)
$fn$;
REVOKE EXECUTE ON FUNCTION public.rpc_search_players_fuzzy(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_search_players_fuzzy(text, uuid, integer) TO service_role;
