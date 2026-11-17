-- Applied live 2026-06-26 (audit_20260626_recover_ts_parallel_null_thumb_via_subedition_nft);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Result: backed_up=141 `::` subedition parallels; canonical TS null-thumb 149 -> 8
--   (the 8 remaining are non-parallel base editions w/ no subedition rep — need GQL mint
--   discovery, a tiny niche). check_public_security_invariants()=0, backup RLS-on/anon 0.
-- Revert: UPDATE editions e SET thumbnail_url=b.old_thumbnail_url, video_url=b.old_video_url
--   FROM audit_20260626_ts_parallel_thumb_recovery b WHERE e.id=b.edition_id;

-- Data-quality follow-up to audit_20260626_recover_canonical_ts_null_thumb_via_per_moment_cdn.
-- That pass left 149 canonical TS null-thumbnail editions; 141 are `::` subedition parallels
-- whose representative moment the wmc/moments rep lookup missed. topshot_moment_subeditions
-- (nft_id, base_external_id, subedition_id) DOES carry a minted nft of each exact parallel —
-- so media/<nft_id>/image|video is PER-PARALLEL-CORRECT (not base art). CDN verified serving
-- real image/jpeg + video/mp4 (HTTP 200, 3 sampled) before writing. Better-or-equal: currently
-- NULL. Backup table retained for exact revert.
CREATE TABLE IF NOT EXISTS public.audit_20260626_ts_parallel_thumb_recovery (
  edition_id uuid PRIMARY KEY,
  old_thumbnail_url text, new_thumbnail_url text,
  old_video_url text, new_video_url text,
  rep_nft_id text,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.audit_20260626_ts_parallel_thumb_recovery ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260626_ts_parallel_thumb_recovery FROM anon, authenticated;

WITH reps AS (
  SELECT e.id AS edition_id, e.thumbnail_url AS old_thumb, e.video_url AS old_video,
    (SELECT s.nft_id FROM public.topshot_moment_subeditions s
      WHERE s.base_external_id = split_part(e.external_id,'::',1)
        AND s.subedition_id = split_part(e.external_id,'::',2)::smallint
      ORDER BY s.nft_id LIMIT 1) AS rep
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.external_id ~ '^[0-9]+:[0-9]+::[0-9]+$'
    AND e.thumbnail_url IS NULL
)
INSERT INTO public.audit_20260626_ts_parallel_thumb_recovery
  (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url, rep_nft_id)
SELECT edition_id, old_thumb,
  'https://assets.nbatopshot.com/media/' || rep || '/image?width=400',
  old_video,
  CASE WHEN old_video IS NULL THEN 'https://assets.nbatopshot.com/media/' || rep || '/video' END,
  rep
FROM reps WHERE rep IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260626_ts_parallel_thumb_recovery b
WHERE e.id = b.edition_id AND e.thumbnail_url IS NULL;

UPDATE public.editions e SET video_url = b.new_video_url
FROM public.audit_20260626_ts_parallel_thumb_recovery b
WHERE e.id = b.edition_id AND b.new_video_url IS NOT NULL AND e.video_url IS NULL;
