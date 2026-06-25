-- Applied live 2026-06-25 (audit_20260625_recover_ts_wnba_ultimates_media_via_minted_flowid);
-- repo-parity copy, record-only — never re-applied (prod already migrated).
-- Revert: UPDATE editions e SET thumbnail_url=b.old_thumbnail_url, video_url=b.old_video_url
--   FROM audit_20260625_ts_wnba_media_recovery b WHERE e.id=b.edition_id;

-- Final dead-media tail (11 WNBA Rookie Ultimates, sets 151/198) — NO moment in
-- wmc/moments/sales, so the wmc + moments.nft_id passes couldn't reach them. Resolved a
-- representative minted moment flowId per edition via searchMintedMoments (serial #1, any
-- minted; through the topshot-proxy worker) and verified the per-moment CDN form serves real
-- image/jpeg + video/mp4 (HTTP 200) before writing. Same proven media/<nft_id> form + same
-- backup table (extended). Better-or-equal: the old editions/ URLs already 404. Keyed by
-- external_id->flowId (join self-verifies). After this, the TS dead-media tail is 0/0.
WITH m(external_id, flow_id) AS (VALUES
  ('151:5421','47085182'),('151:5504','47145945'),('151:5543','47172754'),
  ('151:5629','47256799'),('151:5654','47294349'),
  ('198:6989','49694324'),('198:7205','50104290'),('198:7310','50223353'),
  ('198:7334','50241944'),('198:7335','50244169'),('198:7395','50253814')
)
INSERT INTO public.audit_20260625_ts_wnba_media_recovery
  (edition_id, old_thumbnail_url, new_thumbnail_url, old_video_url, new_video_url)
SELECT e.id, e.thumbnail_url,
  'https://assets.nbatopshot.com/media/' || m.flow_id || '/image?width=400',
  e.video_url,
  'https://assets.nbatopshot.com/media/' || m.flow_id || '/video'
FROM m JOIN public.editions e
  ON e.external_id = m.external_id AND e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
WHERE e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%'
   OR e.video_url LIKE '%assets.nbatopshot.com/editions/%'
ON CONFLICT (edition_id) DO NOTHING;

UPDATE public.editions e SET thumbnail_url = b.new_thumbnail_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_thumbnail_url LIKE '%/media/%'
  AND e.thumbnail_url LIKE '%assets.nbatopshot.com/editions/%';

UPDATE public.editions e SET video_url = b.new_video_url
FROM public.audit_20260625_ts_wnba_media_recovery b
WHERE e.id = b.edition_id AND b.new_video_url LIKE '%/media/%'
  AND e.video_url LIKE '%assets.nbatopshot.com/editions/%';
