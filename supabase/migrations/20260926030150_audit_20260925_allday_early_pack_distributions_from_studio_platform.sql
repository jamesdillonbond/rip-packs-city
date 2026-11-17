-- 2026-09-25 (PT) — 151 NFL All Day pack distributions that 453,796 recorded
-- pack opens point at did not exist in pack_distributions, so every one of
-- those opens rendered as a nameless "Pack" with no image (Trevor's history:
-- 58 of his All Day opens). Plus 7 existing low-id rows carrying a wrong title
-- or a BACKGROUND image instead of the pack art.
--
-- WHY. The All Day seeder (seed-allday-pack-distributions) walks the PDS
-- contract, which does not hold All Day's 2022–23 distributions (ids 1–179);
-- only a handful were seeded, from Dapper's per-pack searchPackNft index.
--
-- SOURCE. Dapper Studio Platform GraphQL, searchDistributions(byProductID:
-- "AllDay", byIDs), read ~8:25 PM PT via pg_net: 154 of 154 requested ids
-- answered, every one with a title and a DEFAULT image.
--   · ID NAMESPACE CONTROL: for the 25 low-id All Day rows we already had, the
--     API title equals ours on 23; the 2 others (dists 2 and 151) both carry
--     the SAME stray title, "Dak Prescott - Rookie Rewind Gold: Sapphire
--     Reward", which Dapper's own per-pack index gives for only 1 of dist 2's
--     4 titled packs (3 say "Standard (Series 1, Week 13)") and which cannot be
--     a 55,000-pack distribution. The API is right; ours is corrected below.
--   · IMAGES: 18 of 25 equal; 5 of the other 7 are our copy of the pack's
--     BACKGROUND (…PACKBG…, …PLAYOFF_BGs…) where the API gives the pack art;
--     2 are the stray Dak image. 14 target URLs fetched: all image/png.
--   · Row text is literal and was md5-checked against the API response
--     (151 rows, identical digest) before this file was written.
-- COUNTS ARE LEFT UNKNOWN (total_minted = total_opened = 0, the same
-- convention as Top Shot dist 8825): v_allday_pack_info covers none of these
-- ids, our own rip counts run 0–4 % short of Dapper's on dists where both are
-- known, and the API's totalSupply disagrees with the chain's mint count by
-- ~2 %. A count we cannot stand behind is not written.
--
-- Revert: DELETE FROM pack_distributions WHERE collection_id =
-- 'dee28451-5d62-409e-a1ad-a83f763ac070' AND metadata->>'seeded_from' =
-- 'studio_platform_gql_backfill_20260925'; restore the 7 corrected rows from
-- audit_20260925_allday_low_dist_fix_backup (drop after 2026-10-02).

CREATE TABLE IF NOT EXISTS public.audit_20260925_allday_low_dist_fix_backup AS
SELECT id, dist_id, title, image_url, metadata, updated_at
FROM public.pack_distributions
WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
  AND dist_id IN ('2', '3', '5', '9', '10', '11', '151');
ALTER TABLE public.audit_20260925_allday_low_dist_fix_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_allday_low_dist_fix_backup FROM PUBLIC, anon, authenticated;

WITH v(dist_id, title, image_url, tier, slots, uuid, start_time, end_time) AS (VALUES
  ('1', 'Premium (Series 1, Week 13)', 'https://assets.nflallday.com/tmp/NFL_PACKS_PREMIUM_WK_13.png', 'premium', 4, '4581feee-b612-4ac8-8d86-c84446f069ff', '2022-02-25T23:00:00Z', '2022-02-01T17:00:00Z'),
  ('4', 'Premium (Series 1, Week 14)', 'https://assets.nflallday.com/tmp/NFL_PACKS_PREMIUM_WK_14.png', 'premium', 4, 'd8de5d95-3bf0-45dc-af18-0c334e768e7f', '2022-03-02T23:00:00Z', '2022-03-03T01:25:00Z'),
  ('6', 'Premium (Series 1, Week 17)', 'https://assets.nflallday.com/tmp/NFL_PACKS_PREMIUM_WK_17.png', 'premium', 4, '821e0f39-70de-410e-945f-f8c636e1c2f8', '2022-03-04T23:00:00Z', '2022-03-05T01:00:00Z'),
  ('8', 'Premium (Series 1, Week 18)', 'https://assets.nflallday.com/tmp/NFL_PACKS_PREMIUM_WK_18.png', 'premium', 4, '014a92d8-2231-48f6-8419-0284f6f798fd', '2022-03-11T23:00:00Z', '2022-03-11T19:00:00Z'),
  ('17', 'Rewind: Reward (Series 1, Release 1)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, 'e3753989-3d8f-48d6-ae0b-7270b2c45c7e', '2022-06-09T21:00:00Z', '2022-06-11T21:00:00Z'),
  ('18', 'Rewind: Reward (Series 1, Release 1.1)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, 'b3c842c9-1de6-466d-b500-48d0711c8881', '2022-06-09T21:00:00Z', '2022-06-11T21:00:00Z'),
  ('19', 'Rewind: Reward (Series 1, Release 2)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD1.png', 'standard', 3, '94921f3e-4370-4a70-98a3-55594beee01c', '2022-06-21T21:00:00Z', '2022-06-22T21:00:00Z'),
  ('20', 'Rewind: Reward (Series 1, Release 3)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, '2f444d83-490a-4233-9e58-4ec2b61a55ff', '2022-06-21T21:00:00Z', '2022-06-22T21:00:00Z'),
  ('22', 'Rewind: Reward (Series 1, Release 4)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD1.png', 'standard', 3, 'c3db814d-9338-4583-876f-61da94f07acf', '2022-08-01T21:00:00Z', '2022-08-02T21:00:00Z'),
  ('23', 'Rewind: Reward (Series 1, Release 5)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, 'eb74ca0a-69f6-4488-89a1-434cf8e1cf0f', '2022-08-01T21:00:00Z', '2022-08-02T21:00:00Z'),
  ('24', 'Rewind: Reward (Series 1, Release 6)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD3.png', 'premium', 5, '58ea92f7-8449-4537-905d-8ca24d69a55e', '2022-08-01T21:00:00Z', '2022-08-02T21:00:00Z'),
  ('25', 'Rewind: Reward (Series 1, Release 7)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD1.png', 'standard', 3, 'c65454d2-0894-4fa5-9fd1-9e5d61354350', '2022-08-08T21:00:00Z', '2022-08-09T21:00:00Z'),
  ('26', 'Rewind: Reward (Series 1, Release 8)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, 'cef8a02b-9514-443d-999d-0e474114053b', '2022-08-08T21:00:00Z', '2022-08-09T21:00:00Z'),
  ('27', 'Enshrinement: Class of 2022', 'https://assets.nflallday.com/tmp/NFL_PACKS_HOF2022.png', 'premium', 1, '16f1ff5a-2dd1-4d7d-8607-ec0530719aa9', '2022-08-12T17:00:00Z', '2022-08-12T17:00:00Z'),
  ('32', 'Rewind: Reward (Series 1, Release 10)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD2.png', 'standard', 3, '1da9de70-4eee-462f-af0d-b76104e0f161', '2022-08-23T21:00:00Z', '2022-08-24T21:00:00Z'),
  ('33', 'Rewind: Reward (Series 1, Release 11)', 'https://assets.nflallday.com/tmp/NFL_PACKS_REWINDREWARD3.png', 'premium', 3, '59523020-808c-4914-9729-94145c74dee8', '2022-08-23T21:00:00Z', '2022-08-24T21:00:00Z'),
  ('34', 'Historical II: Modern Greatness', 'https://assets.nflallday.com/tmp/7_HistoricalDrop2.png', 'standard', 4, 'fb00f0b7-f390-414a-a1e9-908e2f447abd', '2022-09-01T20:30:00Z', '2022-09-01T20:00:00Z'),
  ('35', 'Celebration (Series 1, Release 2)', 'https://assets.nflallday.com/tmp/NFL_PACKS_CELEBRATIONBLUE.png', 'standard', 3, 'c75700da-29a6-4da7-8fc5-d880b70c29e4', '2022-09-06T10:00:00Z', '2022-09-06T11:00:00Z'),
  ('36', '4th & Goal (Series 1)', 'https://assets.nflallday.com/tmp/NFL-PACKS_4thandGoal.png', 'standard', 4, 'ec060bbc-5330-4d59-8cdb-62196bc4efbc', '2022-09-10T16:00:00Z', '2022-09-11T16:00:00Z'),
  ('37', 'Playbook: One-Star Reward (Series 2, Week 1)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week1Playbook/_Reward_01.png', 'standard', 1, '0a648a51-0a53-446d-8aa8-464b8e739f75', '2022-09-06T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('38', 'Playbook: Two-Star Reward (Series 2, Week 1)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week1Playbook/_Reward_02.png', 'standard', 2, '91d33c63-3b15-46be-a31a-03f876d71682', '2022-09-06T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('39', 'Playbook: Three-Star Reward (Series 2, Week 1)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week1Playbook/_Reward_03.png', 'standard', 3, 'fc241bcf-8d4b-4258-8c88-1cd93c57e35b', '2022-09-06T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('40', 'Playbook: Four-Star Reward (Series 2, Week 1)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week1Playbook/_Reward_04.png', 'standard', 3, '6856d102-6ce6-4b4f-8af4-7b9d81779928', '2022-09-06T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('41', 'Playbook: Five-Star Reward (Series 2, Week 1)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week1Playbook/_Reward_05.png', 'standard', 3, 'e60615c0-e873-4936-9f76-e7b65920a822', '2022-09-06T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('42', 'Playbook: One-Star Reward (Series 2, Week 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week2Playbook/Week2_Reward_01.png', 'standard', 1, 'f92db672-0d4a-49b9-90e3-7052b66167a2', '2022-09-12T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('43', 'Playbook: Two-Star Reward (Series 2, Week 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week2Playbook/Week2_Reward_02.png', 'standard', 2, '42f12af8-803a-4c56-a213-ecca6f9bb552', '2022-09-12T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('44', 'Playbook: Three-Star Reward (Series 2, Week 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week2Playbook/Week2_Reward_03.png', 'standard', 3, '96adfffe-7580-4e48-9c41-8cdf7ed2e274', '2022-09-12T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('45', 'Playbook: Four-Star Reward (Series 2, Week 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week2Playbook/Week2_Reward_04.png', 'standard', 3, '53c41430-a766-47a4-a71f-1cc178d47bcc', '2022-09-12T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('46', 'Playbook: Five-Star Reward (Series 2, Week 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week2Playbook/Week2_Reward_05.png', 'premium', 3, '8b8b281f-d015-4d9f-959c-396d831867ea', '2022-09-12T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('47', 'Premium (Series 2, Week 1-2)', 'https://assets.nflallday.com/tmp/NFL_PACKS_W1-2_PREM.png', 'premium', 8, '425c6882-2b87-4108-a96d-34f9b2d1d9db', '2022-09-27T19:00:00Z', '2022-09-28T19:00:00Z'),
  ('49', 'Playbook: One-Star Reward (Series 2, Week 3)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week3Playbook/Week3_Reward_Pack_01.png', 'standard', 1, 'fe5bacd0-f324-4211-adc3-07832395d7f4', '2022-09-20T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('50', 'Playbook: Two-Star Reward (Series 2, Week 3)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week3Playbook/Week3_Reward_Pack_02.png', 'standard', 2, '321fbb6f-5441-4a36-8957-63b85f80ddeb', '2022-09-20T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('51', 'Playbook: Three-Star Reward (Series 2, Week 3)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week3Playbook/Week3_Reward_Pack_03.png', 'standard', 3, '555b29f9-aa2f-4f2d-95d2-7f4bc7eeb5f8', '2022-09-20T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('52', 'Playbook: Four-Star Reward (Series 2, Week 3)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week3Playbook/Week3_Reward_Pack_04.png', 'standard', 3, 'ad3b8caf-17e3-4d4f-afe9-c8cffea65e86', '2022-09-20T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('53', 'Playbook: Five-Star Reward (Series 2, Week 3)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week3Playbook/Week3_Reward_Pack_05.png', 'premium', 3, '0f5e1431-907d-486c-a8ce-da855b093dda', '2022-09-20T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('54', 'Reward (Series 2, Release 1)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Silver.png', 'premium', 3, '0528c74c-05c0-4d42-aa24-f52e6b936f69', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('55', 'Reward (Series 2, Release 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Gold.png', 'premium', 3, '7382d299-6501-4b1b-b7fb-1ba040a4b67b', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('56', 'Playbook: One-Star Reward (Series 2, Week 4)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week4Playbook/Week4_Reward_Pack_01.png', 'standard', 1, '4ce6f70f-9f65-46ea-a79e-f2768577e01c', '2022-09-27T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('57', 'Playbook: Two-Star Reward (Series 2, Week 4)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week4Playbook/Week4_Reward_Pack_02.png', 'standard', 2, '344faa0a-b458-4978-9b90-bae539a5325c', '2022-09-27T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('58', 'Playbook: Three-Star Reward (Series 2, Week 4)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week4Playbook/Week4_Reward_Pack_03.png', 'standard', 3, 'd5c2b7c2-f97e-494a-a4fe-5f87da128051', '2022-09-27T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('59', 'Playbook: Four-Star Reward (Series 2, Week 4)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week4Playbook/Week4_Reward_Pack_04.png', 'standard', 3, '743c9506-a479-4083-97ce-e5d30074a428', '2022-09-27T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('60', 'Playbook: Five-Star Reward (Series 2, Week 4)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week4Playbook/Week4_Reward_Pack_05.png', 'premium', 3, '3bafb67c-dd29-46b9-94aa-32ed1366b73c', '2022-09-27T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('61', 'Premium (Series 2, Week 3-4)', 'https://assets.nflallday.com/tmp/NFL_PACK_WKS_03_04_PRM.png', 'premium', 5, '4ef57cfb-9a45-49cd-819c-21d6ff4dd53f', '2022-10-11T17:00:00Z', '2022-10-11T17:53:00Z'),
  ('63', 'Draw it Up: CeeDee Lamb (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Blue.png', 'standard', 1, '8810f1fa-97c0-42f4-b383-df476c9b2a74', '2022-10-12T17:00:00Z', '2022-10-12T17:00:00Z'),
  ('64', 'Playbook: One-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_01.png', 'standard', 1, 'eb094994-266d-4540-a958-88870e74cce4', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('65', 'Playbook: Two-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_02.png', 'standard', 2, 'c4f61193-b6cd-4df7-9473-703756de10ac', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('66', 'Playbook: Two-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_02.png', 'standard', 2, '5403eb35-b84c-41d9-a66e-1822f44638c0', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('67', 'Playbook: Three-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_03.png', 'standard', 3, 'a1693e77-3c4c-41c8-8493-7ca03c544e06', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('68', 'Playbook: Four-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_04.png', 'standard', 3, '1f374c41-70c1-4fcb-8f05-ef67a7d4afb3', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('69', 'Playbook: Five-Star Reward (Series 2, Week 5)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week5Playbook/Week5_Reward_Pack_05.png', 'premium', 1, 'fb2fab73-6f0b-4975-bf7c-86c4c0544d00', '2022-10-04T18:00:00Z', '2022-10-04T18:00:00Z'),
  ('70', 'Playbook: One-Star Reward (Series 2, Week 6)', 'https://assets.nflallday.com/playbookAssets/week6Playbook/Week6_Reward_Pack_01.png', 'standard', 1, 'af0c0dd5-d24a-4ce9-8e36-aa019385d088', '2022-10-11T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('71', 'Playbook: Two-Star Reward (Series 2, Week 6)', 'https://assets.nflallday.com/playbookAssets/week6Playbook/Week6_Reward_Pack_02.png', 'standard', 2, 'd4e6d161-ae67-4b75-8160-25b18a126d1b', '2022-10-11T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('72', 'Playbook: Three-Star Reward (Series 2, Week 6)', 'https://assets.nflallday.com/playbookAssets/week6Playbook/Week6_Reward_Pack_03.png', 'standard', 3, '25b8ebc8-75ec-4045-9dbe-ed4884ffe908', '2022-10-11T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('73', 'Playbook: Four-Star Reward (Series 2, Week 6)', 'https://assets.nflallday.com/playbookAssets/week6Playbook/Week6_Reward_Pack_04.png', 'standard', 3, 'f7d03e09-2914-49bc-9529-7aca0e05ba65', '2022-10-11T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('74', 'Playbook: Five-Star Reward (Series 2, Week 6)', 'https://assets.nflallday.com/playbookAssets/week6Playbook/Week6_Reward_Pack_05.png', 'premium', 1, 'de49081b-ef1a-4b1e-bcad-25a4ccef1153', '2022-10-11T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('76', 'Legacy: Steve McNair (Historical Series)', 'https://assets.nflallday.com/tmp/NFL-PACK_Historical_Reward_Vaporwave.png', 'standard', 1, '8a845b1d-ec41-4784-92a4-b387635c8d14', '2022-10-25T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('77', 'Legacy: Derrick Brooks (Historical Series)', 'https://assets.nflallday.com/tmp/NFL-PACK_Historical_Reward_Vaporwave.png', 'standard', 1, '4027701f-5071-4c7d-8182-bfea4c779081', '2022-10-25T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('78', 'Legacy: Thurman Thomas (Historical Series)', 'https://assets.nflallday.com/tmp/NFL-PACK_Historical_Reward_Vaporwave.png', 'premium', 1, '71a57f56-e6ce-4688-a891-36d5716448fa', '2022-10-25T18:00:00Z', '2022-08-26T18:00:00Z'),
  ('79', 'Starter Pack (Series 2, Release 1)', 'https://assets.nflallday.com/tmp/NFL_S2_STARTER_STD.png', 'standard', 3, 'd58bf376-7c89-497e-ae5a-c708491ad1ee', '2022-10-28T17:00:00Z', '2022-11-01T21:00:00Z'),
  ('80', 'Playbook: One-Star Reward (Series 2, Week 7)', 'https://assets.nflallday.com/playbookAssets/week7Playbook/Week7_Reward_Pack_01.png', 'standard', 1, 'b5c13bc5-7c60-468b-8313-b7c60f6d6c7c', '2022-10-18T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('81', 'Playbook: Two-Star Reward (Series 2, Week 7)', 'https://assets.nflallday.com/playbookAssets/week7Playbook/Week7_Reward_Pack_02.png', 'standard', 2, 'd8523e67-824e-44bf-9cae-7b0d5dd6d209', '2022-10-18T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('82', 'Playbook: Three-Star Reward (Series 2, Week 7)', 'https://assets.nflallday.com/playbookAssets/week7Playbook/Week7_Reward_Pack_03.png', 'standard', 3, '8924e446-f937-4918-ad6f-8ab04bf627e8', '2022-10-18T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('83', 'Playbook: Four-Star Reward (Series 2, Week 7)', 'https://assets.nflallday.com/playbookAssets/week7Playbook/Week7_Reward_Pack_04.png', 'standard', 3, 'd61aafbc-488d-4b39-92b4-d8773e2aef97', '2022-10-18T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('84', 'Playbook: Five-Star Reward (Series 2, Week 7)', 'https://assets.nflallday.com/playbookAssets/week7Playbook/Week7_Reward_Pack_05.png', 'premium', 3, 'f3a5ff52-003e-469e-acda-46c825aebf8a', '2022-10-18T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('85', 'Playbook: One-Star Reward (Series 2, Week 8)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week8Playbook/Week8_Reward_Pack_01.png', 'standard', 1, '42c23e89-dfb8-4165-a520-05edbb676abc', '2022-10-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('86', 'Playbook: Two-Star Reward (Series 2, Week 8)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week8Playbook/Week8_Reward_Pack_02.png', 'standard', 2, 'ff62ea6e-5517-4967-94a3-6f8e88e604f9', '2022-10-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('87', 'Playbook: Three-Star Reward (Series 2, Week 8)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week8Playbook/Week8_Reward_Pack_03.png', 'standard', 3, '7d203996-3e08-4312-a58e-bb9357c1208f', '2022-10-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('88', 'Playbook: Four-Star Reward (Series 2, Week 8)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week8Playbook/Week8_Reward_Pack_04.png', 'standard', 3, 'c4c4b709-9099-4e3a-a024-9884c8d72d0c', '2022-10-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('89', 'Playbook: Five-Star Reward (Series 2, Week 8)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week8Playbook/Week8_Reward_Pack_05.png', 'premium', 3, 'a5515899-2532-490c-9d32-e06478dbb12e', '2022-10-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('90', 'Playbook: One-Star Reward (Series 2, Week 9)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week9Playbook/Week9_Reward_Pack_01.png', 'standard', 1, '8f414430-b997-4eb7-866f-d9b29091bae0', '2022-11-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('91', 'Playbook: Two-Star Reward (Series 2, Week 9)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week9Playbook/Week9_Reward_Pack_02.png', 'standard', 2, 'b3dec758-052f-4573-ad78-a5977fb92a09', '2022-11-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('92', 'Playbook: Three-Star Reward (Series 2, Week 9)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week9Playbook/Week9_Reward_Pack_03.png', 'standard', 3, '89fc4253-c28e-45d8-b058-2a0e7b66e540', '2022-11-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('93', 'Playbook: Four-Star Reward (Series 2, Week 9)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week9Playbook/Week9_Reward_Pack_04.png', 'standard', 3, '322bce4e-1210-4885-a150-746a61876bd7', '2022-11-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('94', 'Playbook: Five-Star Reward (Series 2, Week 9)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week9Playbook/Week9_Reward_Pack_05.png', 'premium', 3, '8bc3927c-1248-4b87-bd21-793e692e19d3', '2022-11-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('95', 'Premium (Series 2, Week 5-8)', 'https://assets.nflallday.com/tmp/NFL_PACK_WK-0508_PRM.png', 'premium', 8, '85fa22d5-8f1d-46d3-893c-d2d0e3d263f5', '2022-11-18T17:00:00Z', '2022-11-19T02:30:00Z'),
  ('97', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 1)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'standard', 3, '4e7b77a7-51a6-4fbb-8817-a46d9e09eb1a', '2022-11-16T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('98', 'Draw it Up: Joe Burrow (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Orange.png', 'standard', 1, '6c6ee1bd-8e6a-4d8a-afc5-85f2e6658597', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('99', 'Draw it Up: Micah Parsons (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Blue2.png', 'standard', 1, '6685ee42-0e8b-4f2d-b3f6-e0f9fbf714ab', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('100', 'Draw it Up: Aaron Jones (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Green.png', 'standard', 1, 'f5137f23-6f62-49f5-beb5-0cff2c8d9baf', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('101', 'Draw it Up: Austin Ekeler (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Base.png', 'standard', 1, '12f6371c-9c35-4056-ad2f-b793566ab268', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('102', 'Draw it Up: George Kittle (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Red.png', 'standard', 1, '0b55c5af-1675-4e75-9595-26ee5a72a4f8', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('103', 'Draw it Up: Travis Kelce (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Red.png', 'standard', 1, '510127ad-c589-4a97-83e7-461931a1aee8', '2022-11-23T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('104', 'Reward (Series 2, Release 3)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Silver.png', 'standard', 3, '99def09c-58f7-445e-b21d-bc067dc01175', '2022-12-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('105', 'Reward (Series 2, Release 4)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Gold.png', 'premium', 3, 'f88fc521-03a7-4e24-a9a5-69b0331eeb80', '2022-12-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('106', 'Legacy: Calvin Johnson (Historical Series)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Base.png', 'standard', 1, 'fe08ec78-bbac-47e9-8768-f42498ed7672', '2022-12-02T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('107', 'Stadium (Rams, 12/8/2022)', 'https://assets.nflallday.com/tmp/NFL_RAMS_STADIUM_PACK.png', 'standard', 3, 'f3f56de9-67c3-40c9-a3ab-759ae5f84037', '2022-12-08T18:00:00Z', '2022-12-15T15:45:00Z'),
  ('110', 'Playbook: Three-Star Reward (Series 2, Week 13)', 'https://assets.nflallday.com/playbookAssets/week13Playbook/NFL-PACK-PLAYBOOK_wk13_Reward_-ROOKIE.png', 'standard', 1, '147405a8-3cf0-4878-97e6-30cd22667b7b', '2022-11-30T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('111', 'Playbook: Five-Star Reward (Series 2, Week 13)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week13Playbook/NFL-PACK-PLAYBOOK_wk13_Reward_-AP.png', 'premium', 1, '3c798350-da97-4d17-815a-c309ca4327ae', '2022-11-30T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('112', 'Draw it Up: A.J. Green (Series 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week13Playbook/NFL-PACK-PLAYBOOK_wk13_Reward_-ROOKIE-mtc.png', 'standard', 1, 'fa88c5ef-fcd9-4de2-a3bf-8e9f0406aad3', '2022-11-30T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('113', 'Draw it Up: Khalil Mack (Series 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week13Playbook/NFL-PACK-PLAYBOOK_wk13_Reward_-ALL_PRO-mtc.png', 'premium', 1, 'b593a8f9-f47e-4a8c-affa-e7e804b79fc8', '2022-11-30T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('114', 'Draw it Up: Joe Mixon (Series 2)', 'https://storage.googleapis.com/dl-nfl-assets-prod/playbookAssets/week13Playbook/NFL-PACK-PLAYBOOK_wk13_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '627364f8-8e2e-41eb-972d-02b8b44738d7', '2022-11-30T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('115', 'Playbook: Three-Star Reward (Series 2, Week 14)', 'https://assets.nflallday.com/playbookAssets/week14Playbook/NFL-PACK-PLAYBOOK_week14_Reward_-ROOKIE.png', 'standard', 1, '832248f6-f4ef-4065-bba3-81280cf208a7', '2022-12-07T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('116', 'Playbook: Five-Star Reward (Series 2, Week 14)', 'https://assets.nflallday.com/playbookAssets/week14Playbook/NFL-PACK-PLAYBOOK_week14_Reward_-AP.png', 'premium', 1, '237cee48-9476-4d08-ad37-75fc4e50fb3b', '2022-12-07T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('117', 'Draw it Up: Cordarrelle Patterson (Series 2)', 'https://assets.nflallday.com/playbookAssets/week14Playbook/NFL-PACK-PLAYBOOK_week14_Reward_-ROOKIE-mtc.png', 'premium', 1, '4e5694e1-8032-401b-9046-4f054594c609', '2022-12-07T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('118', 'Draw it Up: Darrick Forrest (Series 2)', 'https://assets.nflallday.com/playbookAssets/week14Playbook/NFL-PACK-PLAYBOOK_week14_Reward_-ALL_PRO-mtc.png', 'premium', 1, 'e2d7b21a-8c8e-494b-ab68-f63f09faa8f6', '2022-12-07T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('119', 'Draw it Up: Justin Herbert (Series 2)', 'https://assets.nflallday.com/playbookAssets/week14Playbook/NFL-PACK-PLAYBOOK_week14_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '661ce99a-2f25-484b-ab65-51ded0c77995', '2022-12-07T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('120', 'Immaculate Reception (Standard)', 'https://assets.nflallday.com/tmp/NFL-PACKS-IMMACULATE_REC-PACK.png', 'premium', 1, '3098b856-04c8-470e-8151-f0cd13f4f9b0', '2022-12-20T17:00:00Z', '2022-12-20T19:26:00Z'),
  ('121', 'Immaculate Reception (Premium)', 'https://assets.nflallday.com/tmp/NFL-PACKS-IMMACULATE_REC-PACK.png', 'premium', 1, 'b2174f7e-7318-43f0-83f4-683ba08c7636', '2022-12-20T21:30:00Z', '2022-12-20T23:00:00Z'),
  ('122', 'Playbook: Three-Star Reward (Series 2, Week 15)', 'https://assets.nflallday.com/playbookAssets/week15Playbook/NFL-PACK-PLAYBOOK_week15_Reward_-ROOKIE.png', 'standard', 1, '5426b5e2-fcb5-4e68-a7e9-8e27c3e9f44b', '2022-12-14T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('123', 'Playbook: Five-Star Reward (Series 2, Week 15)', 'https://assets.nflallday.com/playbookAssets/week15Playbook/NFL-PACK-PLAYBOOK_week15_Reward_-AP.png', 'premium', 1, 'fa1e790d-2b76-4b2d-95c4-3b4048de56ca', '2022-12-14T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('124', 'Draw it Up: Mark Andrews (Series 2)', 'https://assets.nflallday.com/playbookAssets/week15Playbook/NFL-PACK-PLAYBOOK_week15_Reward_-ROOKIE-mtc.png', 'premium', 1, '7aea1dae-d609-4af6-81b7-86a77da3d4b5', '2022-12-14T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('125', 'Draw it Up: Aidan Hutchinson (Series 2)', 'https://assets.nflallday.com/playbookAssets/week15Playbook/NFL-PACK-PLAYBOOK_week15_Reward_-ALL_PRO-mtc.png', 'premium', 1, '1cfd8564-33a5-42e5-8959-2c9322ead76c', '2022-12-14T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('126', 'Draw it Up: Dalvin Cook (Series 2)', 'https://assets.nflallday.com/playbookAssets/week15Playbook/NFL-PACK-PLAYBOOK_week15_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '258ebdc7-b89c-4e06-9668-57f4a2c70157', '2022-12-14T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('127', 'Cardinals Hard Knocks Challenge Reward Pack', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Red.png', 'premium', 1, 'cc6307ad-30a0-4143-a19d-bfdbbb1ff5f7', '2022-12-15T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('128', 'Playbook: Three-Star Reward (Series 2, Week 16)', 'https://assets.nflallday.com/playbookAssets/week16Playbook/NFL-PACK-PLAYBOOK_week16_Reward_-ROOKIE.png', 'standard', 1, 'eb1cc2df-0840-4de2-9594-e6fea8db68b5', '2022-12-21T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('129', 'Playbook: Five-Star Reward (Series 2, Week 16)', 'https://assets.nflallday.com/playbookAssets/week16Playbook/NFL-PACK-PLAYBOOK_week16_Reward_-AP.png', 'premium', 1, 'd7af3063-79d3-4bd8-a0be-6d8ab012254a', '2022-12-21T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('130', 'Draw it Up: Myles Garrett (Series 2)', 'https://assets.nflallday.com/playbookAssets/week16Playbook/NFL-PACK-PLAYBOOK_week16_Reward_-ROOKIE-mtc.png', 'premium', 1, '9da5a43a-1e27-45ed-b2d8-be2d597f107a', '2022-12-21T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('131', 'Draw it Up: Tyreek Hill (Series 2)', 'https://assets.nflallday.com/playbookAssets/week16Playbook/NFL-PACK-PLAYBOOK_week16_Reward_-ALL_PRO-mtc.png', 'premium', 1, 'dbb8b72a-0ed8-497e-ad2a-fcc8dab20d07', '2022-12-21T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('132', 'Draw it Up: Aaron Rodgers (Series 2)', 'https://assets.nflallday.com/playbookAssets/week16Playbook/NFL-PACK-PLAYBOOK_week16_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '7a6d7b1f-4976-4d10-b13a-967e3839753f', '2022-12-21T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('133', 'Draw it Up: Justin Fields (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Orange.png', 'premium', 1, '10c36f19-6bcf-4625-8f45-6ef10a30a8f3', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('134', 'Draw it Up: Derek Carr (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Silver.png', 'premium', 1, '9b675150-376a-429e-b610-c4262c21cbe9', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('135', 'Draw it Up: Keenan Allen (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Base.png', 'premium', 1, '8afd8506-4bb5-4005-add2-fa65667593a4', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('136', 'Draw it Up: T.J. Watt (Series 2)', 'https://assets.nflallday.com/tmp/NFLAD%20S2%20Reward%20Pack%20-%20Yellow.png', 'premium', 1, '80873a1e-acd3-47b5-86aa-469b9387c183', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('137', 'Draw it Up: Patrick Mahomes II (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Red.png', 'premium', 1, '1587b5bd-1ec8-426e-8e9a-735b7e6e7a61', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('138', 'Draw it Up: Justin Jefferson (Series 2)', 'https://assets.nflallday.com/tmp/NFLAD%20S2%20Reward%20Pack%20-%20Purple.png', 'premium', 1, 'ef81e3be-cef5-47b1-afd5-861ae0079315', '2022-12-22T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('139', 'Playbook: Three-Star Reward (Series 2, Week 17)', 'https://assets.nflallday.com/playbookAssets/week17Playbook/NFL-PACK-PLAYBOOK_week17_Reward_-ROOKIE.png', 'standard', 1, '69b98628-3c3a-47fd-826c-f464918e9c01', '2022-12-28T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('140', 'Playbook: Five-Star Reward (Series 2, Week 17)', 'https://assets.nflallday.com/playbookAssets/week17Playbook/NFL-PACK-PLAYBOOK_week17_Reward_-AP.png', 'premium', 1, '34d2c297-4638-4e4d-b8a9-83485cad0c4b', '2022-12-28T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('141', 'Draw it Up: Maxx Crosby (Series 2)', 'https://assets.nflallday.com/playbookAssets/week17Playbook/NFL-PACK-PLAYBOOK_week17_Reward_-ROOKIE-mtc.png', 'premium', 1, '302d1f3f-c339-445e-886f-064511c378c7', '2022-12-28T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('142', 'Draw it Up: Jameson Williams (Series 2)', 'https://assets.nflallday.com/playbookAssets/week17Playbook/NFL-PACK-PLAYBOOK_week17_Reward_-ALL_PRO-mtc.png', 'premium', 1, '654beb05-4faf-4e2e-b7b0-a1c667ad2702', '2022-12-28T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('143', 'Draw it Up: Jalen Hurts (Series 2)', 'https://assets.nflallday.com/playbookAssets/week17Playbook/NFL-PACK-PLAYBOOK_week17_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '78f0744c-44a7-4b26-b6f3-f2534fcc66f5', '2022-12-28T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('144', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 2)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'standard', 3, '7f031983-1a05-49cc-bcab-c9fdfd58774f', '2023-01-12T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('145', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 3)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'standard', 3, '483ad77a-c6a7-4a38-8fcb-d1fde25febf0', '2023-01-12T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('146', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 4)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'premium', 3, '727b5a7e-2757-4ab7-b4ea-4304f2992877', '2023-01-12T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('147', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 5)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'premium', 3, 'aa206bae-bc09-4e8e-9a2f-9c7b834aa1cb', '2023-01-12T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('148', 'Bud Light Pick ‘Em Reward Pack (Series 2, Release 6)', 'https://assets.nflallday.com/tmp/NFL_BUDLIGHT_REWARD.png', 'premium', 3, '0d86b3af-4f53-42fe-9db7-c47036e26bff', '2023-01-12T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('149', 'Standard (Series 2, Playoff Push)', 'https://assets.nflallday.com/tmp/NFL_PlayoffPushStdPack.png', 'standard', 10, '7fe05edf-36db-49a8-be46-b9cda0ec8b8f', '2023-01-12T20:10:00Z', '2023-01-13T20:00:00Z'),
  ('150', 'Premium (Series 2, Playoff Push)', 'https://assets.nflallday.com/tmp/NFL_PlayoffPushPremPack.png', 'premium', 10, 'd5ee3b83-5d7e-41be-a66b-d2b6156fcc4a', '2023-01-12T20:10:00Z', '2023-01-13T20:00:00Z'),
  ('152', 'Playbook: Three-Star Reward (Series 2, Week 18)', 'https://assets.nflallday.com/playbookAssets/week18Playbook/NFL-PACK-PLAYBOOK_WK18_Reward_-ROOKIE.png', 'standard', 1, 'd43c68fd-bc11-4699-b771-43eb075c58af', '2023-01-04T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('153', 'Playbook: Five-Star Reward (Series 2, Week 18)', 'https://assets.nflallday.com/playbookAssets/week18Playbook/NFL-PACK-PLAYBOOK_WK18_Reward_-AP.png', 'premium', 1, '833f3de8-9fec-4461-bc87-9e5bc1f73039', '2023-01-04T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('154', 'Draw it Up: Adam Thielen (Series 2)', 'https://assets.nflallday.com/playbookAssets/week18Playbook/NFL-PACK-PLAYBOOK_WK18_Reward_-ROOKIE-mtc.png', 'standard', 1, 'a361e400-1e43-47b5-8d10-d9a4b13246c5', '2023-01-04T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('155', 'Draw it Up: Ja''Marr Chase(Series 2)', 'https://assets.nflallday.com/playbookAssets/week18Playbook/NFL-PACK-PLAYBOOK_WK18_Reward_-ALL_PRO-mtc.png', 'premium', 1, '8d249f04-8acf-4186-ad5f-8f923f98ac6d', '2023-01-04T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('156', 'Draw it Up: Nick Bosa (Series 2)', 'https://assets.nflallday.com/playbookAssets/week18Playbook/NFL-PACK-PLAYBOOK_WK18_Reward_-ALL_PRO-mtc_2.png', 'premium', 1, '7bff4022-6a50-4fce-9527-ac53b908030c', '2023-01-04T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('157', 'Playbook: One-Star Reward (Series 2, Week 19)', 'https://assets.nflallday.com/playbookAssets/week19Playbook/NFL-PACK-PLAYBOOK_WK19-2_Reward_-ROOKIE-ONESTAR.png', 'standard', 1, 'f678c929-f4d9-4cc3-bd03-32d6a4dde4e0', '2023-01-11T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('158', 'Playbook: Three-Star Reward (Series 2, Week 19)', 'https://assets.nflallday.com/playbookAssets/week19Playbook/NFL-PACK-PLAYBOOK_WK19-2_Reward_-PRO-THREESTAR.png', 'standard', 1, '7583426a-2fd9-4afd-ac88-ca93a547bc16', '2023-01-11T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('159', 'Playbook: Five-Star Reward (Series 2, Week 19)', 'https://assets.nflallday.com/playbookAssets/week19Playbook/NFL-PACK-PLAYBOOK_WK19-2_Reward_-ALL-PRO-FIVESTAR.png', 'premium', 1, '090ecc69-b060-4eac-8289-0e267ac2dde9', '2023-01-11T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('160', 'Draw it Up: Garrett Wilson (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Green.png', 'premium', 1, '78d02135-b2b3-4313-b2ae-fea562bd6f7b', '2023-01-19T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('161', 'Draw it Up: Brock Purdy (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Red.png', 'premium', 1, '8b76941f-1364-4e94-bd6f-5dcbd725e740', '2023-01-19T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('162', 'Draw it Up: Tennessee Titans (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Blue2.png', 'premium', 1, '887da921-aadb-40e0-bdbe-067e0872edda', '2023-01-19T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('163', 'Draw it Up: Lamar Jackson (Series 2)', 'https://assets.nflallday.com/tmp/NFLAD%20S2%20Reward%20Pack%20-%20Purple.png', 'premium', 1, 'c3455c01-2b10-44a9-a0a7-b0f1fdb9286b', '2023-01-19T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('164', 'Draw it Up: Derrick Henry (Series 2)', 'https://assets.nflallday.com/tmp/NFL_S2_REWARD_Blue2.png', 'premium', 1, '125016dd-62ea-479e-bb08-41767424f1ad', '2023-01-19T18:00:00Z', '2022-10-12T17:00:00Z'),
  ('166', 'Playbook: Three-Star Reward (Series 2, Week 20)', 'https://assets.nflallday.com/playbookAssets/week20Playbook/NFL-PACK-PLAYBOOK_WK20-2_Reward_-PRO.png', 'standard', 1, '369b45d8-d8f7-4c46-8165-1eae33dc05ae', '2023-01-19T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('167', 'Playbook: Five-Star Reward (Series 2, Week 20)', 'https://assets.nflallday.com/playbookAssets/week20Playbook/NFL-PACK-PLAYBOOK_WK20-2_Reward_-ALL-PRO.png', 'premium', 1, '9970af12-ae0b-40e0-a2fd-7252098335af', '2023-01-19T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('168', 'Draw it Up: Chase Claypool (Series 2)', 'https://assets.nflallday.com/playbookAssets/week20Playbook/NFL-PACK-PLAYBOOK_wk20_Reward-MtC-PRO.png', 'standard', 1, '0d5eca47-8a7b-4b71-98af-38146fcdd8b6', '2023-01-19T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('169', 'Draw it Up: Demarcus Lawrence (Series 2)', 'https://assets.nflallday.com/playbookAssets/week20Playbook/NFL-PACK-PLAYBOOK_wk20_Reward-MtC-ALL_PRO-1.png', 'premium', 1, 'd44b5383-34a4-44e5-aa56-cc155cf55d2f', '2023-01-19T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('171', 'Legacy: Larry Fitzgerald (Historical 2)', 'https://assets.nflallday.com/tmp/NFL-PACK_Historical_REWARD-Vaporwave_HISTORICAL2.png', 'premium', 1, 'a2582a73-a92b-4891-8b58-e7c6d00dd855', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('174', 'Playbook: One-Star Reward (Series 2, Week 21)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_week21_Reward_-ROOKIE.png', 'standard', 1, '89ba92d8-5214-4e46-a179-9ee43bf47fd8', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('175', 'Playbook: Three-Star Reward (Series 2, Week 21)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_week21_Reward_-PRO.png', 'standard', 1, 'b32ec5ac-07a5-478d-9468-30124e7c761c', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('176', 'Playbook: Five-Star Reward (Series 2, Week 21)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_week21_Reward_-ALL-PRO.png', 'premium', 1, 'eb4b6e90-9066-471f-a75e-c369c89bfbd0', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('177', 'Draw it Up: Kyle Van Noy (Series 2)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_wk20_Reward-MtC-PRO.png', 'premium', 1, 'f12aabf8-d299-44f6-989a-4f81493e02fa', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('178', 'Draw it Up: Taysom Hill (Series 2)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_wk20_Reward-MtC-ALL_PRO-1.png', 'premium', 1, 'cb2ea697-7d8d-419b-aecd-0b7a0013c57b', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z'),
  ('179', 'Draw it Up: Cleveland Browns (Series 2)', 'https://assets.nflallday.com/playbookAssets/week21Playbook/NFL-PACK-PLAYBOOK_wk20_Reward-MtC-ALL_PRO-2.png', 'premium', 1, '14e134cc-8db1-463a-9cf3-5bb7c414e3e9', '2023-01-26T18:00:00Z', '2022-09-24T18:00:00Z')
)
INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070', v.dist_id, v.title, 'A.e4cf4bdc1751c65d.PackNFT.NFT', v.image_url,
       jsonb_build_object('tier', v.tier, 'number_of_pack_slots', v.slots, 'uuid', v.uuid,
                          'start_time', v.start_time, 'end_time', v.end_time,
                          'seeded_from', 'studio_platform_gql_backfill_20260925')
FROM v
ON CONFLICT (dist_id, collection_id) DO NOTHING;

-- The 7 corrections, each guarded on the WRONG value it replaces so a
-- concurrent fix is never overwritten.
UPDATE public.pack_distributions SET
  title = 'Standard (Series 1, Week 13)',
  image_url = 'https://assets.nflallday.com/tmp/NFL_PACKS_STANDARD_WK_13.png', updated_at = now()
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND dist_id = '2'
   AND title = 'Dak Prescott - Rookie Rewind Gold: Sapphire Reward';
UPDATE public.pack_distributions SET
  title = 'Hot Route (Series 2, Playoff Push)',
  image_url = 'https://assets.nflallday.com/tmp/NFL_HotRoutePack.png', updated_at = now()
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND dist_id = '151'
   AND title = 'Dak Prescott - Rookie Rewind Gold: Sapphire Reward';
UPDATE public.pack_distributions d SET image_url = x.img, updated_at = now()
  FROM (VALUES
    ('3',  'https://assets.nflallday.com/tmp/NFL_PACKS_STANDARD_WK_14.png'),
    ('5',  'https://assets.nflallday.com/tmp/NFL_PACKS_STANDARD_WK_17.png'),
    ('9',  'https://assets.nflallday.com/tmp/1_WILDCARD_STANDARD.png'),
    ('10', 'https://assets.nflallday.com/tmp/2_DIVISIONAL_PLAYOFF.png'),
    ('11', 'https://assets.nflallday.com/tmp/3_CHAMPIONSHIP_2_STANDARD.png')
  ) AS x(dist_id, img)
 WHERE d.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND d.dist_id = x.dist_id
   AND (d.image_url LIKE '%PACKBG%' OR d.image_url LIKE '%PLAYOFF_BGs%');

-- Post-conditions: every All Day dist a rip points at now exists; the 151 are
-- titled + pictured; no row keeps the stray title; the backgrounds are gone.
DO $$
DECLARE v_missing int; v_new int; v_bad int;
BEGIN
  SELECT count(DISTINCT r.dist_id) INTO v_missing FROM public.pack_rips r
   WHERE r.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND r.dist_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.collection_id = r.collection_id AND pd.dist_id = r.dist_id);
  IF v_missing <> 0 THEN RAISE EXCEPTION '% All Day dists referenced by rips still missing', v_missing; END IF;
  SELECT count(*) INTO v_new FROM public.pack_distributions
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
     AND metadata->>'seeded_from' = 'studio_platform_gql_backfill_20260925'
     AND coalesce(title, '') <> '' AND image_url LIKE 'https://%';
  IF v_new <> 151 THEN RAISE EXCEPTION 'expected 151 titled + pictured new rows, got %', v_new; END IF;
  SELECT count(*) INTO v_bad FROM public.pack_distributions
   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND dist_id IN ('2','3','5','9','10','11','151')
     AND (title = 'Dak Prescott - Rookie Rewind Gold: Sapphire Reward' OR image_url LIKE '%PACKBG%'
          OR image_url LIKE '%PLAYOFF_BGs%' OR image_url LIKE '%Rewind_PACK_REWARD_rare%');
  IF v_bad <> 0 THEN RAISE EXCEPTION '% corrected rows still wrong', v_bad; END IF;
END $$;
