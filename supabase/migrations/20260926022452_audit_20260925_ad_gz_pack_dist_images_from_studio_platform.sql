-- 2026-09-25 (PT) — 76 All Day / Golazos pack distributions with no image get
-- the one Dapper publishes for them.
--
-- WHY. 65 Golazos dists (ids 1–196, the 2022-23 catalogue) and 45 All Day dists
-- had image_url NULL. New dists of both collections DO get images (the 25 All
-- Day dists first seen in the last 30 days all have one), so this is a
-- historical hole, not a live writer bug — a one-time fill is the fix.
--
-- SOURCE. Dapper Studio Platform GraphQL (the host compute-pinnacle-pack-ev
-- already reads), `searchDistributions(filters: {byProductID, byIDs})`, the
-- DEFAULT entry of `images`. Read ~7:40 PM PT via pg_net.
--   · CONTROL: for the 40 newest imaged dists of each collection, the API's
--     DEFAULT image equals our stored image_url on 80 of 80.
--   · All 53 distinct target URLs fetched: 53 × HTTP 200 image/png.
--   · All Day: the API returns an image for exactly 11 of 45 — the real
--     products (Gift Pack, Super Bowl Flashback, Draw it Up …). The other 34
--     are internal holding/test distributions ("NFL Pack Hold", "Pack Test",
--     "Do Not Use") whose DEFAULT url is "" — left NULL, correctly.
--   · Golazos: 65 of 65.
--   · Pinnacle (154 dists, all imageless) is NOT here: the API's `images` is
--     [] for every one, the PDS contract's `images` is [] and `thumbnail` is
--     "", and the Pinnacle PackNFT contract's Display is one generic
--     collection image — no per-pack art exists in any public source.
-- Fill-only (image_url IS NULL).
--
-- Revert: UPDATE pack_distributions d SET image_url = NULL FROM
-- audit_20260925_ad_gz_pack_dist_images_backup b WHERE d.id = b.id
-- (drop the backup after 2026-10-02).

CREATE TABLE IF NOT EXISTS public.audit_20260925_ad_gz_pack_dist_images_backup AS
SELECT pd.id, c.slug, pd.dist_id, pd.image_url, pd.updated_at
FROM public.pack_distributions pd
JOIN public.collections c ON c.id = pd.collection_id
WHERE c.slug IN ('nfl_all_day', 'laliga_golazos')
  AND pd.image_url IS NULL;
ALTER TABLE public.audit_20260925_ad_gz_pack_dist_images_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ad_gz_pack_dist_images_backup FROM PUBLIC, anon, authenticated;

WITH img(slug, dist_id, image_url) AS (VALUES
  ('laliga_golazos', '1', 'https://assets.laligagolazos.com/packs/j1_9_in_season_standard_test_500/images/pack.png'),
  ('laliga_golazos', '2', 'https://assets.laligagolazos.com/packs/eterno_rival_historic_premium/images/pack.png'),
  ('laliga_golazos', '3', 'https://assets.laligagolazos.com/packs/world_stars_historic_premium/images/pack.png'),
  ('laliga_golazos', '4', 'https://assets.laligagolazos.com/packs/world_stars_historic_standard/images/pack.png'),
  ('laliga_golazos', '5', 'https://assets.laligagolazos.com/packs/challenge_wc_1_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '6', 'https://assets.laligagolazos.com/packs/challenge_wc_1_in_season_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '7', 'https://assets.laligagolazos.com/packs/challenge_wc_1_in_season_premium_reward_3_moments/images/pack.png'),
  ('laliga_golazos', '8', 'https://assets.laligagolazos.com/packs/kotw_historic_premium_new/images/pack.png'),
  ('laliga_golazos', '9', 'https://assets.laligagolazos.com/packs/kotw_historic_standard_new/images/pack.png'),
  ('laliga_golazos', '10', 'https://assets.laligagolazos.com/packs/challenge_wc_2_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '11', 'https://assets.laligagolazos.com/packs/challenge_wc_2_in_season_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '12', 'https://assets.laligagolazos.com/packs/challenge_wc_2_in_season_premium_reward_3_moments/images/pack.png'),
  ('laliga_golazos', '13', 'https://assets.laligagolazos.com/packs/challenge_wc_3_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '14', 'https://assets.laligagolazos.com/packs/challenge_wc_3_in_season_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '15', 'https://assets.laligagolazos.com/packs/kotw_historic_standard_new/images/pack.png'),
  ('laliga_golazos', '16', 'https://assets.laligagolazos.com/packs/challenge_wc_4_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '17', 'https://assets.laligagolazos.com/packs/challenge_wc_4_in_season_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '18', 'https://assets.laligagolazos.com/packs/kotw_historic_premium_new/images/pack.png'),
  ('laliga_golazos', '19', 'https://assets.laligagolazos.com/packs/eterno_rival_1_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '20', 'https://assets.laligagolazos.com/packs/eterno_rival_2_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '21', 'https://assets.laligagolazos.com/packs/world_stars_standard_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '22', 'https://assets.laligagolazos.com/packs/world_stars_premium_in_season_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '23', 'https://assets.laligagolazos.com/packs/equipo_del_mundo_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '24', 'https://assets.laligagolazos.com/packs/equipo_del_mundo_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '25', 'https://assets.laligagolazos.com/packs/team_europa_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '26', 'https://assets.laligagolazos.com/packs/team_europa_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '27', 'https://assets.laligagolazos.com/packs/superduelo_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '28', 'https://assets.laligagolazos.com/packs/superduelo_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '29', 'https://assets.laligagolazos.com/packs/superduelo_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '30', 'https://assets.laligagolazos.com/packs/team_croqueta_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '31', 'https://assets.laligagolazos.com/packs/team_croqueta_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '32', 'https://assets.laligagolazos.com/packs/team_roulette_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '33', 'https://assets.laligagolazos.com/packs/team_roulette_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '34', 'https://assets.laligagolazos.com/packs/j1_9_in_season_premium/images/pack.png'),
  ('laliga_golazos', '35', 'https://assets.laligagolazos.com/packs/j1_9_in_season_standard/images/pack.png'),
  ('laliga_golazos', '36', 'https://assets.laligagolazos.com/packs/derbi_vasco_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '37', 'https://assets.laligagolazos.com/packs/derbi_vasco_historic_premium_reward_2_moments/images/pack.png'),
  ('laliga_golazos', '38', 'https://assets.laligagolazos.com/packs/cardiff_express_t3_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '39', 'https://assets.laligagolazos.com/packs/cardiff_express_t2_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '40', 'https://assets.laligagolazos.com/packs/cardiff_express_t1_historic_premium_reward_1_moment/images/pack.png'),
  ('laliga_golazos', '41', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '42', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '43', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '44', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '45', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '46', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '47', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '48', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '49', 'https://assets.laligagolazos.com/packs/j1_9_in_season_standard/images/pack.png'),
  ('laliga_golazos', '50', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '51', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '52', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '53', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '54', 'https://assets.laligagolazos.com/packs/j10_19_in_season_standard/images/pack.png'),
  ('laliga_golazos', '55', 'https://assets.laligagolazos.com/packs/j10_19_in_season_premium_v3/images/pack.png'),
  ('laliga_golazos', '56', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '183', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '184', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '185', 'https://assets.laligagolazos.com/packs/in_season_standard/images/pack.png'),
  ('laliga_golazos', '186', 'https://assets.laligagolazos.com/packs/in_season_standard/images/pack.png'),
  ('laliga_golazos', '187', 'https://assets.laligagolazos.com/packs/in_season_premium/images/pack.png'),
  ('laliga_golazos', '188', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '194', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '195', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('laliga_golazos', '196', 'https://assets.laligagolazos.com/packs/reward/images/pack.png'),
  ('nfl_all_day', '180', 'https://assets.nflallday.com/resize/static/images/pack-gifting/holiday-gift-pack.png'),
  ('nfl_all_day', '181', 'https://assets.nflallday.com/tmp/NFL-FLASHBACK-PACK-SB-SUPER_BOWL-LI.png'),
  ('nfl_all_day', '182', 'https://assets.nflallday.com/tmp/NFL-FLASHBACK-PACK-SB-SUPER_BOWL-LI-premium.png'),
  ('nfl_all_day', '189', 'https://assets.nflallday.com/playbookAssets/week23Playbook/NFL-PACK-PLAYBOOK_SB_Reward-MtC-PRO.png'),
  ('nfl_all_day', '190', 'https://assets.nflallday.com/playbookAssets/week23Playbook/NFL-PACK-PLAYBOOK_SB_Reward-MtC-ALL_PRO-2.png'),
  ('nfl_all_day', '191', 'https://assets.nflallday.com/playbookAssets/week23Playbook/NFL-PACK-PLAYBOOK_SB_Reward-MtC-ALL_PRO-1.png'),
  ('nfl_all_day', '192', 'https://assets.nflallday.com/playbookAssets/week23Playbook/NFL-PACK-PLAYBOOK_SB_Reward-MtC-ALL_PRO-3.png'),
  ('nfl_all_day', '193', 'https://assets.nflallday.com/playbookAssets/week23Playbook/NFL-PACK-PLAYBOOK_SB_Reward-MtC-ROOKIE.png'),
  ('nfl_all_day', '899', 'https://assets.nflallday.com/tmp/NFLAD_PACKS_DYNAMICS_HOLIDAY_REWARD.png'),
  ('nfl_all_day', '1475', 'https://assets.nflallday.com/tmp/NFL_PACK_GENERIC_Historic_Teal.png'),
  ('nfl_all_day', '4455', 'https://assets.nflallday.com/tmp/2024_rookie_revelation/packs/NFLAD_PACKS_ROOKIE-REV_QUICK-RIP.png')
)
UPDATE public.pack_distributions d
   SET image_url = img.image_url, updated_at = now()
  FROM img
  JOIN public.collections c ON c.slug = img.slug
 WHERE d.collection_id = c.id
   AND d.dist_id = img.dist_id
   AND d.image_url IS NULL;

-- Post-conditions: the 76 landed (65 Golazos + 11 All Day); what is left NULL
-- in those two collections is exactly the 34 All Day holding/test dists.
DO $$
DECLARE v_gz int; v_ad int;
BEGIN
  SELECT count(*) FILTER (WHERE c.slug = 'laliga_golazos'), count(*) FILTER (WHERE c.slug = 'nfl_all_day')
    INTO v_gz, v_ad
    FROM public.pack_distributions pd JOIN public.collections c ON c.id = pd.collection_id
   WHERE c.slug IN ('laliga_golazos', 'nfl_all_day') AND pd.image_url IS NULL;
  IF v_gz <> 0 THEN RAISE EXCEPTION 'Golazos still has % imageless dists', v_gz; END IF;
  IF v_ad <> 34 THEN RAISE EXCEPTION 'All Day has % imageless dists, expected the 34 holding/test ones', v_ad; END IF;
END $$;
