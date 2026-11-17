-- audit_20260927_pinnacle_multi_character_names_read_as_a_list
--
-- Follow-up to 20260927164039_audit_20260927_pinnacle_wmc_names_come_from_the_pin_catalog
-- (same day, applied minutes earlier). That migration joined a multi-character
-- pin's characters with ' & ' throughout, so a three-character pin read
-- "Simba & Timon & Pumbaa". This one formats the list as "Simba, Timon & Pumbaa"
-- (two characters keep "Poe Dameron & BB-8") and re-runs the writer over every
-- Pinnacle row. Nothing else in the body changes.
--
-- Revert: re-apply the body in 20260927164039_audit_20260927_pinnacle_wmc_names_come_from_the_pin_catalog.sql
-- and re-run `SELECT public.backfill_pinnacle_wmc_metadata_from_editions(NULL);`.

-- anon-exec: unchanged (backfill_pinnacle_wmc_metadata_from_editions) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false after the prior migration.
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
           -- "Simba", "Poe Dameron & BB-8", "Simba, Timon & Pumbaa"; a pin
           -- with no character (an object/scene pin) reads as its title.
           COALESCE(
             CASE cardinality(ch.arr)
               WHEN 0 THEN NULL
               WHEN 1 THEN ch.arr[1]
               ELSE array_to_string(ch.arr[1:cardinality(ch.arr) - 1], ', ')
                    || ' & ' || ch.arr[cardinality(ch.arr)]
             END,
             NULLIF(btrim(pc.character_name), '')
           ) AS pc_player
      FROM public.wallet_moments_cache w
      LEFT JOIN public.pinnacle_editions pe ON pe.edition_key = w.edition_key
      LEFT JOIN public.pinnacle_catalog  pc ON pc.render_id   = w.render_id
      LEFT JOIN LATERAL (
        SELECT ARRAY(
          SELECT btrim(u.x)
            FROM unnest(pc.characters) WITH ORDINALITY AS u(x, o)
           WHERE btrim(u.x) <> ''
           ORDER BY u.o
        ) AS arr
      ) ch ON true
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

SELECT public.backfill_pinnacle_wmc_metadata_from_editions(NULL);
