-- 2026-09-25 (PT) — the last pack distributions any recorded pack event points
-- at that were missing from pack_distributions:
--   · 11 Top Shot dists referenced only by topshot_pack_sales_history (one
--     marketplace sale each, 2024–26). Studio Platform (byProductID "TopShot")
--     answered all 11 with title + image; read ~9:05 PM PT. Studio's
--     numberOfPackSlots = 0 means "not set", so it is stored NULL, never 0.
--   · 3 Disney Pinnacle dists released today ("Summer Sunset", 8872–8874;
--     777 opens already in pinnacle_pack_opens). Studio does not list them yet
--     (compute-pinnacle-pack-ev seeds from Studio, so it would not add them);
--     title/tier/slots/price from the PDS contract (productID "disney"). No
--     image — Pinnacle publishes no pack art anywhere (20260926022452). The
--     row shape follows compute-pinnacle-pack-ev (nft_type "Pinnacle",
--     metadata.retail_price_usd in dollars), whose upsert will own the row
--     once Studio lists it.
-- Counts left unknown (0/0) as for every backfilled dist today.
--
-- Revert: DELETE FROM pack_distributions WHERE metadata->>'seeded_from' =
-- 'last_missing_dists_20260925'.

WITH v(collection_id, dist_id, title, nft_type, image_url, tier, slots, price, uuid, start_time, end_time, source) AS (VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '688', 'Rookie Debut: Mouhamed Gueye Leaderboard Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/common/pack_6_rookie_debut_mouhamed_gueye_lb_reward.png', 'common', 0, NULL::numeric, '287804be-699e-40de-8119-117f2f0f2f0d', '2023-11-14T11:56:12Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '1283', 'For the Win Steph Curry Set Challenge Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/pack_6_for_the_win_steph_curry_set_challenge_reward.png', 'rare', 1, NULL, 'af76baf5-19a9-412e-a935-df13d2517298', '2024-04-30T19:30:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '2536', 'Denver Nuggets Single Moment Pack', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/common/pack_5_denver_nuggets_new_user.png', 'common', 0, NULL, 'dadf8b5f-c14c-43cb-8ab8-fcb3c6ca0cc8', '2024-05-01T19:30:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '2811', 'Miami Heat Single Moment Pack', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/common/pack_5_miami_heat_new_user.png', 'common', 0, NULL, '0438e8b4-eee9-4025-a327-802a59cc73f8', '2024-05-01T19:30:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '3665', 'Run It Back: Glenn Robinson Airdrop', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/pack_6_run_it_back_glenn_robinson_airdrop.png', 'rare', 0, NULL, 'c7154df3-d6d2-4409-8425-be1eeea18af8', '2024-09-17T19:30:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '4678', 'Metallic Gold LE Rare Jordan Poole Crafting Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/pack_7_metallic_gold_le_rare_jordan_poole_crafting_reward.png', 'rare', 1, NULL, '03aa6444-a770-4daf-8d12-b0677fd19c15', '2025-01-07T19:30:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '5288', 'Luke Kornet Rare Trade-In Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/pack_7_luke_koronet_trade_in_reward_rare_may_20_2025.png', 'rare', 1, NULL, '386a7649-791a-4d54-a414-3af3b57a9ea3', '2025-05-20T04:00:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '5574', 'Kiki Iriafen Fresh Gems Reward Pack', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/2035169b-8d96-4aff-973d-87ef6e1fdd5c.png', 'rare', 1, NULL, '2035169b-8d96-4aff-973d-87ef6e1fdd5c', '2025-08-06T04:00:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '5826', 'Aneesah Morrow Metallic Gold LE Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/24d980a4-67f2-4c19-a9fb-47e6ca6f4f99.png', 'rare', 1, NULL, '24d980a4-67f2-4c19-a9fb-47e6ca6f4f99', '2025-09-25T04:00:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '7353', 'Suns All-Time Leaderboard Snapshot 2', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/suns-all-time-leaderboard-snapshot-2.png', 'rare', 0, NULL, '9ef79e66-0b3f-48ee-a9b5-07a89d670129', '2026-02-18T05:00:00Z', NULL, 'studio_platform_gql'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '7612', 'Brandon Miller MGLE Jersey Serial Reward', 'A.0b2a3299cc857e29.PackNFT.NFT', 'https://asset-preview.nbatopshot.com/packs/rare/miller-mgle-jersey-serial-reward.png', 'rare', 0, NULL, '530c59d7-80c4-489d-9a9a-2a6aceba6ae7', '2026-03-31T04:00:00Z', NULL, 'studio_platform_gql'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid, '8872', 'Summer Sunset - Standard - Limited Chase', 'Pinnacle', NULL, 'limited_edition', 1, 4.99, '02d6478e-13ca-4fa4-8237-8289630d69d4', '2026-09-25 16:00:00 +0000 UTC', '2026-10-02 16:00:00 +0000 UTC', 'pds_contract'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid, '8873', 'Summer Sunset - Standard - Limited Standard', 'Pinnacle', NULL, 'limited_edition', 1, 4.99, '1872f124-780b-4bb4-bf8b-0c240814f35a', '2026-09-25 16:00:00 +0000 UTC', '2026-10-02 16:00:00 +0000 UTC', 'pds_contract'),
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid, '8874', 'Summer Sunset - Premium Distribution', 'Pinnacle', NULL, 'limited_edition', 5, 99.99, 'f98e824a-6840-43f5-942b-eb714c0e9dde', '2026-09-25 16:00:00 +0000 UTC', '2026-10-02 16:00:00 +0000 UTC', 'pds_contract')
)
INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
SELECT v.collection_id, v.dist_id, v.title, v.nft_type, v.image_url,
       jsonb_strip_nulls(jsonb_build_object('tier', v.tier, 'number_of_pack_slots', NULLIF(v.slots, 0),
         'retail_price_usd', v.price, 'uuid', v.uuid, 'start_time', v.start_time, 'end_time', v.end_time,
         'seeded_from', 'last_missing_dists_20260925', 'source', v.source))
FROM v
ON CONFLICT (dist_id, collection_id) DO NOTHING;

-- Post-condition: no pack event in any of the event tables points at a
-- missing distribution.
DO $$
DECLARE v_n int;
BEGIN
  SELECT
      (SELECT count(*) FROM public.pinnacle_pack_opens o WHERE NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714' AND pd.dist_id = o.dist_id))
    + (SELECT count(*) FROM public.topshot_pack_sales_history h WHERE h.purchased AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pd.dist_id = h.dist_id))
    + (SELECT count(*) FROM public.golazos_pack_opens o WHERE NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75' AND pd.dist_id = o.dist_id))
    + (SELECT count(*) FROM public.allday_pack_sales_history h WHERE h.purchased AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND pd.dist_id = h.dist_id))
  INTO v_n;
  IF v_n <> 0 THEN RAISE EXCEPTION '% pack events still point at a missing distribution', v_n; END IF;
END $$;
