-- 2026-09-25 (PT) — resolve_canonical_player (wallet-search's resolve-or-create,
-- called on every Top Shot wallet search) consults the league-id crosswalk
-- before the name slug: the last name writer that still keyed a person on a
-- label alone. With the NBA half feed-backed from its stats (20260926003757),
-- a label whose base name matches ONE feed-backed identity now resolves to
-- that identity's row — minting it with the LEAGUE's spelling when RPC has
-- none and aliasing the label — while an undecidable label ('ambiguous') and
-- an unknown one ('none') take the unchanged alias → slug → mint path, so
-- nothing that resolved before resolves differently now. Full-body write from
-- the live prosrc (md5 8273a5d9… re-read 2026-09-25 5:55 PM PT); pinned
-- (supabase/tests/resolve_canonical_player.sql re-pointed).
--
-- Revert: re-apply the body from 20260925135939.

-- anon-exec: intentional — full-body write of resolve_canonical_player; its ACL
-- is unchanged by CREATE OR REPLACE (the wallet-search route calls it as service_role)
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
  v_r         jsonb;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  -- 2026-09-25: a registered ALIAS (a second spelling of one person, e.g.
  -- "Stephen Curry" -> the "Steph Curry" row) resolves before the slug match,
  -- so the no-match arm cannot re-mint a merged duplicate.
  SELECT a.player_id INTO v_id
    FROM public.player_name_aliases a
   WHERE a.collection_id = p_collection_id
     AND a.alias_slug = v_slug;

  -- 2026-09-25 (batch 53): the league-id crosswalk decides before the slug.
  -- 'one' is the person (minted with the league's spelling when RPC has no
  -- row; the label aliased when no row owns its slug); 'ambiguous' and
  -- 'none' fall through to the slug match and the mint below, unchanged.
  IF v_id IS NULL THEN
    v_r := public.resolve_player_identity(p_collection_id, p_name, p_team, NULL);
    IF v_r->>'verdict' = 'one' THEN
      v_id := (v_r->>'player_id')::uuid;
      IF v_id IS NULL THEN
        SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;
        INSERT INTO public.players (external_id, collection_id, name, team, collection)
        VALUES (coalesce(v_coll_slug, 'unknown') || '-' || (v_r->>'name_slug'),
                p_collection_id, v_r->>'display_name', nullif(trim(coalesce(p_team, '')), ''),
                coalesce(v_coll_slug, 'unknown'))
        ON CONFLICT (external_id) DO NOTHING
        RETURNING id INTO v_id;
        IF v_id IS NOT NULL THEN
          UPDATE public.player_identities
             SET player_id = v_id, matched_by = 'resolver', matched_at = now()
           WHERE id = (v_r->>'identity_id')::uuid AND player_id IS NULL;
        END IF;
      END IF;
      IF v_id IS NOT NULL AND v_slug <> (v_r->>'name_slug')
         AND NOT EXISTS (SELECT 1 FROM public.players p
                          WHERE p.collection_id = p_collection_id
                            AND regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = v_slug) THEN
        INSERT INTO public.player_name_aliases (collection_id, alias_slug, player_id, note)
        VALUES (p_collection_id, v_slug, v_id, 'resolver ' || to_char(now(), 'YYYY-MM-DD') || ': label for ' || (v_r->>'name_slug'))
        ON CONFLICT (collection_id, alias_slug) DO NOTHING;
      END IF;
    END IF;
  END IF;

  IF v_id IS NULL THEN
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
  END IF;

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

-- Post-conditions on the live crosswalk: a Top Shot label resolves to the
-- keyed row without minting, and the players count does not move.
DO $$
DECLARE v_before int; v_after int; v_id uuid; v_want uuid;
BEGIN
  SELECT count(*) INTO v_before FROM public.players;
  SELECT i.player_id INTO v_want FROM public.player_identities i WHERE i.league = 'nba' AND i.espn_id = '1966';
  IF v_want IS NULL THEN RAISE EXCEPTION 'post-condition: LeBron identity not keyed'; END IF;
  v_id := public.resolve_canonical_player('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'LeBron James', 'Los Angeles Lakers');
  IF v_id IS DISTINCT FROM v_want THEN RAISE EXCEPTION 'resolve_canonical_player: LeBron -> %, want %', v_id, v_want; END IF;
  SELECT count(*) INTO v_after FROM public.players;
  IF v_after <> v_before THEN RAISE EXCEPTION 'resolve_canonical_player: minted % rows on a known player', v_after - v_before; END IF;
END $$;
