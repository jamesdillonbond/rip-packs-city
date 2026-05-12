-- Returns Top Shot sets ranked by number of editions still holding a pre-2026-05-12
-- broken thumbnail URL. Consumed by app/api/admin/backfill-topshot-catalog with
-- ?forceRefresh=stale_thumbnails to walk the worst-affected sets first.
--
-- The three broken patterns covered:
--   1. .../resize/editions/{int}_{int}/Hero_2880_2880_Transparent.png... (from the
--      May 9 buildThumbnailUrl synthesis, fixed in 0439a8d)
--   2. .../resize/editions/{int}_{int}/play{int}_capture_Hero_Black_2880_2880_default.jpg...
--   3. .../editions/{slug}/{uuid}/play_..._capture_/image
--
-- All three return HTTP 404 from the live TS CDN. The new GQL-assetPathPrefix
-- path produces .../play_..._capture_Hero_2880_2880_Transparent.png which
-- returns 200.
CREATE OR REPLACE FUNCTION public.topshot_sets_with_stale_thumbnails(p_limit INT DEFAULT 1000)
RETURNS TABLE (set_id UUID, stale_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.set_id, COUNT(*) AS stale_count
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.set_id IS NOT NULL
    AND (
      e.thumbnail_url LIKE '%Black_2880_2880_default%'
      OR e.thumbnail_url LIKE '%capture_/image%'
      OR e.thumbnail_url ~ 'https://assets\.nbatopshot\.com/resize/editions/[0-9]+_[0-9]+/Hero_2880_2880_Transparent\.png'
    )
  GROUP BY e.set_id
  ORDER BY stale_count DESC
  LIMIT p_limit
$$;

REVOKE ALL ON FUNCTION public.topshot_sets_with_stale_thumbnails(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_sets_with_stale_thumbnails(INT) TO service_role;
