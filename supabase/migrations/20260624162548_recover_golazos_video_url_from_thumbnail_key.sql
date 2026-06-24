
-- Golazos hover-play video recovery.
-- Live form discovered via dapper.market/laliga (Trevor's guidance — collection sites are WAF-gated):
--   https://assets.laligagolazos.com/editions/<editionKey>/play_<editionKey>__capture_Animated_Video_Popout_Black_1080_1080_default.mp4
-- editionKey is already embedded in each edition's thumbnail_url path (/editions/<editionKey>/...).
-- Both editionKey formats (numeric_numeric_recXXX and g-prefixed) verified to serve video/mp4 via browser direct-nav.
-- editions.video_url was NULL for all Golazos → grids showed thumbnail only. Backup table retained for exact revert.

CREATE TABLE IF NOT EXISTS public.audit_20260624_golazos_video_backfill (
  edition_id uuid PRIMARY KEY,
  old_video_url text,
  new_video_url text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260624_golazos_video_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260624_golazos_video_backfill FROM anon, authenticated;

WITH targets AS (
  SELECT
    e.id AS edition_id,
    e.video_url AS old_video_url,
    'https://assets.laligagolazos.com/editions/'
      || split_part(split_part(e.thumbnail_url, '/editions/', 2), '/', 1)
      || '/play_'
      || split_part(split_part(e.thumbnail_url, '/editions/', 2), '/', 1)
      || '__capture_Animated_Video_Popout_Black_1080_1080_default.mp4' AS new_video_url
  FROM public.editions e
  WHERE e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
    AND e.thumbnail_url LIKE '%assets.laligagolazos.com/editions/%'
    AND e.video_url IS NULL
    AND split_part(split_part(e.thumbnail_url, '/editions/', 2), '/', 1) <> ''
)
INSERT INTO public.audit_20260624_golazos_video_backfill (edition_id, old_video_url, new_video_url)
SELECT edition_id, old_video_url, new_video_url FROM targets
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET video_url = b.new_video_url
FROM public.audit_20260624_golazos_video_backfill b
WHERE e.id = b.edition_id
  AND e.video_url IS NULL;
