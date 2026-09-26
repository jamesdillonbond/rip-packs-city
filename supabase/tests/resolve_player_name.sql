-- DB invariant: public.resolve_player_name(uuid, text) — the concierge's view
-- of a player NAME (batch 55, 2026-09-25). The property: any spelling a
-- collector might type resolves to the PERSON — exact, a registered alias,
-- the league's spelling, a recorded former name, the base name with a
-- suffix dropped, a unique partial — and the answer carries what the name
-- alone hides: every namesake in the collection (a father and son share a
-- base name) with the RECORDED relation between them, every name the person
-- has used, the crosswalk identity, and whether stats exist. Two people are
-- never merged into one answer: several candidates are 'ambiguous', an
-- unknown name is 'none'.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926011020_audit_20260925_player_relations_and_resolve_player_name_for_the_concierge.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text);
INSERT INTO collections VALUES ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
                               ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot');
CREATE TABLE players (id uuid PRIMARY KEY, collection_id uuid NOT NULL, name text NOT NULL, team text);
CREATE TABLE editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), player_id uuid);
CREATE TABLE player_name_aliases (collection_id uuid, alias_slug text, player_id uuid, note text);
CREATE TABLE player_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  league text NOT NULL, league_player_id text NOT NULL, collection_id uuid NOT NULL, player_id uuid,
  name_slug text NOT NULL, display_name text NOT NULL, espn_id text, position text, status text,
  latest_team text, rookie_season int, last_season int, matched_by text, stats_refreshed_at timestamptz
);
CREATE TABLE player_season_stats (league text, espn_id text, season int);
CREATE TABLE player_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL, player_id uuid NOT NULL, related_player_id uuid,
  relation text NOT NULL CHECK (relation IN ('parent_of', 'namesake', 'name_change')),
  name text, note text
);

-- >>> BEGIN verbatim _player_identity_summary (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public._player_identity_summary(p_collection_id uuid, p_player_id uuid, p_query_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'player', jsonb_build_object(
      'id', p.id, 'name', p.name,
      'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')),
      'team', p.team,
      'edition_count', (SELECT count(*) FROM public.editions e WHERE e.player_id = p.id)),
    'aliases', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('slug', a.alias_slug, 'note', a.note) ORDER BY a.alias_slug), '[]'::jsonb)
        FROM public.player_name_aliases a WHERE a.player_id = p.id),
    'identity', (
      SELECT jsonb_build_object(
        'league', i.league, 'league_player_id', i.league_player_id, 'espn_id', i.espn_id,
        'league_name', i.display_name,
        'league_name_differs', regexp_replace(lower(trim(extensions.unaccent(i.display_name))), '[^a-z0-9]+', '-', 'g')
                               <> regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
        'position', i.position, 'status', i.status,
        'rookie_season', i.rookie_season, 'last_season', i.last_season, 'latest_team', i.latest_team,
        'matched_by', i.matched_by,
        'stats_seasons', (SELECT count(DISTINCT s.season) FROM public.player_season_stats s WHERE s.league = i.league AND s.espn_id = i.espn_id AND i.espn_id IS NOT NULL),
        'stats_refreshed_at', i.stats_refreshed_at)
        FROM public.player_identities i WHERE i.player_id = p.id LIMIT 1),
    'relations', (
      SELECT COALESCE(jsonb_agg(x.rel ORDER BY x.rel->>'relation', x.rel->>'name'), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object('relation', 'parent_of', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note) AS rel
            FROM public.player_relations r JOIN public.players o ON o.id = r.related_player_id
           WHERE r.player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'child_of', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = r.player_id
           WHERE r.related_player_id = p.id AND r.relation = 'parent_of'
          UNION ALL
          SELECT jsonb_build_object('relation', 'unrelated_namesake', 'name', o.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(o.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r JOIN public.players o ON o.id = CASE WHEN r.player_id = p.id THEN r.related_player_id ELSE r.player_id END
           WHERE r.relation = 'namesake' AND (r.player_id = p.id OR r.related_player_id = p.id)
          UNION ALL
          SELECT jsonb_build_object('relation', 'also_known_as', 'name', r.name,
                   'slug', trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g')), 'note', r.note)
            FROM public.player_relations r
           WHERE r.player_id = p.id AND r.relation = 'name_change'
        ) x),
    'matched_query_as', CASE
      WHEN trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')) = p_query_slug THEN 'exact'
      WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.player_id = p.id AND a.alias_slug = p_query_slug) THEN 'alias'
      WHEN EXISTS (SELECT 1 FROM public.player_identities i WHERE i.player_id = p.id AND trim(both '-' from i.name_slug) = p_query_slug) THEN 'league_spelling'
      WHEN EXISTS (SELECT 1 FROM public.player_relations r WHERE r.player_id = p.id AND r.relation = 'name_change'
                      AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = p_query_slug) THEN 'former_name'
      WHEN regexp_replace(trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')), '-(jr|sr|ii|iii|iv|v)$', '')
           = regexp_replace(p_query_slug, '-(jr|sr|ii|iii|iv|v)$', '') THEN 'base_name'
      ELSE 'partial' END)
    FROM public.players p WHERE p.id = p_player_id;
$function$;
-- <<< END verbatim _player_identity_summary <<<

-- >>> BEGIN verbatim resolve_player_name (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.resolve_player_name(p_collection_id uuid, p_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_slug   text;
  v_base   text;
  v_suffix text;
  v_id     uuid;
  v_via    text;
  v_n      int;
  v_ids    uuid[];
  v_rows   jsonb;
  v_ns     jsonb;
  v_out    jsonb;
BEGIN
  IF p_collection_id IS NULL OR p_name IS NULL OR trim(p_name) = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  v_slug := regexp_replace(lower(trim(extensions.unaccent(p_name))), '[^a-z0-9]+', '-', 'g');
  v_slug := trim(both '-' from v_slug);
  IF v_slug = '' THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'reason', 'empty name');
  END IF;
  v_base   := regexp_replace(v_slug, '-(jr|sr|ii|iii|iv|v)$', '');
  v_suffix := CASE WHEN v_base <> v_slug THEN substr(v_slug, length(v_base) + 2) END;

  -- Every row of this collection that could be meant, with its slug and base slug, once.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('player_id', p.id, 'name', p.name, 'slug', s.slug,
                                               'base', regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', ''))), '[]'::jsonb)
    INTO v_rows
    FROM public.players p
    CROSS JOIN LATERAL (SELECT trim(both '-' from regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g')) AS slug) s
   WHERE p.collection_id = p_collection_id
     AND (s.slug = v_slug OR regexp_replace(s.slug, '-(jr|sr|ii|iii|iv|v)$', '') = v_base
          OR s.slug LIKE '%' || v_slug || '%'
          OR p.id IN (SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug)
          OR p.id IN (SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL)
          OR p.id IN (SELECT r.player_id FROM public.player_relations r WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
                        AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug));

  -- (1) the direct arms: exact spelling, a registered alias, the league's spelling
  SELECT array_agg(DISTINCT x.player_id) INTO v_ids
    FROM (
      SELECT t.player_id FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.slug = v_slug
      UNION
      SELECT a.player_id FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug
      UNION
      SELECT i.player_id FROM public.player_identities i WHERE i.collection_id = p_collection_id AND trim(both '-' from i.name_slug) = v_slug AND i.player_id IS NOT NULL
    ) x;
  IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
    v_id := v_ids[1];
    SELECT CASE WHEN EXISTS (SELECT 1 FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.player_id = v_id AND t.slug = v_slug) THEN 'exact'
                WHEN EXISTS (SELECT 1 FROM public.player_name_aliases a WHERE a.collection_id = p_collection_id AND a.alias_slug = v_slug AND a.player_id = v_id) THEN 'alias'
                ELSE 'league_spelling' END INTO v_via;
  ELSIF v_ids IS NOT NULL AND array_length(v_ids, 1) > 1 THEN
    v_via := 'conflict';
  END IF;

  -- (2) a name the person USED (a recorded name change)
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(DISTINCT r.player_id) INTO v_ids
      FROM public.player_relations r
     WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
       AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug;
    IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN
      v_id := v_ids[1]; v_via := 'former_name';
    ELSIF v_ids IS NOT NULL THEN
      v_via := 'conflict';
    END IF;
  END IF;

  -- (3) the base name: the suffix the user typed (or omitted) decides
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.base = v_base;
    IF v_ids IS NOT NULL THEN
      IF array_length(v_ids, 1) = 1 THEN
        v_id := v_ids[1]; v_via := 'base_name';
      ELSIF v_suffix = 'sr' THEN
        -- "X Sr." names the unsuffixed row when exactly one exists
        SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.base = v_base AND t.slug = t.base;
        IF v_ids IS NOT NULL AND array_length(v_ids, 1) = 1 THEN v_id := v_ids[1]; v_via := 'base_name'; ELSE v_via := 'conflict'; END IF;
      ELSE
        v_via := 'conflict';
      END IF;
    END IF;
  END IF;

  -- (4) a partial ("Lillard", "Mahomes")
  IF v_id IS NULL AND v_via IS NULL THEN
    SELECT array_agg(t.player_id) INTO v_ids FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.slug LIKE '%' || v_slug || '%';
    IF v_ids IS NOT NULL THEN
      IF array_length(v_ids, 1) = 1 THEN v_id := v_ids[1]; v_via := 'partial'; ELSE v_via := 'conflict'; END IF;
    END IF;
  END IF;

  IF v_id IS NULL AND v_via IS NULL THEN
    RETURN jsonb_build_object('status', 'none', 'query', p_name, 'query_slug', v_slug,
      'note', 'No player in this collection matches that spelling, alias, league spelling, former name, base name or partial. Do not substitute another person.');
  END IF;

  IF v_id IS NULL THEN
    -- ambiguous: describe every candidate the same way a resolved player is described
    SELECT jsonb_build_object(
             'status', 'ambiguous', 'query', p_name, 'query_slug', v_slug,
             'candidates', COALESCE(jsonb_agg(public._player_identity_summary(p_collection_id, c.player_id, v_slug) ORDER BY c.name), '[]'::jsonb),
             'note', 'Several people match — ask which one, or pick by team / era from the candidates. Never pool two people''s editions or prices into one answer.')
      INTO v_out
      FROM (SELECT DISTINCT t.player_id, t.name FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text) WHERE t.player_id = ANY (v_ids)) c;
    RETURN v_out;
  END IF;

  SELECT COALESCE(jsonb_agg(public._player_identity_summary(p_collection_id, t.player_id, v_slug) ORDER BY t.name), '[]'::jsonb)
    INTO v_ns
    FROM (
      SELECT DISTINCT t.player_id, t.name FROM jsonb_to_recordset(v_rows) AS t(player_id uuid, name text, slug text, base text)
       WHERE t.player_id <> v_id
         AND (t.base = (SELECT b.base FROM jsonb_to_recordset(v_rows) AS b(player_id uuid, name text, slug text, base text) WHERE b.player_id = v_id LIMIT 1)
              OR t.player_id IN (SELECT r.player_id FROM public.player_relations r
                                  WHERE r.collection_id = p_collection_id AND r.relation = 'name_change'
                                    AND regexp_replace(lower(trim(extensions.unaccent(r.name))), '[^a-z0-9]+', '-', 'g') = v_slug)
              OR t.player_id IN (SELECT r.related_player_id FROM public.player_relations r WHERE r.player_id = v_id AND r.related_player_id IS NOT NULL)
              OR t.player_id IN (SELECT r.player_id FROM public.player_relations r WHERE r.related_player_id = v_id))
    ) t;

  v_out := public._player_identity_summary(p_collection_id, v_id, v_slug);
  RETURN jsonb_build_object('status', 'one', 'query', p_name, 'query_slug', v_slug, 'matched_via', v_via)
         || v_out
         || jsonb_build_object('namesakes', v_ns)
         || CASE WHEN jsonb_array_length(v_ns) > 0
                 THEN jsonb_build_object('note', 'Another player in this collection shares this base name (see namesakes, with the recorded relation or "kinship not recorded"). Confirm which person is meant before quoting prices, and never pool two people''s editions.')
                 ELSE '{}'::jsonb END;
END
$function$;
-- <<< END verbatim resolve_player_name <<<

-- Fixture: All Day — the Harrisons (father/son), the two Josh Allens (the
-- Bills QB and the renamed Jaguar), Joe Flacco with a first-name alias,
-- Michael Vick under the league's "Mike Vick", the two unrelated Byron
-- Murphys, Deebo Samuel whom the league suffixes; Top Shot — Damian Lillard
-- (a unique partial) and the Paytons (father/son).
INSERT INTO players (id, collection_id, name, team) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison Jr.', 'Arizona Cardinals'),
  ('a0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Marvin Harrison',     'Indianapolis Colts'),
  ('a0000000-0000-0000-0000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen',          'Buffalo Bills'),
  ('a0000000-0000-0000-0000-000000000004', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Hines-Allen',    'Jacksonville Jaguars'),
  ('a0000000-0000-0000-0000-000000000005', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Joe Flacco',          'Cleveland Browns'),
  ('a0000000-0000-0000-0000-000000000006', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Michael Vick',        'Atlanta Falcons'),
  ('a0000000-0000-0000-0000-000000000007', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Byron Murphy Jr.',    'Minnesota Vikings'),
  ('a0000000-0000-0000-0000-000000000008', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Byron Murphy II',     'Seattle Seahawks'),
  ('a0000000-0000-0000-0000-000000000009', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Deebo Samuel',        'San Francisco 49ers'),
  ('a0000000-0000-0000-0000-000000000010', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Keenan Allen',        'Los Angeles Chargers'),
  ('a0000000-0000-0000-0000-000000000011', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Damian Lillard',      'Portland Trail Blazers'),
  ('a0000000-0000-0000-0000-000000000012', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Gary Payton',         'Seattle SuperSonics'),
  ('a0000000-0000-0000-0000-000000000013', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Gary Payton II',      'Golden State Warriors');
INSERT INTO editions (player_id) SELECT 'a0000000-0000-0000-0000-000000000001' FROM generate_series(1, 11);
INSERT INTO editions (player_id) SELECT 'a0000000-0000-0000-0000-000000000002' FROM generate_series(1, 5);
INSERT INTO editions (player_id) VALUES ('a0000000-0000-0000-0000-000000000003'), ('a0000000-0000-0000-0000-000000000004'), ('a0000000-0000-0000-0000-000000000011');
INSERT INTO player_name_aliases VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'joseph-flacco', 'a0000000-0000-0000-0000-000000000005', 'batch 51: first-name variant of Joe Flacco'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'mike-vick',     'a0000000-0000-0000-0000-000000000006', 'batch 51: league spelling of Michael Vick');
INSERT INTO player_identities (league, league_player_id, collection_id, player_id, name_slug, display_name, espn_id, position, status, latest_team, rookie_season, last_season, matched_by) VALUES
  ('nfl', '00-0039849', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000001', 'marvin-harrison-jr-', 'Marvin Harrison Jr.', '4432708', 'WR', 'ACT', 'ARI', 2024, 2026, 'name'),
  ('nfl', '00-0007024', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000002', 'marvin-harrison',     'Marvin Harrison',     '939',     'WR', 'RET', 'IND', 1996, 2008, 'name'),
  ('nfl', '00-0034857', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000003', 'josh-allen',          'Josh Allen',          '3918298', 'QB', 'ACT', 'BUF', 2018, 2026, 'name+team'),
  ('nfl', '00-0035642', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000004', 'josh-hines-allen',    'Josh Hines-Allen',    '3915239', 'DE', 'ACT', 'JAX', 2019, 2026, 'name'),
  ('nfl', '00-0020245', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000006', 'mike-vick',           'Mike Vick',           NULL,      'QB', 'RET', 'PHI', 2001, 2015, 'hand:2026-09-25'),
  ('nfl', '00-0035719', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000009', 'deebo-samuel-sr-',    'Deebo Samuel Sr.',    '3126486', 'WR', 'ACT', 'SF',  2019, 2026, 'suffix'),
  ('nba', '203081',     '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a0000000-0000-0000-0000-000000000011', 'damian-lillard',      'Damian Lillard',      '6606',    NULL, NULL,  'MIL', 2013, 2025, 'players.external_id');
INSERT INTO player_season_stats VALUES ('nfl', '4432708', 2024), ('nfl', '4432708', 2025), ('nba', '6606', 2025);
INSERT INTO player_relations (collection_id, player_id, related_player_id, relation, name, note) VALUES
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'parent_of', NULL, 'Marvin Harrison Jr. is the son of Hall of Famer Marvin Harrison'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000007', 'a0000000-0000-0000-0000-000000000008', 'namesake',  NULL, 'Unrelated: the Vikings CB and the Seahawks DT'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'a0000000-0000-0000-0000-000000000004', NULL, 'name_change', 'Josh Allen', 'Played as Josh Allen through 2023; Josh Hines-Allen since 2024'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'a0000000-0000-0000-0000-000000000012', 'a0000000-0000-0000-0000-000000000013', 'parent_of', NULL, 'Gary Payton II is the son of Gary Payton');

DO $$
DECLARE r jsonb; ad uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070'; ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
BEGIN
  -- 1. THE case: the suffix-less name is the FATHER by spelling, and the answer says so
  r := resolve_player_name(ad, 'Marvin Harrison');
  PERFORM _assert_eq(r->>'status', 'one', 'Marvin Harrison: one');
  PERFORM _assert_eq(r->>'matched_via', 'exact', 'exact spelling');
  PERFORM _assert_eq(r->'player'->>'name', 'Marvin Harrison', 'the father');
  PERFORM _assert_eq(r->'player'->>'edition_count', '5', 'his edition count');
  PERFORM _assert_eq(jsonb_array_length(r->'namesakes')::text, '1', 'one namesake');
  PERFORM _assert_eq(r->'namesakes'->0->'player'->>'name', 'Marvin Harrison Jr.', 'the son is the namesake');
  PERFORM _assert_eq(r->'namesakes'->0->'relations'->0->>'relation', 'child_of', 'the son knows his father');
  PERFORM _assert_eq(r->'namesakes'->0->'identity'->>'stats_seasons', '2', 'the son has two stat seasons');
  PERFORM _assert_eq(r->'relations'->0->>'relation', 'parent_of', 'the father knows his son');
  PERFORM _assert_eq(r->'relations'->0->>'name', 'Marvin Harrison Jr.', 'by name');
  PERFORM _assert((r->>'note') LIKE '%shares this base name%', 'the answer warns');
  PERFORM _assert_eq(r->'identity'->>'league_player_id', '00-0007024', 'the crosswalk id');
  PERFORM _assert_eq(r->'identity'->>'stats_seasons', '0', 'no stats for the father');

  -- 2. the suffixed spelling is the son, father listed as namesake, no exact-only bias
  r := resolve_player_name(ad, 'Marvin Harrison Jr');
  PERFORM _assert_eq(r->'player'->>'name', 'Marvin Harrison Jr.', 'Jr without the dot -> the son');
  PERFORM _assert_eq(r->'namesakes'->0->'player'->>'name', 'Marvin Harrison', 'father as namesake');

  -- 3. "X Sr." names the unsuffixed row
  r := resolve_player_name(ad, 'Marvin Harrison Sr.');
  PERFORM _assert_eq(r->>'status', 'one', 'Sr.: one');
  PERFORM _assert_eq(r->'player'->>'name', 'Marvin Harrison', 'Sr. -> the father');
  PERFORM _assert_eq(r->>'matched_via', 'base_name', 'via the base name');

  -- 4. a first-name alias
  r := resolve_player_name(ad, 'Joseph Flacco');
  PERFORM _assert_eq(r->>'status', 'one', 'alias: one');
  PERFORM _assert_eq(r->>'matched_via', 'alias', 'via alias');
  PERFORM _assert_eq(r->'player'->>'name', 'Joe Flacco', 'the row');
  PERFORM _assert_eq(r->'aliases'->0->>'slug', 'joseph-flacco', 'aliases listed');
  PERFORM _assert_eq(jsonb_array_length(r->'namesakes')::text, '0', 'no namesakes');
  PERFORM _assert((r->>'note') IS NULL, 'no warning without namesakes');

  -- 5. the league's spelling (an alias here too, and the identity name_slug) — and league_name_differs says so
  r := resolve_player_name(ad, 'Mike Vick');
  PERFORM _assert_eq(r->'player'->>'name', 'Michael Vick', 'Mike Vick -> Michael Vick');
  PERFORM _assert_eq(r->'identity'->>'league_name', 'Mike Vick', 'the league name comes along');
  PERFORM _assert_eq(r->'identity'->>'league_name_differs', 'true', 'and is flagged as different');

  -- 6. a name change: the CURRENT exact row wins, the renamed person is surfaced as a namesake via his former name
  r := resolve_player_name(ad, 'Josh Allen');
  PERFORM _assert_eq(r->>'status', 'one', 'Josh Allen: one');
  PERFORM _assert_eq(r->'identity'->>'league_player_id', '00-0034857', 'the Bills QB');
  PERFORM _assert_eq(jsonb_array_length(r->'namesakes')::text, '1', 'one namesake');
  PERFORM _assert_eq(r->'namesakes'->0->'player'->>'name', 'Josh Hines-Allen', 'the renamed Jaguar');
  PERFORM _assert_eq(r->'namesakes'->0->>'matched_query_as', 'former_name', 'matched the query by his former name');
  PERFORM _assert_eq(r->'namesakes'->0->'relations'->0->>'relation', 'also_known_as', 'his name change is on him');
  PERFORM _assert_eq(r->'namesakes'->0->'relations'->0->>'name', 'Josh Allen', 'with the former name');
  -- and the new name resolves directly, carrying the former name
  r := resolve_player_name(ad, 'Hines-Allen');
  PERFORM _assert_eq(r->'player'->>'name', 'Josh Hines-Allen', 'partial on the new name');
  PERFORM _assert_eq(r->'relations'->0->>'relation', 'also_known_as', 'former name on the resolved row');

  -- 7. the unrelated namesakes: the suffix-less spelling is AMBIGUOUS, both candidates carry the recorded relation
  r := resolve_player_name(ad, 'Byron Murphy');
  PERFORM _assert_eq(r->>'status', 'ambiguous', 'Byron Murphy: ambiguous');
  PERFORM _assert_eq(jsonb_array_length(r->'candidates')::text, '2', 'two candidates');
  PERFORM _assert_eq(r->'candidates'->0->'relations'->0->>'relation', 'unrelated_namesake', 'recorded as unrelated');
  PERFORM _assert((r->>'note') LIKE '%Never pool%', 'told not to pool');

  -- 8. the league suffixes Deebo; the user does not — exact row, league name differs
  r := resolve_player_name(ad, 'Deebo Samuel Sr.');
  PERFORM _assert_eq(r->'player'->>'name', 'Deebo Samuel', 'league spelling with suffix -> the row');
  PERFORM _assert_eq(r->>'matched_via', 'league_spelling', 'via the league spelling');

  -- 9. a unique partial; an ambiguous partial
  r := resolve_player_name(ts, 'Lillard');
  PERFORM _assert_eq(r->>'status', 'one', 'Lillard: one');
  PERFORM _assert_eq(r->>'matched_via', 'partial', 'via partial');
  PERFORM _assert_eq(r->'identity'->>'stats_seasons', '1', 'stats seasons counted');
  r := resolve_player_name(ad, 'Allen');
  PERFORM _assert_eq(r->>'status', 'ambiguous', 'Allen: ambiguous (Josh, Hines-Allen, Keenan)');
  PERFORM _assert_eq(jsonb_array_length(r->'candidates')::text, '3', 'three Allens');

  -- 10. the father/son pair on Top Shot, resolved from the son
  r := resolve_player_name(ts, 'Gary Payton II');
  PERFORM _assert_eq(r->'relations'->0->>'relation', 'child_of', 'GP2 is the child');
  PERFORM _assert_eq(r->'namesakes'->0->'player'->>'name', 'Gary Payton', 'father as namesake');
  PERFORM _assert((r->'identity') IS NULL OR r->'identity' = 'null'::jsonb, 'no identity row -> null, not a fabricated one');

  -- 11. nothing invented
  r := resolve_player_name(ts, 'Zzyzx Nobody');
  PERFORM _assert_eq(r->>'status', 'none', 'unknown: none');
  r := resolve_player_name(ts, '   ');
  PERFORM _assert_eq(r->>'status', 'none', 'blank: none');
  r := resolve_player_name(ad, 'Lillard');
  PERFORM _assert_eq(r->>'status', 'none', 'a Top Shot name is not found on All Day');
END $$;

ROLLBACK;
