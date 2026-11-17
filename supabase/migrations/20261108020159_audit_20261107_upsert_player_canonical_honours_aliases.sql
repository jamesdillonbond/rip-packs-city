-- audit_20261107_upsert_player_canonical_honours_aliases
--
-- 2026-11-07 ~6:05 PM PT (Claude Code cloud). Trevor, 5:58 PM: "make sure
-- we're setup for long term success on these" (today's player renames).
--
-- WHAT WAS WRONG. upsert_player_canonical (the /api/ingest player write) never
-- read player_name_aliases. Today five Top Shot players took their league name
-- (Skylar Diggins, Megan DiLeo, Maya Caldwell, Betnijah Laney-Hamilton, Enes
-- Freedom) with the old spelling kept as an alias — but Dapper's feed still
-- sends the old spelling, and this function would (1) on an external_id hit
-- write it straight back over players.name, and (2) on a slug lookup find no
-- player named it and INSERT a twin. The route has 0 runs in pipeline_runs'
-- retention (its GraphQL source is dead since August), so nothing has reverted
-- yet; this closes it before anything revives it.
--
-- FIX. A name whose slug is a registered alias of the player resolves to that
-- player and never overwrites players.name. Everything else is unchanged.
-- Re-read live before writing: md5(prosrc) = b4a37f3b… = the pinned copy.
--
-- anon-exec: unchanged (upsert_player_canonical) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
--
-- REVERT: re-apply the function from 20260802181500_audit_20260802_snapshot_upsert_player_canonical.sql.

CREATE OR REPLACE FUNCTION public.upsert_player_canonical(p_collection_id uuid, p_external_id text, p_name text, p_first_name text DEFAULT NULL::text, p_last_name text DEFAULT NULL::text, p_team text DEFAULT NULL::text, p_jersey_number integer DEFAULT NULL::integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug       text;
  v_coll_slug  text;
  v_id         uuid;
  v_row_coll   uuid;
  v_row_ext    text;
  v_blocked    boolean := false;
  v_team       text := nullif(trim(coalesce(p_team, '')), '');
  v_name       text := nullif(trim(coalesce(p_name, '')), '');
  v_alias_of   uuid;
BEGIN
  IF p_collection_id IS NULL
     OR p_external_id IS NULL OR trim(p_external_id) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(coalesce(v_name, ''))), '[^a-z0-9]+', '-', 'g');

  -- 2026-11-07: a spelling registered in player_name_aliases is ANOTHER NAME for
  -- that player (a former name, the source's spelling, a nickname). It resolves to
  -- the player and NEVER overwrites players.name — the catalog name is a decision
  -- (e.g. the league's own spelling), and the feed still sends the old one.
  IF v_slug <> '' THEN
    SELECT a.player_id INTO v_alias_of
      FROM public.player_name_aliases a
     WHERE a.collection_id = p_collection_id
       AND btrim(a.alias_slug, '-') = btrim(v_slug, '-')
     ORDER BY a.player_id
     LIMIT 1;
  END IF;

  -- 1. exact external_id hit (external_id is GLOBALLY unique, so at most one row)
  SELECT p.id, p.collection_id INTO v_id, v_row_coll
    FROM public.players p
   WHERE p.external_id = p_external_id;

  IF v_id IS NOT NULL THEN
    IF v_row_coll IS DISTINCT FROM p_collection_id THEN
      -- the id belongs to a DIFFERENT collection; never mutate that row, and an
      -- INSERT here would violate the global unique. Fall through to slug
      -- resolution, but forbid inserting.
      v_blocked := true;
      v_id := NULL;
    ELSE
      UPDATE public.players p SET
        name          = CASE WHEN v_alias_of = p.id THEN p.name ELSE COALESCE(v_name, p.name) END,
        first_name    = COALESCE(p.first_name,    p_first_name),
        last_name     = COALESCE(p.last_name,     p_last_name),
        team          = COALESCE(p.team,          v_team),
        jersey_number = COALESCE(p.jersey_number, p_jersey_number),
        updated_at    = now()
      WHERE p.id = v_id;
      RETURN v_id;
    END IF;
  END IF;

  -- 2. canonical resolution by (collection_id, name-slug)
  IF v_slug <> '' THEN
    SELECT p.id, p.external_id INTO v_id, v_row_ext
      FROM public.players p
     WHERE p.collection_id = p_collection_id
       AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
     ORDER BY CASE WHEN p.external_id ~ '^[0-9]+$'  THEN 1
                   WHEN p.external_id LIKE 'flow:%' THEN 3
                   ELSE 2 END,
              (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id) DESC,
              p.id
     LIMIT 1;

    -- no row carries this name: a registered alias names the player instead
    IF v_id IS NULL AND v_alias_of IS NOT NULL THEN
      SELECT p.id, p.external_id INTO v_id, v_row_ext
        FROM public.players p
       WHERE p.id = v_alias_of AND p.collection_id = p_collection_id;
    END IF;

    IF v_id IS NOT NULL THEN
      -- adopt the canonical numeric stats id onto a slug-scheme row when free
      IF p_external_id ~ '^[0-9]+$'
         AND v_row_ext !~ '^[0-9]+$'
         AND NOT EXISTS (SELECT 1 FROM public.players x WHERE x.external_id = p_external_id)
      THEN
        UPDATE public.players SET external_id = p_external_id WHERE id = v_id;
      END IF;

      UPDATE public.players p SET
        name          = CASE WHEN v_alias_of = p.id THEN p.name ELSE COALESCE(v_name, p.name) END,
        first_name    = COALESCE(p.first_name,    p_first_name),
        last_name     = COALESCE(p.last_name,     p_last_name),
        team          = COALESCE(p.team,          v_team),
        jersey_number = COALESCE(p.jersey_number, p_jersey_number),
        updated_at    = now()
      WHERE p.id = v_id;

      RETURN v_id;
    END IF;
  END IF;

  -- 3. cross-collection collision and no slug match -> cannot insert safely
  IF v_blocked THEN
    RETURN NULL;
  END IF;

  -- 4. genuinely new player
  SELECT c.slug INTO v_coll_slug FROM public.collections c WHERE c.id = p_collection_id;

  INSERT INTO public.players (external_id, collection_id, collection, name,
                              first_name, last_name, team, jersey_number)
  VALUES (p_external_id, p_collection_id, coalesce(v_coll_slug, 'unknown'),
          coalesce(v_name, 'Unknown Player'),
          p_first_name, p_last_name, v_team, p_jersey_number)
  ON CONFLICT (external_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- lost an insert race: re-resolve
    SELECT p.id INTO v_id FROM public.players p WHERE p.external_id = p_external_id;
    IF v_id IS NULL AND v_slug <> '' THEN
      SELECT p.id INTO v_id
        FROM public.players p
       WHERE p.collection_id = p_collection_id
         AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
       LIMIT 1;
    END IF;
  END IF;

  RETURN v_id;
END
$function$;
