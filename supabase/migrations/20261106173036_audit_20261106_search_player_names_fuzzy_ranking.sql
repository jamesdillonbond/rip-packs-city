-- audit_20261106_search_player_names_fuzzy_ranking
--
-- Follow-up to 20261106172939 (same pass), from reading its first live answers:
-- "dontcic" ranked Dont'a Hightower, Dont'e Thornton Jr. and Dontayvion Wicks
-- ABOVE Luka Doncic (all four tie at word_similarity 0.50, and the tie fell to
-- the alphabet), and "jalen bruson" spent two of its three slots on team-Moment
-- composite names ("Jalen Brunson | Luka Doncic"), which the exact search for
-- "Jalen Brunson" surfaces anyway.
--
-- Ranking is now word_similarity, then strict_word_similarity (Doncic 0.50 vs
-- Hightower 0.44), then whole-string similarity, then how many collections carry
-- the name (a player on Top Shot AND Panini outranks a single-collection
-- namesake), then the name. Composite "A | B" names are excluded from the
-- candidate list. Measured after: dontcic → Luka Doncic first; murry → the
-- Murrays; wemby → Victor Wembanyama; mahomse → Patrick Mahomes.
--
-- anon-exec: revoked (rpc_search_players_fuzzy) — CREATE OR REPLACE keeps the 20261106172939 ACL (anon false, authenticated false, service_role true; re-verified with has_function_privilege after apply).
-- REVERT: re-apply 20261106172939.
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
     AND p.name NOT LIKE '%|%'
     AND extensions.word_similarity(q.t, lower(extensions.unaccent(p.name))) >= 0.45
   GROUP BY lower(extensions.unaccent(p.name))
   ORDER BY 2 DESC,
            max(extensions.strict_word_similarity(q.t, lower(extensions.unaccent(p.name)))) DESC,
            max(extensions.similarity(q.t, lower(extensions.unaccent(p.name)))) DESC,
            count(DISTINCT p.collection_id) DESC,
            1
   LIMIT least(greatest(coalesce(p_limit, 3), 1), 10)
$fn$;
REVOKE EXECUTE ON FUNCTION public.rpc_search_players_fuzzy(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_search_players_fuzzy(text, uuid, integer) TO service_role;
