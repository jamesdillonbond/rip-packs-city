-- audit_20261023_search_accented_labels
--
-- 2026-10-23 (Claude Code cloud; #207 platform-wide follow-on). rpc_search_catalog's
-- TEAM and SET arms match the raw query (their predicates ride trigram indexes that
-- an unaccent() wrapper would forfeit), so none of the 12 accented team / set names
-- could be found without typing the accent — measured: "atletico", "cadiz",
-- "malaga", "leganes", "almeria", "hercules", "coruna" (Golazos clubs) and
-- "elclasico", "idolos", "lewandowski's strikers", "'94 / '99 draft class" all
-- returned 0 team/set hits.
--
-- Rather than touch the hot search path, /api/search asks this function — once an
-- hour per instance — for the small list of accented team and set labels, and when
-- a typed query matches one of them only accent-blind it re-runs the search with
-- that label and merges the team / set hits (lib/search/accented-labels.ts).
--
-- anon-exec: revoked (search_accented_labels) — called only by the service-role route.
-- REVERT: DROP FUNCTION public.search_accented_labels();
CREATE OR REPLACE FUNCTION public.search_accented_labels()
RETURNS TABLE (kind text, label text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT DISTINCT 'team'::text, e.team_name
    FROM public.editions e
   WHERE e.team_name IS NOT NULL AND e.team_name ~ '[^\x01-\x7e]'
  UNION
  SELECT DISTINCT 'set'::text, s.name::text
    FROM public.sets s
   WHERE s.name ~ '[^\x01-\x7e]'
  UNION
  SELECT DISTINCT 'set'::text, ss.set_name
    FROM public.sets_summary ss
   WHERE ss.set_name ~ '[^\x01-\x7e]'
$fn$;
REVOKE EXECUTE ON FUNCTION public.search_accented_labels() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_accented_labels() TO service_role;
