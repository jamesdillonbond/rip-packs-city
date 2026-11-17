-- Applied live 2026-06-26 (audit_20260626_recover_canonical_ts_null_thumb_via_per_moment_cdn);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Result: backed_up=1427 canonical TS null-thumbnail editions repointed to the proven
--   per-moment CDN form media/<nft_id>/image|video; canonical null-thumb remaining=149
--   (no representative moment anywhere → on-chain mint discovery, separate niche class).
--   check_public_security_invariants()=0, check_secdef_anon_execute_violations()=[].
-- Revert: UPDATE editions e SET thumbnail_url=b.old_thumbnail_url, video_url=b.old_video_url
--   FROM audit_20260626_ts_null_thumb_media_recovery b WHERE e.id=b.edition_id;

-- Data-quality: 1,576 CANONICAL TS editions (1,482 `::` subedition parallels the
-- subedition-aware art cron never filled, + ~94 base) have NULL thumbnail_url, so their
-- edition/share/OG surfaces show no image. ~1,500 have a representative on-chain moment
-- (wmc.moment_id, else moments.nft_id) → repoint to the proven per-moment CDN form
-- media/<nft_id>/image|video (the grid's own primary; for a `::` parallel the rep moment
-- is that parallel's moment, so the art is per-parallel-correct). Canonical only (UUID-dupe
-- inert editions explicitly excluded). Better-or-equal: currently NULL, so a working form is
-- pure gain and a non-resolving one is no worse. Backup table retained for exact revert.

CREATE TABLE IF NOT EXISTS public.audit_20260626_ts_null_thumb_media_recovery (
  edition_id uuid PRIMARY KEY,
  old_thumbnail_url text, new_thumbnail_url text,
  old_video_url text, new_video_url text,
  rep_nft_id text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260626_ts_null_thumb_media_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260626_ts_null_thumb_media_recovery FROM anon, authenticated;

WITH reps AS (
  SELECT e.id AS edition_id, e.thumbnail_url AS old_thumb, e.video_url AS old_video,
    COALESCE(
      (SELECT w.moment_id FROM public.wallet_moments_cache w
        WHERE w.collection_id = e.collection_id AND w.edition_key = e.external_id AND w.moment_id IS NOT NULL
        ORDER BY w.serial_number NULLS LAST LIMIT 1),
      (SELECT m.nft_id FROM public.moments m
        WHERE m.edition_id = e.id AND m.nft_id IS NOT NULL ORDER BY m.nft_id LIMIT 1)
    ) AS rep
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
    AND e.thumbnail_url IS NULL
)
INSERT INTO public.audit_20260626_ts_null_thumb_media_recovery
  (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url, rep_nft_id)
SELECT edition_id, old_thumb,
  'https://assets.nbatopshot.com/media/' || rep || '/image?width=400',
  old_video,
  CASE WHEN old_video IS NULL THEN 'https://assets.nbatopshot.com/media/' || rep || '/video' END,
  rep
FROM reps WHERE rep IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260626_ts_null_thumb_media_recovery b
WHERE e.id = b.edition_id AND e.thumbnail_url IS NULL;

UPDATE public.editions e SET video_url = b.new_video_url
FROM public.audit_20260626_ts_null_thumb_media_recovery b
WHERE e.id = b.edition_id AND b.new_video_url IS NOT NULL AND e.video_url IS NULL;
