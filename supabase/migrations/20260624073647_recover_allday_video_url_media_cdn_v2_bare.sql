
-- Recover AllDay hover-play video — CORRECT form (v2). The dead assets.nflallday.com
-- MP4s (6,176 editions) -> the live form confirmed by reading app.nflallday.com's
-- own <video> elements + a direct navigation returning Content-Type video/mp4:
--   https://media.nflallday.com/editions/<edition_flow_id>/media/video   (NO query params)
-- (v1 failed because lib/media/momentVideoUrl.ts appended ?width=512&format=mp4, which
-- that image-resizer endpoint rejects with "9401: mp4 not a supported output format";
-- the bare /media/video path is a distinct video route.) edition_flow_id = external_id.
-- Editions without a video gracefully 404 -> tile falls back to thumbnail (no worse
-- than the current all-dead state). Backup table = exact revert.
CREATE TABLE IF NOT EXISTS public.audit_20260624_allday_video_backfill_v2 (
  edition_id uuid PRIMARY KEY,
  old_video_url text,
  new_video_url text,
  backed_up_at timestamptz DEFAULT now()
);
ALTER TABLE public.audit_20260624_allday_video_backfill_v2 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260624_allday_video_backfill_v2 FROM anon, authenticated;

WITH targets AS (
  SELECT e.id, e.video_url AS old_url,
    'https://media.nflallday.com/editions/' || e.external_id || '/media/video' AS new_url
  FROM public.editions e
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND e.video_url LIKE '%assets.nflallday.com/editions/%'
    AND e.external_id ~ '^[0-9]+$'
)
INSERT INTO public.audit_20260624_allday_video_backfill_v2 (edition_id, old_video_url, new_video_url)
SELECT id, old_url, new_url FROM targets
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET video_url = b.new_video_url
FROM public.audit_20260624_allday_video_backfill_v2 b
WHERE e.id = b.edition_id;
