-- 2026-10-18 11:25 AM PT (Cowork cloud; Trevor "Keep going").
-- The last two UFC editions with a media.gigantik.io URL (a host the site does not proxy or
-- allow): their VIDEO only. Chain read 2026-10-18, UFC_NFT.getSetMetadata(621 / 623):
--   621 JACK HERMANSSON | UFC FIGHT NIGHT MAR 30, 2019 | SUBMISSION, ipfs_image QmdTWybs...rn9
--   623 JOOSANG YOO | UFC 316 | KO/TKO, ipfs_image QmX5iLMk...eP5
-- REVERT: video_url back to https://media.gigantik.io/ufc/9208fd852a097bb005c82a4b89800352 (621)
--   and https://media.gigantik.io/ufc/6ca9e79a55490bd0bb635d29015d818a (623).
DO $$
DECLARE n int;
BEGIN
  UPDATE public.editions e SET video_url = v.url, updated_at = now()
    FROM (VALUES (621, 'https://ipfs.io/ipfs/QmdTWybsVuQrZv2cco7X2UXYaNKMHSq8PrQBXvAdMVQrn9'),
                 (623, 'https://ipfs.io/ipfs/QmX5iLMkPbszvNHDiL9vrVozppmHF6enzhNQPyZmurneP5')) v(set_id, url)
    JOIN public.ufc_chain_set_editions c ON c.set_id = v.set_id
   WHERE e.id = c.edition_id AND e.video_url LIKE 'https://media.gigantik.io/%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 2 THEN RAISE EXCEPTION 'expected 2 editions, updated %', n; END IF;
  IF EXISTS (SELECT 1 FROM public.editions WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
               AND (thumbnail_url LIKE '%gigantik%' OR video_url LIKE '%gigantik%')) THEN
    RAISE EXCEPTION 'a gigantik URL survived';
  END IF;
END $$;
