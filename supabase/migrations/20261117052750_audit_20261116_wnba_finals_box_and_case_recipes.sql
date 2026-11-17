-- 2026-11-16 ~10:00 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously … fix any issues").
--
-- The WNBA Finals drop (11-16 10:25 AM PT) shipped a Box (8934) and a Case (8933) with no
-- pack_container_recipes row, so refresh_container_pack_ev cannot price them and the trust arm
-- topshot_container_missing_recipe_count read BREACH (2, breach_at 1). Runbook:
-- docs/runbooks/topshot-box-case-drop-day.md; template 20261112144751.
--
-- Seeded from Dapper's own distribution descriptions (pack_distributions.metadata.description):
--   8934 "Every WNBA Finals Box holds 6 packs and 36 Moments: a Box Topper and 5 WNBA Finals
--         Collector Packs."   → 8939 Box Topper x1 (1 Moment) + 8937 Collector x5 (7 each)
--                              = 6 packs, 36 Moments
--   8933 "Every WNBA Finals Case holds 12 packs and 78 Moments: a Case Topper, a Premium Pack and
--         10 WNBA Finals Collector Packs." → 8932 Case Topper x1 (2) + 8938 Premium x1 (6)
--                                           + 8937 Collector x10 (7 each) = 12 packs, 78 Moments
-- The DO block refuses to commit if either count disagrees with number_of_pack_slots or the text.
-- An observed recipe replaces these the first time a box or case is opened.
--
-- No function change. Data only.
-- Revert: DELETE FROM public.pack_container_recipes WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--           AND container_dist_id IN ('8933','8934') AND source = 'description';

INSERT INTO public.pack_container_recipes (collection_id, container_dist_id, inner_dist_id, inner_count, source)
VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8934', '8939',  1, 'description'),  -- WNBA Finals Box: Box Topper
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8934', '8937',  5, 'description'),  --   + 5 Collector Packs
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8933', '8932',  1, 'description'),  -- WNBA Finals Case: Case Topper
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8933', '8938',  1, 'description'),  --   + Premium Pack
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8933', '8937', 10, 'description')   --   + 10 Collector Packs
ON CONFLICT (collection_id, container_dist_id, inner_dist_id) DO NOTHING;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT cr.container_dist_id,
           sum(cr.inner_count) AS packs,
           max(NULLIF(pd.metadata->>'number_of_pack_slots', '')::int) AS slots,
           sum(cr.inner_count * COALESCE(NULLIF(ip.metadata->>'number_of_pack_slots', '')::int, 0)) AS moments
    FROM public.pack_container_recipes cr
    JOIN public.pack_distributions pd ON pd.collection_id = cr.collection_id AND pd.dist_id = cr.container_dist_id
    JOIN public.pack_distributions ip ON ip.collection_id = cr.collection_id AND ip.dist_id = cr.inner_dist_id
    WHERE cr.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
      AND cr.container_dist_id IN ('8933', '8934')
    GROUP BY 1
  LOOP
    IF r.packs IS DISTINCT FROM r.slots THEN
      RAISE EXCEPTION 'container % recipe holds % packs but its number_of_pack_slots is %', r.container_dist_id, r.packs, r.slots;
    END IF;
    IF r.container_dist_id = '8934' AND r.moments <> 36 THEN
      RAISE EXCEPTION 'Box 8934 recipe yields % Moments, its description says 36', r.moments;
    END IF;
    IF r.container_dist_id = '8933' AND r.moments <> 78 THEN
      RAISE EXCEPTION 'Case 8933 recipe yields % Moments, its description says 78', r.moments;
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT container_dist_id) FROM public.pack_container_recipes
       WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND container_dist_id IN ('8933', '8934')) <> 2 THEN
    RAISE EXCEPTION 'expected recipes for both 8933 and 8934';
  END IF;
END $$;
