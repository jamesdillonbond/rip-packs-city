-- audit_20260802_upsert_player_canonical
--
-- Applied to prod 2026-08-02 via Supabase MCP; this file is the repo record.
--
-- WHY (two live defects in app/api/ingest/route.ts upsertPlayer, one shape):
--
-- 1. DUPLICATE FACTORY. upsertPlayer arbitrates on (external_id, collection_id)
--    while `players` also carries a STRICTER GLOBAL UNIQUE(external_id). A human
--    already present under the `<coll_slug>-<name-slug>` scheme (2,513 such rows,
--    written by ensure_players_from_edition_names / resolve_canonical_player) is
--    INVISIBLE to an arbiter keyed on a numeric NBA stats id, so ingest inserts a
--    SECOND row for the same person. Verified: `John Havlicek` existed twice --
--    `nba_top_shot-john-havlicek` (01:22Z) and `76970` (15:35Z, i.e. AFTER the
--    08-02 dedupe). ~2 numeric rows/week, so it is a slow leak, not a burst.
--    ensure_players_from_edition_names is NOT a factory -- it is slug-guarded by
--    a NOT EXISTS on the same slug expression. Only this writer duplicated.
--
-- 2. STALE-TEAM CLOBBER -- the live user-facing half. upsertPlayer wrote
--    `team = stats.teamAtMoment`, the team AT THE TIME OF THE MOMENT, on EVERY
--    sale. get_player_detail returns `players.team` directly (the recent-edition
--    join only breaks ties BETWEEN duplicate candidate rows), so after the 08-02
--    dedupe left one row per slug there is no correct candidate left to pick and
--    the page renders whatever ingest last wrote. This silently undid
--    audit_20260802_players_team_from_recent_edition: that migration repaired 148
--    rows at ~12:40Z and by 16:38Z ingest had re-broken 23 of them. Measured
--    live: Jrue Holiday -> 'Boston Celtics' (plays in Portland), Marcus Smart ->
--    'Boston Celtics' (Lakers), Kelly Olynyk -> 'Utah Jazz' (Spurs), Andre
--    Drummond -> 'Chicago Bulls' (76ers). Same class 418ec607 fixed.
--
-- FIX: one SECDEF resolver the route calls instead of a blind .upsert().
--   * identity is the (collection_id, name-slug) pair, using the SAME slug
--     expression get_player_detail / resolve_canonical_player /
--     ensure_players_from_edition_names use, so all four agree on identity;
--   * enrichable columns are COALESCE FILL-ONLY -- a non-NULL value is NEVER
--     overwritten, so teamAtMoment can seed a brand-new player but can never
--     clobber a derived current team;
--   * a numeric NBA stats id is ADOPTED onto an existing slug-scheme row when
--     that id is free, so the canonical numeric external_id is preserved without
--     minting a second row (matches resolve_canonical_player's preference order);
--   * a cross-collection external_id collision returns NULL rather than raising
--     23505 -- same observable outcome as the old error path (player_id null),
--     without an exception. This closes the latent ON CONFLICT hazard the
--     2026-08-02 roadmap flagged rather than merely renaming it.
--
-- Race-safety: the INSERT is ON CONFLICT (external_id) DO NOTHING with a
-- re-select fallback, so two concurrent ingest lambdas cannot both insert.
--
-- Verified behaviourally against a synthetic row before the route was switched:
-- three calls with two different external_ids produced ONE row for the slug;
-- `team`/`jersey_number` survived two clobber attempts; the numeric id was
-- adopted onto the slug-scheme row. Probe rows deleted afterwards.
--
-- REVERT:
--   DROP FUNCTION IF EXISTS public.upsert_player_canonical(uuid,text,text,text,text,text,integer);
--   (and `git revert` the app/api/ingest/route.ts commit, which restores the
--    original .upsert() -- the two must move together.)

CREATE OR REPLACE FUNCTION public.upsert_player_canonical(
  p_collection_id uuid,
  p_external_id   text,
  p_name          text,
  p_first_name    text DEFAULT NULL,
  p_last_name     text DEFAULT NULL,
  p_team          text DEFAULT NULL,
  p_jersey_number integer DEFAULT NULL
)
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

REVOKE EXECUTE ON FUNCTION public.upsert_player_canonical(uuid,text,text,text,text,text,integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.upsert_player_canonical(uuid,text,text,text,text,text,integer) FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.upsert_player_canonical(uuid,text,text,text,text,text,integer) TO service_role;
