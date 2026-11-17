-- Applied live 2026-06-25 (audit_20260625_recover_ts_wnba_media_from_per_moment_cdn);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Revert: UPDATE editions e SET thumbnail_url=b.old_thumbnail_url, video_url=b.old_video_url
--   FROM audit_20260625_ts_wnba_media_recovery b WHERE e.id=b.edition_id;

-- Recover the irreducible TS dead-media tail (803 thumbs / 823 videos still on the dead
-- assets.nbatopshot.com/editions/<set>/<uuid> path — WNBA + residual Base-Set, NOT in the
-- topshot_ipfs_assets catalog so the IPFS recovery + daily art cron can't fix them).
-- Fix = the per-moment CDN form (project-established: media/<nft_id>/image works for any serial,
-- the grid's primary; media/<nft_id>/video is the trophy-modal form) using a representative
-- on-chain moment_id from wmc. No IPFS-catalog extension needed. 788/803 have a rep moment.
-- STRICTLY better-or-equal: the old URLs already 404, so worst case is the same graceful broken
-- state (grid builds its own media URL regardless; /share/OG/sitemap get a real image when the
-- form resolves). Backup table retained for exact revert.

CREATE TABLE IF NOT EXISTS public.audit_20260625_ts_wnba_media_recovery (
  edition_id uuid PRIMARY KEY,
  old_thumbnail_url text, new_thumbnail_url text,
  old_video_url text, new_video_url text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260625_ts_wnba_media_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260625_ts_wnba_media_recovery FROM anon, authenticated;

WITH reps AS (
  SELECT e.id AS edition_id, e.thumbnail_url AS old_thumb, e.video_url AS old_video,
    (SELECT w.moment_id FROM public.wallet_moments_cache w
     WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id AND w.moment_id IS NOT NULL
     ORDER BY w.serial_number NULLS LAST LIMIT 1) AS rep
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%'
      OR e.video_url LIKE '%assets.nbatopshot.com/editions/%')
)
INSERT INTO public.audit_20260625_ts_wnba_media_recovery
  (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url)
SELECT edition_id, old_thumb,
  CASE WHEN old_thumb LIKE '%assets.nbatopshot.com/editions/%'
       THEN 'https://assets.nbatopshot.com/media/' || rep || '/image?width=400' END,
  old_video,
  CASE WHEN old_video LIKE '%assets.nbatopshot.com/editions/%'
       THEN 'https://assets.nbatopshot.com/media/' || rep || '/video' END
FROM reps WHERE rep IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_thumbnail_url IS NOT NULL
  AND e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%';

UPDATE public.editions e SET video_url = b.new_video_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_video_url IS NOT NULL
  AND e.video_url LIKE '%assets.nbatopshot.com/editions/%';
