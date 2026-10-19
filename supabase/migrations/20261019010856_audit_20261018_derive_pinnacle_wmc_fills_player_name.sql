-- audit_20261018_derive_pinnacle_wmc_fills_player_name
--
-- WHY (found 10-18 ~6:10 PM PT re-reading deep-audit D8's exit): 41 Pinnacle wmc rows of one wallet
-- (0xa9435b88c3798c19, written 6:28 AM PT) had character_name ("Django") but player_name NULL, though
-- their catalog rows exist since 09-27. Mechanism: wallet-backfill-pinnacle's post-pass
-- (backfill_pinnacle_wmc_metadata_from_editions) ran while render_id was still NULL, so it could not
-- read the pin; /api/cron/pinnacle-wmc-render-id (hourly) later set render_id and called THIS
-- function, which copied character_name / set_name / mint_count / image_url but never player_name. So
-- every such pin waited for the daily 3:33 AM PT heal (jobid 727), up to ~21 h with no subject name.
-- HOW: fill player_name here too, NULL or 'Unknown' only (never a rewrite), from the pin's
-- `characters` trait formatted exactly as the canonical heal formats it (CLAUDE.md: a character is
-- the `characters` trait, never character_name — that is the fallback for an object pin only).
-- Cost: same join as before (EXPLAIN 10-18: ~40.7k buffers over 41,229 joined rows); the characters
-- subplan ran 41 times. Hourly.
-- Test: new pin supabase/tests/derive_pinnacle_wmc_from_catalog.sql; the live (old) body fails it
-- ("got [<NULL>], want [Django]"). The function had no migration in the repo; the old live body,
-- verified equal to prosrc 10-18 (md5 8eef1781643712326cd5a3830750c29d), is the REVERT below.
-- anon-exec: intentional — unchanged; CREATE OR REPLACE with the same signature keeps the existing grants (postgres + service_role only) (derive_pinnacle_wmc_from_catalog)
-- REVERT:
--   CREATE OR REPLACE FUNCTION public.derive_pinnacle_wmc_from_catalog()
--    RETURNS integer
--    LANGUAGE plpgsql
--    SECURITY DEFINER
--    SET search_path TO 'public'
--   AS $function$
--   DECLARE
--     v_count integer;
--   BEGIN
--     UPDATE wallet_moments_cache w
--     SET character_name = c.character_name,
--         set_name       = c.set_name,
--         mint_count     = COALESCE(c.total_minted, w.mint_count),
--         image_url      = c.thumbnail_url
--     FROM pinnacle_catalog c
--     WHERE w.render_id = c.render_id
--       AND w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
--       AND c.character_name IS NOT NULL
--       AND (
--         w.character_name IS DISTINCT FROM c.character_name
--         OR w.set_name IS DISTINCT FROM c.set_name
--         OR w.image_url IS DISTINCT FROM c.thumbnail_url
--         OR w.mint_count IS DISTINCT FROM COALESCE(c.total_minted, w.mint_count)
--       );
--     GET DIAGNOSTICS v_count = ROW_COUNT;
--     RETURN v_count;
--   END;
--   $function$;

CREATE OR REPLACE FUNCTION public.derive_pinnacle_wmc_from_catalog()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer;
BEGIN
  -- 2026-10-18: player_name is FILLED here too (NULL or the literal 'Unknown' only,
  -- never rewritten). It is the pin's `characters` trait, formatted exactly as the
  -- canonical heal backfill_pinnacle_wmc_metadata_from_editions formats it ("Simba",
  -- "Poe Dameron & BB-8", "Simba, Timon & Pumbaa"; an object pin with no character
  -- reads as its character_name). Before this, a row whose render_id landed after the
  -- wallet post-pass got character_name here but player_name only from the daily
  -- 3:33 AM PT heal, up to ~21 h later (41 rows of one wallet, 10-18).
  UPDATE wallet_moments_cache w
  SET character_name = c.character_name,
      set_name       = c.set_name,
      mint_count     = COALESCE(c.total_minted, w.mint_count),
      image_url      = c.thumbnail_url,
      player_name    = CASE
                         WHEN w.player_name IS NULL OR w.player_name = 'Unknown'
                         THEN COALESCE(ch.player, w.player_name)
                         ELSE w.player_name
                       END
  FROM pinnacle_catalog c
  CROSS JOIN LATERAL (
    SELECT COALESCE(
             CASE cardinality(a.arr)
               WHEN 0 THEN NULL
               WHEN 1 THEN a.arr[1]
               ELSE array_to_string(a.arr[1:cardinality(a.arr) - 1], ', ')
                    || ' & ' || a.arr[cardinality(a.arr)]
             END,
             NULLIF(btrim(c.character_name), '')
           ) AS player
      FROM (
        SELECT ARRAY(
          SELECT btrim(u.x)
            FROM unnest(c.characters) WITH ORDINALITY AS u(x, o)
           WHERE btrim(u.x) <> ''
           ORDER BY u.o
        ) AS arr
      ) a
  ) ch
  WHERE w.render_id = c.render_id
    AND w.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'
    AND c.character_name IS NOT NULL
    AND (
      w.character_name IS DISTINCT FROM c.character_name
      OR w.set_name IS DISTINCT FROM c.set_name
      OR w.image_url IS DISTINCT FROM c.thumbnail_url
      OR w.mint_count IS DISTINCT FROM COALESCE(c.total_minted, w.mint_count)
      OR ((w.player_name IS NULL OR w.player_name = 'Unknown') AND ch.player IS NOT NULL)
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;
