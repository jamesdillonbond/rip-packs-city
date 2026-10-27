-- audit_20261026: get_allday_listing_badges — the All Day sniper's badge decoration (All Day ↔ Top Shot parity, 2026-10-26).
--
-- The All Day sniper path (get_allday_sniper_deals; the GraphQL leg is off since 09-28) built every deal with
-- hasBadge=false, and its filter bar hid BADGES ONLY with the comment "All Day has no badge system" — false:
-- badge_editions.set_play_tags holds 8 badges on 3,202 All Day editions. This maps each deal's listing to its edition
-- and that edition's badge titles. ⚠ SUPERSEDED within minutes by 20261027012828 (…_one_row_per_listing): this first
-- body returned 224 rows for 186 listings because cached_listings_v2's key is (listing_resource_id, source).
-- Kept so migration parity has this applied name's file. Anon cannot execute.
--
-- Revert: DROP FUNCTION public.get_allday_listing_badges(bigint[]);

-- anon-exec: revoked (get_allday_listing_badges) — new fn; REVOKE FROM PUBLIC, anon, authenticated below.
CREATE OR REPLACE FUNCTION public.get_allday_listing_badges(p_listing_ids bigint[])
 RETURNS TABLE(listing_resource_id bigint, edition_key text, badges text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT cl.listing_resource_id,
         e.external_id AS edition_key,
         COALESCE((SELECT array_agg(t->>'title' ORDER BY t->>'title')
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.set_play_tags) = 'array' THEN b.set_play_tags ELSE '[]'::jsonb END) t
                    WHERE t->>'title' IS NOT NULL), ARRAY[]::text[]) AS badges
    FROM public.cached_listings_v2 cl
    JOIN public.editions e ON e.id = cl.edition_id
    LEFT JOIN public.badge_editions b
      ON b.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND b.external_id = e.external_id
   WHERE cl.listing_resource_id = ANY (p_listing_ids[1:500])
     AND cl.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
$function$;

REVOKE EXECUTE ON FUNCTION public.get_allday_listing_badges(bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_listing_badges(bigint[]) TO postgres, service_role;

COMMENT ON FUNCTION public.get_allday_listing_badges(bigint[]) IS
  'NFL All Day sniper badges (Top Shot parity, 2026-10-26): listing_resource_id -> its edition key and that edition''s badge titles (badge_editions.set_play_tags). The All Day sniper path built every deal with hasBadge=false, so BADGES ONLY could not work there. At most 500 ids per call. audit_20261026.';
