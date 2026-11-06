-- audit_20261106_search_names_fuzzy_teams_and_sets
--
-- Follow-up to 20261106172939 / 20261106173036 (same pass). The closest-match
-- fallback covered PLAYERS only; "nugets", "lakerz" and "playofs" still answered
-- nothing (measured live after batch 1). This widens the candidate list to TEAM
-- labels (editions.team_name, the catalog arm's own source) and SET names
-- (sets, plus sets_summary for Panini, as rpc_search_catalog reads them), and
-- returns the kind so the route can keep only that kind's rows from each
-- re-search. Same threshold and ranking as the player-only function.
-- Measured: nugets → team Denver Nuggets 0.67; lakerz → team Los Angeles Lakers
-- 0.71; playofs → set 2026 NBA Playoffs 0.75; murry/dontcic/wemby unchanged.
-- Cost on the empty path: ~145 ms / ~6.6k buffers (the team leg is an
-- index-only walk of editions.team_name, 21k rows); the exact path is untouched.
--
-- anon-exec: revoked (rpc_search_names_fuzzy) — service_role only, like rpc_search_players_fuzzy; verified has_function_privilege('anon', …, 'EXECUTE') = false after the REVOKE.
-- anon-exec: dropped (rpc_search_players_fuzzy) — superseded by rpc_search_names_fuzzy; the route no longer calls it.
-- REVERT: DROP FUNCTION public.rpc_search_names_fuzzy(text, uuid, integer); re-apply 20261106173036.
CREATE OR REPLACE FUNCTION public.rpc_search_names_fuzzy(p_q text, p_collection_id uuid, p_limit integer)
RETURNS TABLE (kind text, name text, similarity real)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH q AS (
    SELECT lower(btrim(extensions.unaccent(coalesce(p_q, '')))) AS t
  ),
  cand AS (
    SELECT 'player'::text AS k, min(p.name)::text AS nm,
           max(extensions.word_similarity(q.t, lower(extensions.unaccent(p.name)))) AS ws,
           max(extensions.strict_word_similarity(q.t, lower(extensions.unaccent(p.name)))) AS sws,
           max(extensions.similarity(q.t, lower(extensions.unaccent(p.name)))) AS sim,
           count(DISTINCT p.collection_id) AS ncoll
      FROM public.players p, q
     WHERE length(q.t) >= 3
       AND (p_collection_id IS NULL OR p.collection_id = p_collection_id)
       AND p.name IS NOT NULL AND p.name NOT LIKE '%|%'
       AND extensions.word_similarity(q.t, lower(extensions.unaccent(p.name))) >= 0.45
     GROUP BY lower(extensions.unaccent(p.name))
    UNION ALL
    SELECT 'team', min(e.team_name)::text,
           max(extensions.word_similarity(q.t, lower(extensions.unaccent(e.team_name)))),
           max(extensions.strict_word_similarity(q.t, lower(extensions.unaccent(e.team_name)))),
           max(extensions.similarity(q.t, lower(extensions.unaccent(e.team_name)))),
           count(DISTINCT e.collection_id)
      FROM public.editions e, q
     WHERE length(q.t) >= 3
       AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
       AND e.team_name IS NOT NULL
       AND extensions.word_similarity(q.t, lower(extensions.unaccent(e.team_name))) >= 0.45
     GROUP BY lower(extensions.unaccent(e.team_name))
    UNION ALL
    SELECT 'set', min(s.name)::text,
           max(extensions.word_similarity(q.t, lower(extensions.unaccent(s.name)))),
           max(extensions.strict_word_similarity(q.t, lower(extensions.unaccent(s.name)))),
           max(extensions.similarity(q.t, lower(extensions.unaccent(s.name)))),
           count(DISTINCT s.collection_id)
      FROM public.sets s, q
     WHERE length(q.t) >= 3
       AND (p_collection_id IS NULL OR s.collection_id = p_collection_id)
       AND s.collection_id <> 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND extensions.word_similarity(q.t, lower(extensions.unaccent(s.name))) >= 0.45
     GROUP BY lower(extensions.unaccent(s.name))
    UNION ALL
    SELECT 'set', min(ss.set_name)::text,
           max(extensions.word_similarity(q.t, lower(extensions.unaccent(ss.set_name)))),
           max(extensions.strict_word_similarity(q.t, lower(extensions.unaccent(ss.set_name)))),
           max(extensions.similarity(q.t, lower(extensions.unaccent(ss.set_name)))),
           1::bigint
      FROM public.sets_summary ss, q
     WHERE length(q.t) >= 3
       AND ss.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
       AND (p_collection_id IS NULL OR p_collection_id = ss.collection_id)
       AND ss.set_name IS NOT NULL
       AND extensions.word_similarity(q.t, lower(extensions.unaccent(ss.set_name))) >= 0.45
     GROUP BY lower(extensions.unaccent(ss.set_name))
  )
  SELECT k, nm, ws::real
    FROM cand
   ORDER BY ws DESC, sws DESC, sim DESC, ncoll DESC, nm
   LIMIT least(greatest(coalesce(p_limit, 3), 1), 10)
$fn$;
REVOKE EXECUTE ON FUNCTION public.rpc_search_names_fuzzy(text, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_search_names_fuzzy(text, uuid, integer) TO service_role;
DROP FUNCTION IF EXISTS public.rpc_search_players_fuzzy(text, uuid, integer);
