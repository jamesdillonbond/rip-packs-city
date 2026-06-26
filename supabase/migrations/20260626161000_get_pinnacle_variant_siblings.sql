-- Item 2 (2026-06-26 audit): per-pin Pinnacle "Other printings" ladder. The
-- render-keyed per-pin page (/pinnacle/moment/<render_id>, Wave 1b) had no sibling
-- ladder. shape_render_id groups every variant printing of the same pin within a
-- set (verified: render_id = shape_render_id || '-' || variant suffix), so it is
-- the correct sibling key. Each sibling links to its own existing render page;
-- per-render FMV is honest (not a fabricated per-pin number). Read-only.
-- Revert: DROP FUNCTION public.get_pinnacle_variant_siblings(text);
CREATE OR REPLACE FUNCTION public.get_pinnacle_variant_siblings(p_render_id text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  WITH self AS (
    SELECT shape_render_id
    FROM pinnacle_catalog
    WHERE render_id = p_render_id
    LIMIT 1
  )
  SELECT COALESCE(
    jsonb_agg(to_jsonb(s) ORDER BY s.printing NULLS LAST, s.total_minted ASC NULLS LAST),
    '[]'::jsonb
  )
  FROM (
    SELECT
      pc.render_id,
      pc.character_name,
      pc.set_name,
      pc.variant,
      pc.printing,
      pc.total_minted,
      pc.thumbnail_url,
      pc.fmv_usd,
      pc.fmv_confidence::text AS fmv_confidence,
      pc.floor_ask,
      (pc.render_id = p_render_id) AS is_self
    FROM pinnacle_catalog pc
    JOIN self ON pc.shape_render_id = self.shape_render_id
    WHERE self.shape_render_id IS NOT NULL
  ) s;
$function$;

REVOKE ALL ON FUNCTION public.get_pinnacle_variant_siblings(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pinnacle_variant_siblings(text) TO service_role;
