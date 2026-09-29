-- 2026-09-29 (PT): every image pack_table_rows serves was probed (3,934 distinct URLs, one request each).
-- 14 were dead, on 36 pack_distributions rows. pack_table_rows serves COALESCE(metadata->>'thumbnail',
-- image_url), so each row is repaired in the field that is served. Each class was verified live the same evening:
--   · 6 Golazos rows: metadata.thumbnail is a dead "_v0" URL (404 NoSuchKey); the image_url beside it
--     answers 200 image/png, so the thumbnail takes the image_url.
--   · 9 All Day rows: the URL carries the host TWICE ("https://assets.nflallday.com/https://assets.nflallday.com/tmp/...",
--     404); with the doubled host removed it answers 200 image/png. Both fields are repaired.
--   · 21 rows: no working image in either field (a 404, an empty ".../tmp/" path, or an .mp4 VIDEO in an image
--     slot). Set to NULL, the state the UI already renders for the 158 rows with no art, instead of a failing request.
-- No writer in the repo or DB builds these URLs (they arrived from upstream as-is). Rows backed up first.
-- Revert: UPDATE public.pack_distributions d SET image_url = b.image_url, metadata = b.metadata
--         FROM public.audit_20260929_pack_dist_dead_art_backup b WHERE d.id = b.id;
CREATE TABLE IF NOT EXISTS public.audit_20260929_pack_dist_dead_art_backup AS
  SELECT id, dist_id, image_url, metadata FROM public.pack_distributions
   WHERE id IN ('a528f5c7-13bf-4bd3-9d6e-bd53dd09b253'::uuid, 'd565b6b2-3dad-4950-b34a-13d875cd1ea1'::uuid, '80023e2e-a733-4854-80c3-4162de8994fe'::uuid, 'ad926565-c35d-4ec2-8146-93f61729bde7'::uuid, 'e3244f4d-a03d-4842-85c0-3dc15172fc14'::uuid, '52070efc-15b5-417c-be74-5ddfd67c76f5'::uuid, '94509446-2434-408d-b749-f6179a79f5c9'::uuid, '2fdc38b8-17c9-47f7-a7dd-66d0491b2fe2'::uuid, 'e991a49b-1eee-42d8-adf5-2fad5b456a32'::uuid, 'd7139037-dcae-4cbd-97bc-7af3dceebbc9'::uuid, '7ed71e88-f861-49f2-b3f1-2777fd388549'::uuid, 'faa9272d-04b2-4529-b2d1-76df19f2d879'::uuid, 'e5bdfeab-05e8-46e3-9f18-d41a5e8ec9e7'::uuid, 'eb930fbf-9243-46fe-a6e8-4585b5a8211c'::uuid, '35229c9e-1208-4a58-b6a3-87c2b6732215'::uuid, 'cfa32d10-27b9-4a22-bf90-7e72907b0c1f'::uuid, '45cf0590-341c-4962-9b50-0ed51223204a'::uuid, '8b423220-ffd1-4393-af95-1e6bd1dc48e1'::uuid, '4fca3472-6560-4ef9-8fab-3426df957593'::uuid, '11a5f513-f3c3-4d1a-81c0-24e97adab668'::uuid, '6a850317-759e-413c-8285-f27c9081f516'::uuid, '11b11934-4ba3-47c9-a497-6ca2c778e609'::uuid, 'd0fda90f-5051-4747-b8d4-7c32669e178d'::uuid, 'aaaa6600-d84e-42e3-aefb-b1a750366d2e'::uuid, '939f8b2c-c23c-4d35-9f33-c1d70a8c7c73'::uuid, '112f07a7-7d24-4d32-b966-894525890040'::uuid, '42258050-d225-47a8-903b-66fedc6c83f4'::uuid, '8067b7f7-d0d4-4c87-bb81-5b97e7e1cc21'::uuid, '61329a74-94a3-4e9e-9e4b-ef50ff5caedc'::uuid, '0852e8c7-0545-436c-af3d-54618288c5cd'::uuid, '6bb9a4b8-cf66-4b0b-b7e4-35c2c12c8f08'::uuid, '1d79701c-a383-4ed7-807c-2f43b0edac14'::uuid, 'c5762825-db44-499e-967d-205eb8a03325'::uuid, '42bf19de-ba19-42ab-a6de-1af1583a56f5'::uuid, '52e6f6b2-bc73-4df3-847d-afcb92672cd1'::uuid, '358af238-630d-4729-b4e1-659ca71b13e5'::uuid);
ALTER TABLE public.audit_20260929_pack_dist_dead_art_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260929_pack_dist_dead_art_backup FROM PUBLIC, anon, authenticated;

UPDATE public.pack_distributions
   SET metadata = jsonb_set(metadata, '{thumbnail}', to_jsonb(image_url))
 WHERE id IN ('d565b6b2-3dad-4950-b34a-13d875cd1ea1'::uuid, '80023e2e-a733-4854-80c3-4162de8994fe'::uuid, 'ad926565-c35d-4ec2-8146-93f61729bde7'::uuid, 'e3244f4d-a03d-4842-85c0-3dc15172fc14'::uuid, '52070efc-15b5-417c-be74-5ddfd67c76f5'::uuid, '94509446-2434-408d-b749-f6179a79f5c9'::uuid)
   AND metadata->>'thumbnail' LIKE '%\_v0/images/pack.png' AND image_url NOT LIKE '%\_v0/%';

UPDATE public.pack_distributions
   SET image_url = regexp_replace(image_url, '^(https://[^/]+/)https://[^/]+/', '\1'),
       metadata  = CASE WHEN metadata ? 'thumbnail'
                        THEN jsonb_set(metadata, '{thumbnail}', to_jsonb(regexp_replace(metadata->>'thumbnail', '^(https://[^/]+/)https://[^/]+/', '\1')))
                        ELSE metadata END
 WHERE id IN ('faa9272d-04b2-4529-b2d1-76df19f2d879'::uuid, 'e5bdfeab-05e8-46e3-9f18-d41a5e8ec9e7'::uuid, 'eb930fbf-9243-46fe-a6e8-4585b5a8211c'::uuid, '35229c9e-1208-4a58-b6a3-87c2b6732215'::uuid, 'cfa32d10-27b9-4a22-bf90-7e72907b0c1f'::uuid, '45cf0590-341c-4962-9b50-0ed51223204a'::uuid, '8b423220-ffd1-4393-af95-1e6bd1dc48e1'::uuid, '4fca3472-6560-4ef9-8fab-3426df957593'::uuid, '11a5f513-f3c3-4d1a-81c0-24e97adab668'::uuid)
   AND image_url ~ '^https://[^/]+/https://';

UPDATE public.pack_distributions
   SET image_url = NULL,
       metadata  = metadata - 'thumbnail'
 WHERE id IN ('a528f5c7-13bf-4bd3-9d6e-bd53dd09b253'::uuid, '2fdc38b8-17c9-47f7-a7dd-66d0491b2fe2'::uuid, 'e991a49b-1eee-42d8-adf5-2fad5b456a32'::uuid, 'd7139037-dcae-4cbd-97bc-7af3dceebbc9'::uuid, '7ed71e88-f861-49f2-b3f1-2777fd388549'::uuid, '6a850317-759e-413c-8285-f27c9081f516'::uuid, '11b11934-4ba3-47c9-a497-6ca2c778e609'::uuid, 'd0fda90f-5051-4747-b8d4-7c32669e178d'::uuid, 'aaaa6600-d84e-42e3-aefb-b1a750366d2e'::uuid, '939f8b2c-c23c-4d35-9f33-c1d70a8c7c73'::uuid, '112f07a7-7d24-4d32-b966-894525890040'::uuid, '42258050-d225-47a8-903b-66fedc6c83f4'::uuid, '8067b7f7-d0d4-4c87-bb81-5b97e7e1cc21'::uuid, '61329a74-94a3-4e9e-9e4b-ef50ff5caedc'::uuid, '0852e8c7-0545-436c-af3d-54618288c5cd'::uuid, '6bb9a4b8-cf66-4b0b-b7e4-35c2c12c8f08'::uuid, '1d79701c-a383-4ed7-807c-2f43b0edac14'::uuid, 'c5762825-db44-499e-967d-205eb8a03325'::uuid, '42bf19de-ba19-42ab-a6de-1af1583a56f5'::uuid, '52e6f6b2-bc73-4df3-847d-afcb92672cd1'::uuid, '358af238-630d-4729-b4e1-659ca71b13e5'::uuid);