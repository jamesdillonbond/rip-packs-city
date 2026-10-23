-- audit_20261023_search_accented_labels_letters_only
--
-- Follow-up to 20261023145852 (same pass). "Non-ASCII" was the wrong test: Panini's
-- set names carry a "·" separator, so the function returned 2,829 rows — over
-- PostgREST's 1,000-row cap — instead of the accented labels it exists to list.
-- Match accented LETTERS (Latin-1 Supplement / Extended-A/B, without × and ÷) and
-- the curly apostrophes only: 7 team labels + 5 set names + 5 Panini set names
-- (measured 2026-10-23).
--
-- anon-exec: revoked (search_accented_labels) — called only by the service-role route.
-- REVERT: re-apply 20261023145852.
CREATE OR REPLACE FUNCTION public.search_accented_labels()
RETURNS TABLE (kind text, label text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT DISTINCT 'team'::text, e.team_name
    FROM public.editions e
   WHERE e.team_name IS NOT NULL AND e.team_name ~ '[À-ÖØ-öø-ɏ’‘]'
  UNION
  SELECT DISTINCT 'set'::text, s.name::text
    FROM public.sets s
   WHERE s.name ~ '[À-ÖØ-öø-ɏ’‘]'
  UNION
  SELECT DISTINCT 'set'::text, ss.set_name
    FROM public.sets_summary ss
   WHERE ss.set_name ~ '[À-ÖØ-öø-ɏ’‘]'
$fn$;
REVOKE EXECUTE ON FUNCTION public.search_accented_labels() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_accented_labels() TO service_role;
