
-- REVERT audit_20260624_recover_allday_video_url_to_media_cdn. The form it used
-- (from lib/media/momentVideoUrl.ts, "verified 2026-05") is STALE: live test shows
-- media.nflallday.com/editions/<id>/media/video?format=mp4 returns "ERROR 9401:
-- 'mp4' is not a supported output format" — that endpoint is an image resizer
-- (jpeg/webp/avif/json), not video. The new URLs are broken too, so restore the
-- original values (the dead assets.nflallday.com MP4s — same pre-migration state,
-- which at least reflects the real historical asset path). The correct current
-- AllDay video CDN form is unknown and needs frontend discovery (nflallday.com is
-- WAF-blocked from here). NOTE: momentVideoUrl.ts itself carries the stale form ->
-- the Trophy modal's AllDay video is also broken; fix the helper once the real
-- form is found.
UPDATE public.editions e
SET video_url = b.old_video_url
FROM public.audit_20260624_allday_video_backfill b
WHERE e.id = b.edition_id;

DROP TABLE IF EXISTS public.audit_20260624_allday_video_backfill;
