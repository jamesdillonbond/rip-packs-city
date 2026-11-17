-- audit_20261112_trust_arm_topshot_container_missing_recipe
--
-- WHY (Cowork cloud, 2026-11-12 ~7:35 AM PT; Trevor: "Yes do it all" — the daily check offered after the
-- Rookie Debut Box/Case EV fix, 20261112144751). A Top Shot box or case is priced by refresh_container_pack_ev
-- (:28) ONLY from a pack_container_recipes row, and recipes are OBSERVED from opened containers. A new drop
-- therefore has NO EV until someone opens one — the Rookie Debut 2026-27 Box (8917) and Case (8916) sat a day
-- with none. Nothing reported it: the writer's `incomplete` count only sees containers that HAVE a recipe.
--
-- New arm topshot_container_missing_recipe_count: Top Shot dists that ARE a box or case (Dapper / the writer
-- typed pack_type box|case, or the title ENDS in "Box"/"Case" — "Box Topper", "Case Break 1", "Jukebox" do not
-- match), first seen in the last 30 days, with no recipe row. Breach at 1. The fix it asks for is the drop-day
-- seed in docs/reference/packs.md (a 'description' recipe from Dapper's own metadata.description; template
-- 20261112144751). The 30-day window keeps it a NEW-DROP detector: 8426 "2025-26 NBA Playoffs Mega Box" (first
-- seen 09-19, one pack NFT, no description, no sales) has no recipe and no source to seed one from, and would
-- otherwise read permanently red.
-- Measured at write: 0 (8916/8917 seeded 6:47 AM PT). Positive control in the DO block: the arm's predicate,
-- with the window widened to 90 days, must count 8426.
--
-- Live definition (md5 asserted) with exactly one fragment replaced (the closing of the last arm, so the new arm
-- is appended before the final SELECT); security_invoker re-specified; no dependent views.
-- REVERT: the same DO block with old/new swapped (guard md5 = the post-change definition).

DO $$
DECLARE
  d text := pg_get_viewdef('public.v_rpc_trust_health'::regclass, true);
  o text := $o$'::text AS catches
        )
 SELECT metric,$o$;
  nw text := $n$'::text AS catches
        UNION ALL
         SELECT 'topshot_container_missing_recipe_count'::text AS metric,
            ( SELECT count(*)::numeric AS count
                   FROM pack_distributions pd
                  WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
                    AND pd.first_seen_at > (now() - '30 days'::interval)
                    AND ((pd.metadata ->> 'pack_type'::text) = ANY (ARRAY['box'::text, 'case'::text]) OR pd.title ~* '\m(box|case)\s*$'::text)
                    AND NOT (EXISTS ( SELECT 1
                           FROM pack_container_recipes cr
                          WHERE cr.collection_id = pd.collection_id AND cr.container_dist_id = pd.dist_id))) AS value,
            1::numeric AS breach_at,
            'a NEW Top Shot box or case with NO EV. refresh_container_pack_ev prices a container only from a pack_container_recipes row, and recipes are OBSERVED from opened containers, so a fresh drop has no EV until someone opens one (Rookie Debut 2026-27 Box 8917 / Case 8916 sat a day with none, 2026-11-11/12). Counts Top Shot dists typed box|case or titled ...Box / ...Case, first seen in 30 days, with no recipe. FIX: seed a description recipe from Dapper metadata.description (docs/reference/packs.md, box/case section; template migration 20261112144751). 30-day window on purpose: 8426 Mega Box has no recipe and no source to seed one'::text AS catches
        )
 SELECT metric,$n$;
  n int;
  pc int;
BEGIN
  IF md5(d) <> '5edd82f6fa57a7cc6daba77e97793828' THEN
    RAISE EXCEPTION 'v_rpc_trust_health drifted (md5 %); re-derive before replacing', md5(d);
  END IF;
  n := (length(d) - length(replace(d, o, ''))) / length(o);
  IF n <> 1 THEN RAISE EXCEPTION 'expected the closing fragment exactly once, found %', n; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health WITH (security_invoker = on) AS ' || replace(d, o, nw);
  IF (SELECT count(*) FROM public.v_rpc_trust_health WHERE metric = 'topshot_container_missing_recipe_count') <> 1 THEN
    RAISE EXCEPTION 'new arm not present exactly once';
  END IF;
  -- positive control: the same predicate over 90 days sees the known recipe-less Mega Box
  SELECT count(*) INTO pc FROM pack_distributions pd
   WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND pd.dist_id = '8426'
     AND ((pd.metadata ->> 'pack_type') = ANY (ARRAY['box','case']) OR pd.title ~* '\m(box|case)\s*$')
     AND NOT EXISTS (SELECT 1 FROM pack_container_recipes cr WHERE cr.collection_id = pd.collection_id AND cr.container_dist_id = pd.dist_id);
  IF pc <> 1 THEN RAISE EXCEPTION 'positive control failed: predicate does not see 8426 (got %)', pc; END IF;
END $$;
