-- audit_20260926_every_pinnacle_catalog_character_gets_a_page
--
-- WHY. Character pages now list pins from the render catalog (20260926191419),
-- but a page exists only where public.players has a row — and those rows came
-- from pinnacle_editions characters. Measured 2026-09-26: 266 of the 508
-- distinct names in pinnacle_catalog.characters had NO page (Darth Maul,
-- Jafar, Lady Tremaine, Count Dooku …), although their pins are listed on the
-- Market and set pages.
--
-- WHAT. pinnacle_editions_fill_from_catalog() gains a fourth step that calls
-- pinnacle_ensure_character_player for every catalog character, franchise =
-- its most common first franchise with ™/®/© stripped (after stripping, the
-- catalog's franchise names match pinnacle_editions' 72 exactly). The helper
-- never overwrites an existing row, skips 'Unknown' and dedupes by slug. Runs
-- daily with the fill (07:43 UTC) and once here.
--
-- REVERT: re-apply the function from 20260926185325; rows this added can be
--   removed by created_at (this run) if wanted.

-- anon-exec: unchanged (pinnacle_editions_fill_from_catalog) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.pinnacle_editions_fill_from_catalog()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_inserted integer;
  v_repaired integer;
  v_thumbs   integer;
  v_before   integer;
  v_chars    integer;
BEGIN
  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key                      AS k,
      NULLIF(btrim(pc.characters[1]), '')        AS character_name,
      NULLIF(btrim(pc.franchises[1]), '')        AS franchise,
      NULLIF(btrim(pc.set_name), '')             AS set_name,
      pc.royalty_code,
      pc.variant,
      pc.edition_type,
      pc.printing,
      pc.limited_edition,
      pc.is_chaser,
      CASE WHEN pc.series_name ~ '^[0-9]{4}$' THEN pc.series_name::int END AS series_year
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  ),
  minted AS (
    SELECT pc.legacy_edition_key AS k,
           CASE WHEN count(DISTINCT pc.total_minted) = 1 AND count(pc.total_minted) = count(*)
                THEN min(pc.total_minted) END AS mint_count
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    GROUP BY pc.legacy_edition_key
  )
  INSERT INTO public.pinnacle_editions (
    id, edition_key, character_name, franchise, set_name, royalty_code,
    series_year, variant_type, edition_type, printing, mint_count,
    is_serialized, is_chaser
  )
  SELECT r.k, r.k, r.character_name, COALESCE(r.franchise, 'Unknown'), r.set_name,
         r.royalty_code, r.series_year, COALESCE(r.variant, 'Standard'),
         COALESCE(r.edition_type, 'Open Edition'), COALESCE(r.printing, 1),
         m.mint_count, COALESCE(r.limited_edition, false), COALESCE(r.is_chaser, false)
  FROM rep r
  JOIN minted m ON m.k = r.k
  WHERE r.character_name IS NOT NULL
    AND r.set_name IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.pinnacle_editions pe WHERE pe.id = r.k)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  WITH rep AS (
    SELECT DISTINCT ON (pc.legacy_edition_key)
      pc.legacy_edition_key               AS k,
      NULLIF(btrim(pc.characters[1]), '') AS character_name,
      NULLIF(btrim(pc.franchises[1]), '') AS franchise,
      NULLIF(btrim(pc.set_name), '')      AS set_name
    FROM public.pinnacle_catalog pc
    WHERE pc.legacy_edition_key IS NOT NULL
    ORDER BY pc.legacy_edition_key, pc.render_id
  )
  UPDATE public.pinnacle_editions pe
     SET character_name = CASE WHEN pe.character_name = 'Unknown' AND r.character_name IS NOT NULL THEN r.character_name ELSE pe.character_name END,
         franchise      = CASE WHEN pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL THEN r.franchise      ELSE pe.franchise      END,
         set_name       = CASE WHEN pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL THEN r.set_name       ELSE pe.set_name       END,
         updated_at     = now()
    FROM rep r
   WHERE r.k = pe.id
     AND (   (pe.character_name = 'Unknown' AND r.character_name IS NOT NULL)
          OR (pe.franchise      = 'Unknown' AND r.franchise      IS NOT NULL)
          OR (pe.set_name       = 'Unknown' AND r.set_name       IS NOT NULL));
  GET DIAGNOSTICS v_repaired = ROW_COUNT;

  -- (3) Thumbnails (20260926 follow-up). A row whose thumbnail is NULL or the
  -- contract's generic placeholder gets the resolver URL of its OWN render —
  -- only when exactly ONE catalog render under the key carries the row's
  -- character. Several renders of one character under a set-level key (e.g. a
  -- royalty code shared by two sets) is left alone rather than guessed.
  WITH one AS (
    SELECT pe.id, min(pc.render_id) AS render_id
    FROM public.pinnacle_editions pe
    JOIN public.pinnacle_catalog pc
      ON pc.legacy_edition_key = pe.id
     AND lower(btrim(pc.characters[1])) = lower(btrim(pe.character_name))
    WHERE pe.thumbnail_url IS NULL
       OR btrim(pe.thumbnail_url) = ''
       OR pe.thumbnail_url LIKE '%/on-chain/pinnacle.jpg%'
    GROUP BY pe.id
    HAVING count(*) = 1
  )
  UPDATE public.pinnacle_editions pe
     SET thumbnail_url = '/api/public/pinnacle-image/' || one.render_id,
         updated_at    = now()
    FROM one
   WHERE one.id = pe.id
     AND one.render_id ~ '^[A-Za-z0-9-]{3,64}$';
  GET DIAGNOSTICS v_thumbs = ROW_COUNT;

  -- (4) Characters (20260926 follow-up). Every character the catalog's
  -- Characters trait names gets its players row — the page is
  -- /disney-pinnacle/player/<slug>, and it lists that character's pins from the
  -- catalog. Only characters reached by pinnacle_editions had one (266 of 508
  -- catalog characters had no page). Franchise = the character's most common
  -- first franchise, with trademark symbols stripped ("Star Wars™" is
  -- "Star Wars" everywhere else). pinnacle_ensure_character_player never
  -- overwrites, skips 'Unknown', and dedupes by slug. The count is rows
  -- WRITTEN (players before vs after), not calls made.
  SELECT count(*) INTO v_before FROM public.players
   WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid;
  PERFORM public.pinnacle_ensure_character_player(c.n, c.team)
  FROM (
    SELECT btrim(ch) AS n,
           mode() WITHIN GROUP (ORDER BY NULLIF(btrim(regexp_replace(pc.franchises[1], '[™®©]', '', 'g')), '')) AS team
    FROM public.pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.characters) AS ch
    WHERE btrim(ch) <> ''
    GROUP BY btrim(ch)
    ORDER BY count(*) DESC, btrim(ch)
  ) c;
  SELECT count(*) - v_before INTO v_chars FROM public.players
   WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid;

  RETURN jsonb_build_object('inserted', v_inserted, 'repaired', v_repaired, 'thumbnails', v_thumbs, 'characters', v_chars);
END;
$function$;

SELECT public.pinnacle_editions_fill_from_catalog();
