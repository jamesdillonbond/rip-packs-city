-- ============================================================================
-- audit_20260801_seed_players_from_edition_names
-- Applied to prod via Supabase MCP 2026-08-01 (version 20260802012214).
-- This file is the repo record of that migration; it is idempotent and a no-op
-- if re-applied.
--
-- CAUSE
--   Every player LINK on the site is built from `editions.player_name`
--   (lib/sitemap-data.ts -> slugifyName(e.player_name), and the same slug on
--   every edition/moment page), but `get_player_detail` resolves the slug
--   against `players.name`:
--       regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
--   A player who appears ONLY on editions therefore has a link and a sitemap
--   entry but no `players` row, so the page 404s (and, since the entity-detail
--   layout gate returns a real 404, Google sees a dead sitemap URL).
--
--   lib/entity-labels.slugifyName is
--       name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
--   i.e. semantically IDENTICAL to the SQL regexp above (no unaccent, no
--   trailing-dash trim), so the JS-side and DB-side slugs agree exactly and the
--   measurement below is the true 404 set.
--
-- EVIDENCE (measured live 2026-08-01, distinct edition-derived player slugs
--           with no matching `players` row, per collection):
--       ufc_strike      37 missing / 381 distinct   (9.7%)
--       nba_top_shot    33 missing / 4418 distinct  (0.7%)
--       nfl_all_day      0
--       laliga_golazos   0
--       candy_mlb        0
--   = 70 slugs that render a link and 404. Examples: "Manu Ginobili" (5
--   editions), "Maya Caldwell" (5), "Oscar Robertson" (3), "Jerry West" (3),
--   "Kayla Harrison" (2), "Quinton Jackson" (2).
--   AFTER: 0 unresolvable slugs in all 5 collections; players 4400->4433 (TS)
--   and 344->381 (UFC).
--
-- FIX
--   A re-runnable self-heal in the same shape as `ensure_topshot_edition_stub`:
--   seed the missing `players` rows from DISTINCT `editions.player_name`.
--
--   external_id scheme: `<collections.slug>-<name-slug>`. This is NOT invented --
--   it is the EXISTING scheme for every name-only player row on this table
--   (nfl_all_day-*, laliga_golazos-*, ufc_strike-*, disney_pinnacle-*; verified
--   live). It matters because `players` carries a GLOBAL `UNIQUE (external_id)`
--   (players_external_id_key) on top of the composite
--   `UNIQUE (external_id, collection_id)`, so the collection prefix is what
--   keeps two collections' same-named players from colliding. Top Shot's own
--   rows use numeric / `flow:NNNN` ids, so the `nba_top_shot-` namespace is
--   free (verified: 0 existing rows match).
--
-- SCOPE / SAFETY
--   * INSERT-only, ON CONFLICT DO NOTHING. Never updates or deletes an existing
--     player row, so a real (GQL-sourced, headshot-bearing) row always wins.
--   * DISTINCT ON the slug, so two edition spellings that collapse to the same
--     slug produce ONE row (the external_id is slug-derived and must be unique).
--   * Rows are name-only (team/position/headshot NULL, player_tier default
--     TIER3) -- identical to the existing seeded rows for the other collections.
--     `get_player_detail` degrades cleanly on those.
--
-- REVERT (exact)
--   DELETE FROM public.players
--    WHERE headshot_url IS NULL AND team IS NULL AND nba_stats_id IS NULL
--      AND created_at >= '2026-08-01'::date
--      AND external_id ~ '^(nba_top_shot|ufc_strike)-';
--   DROP FUNCTION IF EXISTS public.ensure_players_from_edition_names(uuid, int);
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_players_from_edition_names(
  p_collection_id uuid DEFAULT NULL,
  p_limit         int  DEFAULT 5000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_inserted int;
BEGIN
  WITH missing AS (
    SELECT DISTINCT ON (
             e.collection_id,
             regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')
           )
           e.collection_id                                                        AS collection_id,
           c.slug                                                                 AS coll_slug,
           regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')     AS name_slug,
           trim(e.player_name)                                                    AS player_name
      FROM public.editions e
      JOIN public.collections c ON c.id = e.collection_id
     WHERE e.player_name IS NOT NULL
       AND trim(e.player_name) <> ''
       AND (p_collection_id IS NULL OR e.collection_id = p_collection_id)
       -- the slug must not already resolve; this predicate is byte-for-byte the
       -- one get_player_detail uses, so we seed exactly the 404 set
       AND NOT EXISTS (
             SELECT 1
               FROM public.players p
              WHERE p.collection_id = e.collection_id
                AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g')
                  = regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g')
           )
     ORDER BY e.collection_id,
              regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'),
              trim(e.player_name)
     LIMIT p_limit
  ),
  ins AS (
    INSERT INTO public.players (external_id, collection_id, name, collection)
    SELECT m.coll_slug || '-' || m.name_slug,
           m.collection_id,
           m.player_name,
           m.coll_slug
      FROM missing m
    ON CONFLICT (external_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN v_inserted;
END
$fn$;

COMMENT ON FUNCTION public.ensure_players_from_edition_names(uuid, int) IS
  'Self-heal: seeds a name-only public.players row for every DISTINCT editions.player_name whose slug does not already resolve, so edition-derived /player/<slug> links (sitemap + every edition page) stop 404ing. external_id = <collections.slug>-<name-slug>, matching the existing name-only scheme and satisfying the GLOBAL unique on external_id. INSERT-only, ON CONFLICT DO NOTHING - never overwrites a real GQL-sourced player row. Re-runnable and idempotent. Added 2026-08-01 (audit_20260801_seed_players_from_edition_names).';

-- Service-role only: a new function's default EXECUTE grant is to PUBLIC, and
-- revoking only from anon/authenticated leaves that PUBLIC grant intact.
REVOKE ALL ON FUNCTION public.ensure_players_from_edition_names(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_players_from_edition_names(uuid, int) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_players_from_edition_names(uuid, int) TO service_role;

-- Run it once, for every collection, and PROVE the gap actually closed.
DO $do$
DECLARE
  v_before int;
  v_after  int;
  v_seeded int;
BEGIN
  SELECT count(*) INTO v_before
    FROM (
      SELECT DISTINCT e.collection_id,
             regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') AS s
        FROM public.editions e
       WHERE e.player_name IS NOT NULL AND trim(e.player_name) <> ''
    ) d
   WHERE NOT EXISTS (
           SELECT 1 FROM public.players p
            WHERE p.collection_id = d.collection_id
              AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = d.s
         );

  v_seeded := public.ensure_players_from_edition_names(NULL, 5000);

  SELECT count(*) INTO v_after
    FROM (
      SELECT DISTINCT e.collection_id,
             regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') AS s
        FROM public.editions e
       WHERE e.player_name IS NOT NULL AND trim(e.player_name) <> ''
    ) d
   WHERE NOT EXISTS (
           SELECT 1 FROM public.players p
            WHERE p.collection_id = d.collection_id
              AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = d.s
         );

  RAISE NOTICE 'unresolvable player slugs: before=% after=% seeded=%', v_before, v_after, v_seeded;

  IF v_before > 0 AND v_seeded = 0 THEN
    RAISE EXCEPTION 'ensure_players_from_edition_names seeded 0 rows but % slugs were unresolvable - aborting', v_before;
  END IF;
  IF v_after <> 0 THEN
    RAISE EXCEPTION 'expected 0 unresolvable player slugs after seeding, got % - aborting', v_after;
  END IF;
END
$do$;
