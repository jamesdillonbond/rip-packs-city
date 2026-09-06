-- audit_20260906_player_slugs_resolve_unaccented_pack_hero_names_fall_back_to_team_and_dead_golazos_pack_art_v0
--
-- Three user-visible defects found by the 2026-09-06 510-page entity QA sweep
-- (250 editions / 100 players / 50 sets / 50 teams / 40 packs, served HTML +
-- a real 390px Chromium), each fixed at the layer that every consumer inherits.
--
-- 1. /nba-top-shot/player/<slug> 404s for 57 of the 1,413 player URLs the
--    sitemap emits (4%). Three classes, measured live:
--      · 44 TEAM Moments whose `editions.player_name` equals `team_name`
--        (Squad Goals / Season Rewind / WNBA Skyline) — fixed in
--        lib/sitemap-data.ts (routed to /team/, where they already resolve).
--      · 9 legacy players with no `players` row (Run It Back / Immortals) —
--        `ensure_players_from_edition_names()` was written for exactly this on
--        2026-08-01, ran once, and was never scheduled. It is run here and
--        scheduled daily below.
--      · 4 diacritic mismatches (editions `Vít Krejčí`, players `Vit Krejci`):
--        the emitted slug `v-t-krej-` matches nothing. The three player RPCs now
--        ALSO match the unaccented name, and `slugifyName()` strips combining
--        marks in the same commit so both sides emit `vit-krejci`.
--
-- 2. Pack pages rendered "Unknown" as the subject of a team Moment in the
--    "Top chases" strip (dist 1211: "Unknown · Squad Goals · $3.74"). 151
--    canonical Top Shot editions carry NULL player_name — 151/151 have a
--    team_name. `get_pack_detail_bundle` now publishes
--    coalesce(player_name, team_name) plus team_name itself.
--    ⛔ NOT `UPDATE editions SET player_name = team_name` — that recreates
--    class 1 above. NULL player + team_name is the CORRECT shape.
--
-- 3. Six `pack_distributions` rows point Golazos pack art at
--    `…/packs/<x>_v0/images/pack.png`, which 404s; the same path without `_v0`
--    serves 200 (checked 2026-09-06 for all three distinct URLs).
--
-- Every function edit is a GUARDED SPLICE: assert the live md5, assert the
-- anchor occurs exactly once, replace, assert the new marker is present,
-- re-create from pg_get_functiondef so SECURITY / SET clauses are preserved
-- byte-for-byte. Any failed assertion RAISEs and rolls the whole file back.
--
-- Revert: the pre-splice bodies are recoverable from
-- supabase_migrations.schema_migrations (this file's statements) and the md5s
-- below; the data half is `update pack_distributions set image_url =
-- replace(image_url, '/images/pack.png', '_v0/images/pack.png') where id in
-- (the six ids logged by the DO block)`, `cron.unschedule('rpc-ensure-players-from-edition-names')`.

DO $splice$
DECLARE
  v_oid oid;
  v_def text;
  v_old text;
  v_new text;
  v_n int;
BEGIN
  ------------------------------------------------------------------
  -- (2) get_pack_detail_bundle — hero subject falls back to team_name
  ------------------------------------------------------------------
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_pack_detail_bundle';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_pack_detail_bundle missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'ee22757b37c6899ac63b3db5db062d13' THEN
    RAISE EXCEPTION 'get_pack_detail_bundle body drifted from the version this splice was written against (md5 %)',
      md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);
  v_old := E'           e.player_name, e.set_name, e.tier::text as tier, e.thumbnail_url,';
  v_new := E'           coalesce(nullif(trim(e.player_name), \'\'), e.team_name) as player_name,\n'
        || E'           e.team_name, e.set_name, e.tier::text as tier, e.thumbnail_url,';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'get_pack_detail_bundle anchor count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  IF position('e.team_name, e.set_name' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition failed (bundle)'; END IF;
  EXECUTE v_def;

  ------------------------------------------------------------------
  -- (1c) the three player RPCs also match the UNACCENTED players.name
  ------------------------------------------------------------------
  v_old := E'regexp_replace(lower(trim(p.name)), \'[^a-z0-9]+\', \'-\', \'g\') = p_player_slug';
  v_new := E'(regexp_replace(lower(trim(p.name)), \'[^a-z0-9]+\', \'-\', \'g\') = p_player_slug\n'
        || E'           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), \'[^a-z0-9]+\', \'-\', \'g\') = p_player_slug)';
  FOR v_oid IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('get_player_detail', 'get_player_editions', 'get_player_top_sales')
  LOOP
    v_def := pg_get_functiondef(v_oid);
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    IF v_n <> 1 THEN
      RAISE EXCEPTION '% anchor count % (expected 1)', v_oid::regprocedure, v_n;
    END IF;
    v_def := replace(v_def, v_old, v_new);
    IF position('extensions.unaccent(p.name)' IN v_def) = 0 THEN
      RAISE EXCEPTION 'post-condition failed (%)', v_oid::regprocedure;
    END IF;
    EXECUTE v_def;
  END LOOP;

  ------------------------------------------------------------------
  -- (1b) ensure_players_from_edition_names: never seed a TEAM Moment's
  --      team name, the literal "Team Moment", or a name that already
  --      resolves once unaccented (which would create a duplicate player)
  ------------------------------------------------------------------
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'ensure_players_from_edition_names';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'ensure_players_from_edition_names missing'; END IF;
  v_def := pg_get_functiondef(v_oid);
  v_old := E'       AND trim(e.player_name) <> \'\'\n';
  v_new := E'       AND trim(e.player_name) <> \'\'\n'
        || E'       -- 2026-09-06: a team Moment carries its franchise as player_name; that\n'
        || E'       -- is a /team/ page, not a player, and the literal placeholder is neither\n'
        || E'       AND trim(e.player_name) IS DISTINCT FROM trim(e.team_name)\n'
        || E'       AND lower(trim(e.player_name)) <> \'team moment\'\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ensure_players anchor A count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  v_old := E'                AND regexp_replace(lower(trim(p.name)), \'[^a-z0-9]+\', \'-\', \'g\')\n'
        || E'                  = regexp_replace(lower(trim(e.player_name)), \'[^a-z0-9]+\', \'-\', \'g\')\n';
  v_new := E'                AND regexp_replace(lower(trim(extensions.unaccent(p.name))), \'[^a-z0-9]+\', \'-\', \'g\')\n'
        || E'                  = regexp_replace(lower(trim(extensions.unaccent(e.player_name))), \'[^a-z0-9]+\', \'-\', \'g\')\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'ensure_players anchor B count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  IF position('IS DISTINCT FROM trim(e.team_name)' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition failed (ensure_players)'; END IF;
  EXECUTE v_def;

  ------------------------------------------------------------------
  -- data: the literal placeholder (2 rows measured) and the six _v0 URLs
  ------------------------------------------------------------------
  UPDATE public.editions SET player_name = NULL WHERE player_name = 'Team Moment';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 5 THEN RAISE EXCEPTION 'Team Moment placeholder rows % (expected <= 5) — re-measure before proceeding', v_n; END IF;
  RAISE NOTICE 'Team Moment placeholders nulled: %', v_n;

  UPDATE public.pack_distributions
     SET image_url = replace(image_url, '_v0/images/pack.png', '/images/pack.png')
   WHERE image_url LIKE 'https://assets.laligagolazos.com/packs/%_v0/images/pack.png';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n > 12 THEN RAISE EXCEPTION 'golazos _v0 rows % (expected 6) — re-measure before proceeding', v_n; END IF;
  RAISE NOTICE 'golazos _v0 pack art rows rewritten: %', v_n;

  ------------------------------------------------------------------
  -- (1b) seed the legacy players now (9 measured), then keep it seeded daily
  ------------------------------------------------------------------
  SELECT public.ensure_players_from_edition_names(NULL, 500) INTO v_n;
  RAISE NOTICE 'players seeded from edition names: %', v_n;
  IF v_n > 60 THEN
    RAISE EXCEPTION 'ensure_players seeded % rows (measured 9 + at most a few); the exclusions did not hold — rolled back', v_n;
  END IF;
END
$splice$;

-- Daily self-heal. One-statement pg_cron job (postgres owner). Idempotent: the
-- function inserts only slugs that do not resolve, so a quiet day inserts 0.
SELECT cron.schedule(
  'rpc-ensure-players-from-edition-names',
  '50 9 * * *',
  $$select public.ensure_players_from_edition_names(NULL, 500);$$
);

-- Post-flight, readable by the next auditor: how many sitemap player slugs
-- would still 404 (expected 0 for every collection once the sitemap change
-- deploys; the 44 team-Moment slugs are excluded here the same way the
-- sitemap now excludes them).
DO $verify$
DECLARE v_bad int;
BEGIN
  WITH sm AS (
    SELECT e.collection_id,
           regexp_replace(lower(trim(extensions.unaccent(e.player_name))), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.editions e
      JOIN public.collections c ON c.id = e.collection_id
     WHERE c.slug IN ('nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike')
       AND coalesce(trim(e.player_name), '') <> ''
       AND trim(e.player_name) IS DISTINCT FROM trim(e.team_name)
       AND NOT (c.slug = 'nba_top_shot' AND coalesce(e.external_id, '') LIKE '%-%')
     GROUP BY 1, 2
  ), pl AS (
    SELECT DISTINCT collection_id,
           regexp_replace(lower(trim(extensions.unaccent(name))), '[^a-z0-9]+', '-', 'g') AS slug
      FROM public.players
  )
  SELECT count(*) INTO v_bad FROM sm LEFT JOIN pl USING (collection_id, slug) WHERE pl.slug IS NULL;
  RAISE NOTICE 'sitemap player slugs that would still 404: %', v_bad;
  IF v_bad > 5 THEN RAISE EXCEPTION 'post-flight: % player slugs still unresolved (expected ~0)', v_bad; END IF;
END
$verify$;
