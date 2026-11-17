-- Snapshot migration: public.resolve_canonical_player(uuid, text, text).
--
-- This function was applied to prod via the Supabase MCP with no committed
-- migration file, which made it UNPINNABLE — the DB-invariant drift guard has
-- nothing to compare a test copy against, and `npm run db:pins:check` has no
-- committed body to diff live `prosrc` against. This migration commits the
-- CURRENT LIVE definition verbatim (pulled via pg_get_functiondef on
-- 2026-08-02) so the function can carry a pinned invariant test. Applying it is
-- a no-op against prod (byte-identical to what already runs there).
--
-- What it does: the canonical resolve-or-create for a player row keyed on
-- (collection_id, name-slug). Introduced 2026-08-01 for the Top Shot players
-- dedupe (wallet-search had been minting one player row per playID via a
-- flow:<playID> external_id, so TS carried 4,433 duplicate players → 1,359 after
-- this collapsed them). A wrong result here re-fragments players (splitting a
-- single athlete across many rows) or misattributes editions to the wrong player.
--
-- Load-bearing invariants (pinned by supabase/tests/resolve_canonical_player.sql):
--   * NULL/blank name or NULL collection → NULL (never mints a garbage row).
--   * Resolves an EXISTING player by punctuation/case-insensitive name-slug
--     within the collection; tie-break prefers a numeric external_id (canonical)
--     over a non-flow one over a flow:<playID> fossil, then higher edition count.
--   * On an existing match it backfills team ONLY when team IS NULL — it never
--     overwrites a team already set (so a stale p_team can't clobber a good one).
--   * On no match it INSERTs a new canonical row with external_id
--     '<collection-slug>-<name-slug>', resolve-or-create safe under a concurrent
--     insert (ON CONFLICT DO NOTHING then re-select).

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

  v_slug := regexp_replace(lower(trim(p_name)), '[^a-z0-9]+', '-', 'g');
  IF v_slug = '' THEN
    RETURN NULL;
  END IF;

  SELECT p.id INTO v_id
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
       AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = v_slug
     LIMIT 1;
  END IF;

  RETURN v_id;
END
$function$;
