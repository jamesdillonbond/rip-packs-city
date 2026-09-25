-- The unaccented spelling of an accented set name answers 308 to the set's
-- canonical page instead of 404ing (handoff 09-25, "Needs Trevor" 1).
-- sets_summary.set_slug collapses an accent to a dash ("Ídolos" -> "-dolos",
-- "ElClásico" -> "elcl-sico"), so /laliga-golazos/set/idolos 404'd while the
-- team route already accepts both spellings. get_set_detail (pinned) is NOT
-- changed; the set layout calls this only on a would-be 404, mirroring
-- get_player_alias_target. New object, service_role only.
CREATE OR REPLACE FUNCTION public.get_set_alias_target(p_collection_id uuid, p_slug text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.set_slug
    FROM public.sets_summary s
   WHERE s.collection_id = p_collection_id
     AND s.set_slug <> p_slug
     AND regexp_replace(lower(trim(extensions.unaccent(s.set_name))), '[^a-z0-9]+', '-', 'g') = p_slug
   ORDER BY s.set_slug
   LIMIT 1
$function$;
COMMENT ON FUNCTION public.get_set_alias_target(uuid, text) IS
  'Canonical set_slug for the unaccented spelling of an accented set name (idolos -> -dolos). Called by the set segment layout only when get_set_detail returned nothing. Added 2026-09-25.';
REVOKE EXECUTE ON FUNCTION public.get_set_alias_target(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_set_alias_target(uuid, text) TO service_role, postgres;
