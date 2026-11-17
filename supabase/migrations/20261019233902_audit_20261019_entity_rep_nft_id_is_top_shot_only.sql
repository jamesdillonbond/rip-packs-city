-- audit_20261019_entity_rep_nft_id_is_top_shot_only
--
-- 2026-10-19 ~4:45 PM PT (Claude Code cloud; Trevor: "keep going and doing all you can").
-- anon-exec: unchanged (entity_rep_nft_id) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (has_function_privilege anon/authenticated true before, as since 20260623181449).
--
-- WHAT FAILED. /panini-blockchain/set/base-prizm-silver 10-19 1:19 AM PT: get_set_editions hit its 8 s
-- statement_timeout and the page degraded the editions section. Measured now, warm: 2,476 ms on
-- 10,361 buffers, i.e. CPU, not IO. 1,348 ms of it is entity_rep_nft_id over the 100 picked rows
-- (~13.5 ms a call), and every one of the 100 returned NULL: Panini has no wallet_moments_cache,
-- moments or `sales` rows, so all three COALESCE arms miss, and the `sales` arm is planned across
-- all eight yearly partitions per call (18 ms planning, 0.65 ms execution, measured in isolation).
-- Top Shot pays ~0.44 ms a call (98 of 100 hit the first arm, COALESCE stops there).
--
-- WHY RETURNING NULL OFF TOP SHOT IS EXACT, NOT A FEATURE CUT. Every consumer of rep_nft_id builds a
-- Top Shot media URL and gates on the collection first: tsSizedMomentImage (lib/entity-editions-
-- grid-format.ts, `collectionUrlSlug !== "nba-top-shot"` → null; grid tiles + HeroMontage),
-- tsTileImg (lib/pack-dist-format.ts, `collectionSlug === "nba-top-shot"`), and the edition hero
-- (`isTopShotColl`). So off Top Shot the id is computed and then discarded. Callers: get_set_editions,
-- get_player_editions, get_team_top_editions, get_series_editions, get_pack_contents — all unchanged.
-- ⚠ If a non-Top-Shot surface ever wants a representative NFT, widen the CASE here, not the callers.
--
-- The COALESCE body is the live prosrc (md5 90186ed2c43659a2dc9e5ca72452250f, = 20260623181449)
-- verbatim inside the CASE. An untaken CASE arm never evaluates its subqueries.
--
-- REVERT: re-apply the CREATE OR REPLACE in 20260623181449_entity_rep_nft_id_fallback_moments_sales.sql.

CREATE OR REPLACE FUNCTION public.entity_rep_nft_id(p_collection_id uuid, p_external_id text, p_edition_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE WHEN p_collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN
  COALESCE(
    (SELECT w.moment_id FROM wallet_moments_cache w
       WHERE w.collection_id = p_collection_id
         AND w.edition_key = p_external_id
         AND w.moment_id ~ '^[0-9]+$'
       LIMIT 1),
    (SELECT m.nft_id FROM moments m
       WHERE m.edition_id = p_edition_id
         AND m.nft_id ~ '^[0-9]+$'
       LIMIT 1),
    (SELECT s.nft_id FROM sales s
       WHERE s.edition_id = p_edition_id
         AND s.nft_id ~ '^[0-9]+$'
       ORDER BY s.sold_at DESC NULLS LAST
       LIMIT 1)
  )
  END;
$function$;
