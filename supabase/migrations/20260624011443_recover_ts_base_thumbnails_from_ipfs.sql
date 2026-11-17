-- Recover broken legacy TS base-edition thumbnails at the DB source. ~9,058 base
-- editions store thumbnail_url on the dead assets.nbatopshot.com/editions/<set>/<uuid>
-- path (404s); 7,517 have a still image in the on-chain IPFS catalog
-- (topshot_ipfs_assets, parallel='Base'). Set thumbnail_url to the
-- ipfs.dapperlabs.com/ipfs/<hero_cid> form (same format the 185 already-working
-- IPFS thumbnails use; host is CSP-whitelisted). All targets are BASE editions
-- (0 parallels in the broken set) so there is no subID/parallel-mismatch risk;
-- player+set names verified to match the catalog. Belt-and-suspenders alongside
-- the rep_nft_id render-time fix: this corrects the source for /share, OG cards,
-- and every non-RPC consumer, and recovers the ~111 mintless editions rep_nft_id
-- could not. Backup table makes it exactly reversible.

CREATE TABLE IF NOT EXISTS public.audit_20260623_ts_thumb_ipfs_backfill (
  edition_id uuid PRIMARY KEY,
  old_thumbnail_url text,
  new_thumbnail_url text,
  backed_up_at timestamptz DEFAULT now()
);
ALTER TABLE public.audit_20260623_ts_thumb_ipfs_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260623_ts_thumb_ipfs_backfill FROM anon, authenticated;

WITH targets AS (
  SELECT e.id, e.thumbnail_url AS old_url,
    'https://ipfs.dapperlabs.com/ipfs/' || (
      SELECT a.hero_cid FROM public.topshot_ipfs_assets a
      WHERE a.set_flow_id = e.set_id_onchain AND a.play_flow_id = e.play_id_onchain
        AND a.parallel = 'Base' AND a.hero_cid IS NOT NULL
      ORDER BY a.loaded_at DESC LIMIT 1
    ) AS new_url
  FROM public.editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%'
    AND e.external_id NOT LIKE '%::%'
    AND e.set_id_onchain IS NOT NULL AND e.play_id_onchain IS NOT NULL
)
INSERT INTO public.audit_20260623_ts_thumb_ipfs_backfill (edition_id, old_thumbnail_url, new_thumbnail_url)
SELECT id, old_url, new_url FROM targets WHERE new_url IS NOT NULL
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e
SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260623_ts_thumb_ipfs_backfill b
WHERE e.id = b.edition_id;
