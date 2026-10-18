-- 2026-10-18 11:07 AM PT (Cowork cloud; Trevor "Keep going").
-- Follow-up to 20261018175246 (UFC missing editions from the chain). The 35 ORIGIN 1/1
-- editions it created took the chain's "preview" / "image", which for those sets point at
-- media.gigantik.io, a host absent from next.config images.remotePatterns and from the
-- ipfs-media proxy (every other UFC edition is on ipfs.io). The same sets carry
-- "ipfs_preview" / "ipfs_image" (same content ids, ipfs.io), read in the same verified
-- pg_net responses (net._http_response 1816550, 1816551). Switch to those.
-- REVERT: set thumbnail_url / video_url back from the editions_m6_created rows' sets via the
-- same responses' "preview" / "image" (or leave: the ipfs URLs are the same content).
DO $$
DECLARE c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023'; n int;
BEGIN
  CREATE TEMP TABLE _m ON COMMIT DROP AS
  WITH resp AS (SELECT content FROM net._http_response WHERE id IN (1816550, 1816551) AND status_code = 200),
  j AS (SELECT convert_from(decode(content::jsonb #>> '{}','base64'),'UTF8')::jsonb j FROM resp),
  s AS (SELECT (e->'key'->>'value')::int set_id, e->'value'->'value' kv FROM j, jsonb_array_elements(j->'value') e)
  SELECT s.set_id, f.m->>'ipfs_preview' AS ipfs_preview, f.m->>'ipfs_image' AS ipfs_image
    FROM s CROSS JOIN LATERAL (SELECT jsonb_object_agg(k->'key'->>'value', k->'value'->>'value') m FROM jsonb_array_elements(s.kv) k) f;
  UPDATE public.editions e SET thumbnail_url = m.ipfs_preview, video_url = m.ipfs_image, updated_at = now()
    FROM public.ufc_chain_set_editions c JOIN _m m ON m.set_id = c.set_id
   WHERE c.edition_id = e.id AND e.collection_id = c_ufc
     AND (e.thumbnail_url LIKE 'https://media.gigantik.io/%' OR e.video_url LIKE 'https://media.gigantik.io/%')
     AND m.ipfs_preview LIKE 'https://ipfs.io/ipfs/%' AND m.ipfs_image LIKE 'https://ipfs.io/ipfs/%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 35 THEN RAISE EXCEPTION 'expected 35 gigantik editions, updated %', n; END IF;
  -- Scoped to the editions this read covers: two older editions (sets 621, 623) carry a
  -- gigantik VIDEO only (thumbnails on ipfs.io) and are outside this read; left as they are.
  IF EXISTS (SELECT 1 FROM public.editions e JOIN public.ufc_chain_set_editions c ON c.edition_id = e.id
              WHERE e.collection_id = c_ufc AND c.set_id IN (SELECT set_id FROM _m)
                AND (e.thumbnail_url LIKE '%gigantik%' OR e.video_url LIKE '%gigantik%')) THEN
    RAISE EXCEPTION 'a gigantik URL survived';
  END IF;
END $$;
