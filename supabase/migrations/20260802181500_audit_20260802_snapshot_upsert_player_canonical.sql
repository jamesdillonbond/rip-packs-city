-- Snapshot migration: public.upsert_player_canonical(uuid, text, text, text, text, text, integer).
--
-- Applied to prod 2026-08-02 via the Supabase MCP (audit_20260802_upsert_player_canonical)
-- as the canonical player write path for app/api/ingest — replacing a blind
-- .upsert() that clobbered players.team on every sale. That migration IS committed,
-- but this SNAPSHOT commits the CURRENT LIVE body verbatim (pulled via
-- pg_get_functiondef 2026-08-02) so the function can carry a drift-guarded pinned
-- invariant test (the ledger flagged the pin as owed but deferred it for lack of a
-- local Postgres). Applying it is a no-op vs prod (byte-identical to what runs there).
--
-- What it guards (pinned by supabase/tests/upsert_player_canonical.sql):
--   * NULL collection or NULL/blank external_id → NULL (never mints garbage).
--   * Exact external_id hit in the SAME collection → COALESCE FILL-ONLY update:
--     first_name/last_name/team/jersey_number fill only when currently NULL and are
--     NEVER overwritten (the whole point — a moment's teamAtMoment can't clobber a
--     derived team); name IS authoritative-on-provide (COALESCE(provided, existing)).
--   * Exact external_id hit in a DIFFERENT collection → BLOCKED: the other row is
--     never mutated and no insert is attempted (players carries a global
--     UNIQUE(external_id)) → returns NULL.
--   * Canonical (collection, name-slug) resolution adopts a numeric stats id onto a
--     slug/flow-scheme row when that id is free, without minting a second row.
--   * Genuinely new player → INSERT (blank name → 'Unknown Player').

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
BEGIN
  IF p_collection_id IS NULL
     OR p_external_id IS NULL OR trim(p_external_id) = '' THEN
    RETURN NULL;
  END IF;

  v_slug := regexp_replace(lower(trim(coalesce(v_name, ''))), '[^a-z0-9]+', '-', 'g');

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
        name          = COALESCE(v_name, p.name),
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

    IF v_id IS NOT NULL THEN
      -- adopt the canonical numeric stats id onto a slug-scheme row when free
      IF p_external_id ~ '^[0-9]+$'
         AND v_row_ext !~ '^[0-9]+$'
         AND NOT EXISTS (SELECT 1 FROM public.players x WHERE x.external_id = p_external_id)
      THEN
        UPDATE public.players SET external_id = p_external_id WHERE id = v_id;
      END IF;

      UPDATE public.players p SET
        name          = COALESCE(v_name, p.name),
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
