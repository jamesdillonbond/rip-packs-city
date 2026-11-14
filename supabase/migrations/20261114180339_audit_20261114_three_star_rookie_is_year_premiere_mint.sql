-- audit_20261114_three_star_rookie_is_year_premiere_mint
--
-- WHAT: badge_editions.is_three_star_rookie (Top Shot) used the wrong rule. atlas_editions_drain
-- (the live writer, pg_cron) set it from Rookie Year + Rookie Premiere + TOP SHOT DEBUT; Top Shot's
-- own moment page defines Three-Star Rookie as "all three Rookie badges: Rookie Year, Rookie Mint,
-- and Rookie Premiere" (read 2026-11-14 on nbatopshot.com/moment/53148542, Aday Mara Rookie
-- Ultimate #1/1). get_edition_badges_unified already used Year + Premiere + Mint (its "v2 rule")
-- but ORs in the stored flag, so the 3 wrongly-true editions still showed the badge there, and
-- every reader of the stored flag (binder BadgeInfo, badge_score, wallet intel, market cap) missed
-- the 80 wrongly-false ones. Measured before: 14,881 Top Shot rows; the old rule reproduces the
-- stored flag on 14,881 / 14,881; the right rule differs on 83 (80 gain, 3 lose).
--
-- HOW: (1) md5-asserted catalog splice of atlas_editions_drain(): the `is3` expression's
-- 'TOP_SHOT_DEBUT' term becomes 'ROOKIE_MINT' (the slugs array already carries set-play tags --
-- its `rm` column reads ROOKIE_MINT from the same array). SECURITY DEFINER, search_path and
-- grants (anon/authenticated EXECUTE false) are preserved by CREATE OR REPLACE.
-- (2) Backfill the 83 rows: flag := the right rule; badge_score moves by the drain's own +4 term
-- ("three-star AND rookie mint"), so score = old score + 4*(new3 - (old3 AND rm)). The other
-- score terms do not depend on the rule and are untouched.
-- Code twins in the same commit: lib/topshot-badges.ts isThreeStarRookie, app/api/badge-sync.
--
-- APPLIED 2026-11-14 ~10:04 AM PT via apply_migration (version 20261114180339) with Trevor's OK
-- ("Fix these and apply it"). Read back: 14,881 Top Shot rows, 0 differ from the right rule,
-- 684 three-star; 285:9443 true / score 7; drain md5 47f9d007... -> cac88ebdcda63c71f03c1ce12d2efe8d;
-- anon EXECUTE false.
--
-- REVERT: the inverse splice (base md5 cac88ebdcda63c71f03c1ce12d2efe8d), and the
-- inverse backfill (old rule, score - 4*(new3) + 4*(old3 AND rm)) over the same predicate.

DO $mig$
DECLARE d text; d2 text; m text;
  a_old constant text := $a$('ROOKIE_YEAR' = ANY(r.slugs) AND 'ROOKIE_PREMIERE' = ANY(r.slugs) AND 'TOP_SHOT_DEBUT' = ANY(r.slugs)) AS is3$a$;
  a_new constant text := $a$('ROOKIE_YEAR' = ANY(r.slugs) AND 'ROOKIE_PREMIERE' = ANY(r.slugs) AND 'ROOKIE_MINT' = ANY(r.slugs)) AS is3$a$;
BEGIN
  d := pg_get_functiondef('public.atlas_editions_drain()'::regprocedure);
  m := md5(d);
  IF m <> '47f9d007b3dc3c277b7f566e09d839ba' THEN
    RAISE EXCEPTION 'atlas_editions_drain base md5 drift: got %, refusing splice', m;
  END IF;
  IF (length(d) - length(replace(d, a_old, ''))) <> length(a_old) THEN
    RAISE EXCEPTION 'splice anchor (is3 with TOP_SHOT_DEBUT) not present exactly once';
  END IF;
  d2 := replace(d, a_old, a_new);
  IF d2 = d THEN RAISE EXCEPTION 'splice produced no change'; END IF;
  EXECUTE d2;
  d := pg_get_functiondef('public.atlas_editions_drain()'::regprocedure);
  IF position(a_new in d) = 0 OR position(a_old in d) > 0 THEN
    RAISE EXCEPTION 'post-splice: is3 rule not as intended';
  END IF;
  RAISE NOTICE 'atlas_editions_drain spliced; new md5 %', md5(d);
END $mig$;

DO $bf$
DECLARE n int;
BEGIN
  WITH s AS (
    SELECT be.external_id, be.badge_score, be.is_three_star_rookie,
           ARRAY(SELECT x->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(be.play_tags) = 'array' THEN be.play_tags ELSE '[]'::jsonb END) x
                 UNION
                 SELECT x->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(be.set_play_tags) = 'array' THEN be.set_play_tags ELSE '[]'::jsonb END) x) AS slugs
      FROM public.badge_editions be
     WHERE be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  ), f AS (
    SELECT external_id, badge_score, is_three_star_rookie,
           ('ROOKIE_YEAR' = ANY(slugs) AND 'ROOKIE_PREMIERE' = ANY(slugs) AND 'TOP_SHOT_DEBUT' = ANY(slugs)) AS old3,
           ('ROOKIE_YEAR' = ANY(slugs) AND 'ROOKIE_PREMIERE' = ANY(slugs) AND 'ROOKIE_MINT' = ANY(slugs)) AS new3,
           ('ROOKIE_MINT' = ANY(slugs)) AS rm
      FROM s
  )
  UPDATE public.badge_editions be
     SET is_three_star_rookie = f.new3,
         badge_score = f.badge_score + 4 * (f.new3::int - (f.old3 AND f.rm)::int)
    FROM f
   WHERE be.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND be.external_id = f.external_id AND f.new3 IS DISTINCT FROM f.is_three_star_rookie;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 200 THEN RAISE EXCEPTION 'backfill touched % rows; expected ~83 -- refusing', n; END IF;
  RAISE NOTICE 'three-star backfill: % rows', n;
END $bf$;
