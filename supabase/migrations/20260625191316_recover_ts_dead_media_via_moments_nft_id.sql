-- Applied live 2026-06-25 (audit_20260625_recover_ts_dead_media_via_moments_nft_id);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Revert: UPDATE editions e SET thumbnail_url=b.old_thumbnail_url, video_url=b.old_video_url
--   FROM audit_20260625_ts_wnba_media_recovery b WHERE e.id=b.edition_id;

-- Follow-up to audit_20260625_recover_ts_wnba_media_from_per_moment_cdn: recover the dead-media
-- editions that have NO wmc holder but DO have a moments.nft_id (the on-chain id) — the wmc-only
-- recovery missed these. 4 Heroes-of-the-Game editions. Same proven per-moment CDN form, same
-- backup table (extended). Better-or-equal (old editions/ URLs already 404).
WITH dead_m AS (
  SELECT e.id AS edition_id, e.thumbnail_url AS old_thumb, e.video_url AS old_video,
    (SELECT m.nft_id FROM public.moments m
     WHERE m.edition_id = e.id AND m.nft_id IS NOT NULL ORDER BY m.nft_id LIMIT 1) AS rep
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%'
      OR e.video_url LIKE '%assets.nbatopshot.com/editions/%')
    AND EXISTS (SELECT 1 FROM public.moments m WHERE m.edition_id = e.id AND m.nft_id IS NOT NULL)
)
INSERT INTO public.audit_20260625_ts_wnba_media_recovery
  (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url)
SELECT edition_id, old_thumb,
  CASE WHEN old_thumb LIKE '%assets.nbatopshot.com/editions/%'
       THEN 'https://assets.nbatopshot.com/media/' || rep || '/image?width=400' END,
  old_video,
  CASE WHEN old_video LIKE '%assets.nbatopshot.com/editions/%'
       THEN 'https://assets.nbatopshot.com/media/' || rep || '/video' END
FROM dead_m WHERE rep IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_thumbnail_url IS NOT NULL
  AND e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%';

UPDATE public.editions e SET video_url = b.new_video_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_video_url IS NOT NULL
  AND e.video_url LIKE '%assets.nbatopshot.com/editions/%';
