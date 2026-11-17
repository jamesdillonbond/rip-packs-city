-- Companion to audit_20260623_recover_ts_base_thumbnails_from_ipfs: recover the
-- dead editions/-path video_url (hover-play) for the same legacy TS base editions.
-- Proven mapping: base edition video_url = ipfs.dapperlabs.com/ipfs/<Base video_cid>
-- (verified url_cid == video_cid on a clean base-edition sample; not square/tall).
-- 7,499 of 9,058 broken base videos recoverable. Backup table for exact revert.
CREATE TABLE IF NOT EXISTS public.audit_20260623_ts_video_ipfs_backfill (
  edition_id uuid PRIMARY KEY,
  old_video_url text,
  new_video_url text,
  backed_up_at timestamptz DEFAULT now()
);
ALTER TABLE public.audit_20260623_ts_video_ipfs_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260623_ts_video_ipfs_backfill FROM anon, authenticated;

WITH targets AS (
  SELECT e.id, e.video_url AS old_url,
    'https://ipfs.dapperlabs.com/ipfs/' || (
      SELECT a.video_cid FROM public.topshot_ipfs_assets a
      WHERE a.set_flow_id = e.set_id_onchain AND a.play_flow_id = e.play_id_onchain
        AND a.parallel = 'Base' AND a.video_cid IS NOT NULL
      ORDER BY a.loaded_at DESC LIMIT 1
    ) AS new_url
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.video_url LIKE '%assets.nbatopshot.com/editions/%'
    AND e.external_id NOT LIKE '%::%'
    AND e.set_id_onchain IS NOT NULL AND e.play_id_onchain IS NOT NULL
)
INSERT INTO public.audit_20260623_ts_video_ipfs_backfill (edition_id, old_video_url, new_video_url)
SELECT id, old_url, new_url FROM targets WHERE new_url IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET video_url = b.new_video_url
FROM public.audit_20260623_ts_video_ipfs_backfill b
WHERE e.id = b.edition_id;
