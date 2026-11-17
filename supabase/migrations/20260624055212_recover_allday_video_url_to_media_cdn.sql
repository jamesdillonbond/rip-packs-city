
-- Recover AllDay hover-play video. editions.video_url for 6,176/6,191 AllDay
-- editions points at the DEAD assets.nflallday.com/editions/<set>/<uuid>.mp4 CDN
-- (confirmed 404 / S3 not-found). The main grids + edition pages render
-- video_url directly, so AllDay hover-play is broken everywhere except the
-- Trophy modal (which already uses lib/media/momentVideoUrl.ts). Repoint to the
-- canonical working form that helper documents (verified vs live CDNs 2026-05):
--   https://media.nflallday.com/editions/<edition_flow_id>/media/video?width=512&format=mp4
-- where edition_flow_id = editions.external_id (the same id the working AllDay
-- thumbnail at media.nflallday.com/editions/<external_id>/media/image uses; host
-- is already CSP-whitelisted in proxy.ts). All targets have numeric external_id.
-- Dead -> documented-working, so this cannot regress (the current URL 404s).
-- Backup table = exact revert.
--
-- NOTE (parity copy): this v1 form is WRONG — superseded by
-- audit_20260624_revert_allday_video_recovery_stale_form (its revert) and then by
-- audit_20260624_recover_allday_video_url_media_cdn_v2_bare (the correct bare form).
-- Recorded here for migration-history parity; net no-op once all three apply.
CREATE TABLE IF NOT EXISTS public.audit_20260624_allday_video_backfill (
  edition_id uuid PRIMARY KEY,
  old_video_url text,
  new_video_url text,
  backed_up_at timestamptz DEFAULT now()
);
ALTER TABLE public.audit_20260624_allday_video_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260624_allday_video_backfill FROM anon, authenticated;

WITH targets AS (
  SELECT e.id, e.video_url AS old_url,
    'https://media.nflallday.com/editions/' || e.external_id || '/media/video?width=512&format=mp4' AS new_url
  FROM public.editions e
  WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
    AND e.video_url LIKE '%assets.nflallday.com/editions/%'
    AND e.external_id ~ '^[0-9]+$'
)
INSERT INTO public.audit_20260624_allday_video_backfill (edition_id, old_video_url, new_video_url)
SELECT id, old_url, new_url FROM targets
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET video_url = b.new_video_url
FROM public.audit_20260624_allday_video_backfill b
WHERE e.id = b.edition_id;
