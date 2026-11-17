-- 2026-11-16 (Claude Code, local) — Candy media URLs on a Candy gateway are rewritten to arweave.net.
--
-- 229 Candy editions (thumbnail), 198 (video) and 6,529 holdings (wallet_moments_cache.image_url) stored
-- their art as https://permaweb.candy.io/<tx>; 2 editions and 2 holdings as https://candy.permaweb.services/<tx>.
-- Neither host is in the site CSP img-src / media-src (only arweave.net and *.arweave.net), and neither
-- reaches the arweave resizer (lib/ipfs-media.ts ARWEAVE_TX_RE), so every one rendered as a blocked image —
-- and permaweb.candy.io's TLS certificate expired 2026-11-15 4:53 PM PT besides. The same content-addressed
-- transaction is served by arweave.net (verified: 3 of 3 sampled thumbnails, 200 image/jpeg).
-- The writers now store the arweave.net form (lib/chains/solana/normalize.ts canonicalCandyMediaUrl).
--
-- Only the exact `<host>/<43-char tx id>` shape is rewritten (all 6,762 measured rows have it).
--
-- Revert:
--   UPDATE public.editions e SET thumbnail_url = a.old_thumbnail, video_url = a.old_video
--     FROM public.audit_20261116_candy_media_urls_to_arweave a
--    WHERE a.tbl = 'editions' AND e.id = a.row_id;
--   UPDATE public.wallet_moments_cache w SET image_url = a.old_image
--     FROM public.audit_20261116_candy_media_urls_to_arweave a
--    WHERE a.tbl = 'wallet_moments_cache' AND w.id = a.row_id;

CREATE TABLE public.audit_20261116_candy_media_urls_to_arweave AS
SELECT 'editions'::text AS tbl, e.id AS row_id, e.thumbnail_url AS old_thumbnail, e.video_url AS old_video, NULL::text AS old_image
  FROM public.editions e
 WHERE e.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
   AND (e.thumbnail_url ~ '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/[A-Za-z0-9_-]{43}$'
     OR e.video_url ~ '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/[A-Za-z0-9_-]{43}$')
UNION ALL
SELECT 'wallet_moments_cache', w.id, NULL, NULL, w.image_url
  FROM public.wallet_moments_cache w
 WHERE w.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
   AND w.image_url ~ '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/[A-Za-z0-9_-]{43}$';

ALTER TABLE public.audit_20261116_candy_media_urls_to_arweave ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261116_candy_media_urls_to_arweave FROM PUBLIC, anon, authenticated;

UPDATE public.editions e
   SET thumbnail_url = regexp_replace(e.thumbnail_url, '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/([A-Za-z0-9_-]{43})$', 'https://arweave.net/\2'),
       video_url     = regexp_replace(e.video_url,     '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/([A-Za-z0-9_-]{43})$', 'https://arweave.net/\2')
  FROM public.audit_20261116_candy_media_urls_to_arweave a
 WHERE a.tbl = 'editions' AND e.id = a.row_id;

UPDATE public.wallet_moments_cache w
   SET image_url = regexp_replace(w.image_url, '^https://(permaweb\.candy\.io|candy\.permaweb\.services)/([A-Za-z0-9_-]{43})$', 'https://arweave.net/\2')
  FROM public.audit_20261116_candy_media_urls_to_arweave a
 WHERE a.tbl = 'wallet_moments_cache' AND w.id = a.row_id;
