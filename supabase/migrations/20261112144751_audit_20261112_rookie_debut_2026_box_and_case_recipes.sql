-- 2026-11-12 (Cowork cloud; Trevor: "How can we get to having Rip EV on Boxes and Cases?" → "Yes proceed with all").
--
-- The Rookie Debut 2026-27 Box (8917) and Case (8916) had NO EV: a container holds packs, not
-- Moments, so it has no drop pool, and refresh_container_pack_ev (:28 hourly) prices a container
-- only from a pack_container_recipes row. Its recipes are OBSERVED from opened containers, and no
-- 2026-27 box or case has been opened on record (0 marketplace sales of either at 6:40 AM PT), so
-- neither had one. Every inner pack already carries a live EV (6:25 AM PT snapshot):
--   8928 Box Topper $77.78 (93 % priced) · 8919 Collector Pack $39.68 (92 %)
--   8926 Case Topper $1,050.38 (21 %)   · 8927 Premium Pack $915.63 (74 %)
--
-- Seeded from Dapper's own distribution descriptions (pack_distributions.metadata.description), the
-- 'description' source the 2026-10-10 recipe migration (20261011020800) reserved for exactly this:
--   8917 "Every Rookie Debut Box holds 5 packs and 18 Moments: a Box Topper and 4 Rookie Debut
--         Collector Packs."            → 8928 x1 (2 Moments) + 8919 x4 (4 each) = 5 packs, 18 Moments
--   8916 "Every Rookie Debut Case holds 12 packs and 53 Moments: a Case Topper, a Premium Pack and
--         10 Rookie Debut Collector Packs." → 8926 x1 (1) + 8927 x1 (12) + 8919 x10 (4 each)
--                                          = 12 packs, 53 Moments
-- Both pack AND Moment counts reconcile with the descriptions (checked below, and the DO block
-- refuses to commit if the pack count ever disagrees with number_of_pack_slots).
--
-- An observed recipe REPLACES these the first time a box or case is opened (step 1 of
-- refresh_container_pack_ev deletes the pairs it did not write for a re-derived container).
-- The writer publishes a container only when EVERY inner pack has a real EV row, with
-- coverage = the MINIMUM inner coverage — so the Case stays below pack_table_rows' 25 % gate
-- until the Case Topper's pool is priced; the Box publishes on the next :28 run.
--
-- No function change. Data only.
-- Revert: DELETE FROM public.pack_container_recipes WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
--           AND container_dist_id IN ('8916','8917') AND source = 'description';

INSERT INTO public.pack_container_recipes (collection_id, container_dist_id, inner_dist_id, inner_count, source)
VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8917', '8928',  1, 'description'),  -- Rookie Debut Box: Box Topper
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8917', '8919',  4, 'description'),  --   + 4 Collector Packs
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8916', '8926',  1, 'description'),  -- Rookie Debut Case: Case Topper
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8916', '8927',  1, 'description'),  --   + Premium Pack
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '8916', '8919', 10, 'description')   --   + 10 Collector Packs
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
      AND cr.container_dist_id IN ('8916', '8917')
    GROUP BY 1
  LOOP
    IF r.packs IS DISTINCT FROM r.slots THEN
      RAISE EXCEPTION 'container % recipe holds % packs but its number_of_pack_slots is %', r.container_dist_id, r.packs, r.slots;
    END IF;
    IF r.container_dist_id = '8917' AND r.moments <> 18 THEN
      RAISE EXCEPTION 'Box 8917 recipe yields % Moments, its description says 18', r.moments;
    END IF;
    IF r.container_dist_id = '8916' AND r.moments <> 53 THEN
      RAISE EXCEPTION 'Case 8916 recipe yields % Moments, its description says 53', r.moments;
    END IF;
  END LOOP;
END $$;
