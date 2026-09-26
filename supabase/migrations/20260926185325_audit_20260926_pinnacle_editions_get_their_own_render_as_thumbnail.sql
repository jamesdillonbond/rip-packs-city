-- audit_20260926_pinnacle_editions_get_their_own_render_as_thumbnail
--
-- WHY. 325 pinnacle_editions rows showed no art: 82 carried the contract's
-- generic placeholder ("…/on-chain/pinnacle.jpg" — the same logo for every NFT)
-- and 243 were NULL. pinnacle_editions.thumbnail_url feeds 15 functions,
-- among them the character, franchise, series and edition pages
-- (get_player_editions, get_team_top_editions, get_series_editions,
-- get_edition_detail …). Measured 2026-09-26: 159 of the 325 match EXACTLY ONE
-- catalog render by (legacy key, character); 17 match several renders of the
-- same character, 1 is ambiguous, 148 have no catalog render at all.
--
-- WHAT. pinnacle_editions_fill_from_catalog() gains a third step: a NULL /
-- blank / placeholder thumbnail is set to '/api/public/pinnacle-image/<render_id>'
-- (our own resolver, which mints a signed CDN URL for that exact render) when
-- exactly one render matches. Everything else stays as it is — no guess. The
-- function keeps its schedule (rpc-pinnacle-editions-fill-from-catalog, 07:43
-- UTC) and runs once here.
--
-- ⚠ PAIRED WRITER, same commit: /api/pinnacle-ingest passed Flowty's card image
-- (always that placeholder) into upsert_pinnacle_edition, whose
-- `thumbnail_url = COALESCE(EXCLUDED.thumbnail_url, …)` would overwrite a real
-- thumbnail with the logo. The route now sends NULL for the placeholder.
--
-- REVERT: re-apply the function from 20260926171433 (section A verbatim).
--   Thumbnails this wrote are the only '/api/public/pinnacle-image/%' values on
--   rows whose updated_at is this run's; they can be reset to NULL if wanted.

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

  RETURN jsonb_build_object('inserted', v_inserted, 'repaired', v_repaired, 'thumbnails', v_thumbs);
END;
$function$;

SELECT public.pinnacle_editions_fill_from_catalog();
