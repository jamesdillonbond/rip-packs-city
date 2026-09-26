-- 2026-09-25 (PT) — two pack-identity defects surfaced by Trevor's transaction
-- history (dists 8825 / 8735 rendered with no image; pack 153931630615107 named
-- the wrong pack).
--
-- (1) 49 Top Shot pack distributions (dist 8734–8869) had image_url NULL.
-- WHY: the only image writer was Dapper's searchPackNft (530 since ~08-28), and
-- the PDS contract (the on-chain namer, 20260925091300) carries no image for
-- these dists. SOURCE: every Top Shot PackNFT's MetadataViews.Display thumbnail
-- is https://media.nbatopshot.com/packnfts/<pack_nft_id>/media/image, which
-- 302s to the DISTRIBUTION's own image file. One pack per dist (from
-- pack_purchases) was followed 2026-09-25 ~6:55 PM PT: 49 of 49 answered.
-- Positive control: dist 8710's redirect equals the image_url it already had.
-- Three targets fetched in full: image/png, 1.4–3.2 MB. The cdn-cgi resize
-- segment is stripped to store the original. Fill-only (image_url IS NULL).
-- The daily route /api/cron/topshot-pack-dist-names-onchain keeps it true for
-- new dists from here on.
--
-- (2) get_pack_lifecycle(p_pack_nft_id) named a pack by GUESSING its
-- distribution from its pulls' drop pools and never read the distribution the
-- pack itself records (pack_purchases.pack_dist_id / pack_rips.dist_id, both
-- from on-chain events). Measured over the 2,000 newest rips with indexed
-- pulls: the guess resolved 203 and DISAGREED with the record on 188 — e.g.
-- "Run It Back: Vault Pack" (8768) published as "2025-26 Set Completion
-- Reward", Trevor's WNBA Team Leaderboard reward (8710) as "WNBA Fresh Gems Box
-- Topper" (8618). The record agreed with pack_purchases on every sampled row.
-- Now: the recorded dist first (purchase, then rip), the pull guess only when
-- neither exists. Payload shape unchanged ('source' stays 'drop_pool' for any
-- pack_distributions match — the client reads it as "full identity").
-- Guarded splice on the live body (header from pg_proc; ACL unchanged).
--
-- Revert: (1) UPDATE pack_distributions d SET image_url = NULL FROM
-- audit_20260925_ts_pack_dist_images_backup b WHERE d.id = b.id (drop the
-- backup after 2026-10-02). (2) remove the two spliced blocks (the record
-- lookup + the IF/END IF around the pull guess).

-- ── (1) images ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_20260925_ts_pack_dist_images_backup AS
SELECT id, dist_id, image_url, updated_at
FROM public.pack_distributions
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND (image_url IS NULL OR image_url = '');
ALTER TABLE public.audit_20260925_ts_pack_dist_images_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ts_pack_dist_images_backup FROM PUBLIC, anon, authenticated;

WITH img(dist_id, image_url) AS (VALUES
  ('8734', 'https://storage.googleapis.com/assets-nbatopshot/distributions/production-1786051730514-WNBATS_Set_Reward_Pack_RIB_Origins.png'),
  ('8735', 'https://asset-preview.nbatopshot.com/distributions/production-1786396127676-WNBATS_LegacyTrail_ChanceHit_Pack.png'),
  ('8748', 'https://asset-preview.nbatopshot.com/distributions/production-1787069861539-NBATS_Drop003_ChanceHit_AlwaysOn.png'),
  ('8749', 'https://asset-preview.nbatopshot.com/distributions/production-1787170441842-NBATS_Drop003_ChanceHit_AlwaysOn.png'),
  ('8750', 'https://asset-preview.nbatopshot.com/distributions/production-1787292380731-NBATS_RIB_Drop009_Standard_Pack.png'),
  ('8751', 'https://asset-preview.nbatopshot.com/distributions/production-1787214607030-NBATS_RIB_Drop009_Box.png'),
  ('8752', 'https://asset-preview.nbatopshot.com/distributions/production-1788188740703-NBATS_RIB_Drop009_Case5.png'),
  ('8753', 'https://asset-preview.nbatopshot.com/distributions/production-1787292494668-NBATS_RIB_Drop009_Case_Topper.png'),
  ('8754', 'https://asset-preview.nbatopshot.com/distributions/production-1787292567281-NBATS_RIB_Drop009_Premium_Pack.png'),
  ('8755', 'https://asset-preview.nbatopshot.com/distributions/production-1787292712906-NBATS_RIB_Drop009_Box_Topper.png'),
  ('8756', 'https://asset-preview.nbatopshot.com/distributions/production-1787293006129-NBATS_Drop009_Premium_Chance_Hit_Pack.png'),
  ('8757', 'https://asset-preview.nbatopshot.com/distributions/production-1787293144322-NBATS_Drop009_Chance_Hit_Pack.png'),
  ('8767', 'https://asset-preview.nbatopshot.com/distributions/production-1787342892910-NBATS_Drop003_ChanceHit_AlwaysOn.png'),
  ('8768', 'https://asset-preview.nbatopshot.com/distributions/production-1788309434922-NBATS_RIB_Drop009_Premium-Pack_5-Moments.png'),
  ('8769', 'https://asset-preview.nbatopshot.com/distributions/production-1789587085287-WNBATS_Drop004_Chasing_Packs_CaitlinClark.png'),
  ('8770', 'https://asset-preview.nbatopshot.com/distributions/production-1789658929212-WNBATS_Drop004_Standard_Pack-1-.png'),
  ('8771', 'https://asset-preview.nbatopshot.com/distributions/production-1789659028083-WNBATS_Drop004_Box.png'),
  ('8772', 'https://asset-preview.nbatopshot.com/distributions/production-1789659177473-WNBATS_Drop004_Box.png'),
  ('8773', 'https://asset-preview.nbatopshot.com/distributions/production-1789659289307-WNBATS_Drop004_Case.png'),
  ('8774', 'https://asset-preview.nbatopshot.com/distributions/production-1789672392226-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8775', 'https://asset-preview.nbatopshot.com/distributions/production-1789746689529-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8776', 'https://asset-preview.nbatopshot.com/distributions/production-1789749955918-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8777', 'https://asset-preview.nbatopshot.com/distributions/production-1789768588741-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8778', 'https://asset-preview.nbatopshot.com/distributions/production-1790011783177-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8779', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616563-WNBATS_Set_Reward_Pack_HustleandShow.png'),
  ('8780', 'https://asset-preview.nbatopshot.com/distributions/production-1790096369195-WNBATS_Drop004_Premium_Pack.png'),
  ('8781', 'https://asset-preview.nbatopshot.com/distributions/production-1790096209974-WNBATS_Drop004_Box_Topper.png'),
  ('8783', 'https://asset-preview.nbatopshot.com/distributions/production-1790177467196-WNBATS_Drop004_Chance_Hit.png'),
  ('8785', 'https://asset-preview.nbatopshot.com/distributions/production-1790177450028-WNBATS_Drop004_Trade_Ticket_Pack.png'),
  ('8786', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616573-WNBATS_Set_Reward_Pack_RookieRevelation.png'),
  ('8787', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616571-WNBATS_Set_Reward_Pack_Ascension.png'),
  ('8788', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616570-WNBATS_Set_Reward_Pack_FreshGems.png'),
  ('8793', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616566-WNBATS_Set_Reward_Pack_RookieDebut.png'),
  ('8794', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616565-WNBATS_Set_Reward_Pack_HoopVision.png'),
  ('8796', 'https://asset-preview.nbatopshot.com/distributions/production-1790178616564-WNBATS_Set_Reward_Pack_BagWork.png'),
  ('8811', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502785-WNBATS_Team_Leaderboard_Reward_Pack_ATL.png'),
  ('8813', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502786-WNBATS_Team_Leaderboard_Reward_Pack_CHI.png'),
  ('8814', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502787-WNBATS_Team_Leaderboard_Reward_Pack_CON.png'),
  ('8817', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502790-WNBATS_Team_Leaderboard_Reward_Pack_IND.png'),
  ('8818', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502791-WNBATS_Team_Leaderboard_Reward_Pack_LAS.png'),
  ('8821', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502795-WNBATS_Team_Leaderboard_Reward_Pack_PHX.png'),
  ('8822', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502793-WNBATS_Team_Leaderboard_Reward_Pack_MIN.png'),
  ('8823', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502798-WNBATS_Team_Leaderboard_Reward_Pack_TOR.png'),
  ('8825', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502796-WNBATS_Team_Leaderboard_Reward_Pack_POR.png'),
  ('8826', 'https://asset-preview.nbatopshot.com/distributions/production-1790179502797-WNBATS_Team_Leaderboard_Reward_Pack_SEA.png'),
  ('8840', 'https://asset-preview.nbatopshot.com/distributions/production-1790178120922-WNBATS_Drop004_Leaderboard_Reward_RookieRevelation.png'),
  ('8864', 'https://asset-preview.nbatopshot.com/distributions/production-1790178120921-WNBATS_Drop004_Leaderboard_Reward_MGLE.png'),
  ('8868', 'https://asset-preview.nbatopshot.com/distributions/production-1790099344560-NBATS_Drop004_Chanc_Hit_AlwaysOn.png'),
  ('8869', 'https://asset-preview.nbatopshot.com/distributions/production-1790096345500-WNBATS_Drop004_Case_Topper.png')
)
UPDATE public.pack_distributions d
   SET image_url = img.image_url, updated_at = now()
  FROM img
 WHERE d.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND d.dist_id = img.dist_id
   AND (d.image_url IS NULL OR d.image_url = '');

-- ── (2) get_pack_lifecycle: the pack's own record before the pull guess ────
-- anon-exec: unchanged (get_pack_lifecycle) — CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false, authenticated=false (read 2026-09-25).
DO $$
DECLARE
  v_src  text;
  v_new  text;
  v_n    int;
  v_old1 constant text := E'  SELECT pdp.dist_id INTO v_resolved_dist_id\n  FROM moment_acquisitions ma\n';
  v_rep1 constant text := E'  -- 2026-09-25: the distribution the pack RECORDS (on-chain purchase / rip\n  -- event) wins. The pull guess below disagreed with it on 188 of 203 rips.\n  SELECT pp.pack_dist_id INTO v_resolved_dist_id\n  FROM pack_purchases pp\n  WHERE pp.pack_nft_id = p_pack_nft_id\n    AND pp.collection_id = v_pack_collection_id\n    AND pp.pack_dist_id IS NOT NULL\n  ORDER BY pp.sealed_at DESC\n  LIMIT 1;\n\n  IF v_resolved_dist_id IS NULL THEN\n    SELECT pr.dist_id INTO v_resolved_dist_id\n    FROM pack_rips pr\n    WHERE pr.pack_nft_id = p_pack_nft_id\n      AND pr.collection_id = v_pack_collection_id\n      AND pr.dist_id IS NOT NULL\n    LIMIT 1;\n  END IF;\n\n  IF v_resolved_dist_id IS NULL THEN\n  SELECT pdp.dist_id INTO v_resolved_dist_id\n  FROM moment_acquisitions ma\n';
  v_old2 constant text := E'  ORDER BY COUNT(*) DESC, pdp.dist_id\n  LIMIT 1;\n';
  v_rep2 constant text := E'  ORDER BY COUNT(*) DESC, pdp.dist_id\n  LIMIT 1;\n  END IF;\n';
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pack_lifecycle'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pack_nft_id text';
  IF v_src IS NULL THEN RAISE EXCEPTION 'get_pack_lifecycle(text) not found'; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old1, ''))) / length(v_old1);
  IF v_n <> 1 THEN RAISE EXCEPTION 'get_pack_lifecycle: pull-guess anchor expected once, found %', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old2, ''))) / length(v_old2);
  IF v_n <> 1 THEN RAISE EXCEPTION 'get_pack_lifecycle: pull-guess tail anchor expected once, found %', v_n; END IF;
  v_new := replace(replace(v_src, v_old1, v_rep1), v_old2, v_rep2);
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.get_pack_lifecycle(p_pack_nft_id text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''public'' AS %L',
    v_new);
END $$;

-- Post-conditions. (1) Positive: 8825 has its image. (2) Positive: pack
-- 153931630615107 (purchase + rip say 8710) resolves 8710, not 8618.
-- (3) No-change: a rip whose purchase record agrees still resolves its recorded dist.
-- (4) The ACL did not move.
DO $$
DECLARE v_d text; v_id text; v_rec text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pack_distributions WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                  AND dist_id = '8825' AND image_url LIKE 'https://asset-preview.nbatopshot.com/distributions/%') THEN
    RAISE EXCEPTION 'dist 8825 image not written';
  END IF;

  v_d := public.get_pack_lifecycle('153931630615107')->'distribution'->>'dist_id';
  IF v_d IS DISTINCT FROM '8710' THEN
    RAISE EXCEPTION 'pack 153931630615107 resolves %, expected 8710', v_d;
  END IF;

  SELECT pr.pack_nft_id, pr.dist_id INTO v_id, v_rec FROM public.pack_rips pr
   WHERE pr.dist_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.pack_distributions pd WHERE pd.dist_id = pr.dist_id AND pd.collection_id = pr.collection_id)
     AND NOT EXISTS (SELECT 1 FROM public.pack_purchases pp WHERE pp.pack_nft_id = pr.pack_nft_id
                      AND pp.pack_dist_id IS NOT NULL AND pp.pack_dist_id <> pr.dist_id)
   ORDER BY pr.sealed_at DESC LIMIT 1;
  IF v_id IS NOT NULL THEN
    v_d := public.get_pack_lifecycle(v_id)->'distribution'->>'dist_id';
    IF v_d IS DISTINCT FROM v_rec THEN
      RAISE EXCEPTION 'pack % resolves %, its record says %', v_id, v_d, v_rec;
    END IF;
  END IF;

  IF has_function_privilege('anon', 'public.get_pack_lifecycle(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.get_pack_lifecycle(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'get_pack_lifecycle ACL widened';
  END IF;
END $$;
