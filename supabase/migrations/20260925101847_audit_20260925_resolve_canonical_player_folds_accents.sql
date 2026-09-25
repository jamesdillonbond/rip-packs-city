-- 2026-09-25 (PT) — resolve_canonical_player folds ACCENTS in its lookup.
--
-- WHY. Its name-slug was `lower(trim(name))` with every non-[a-z0-9] run
-- collapsed to '-', so an accented letter became a DASH: "Dennis Schröder" →
-- 'dennis-schr-der', "Dennis Schroder" → 'dennis-schroder'. Two spellings of
-- one person never matched, and the no-match arm minted a second players row
-- — 17 accent/case-variant duplicates by 09-25 (Luka Dončić / "Luka Doncic",
-- Alperen Şengün / "Alperen Sengun" 38 + 17 editions, Nikola Vučević, Marine
-- Johannès, Manu Ginóbili, …), each a second /player/ page and a second search
-- hit; merged in 20260925101708. get_player_detail (20260906165511) and
-- ensure_players_from_edition_names already compare the UNACCENTED slug; this
-- is the last name writer that did not.
--
-- WHAT. `extensions.unaccent()` inside the slug on BOTH sides (the probe and
-- every players.name), in the lookup and in the post-insert re-select, so a
-- new row's external_id is also the unaccented '<collection-slug>-<name-slug>'
-- ('nba_top_shot-noemie-brochant', not '-no-mie-brochant'). Everything else —
-- the NULL guards, the numeric > other > flow: tie-break, the edition-count
-- tie-break, team backfill only when NULL, ON CONFLICT DO NOTHING + re-select
-- — is byte-identical to 20260802181000. ACL unchanged (postgres,
-- service_role only; never anon).
-- Pinned by supabase/tests/resolve_canonical_player.sql (verbatim copy below).
-- Revert: re-apply 20260802181000 (the un-accented body).

-- anon-exec: intentional — resolve_canonical_player stays service_role/postgres-only (ACL unchanged by CREATE OR REPLACE; it was REVOKEd from PUBLIC, anon and authenticated in 20260802020000).
CREATE OR REPLACE FUNCTION public.resolve_canonical_player(p_collection_id uuid, p_name text, p_team text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug      text;
  v_coll_slug text;
  v_id        uuid;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_id
    FROM public.players p
   WHERE p.collection_id = p_collection_id
     AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
   ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                 WHEN p.external_id LIKE 'flow:%' THEN 3
                 ELSE 2 END,
            (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
            p.id
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    IF p_team IS NOT NULL AND trim(p_team) <> '' THEN
      UPDATE public.players SET team = p_team, updated_at = now()
       WHERE id = v_id AND team IS NULL;
    END IF;
    RETURN v_id;
  END IF;

  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, name, team, collection)
  VALUES (coalesce(v_coll_slug, 'unknown') || '-' || v_slug,
          p_collection_id, trim(p_name), nullif(trim(coalesce(p_team, '')), ''),
          coalesce(v_coll_slug, 'unknown'))
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT p.id INTO v_id
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;
