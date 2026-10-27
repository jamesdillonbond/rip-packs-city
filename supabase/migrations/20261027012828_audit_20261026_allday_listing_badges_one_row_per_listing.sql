-- audit_20261026: get_allday_listing_badges returns ONE row per listing (fix to 20261027012804, minutes later).
--
-- cached_listings_v2's key is (listing_resource_id, source): a listing seen by two lanes has two rows, so the first body
-- returned 224 rows for the 186 distinct listings on a 200-deal All Day sniper page. Now DISTINCT ON listing, preferring
-- an open row. Re-read after: 186 listings → 186 rows, 77 badged (41 %). Grants and comment unchanged (CREATE OR REPLACE
-- keeps them).
--
-- Revert: re-apply 20261027012804 (or DROP FUNCTION public.get_allday_listing_badges(bigint[]); to remove both).

-- anon-exec: unchanged (get_allday_listing_badges) — CREATE OR REPLACE of 20261027012804 minutes after it; ACL preserved (has_function_privilege anon = false, read 2026-10-26 ~7:00 PM PT).
CREATE OR REPLACE FUNCTION public.get_allday_listing_badges(p_listing_ids bigint[])
 RETURNS TABLE(listing_resource_id bigint, edition_key text, badges text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cl AS (
    -- cached_listings_v2's key is (listing_resource_id, source): a listing seen by two lanes has two rows.
    SELECT DISTINCT ON (c.listing_resource_id) c.listing_resource_id, c.edition_id
      FROM public.cached_listings_v2 c
     WHERE c.listing_resource_id = ANY (p_listing_ids[1:500])
       AND c.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
       AND c.edition_id IS NOT NULL
     ORDER BY c.listing_resource_id, (c.completed_at IS NULL) DESC, c.source
  )
  SELECT cl.listing_resource_id,
         e.external_id AS edition_key,
         COALESCE((SELECT array_agg(t->>'title' ORDER BY t->>'title')
                     FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.set_play_tags) = 'array' THEN b.set_play_tags ELSE '[]'::jsonb END) t
                    WHERE t->>'title' IS NOT NULL), ARRAY[]::text[]) AS badges
    FROM cl
    JOIN public.editions e ON e.id = cl.edition_id
    LEFT JOIN public.badge_editions b
      ON b.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND b.external_id = e.external_id
$function$;
