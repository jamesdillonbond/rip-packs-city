-- audit_20260927_pinnacle_wmc_names_come_from_the_pin_catalog
--
-- Disney Pinnacle holdings showed the WRONG character — or the literal word
-- "Unknown" — in the trophy picker and everywhere else reading
-- wallet_moments_cache.player_name.
--
-- Cause: `backfill_pinnacle_wmc_metadata_from_editions` (the post-pass of every
-- Pinnacle wallet backfill) filled player_name and character_name from
-- `pinnacle_editions`, which is SET-LEVEL: one character per set+variant key
-- (CLAUDE.md "Disney Pinnacle grain"). Every pin in a set inherited that one
-- name, and a multi-character set's name is the literal 'Unknown'. The pin
-- grain is `pinnacle_catalog`, keyed by render_id, whose `characters` array is
-- the character(s) and `character_name` the pin's title. Measured 2026-09-27
-- over the 41,198 Pinnacle rows (render_id present and catalog-matched on all):
--   · 769 rows read 'Unknown' (e.g. OEV3-TOYS-DOLL-S5 → "Dolly");
--   · ~31k read a different character from the same set (LEV1-SWPA-YODA-S6 →
--     "Chewbacca", OEV1-LION-SCAR-S5 → "Nala", OEV1-JUNG-BALO-S2 → "Kaa").
--   The render_id spells the catalog's answer in every sampled case.
-- This is the known-issues #150 class (Pinnacle readers moved to the catalog
-- 2026-09-26); this writer was not among them, so the read fix could not hold.
--
-- Fix:
--   1. The writer takes names from the catalog by render_id: player_name = the
--      pin's characters joined ' & ' (trimmed), else its title; character_name
--      = the pin title. It never writes a set-level name, and never 'Unknown'.
--      set_name / tier / mint_count keep their set-level source unchanged.
--   2. One-time repair of every Pinnacle row whose player_name disagrees with
--      its catalog pin.
--
-- Revert: re-apply the prior body (prosrc md5 15f5dd70c29831f7366921120c34ea5e),
-- same signature and attributes (plpgsql, SECURITY DEFINER, search_path
-- public,pg_temp, statement_timeout 120s). Its body, verbatim, was:
--   DECLARE v_pinnacle_collection_id uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714'; v_updated integer;
--   BEGIN
--     WITH updated AS (
--       UPDATE public.wallet_moments_cache wmc
--          SET character_name = COALESCE(wmc.character_name, pe.character_name),
--              player_name    = COALESCE(wmc.player_name,    pe.character_name),
--              set_name       = COALESCE(wmc.set_name,       pe.set_name),
--              tier           = COALESCE(wmc.tier,           pe.variant_type),
--              mint_count     = COALESCE(wmc.mint_count,     pe.mint_count)
--         FROM public.pinnacle_editions pe
--        WHERE pe.edition_key = wmc.edition_key AND wmc.collection_id = v_pinnacle_collection_id
--          AND wmc.edition_key IS NOT NULL
--          AND (wmc.character_name IS NULL OR wmc.player_name IS NULL OR wmc.set_name IS NULL
--               OR wmc.tier IS NULL OR (wmc.mint_count IS NULL AND pe.mint_count IS NOT NULL))
--          AND (p_wallet_address IS NULL OR wmc.wallet_address = p_wallet_address)
--       RETURNING 1)
--     SELECT COUNT(*)::int INTO v_updated FROM updated;
--     RETURN COALESCE(v_updated, 0);
--   END;
-- The data repair is not reversed — the prior values were the defect.

-- anon-exec: unchanged (backfill_pinnacle_wmc_metadata_from_editions) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false, authenticated=false.
CREATE OR REPLACE FUNCTION public.backfill_pinnacle_wmc_metadata_from_editions(p_wallet_address text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pinnacle_collection_id uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_updated integer;
BEGIN
  -- Names come from the PIN (pinnacle_catalog by render_id), never from the
  -- set-level pinnacle_editions row: that table carries one character per set
  -- and the literal 'Unknown' for multi-character sets, which every pin in the
  -- set inherited. set_name / tier / mint_count stay set-level (correct grain).
  WITH src AS (
    SELECT w.id,
           pe.set_name     AS pe_set_name,
           pe.variant_type AS pe_tier,
           pe.mint_count   AS pe_mint_count,
           NULLIF(btrim(pc.character_name), '') AS pc_title,
           COALESCE(
             NULLIF(array_to_string(ARRAY(
               SELECT btrim(x) FROM unnest(pc.characters) AS x WHERE btrim(x) <> ''
             ), ' & '), ''),
             NULLIF(btrim(pc.character_name), '')
           ) AS pc_player
      FROM public.wallet_moments_cache w
      LEFT JOIN public.pinnacle_editions pe ON pe.edition_key = w.edition_key
      LEFT JOIN public.pinnacle_catalog  pc ON pc.render_id   = w.render_id
     WHERE w.collection_id = v_pinnacle_collection_id
       AND (p_wallet_address IS NULL OR w.wallet_address = p_wallet_address)
       AND (pe.edition_key IS NOT NULL OR pc.render_id IS NOT NULL)
  ),
  updated AS (
    UPDATE public.wallet_moments_cache wmc
       SET character_name = COALESCE(s.pc_title, wmc.character_name),
           player_name    = COALESCE(s.pc_player, NULLIF(wmc.player_name, 'Unknown')),
           set_name       = COALESCE(wmc.set_name,   s.pe_set_name),
           tier           = COALESCE(wmc.tier,       s.pe_tier),
           mint_count     = COALESCE(wmc.mint_count, s.pe_mint_count)
      FROM src s
     WHERE wmc.id = s.id
       AND (
         (s.pc_title  IS NOT NULL AND wmc.character_name IS DISTINCT FROM s.pc_title) OR
         (s.pc_player IS NOT NULL AND wmc.player_name    IS DISTINCT FROM s.pc_player) OR
         wmc.player_name = 'Unknown' OR
         (wmc.set_name   IS NULL AND s.pe_set_name   IS NOT NULL) OR
         (wmc.tier       IS NULL AND s.pe_tier       IS NOT NULL) OR
         (wmc.mint_count IS NULL AND s.pe_mint_count IS NOT NULL)
       )
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_updated FROM updated;

  RETURN COALESCE(v_updated, 0);
END;
$function$;

-- One-time repair across every wallet (the function with NULL = all Pinnacle rows).
SELECT public.backfill_pinnacle_wmc_metadata_from_editions(NULL);
