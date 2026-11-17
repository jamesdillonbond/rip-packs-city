-- DB invariant: the two sitemap readers for the cross-collection hubs
-- (2026-10-23) — list_indexable_player_hubs() (the canonical slug of every
-- /players/<slug> hub that get_player_hub renders indexable: one sport group
-- gathering 2+ collections) and list_indexable_franchise_hubs() (every
-- /teams/<league>/<slug> hub whose league collection is enabled AND whose
-- Panini panel has cards). The property: the sitemap lists a hub exactly when
-- the page would index it, under the URL the page canonicalises to — a name
-- shared by two collections of ONE sport is listed once; the same name across
-- two sports (two people) is not; a one-collection name is not; an alias
-- spelling gathers the same hub and the hub is listed under the member with
-- the most editions; a franchise is listed only with both a league collection
-- and a mapped Panini card, and never when inactive.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261023073556_audit_20261023_sitemap_lists_the_indexable_hubs.sql;
-- list_indexable_franchise_hubs re-pointed 2026-10-25 to 20261026044548_audit_20261025_panini_edition_team_keys.sql,
-- which reads the per-edition map panini_edition_team_keys instead of the raw walk listings);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- ── stand-ins for the tables the readers touch ──────────────────────────────
CREATE TABLE collections (id uuid PRIMARY KEY, slug text, is_active boolean DEFAULT true);
INSERT INTO collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot',      true),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day',       true),
  ('d1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'panini_blockchain', false),  -- Panini reads by slug, not is_active
  ('7dd9dd11-e8b6-45c4-ac99-71331f959714', 'disney_pinnacle',   true),   -- excluded by id (characters, not players)
  ('11111111-1111-1111-1111-111111111111', 'ufc_strike',        false);  -- inactive, never gathered

CREATE TABLE players (id uuid PRIMARY KEY, collection_id uuid, name text);
CREATE TABLE editions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collection_id uuid, player_id uuid, player_name text, external_id text);
CREATE TABLE panini_products (set_id text, last_grid_sport text);
CREATE TABLE player_name_aliases (player_id uuid, alias_slug text);
CREATE TABLE teams_master (league text, slug text, active boolean);
CREATE TABLE league_collections (league text, collection_id uuid, enabled boolean);
CREATE TABLE panini_edition_team_keys (external_id text, franchise_keys text[]);

-- the namesake guard the count predicate consults (its own migration; a fixture
-- copy here: a name-matched edition linked to ANOTHER player row is another person)
CREATE OR REPLACE FUNCTION public.edition_player_is_other_person(p_edition_player_id uuid, p_player_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p_edition_player_id IS NOT NULL AND p_edition_player_id <> p_player_id
$$;

-- players: ids are readable
--   a1 Top Shot "Damian Lillard" (3 eds)      · a2 Panini "Damian Lillard" (5 eds)   → one basketball hub, canonical damian-lillard
--   b1 Top Shot "Steph Curry" (2 eds, alias stephen-curry) · b2 Panini "Stephen Curry" (4 eds) → one hub via the alias, canonical stephen-curry (more editions)
--   c1 Top Shot "Larry Johnson" (2 eds, basketball) · c2 All Day "Larry Johnson" (2 eds, football) → two people, NOT listed
--   d1 Top Shot "Lone Name" (3 eds)           → one collection, NOT listed
--   e1 Top Shot "No Editions" (0 eds) · e2 Panini "No Editions" (2 eds) → e1 does not count, NOT listed
--   f1 Panini "Josh Allen" (2 eds, football) · f2 All Day "Josh Allen" (3 eds) → one football hub, canonical josh-allen
--   g1 UFC "Inactive Coll" (2 eds) · g2 Panini "Inactive Coll" (2 eds, mma? no — football) → UFC inactive, NOT listed
--   h1 Top Shot "Ødegaard Twin" (2 eds) · h2 Panini "Odegaard Twin" (2 eds) → unaccent folds them, canonical odegaard-twin
INSERT INTO players VALUES
  ('a0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Damian Lillard'),
  ('a0000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Damian Lillard'),
  ('b0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Steph Curry'),
  ('b0000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Stephen Curry'),
  ('c0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Larry Johnson'),
  ('c0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Larry Johnson'),
  ('d0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Lone Name'),
  ('e0000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'No Editions'),
  ('e0000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'No Editions'),
  ('f0000000-0000-0000-0000-000000000001', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Josh Allen'),
  ('f0000000-0000-0000-0000-000000000002', 'dee28451-5d62-409e-a1ad-a83f763ac070', 'Josh Allen'),
  ('90000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Inactive Coll'),
  ('90000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Inactive Coll'),
  ('80000000-0000-0000-0000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'Ødegaard Twin'),
  ('80000000-0000-0000-0000-000000000002', 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b', 'Odegaard Twin');

INSERT INTO player_name_aliases VALUES ('b0000000-0000-0000-0000-000000000001', 'stephen-curry');

-- Panini products: set 100 basketball, set 200 football
INSERT INTO panini_products VALUES ('100', 'Basketball'), ('200', 'Football');

-- editions (Top Shot ones need the int-pair external_id the count predicate requires;
-- Panini ones need the packcard-<set_id>_ prefix the sport read parses)
INSERT INTO editions (collection_id, player_id, player_name, external_id)
SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'a0000000-0000-0000-0000-000000000001'::uuid, 'Damian Lillard', '1:' || g FROM generate_series(1, 3) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, 'a0000000-0000-0000-0000-000000000002'::uuid, 'Damian Lillard', 'packcard-100_' || g FROM generate_series(1, 5) g
UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'b0000000-0000-0000-0000-000000000001'::uuid, 'Steph Curry', '2:' || g FROM generate_series(1, 2) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, 'b0000000-0000-0000-0000-000000000002'::uuid, 'Stephen Curry', 'packcard-100_' || (10 + g) FROM generate_series(1, 4) g
UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'c0000000-0000-0000-0000-000000000001'::uuid, 'Larry Johnson', '3:' || g FROM generate_series(1, 2) g
UNION ALL SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'c0000000-0000-0000-0000-000000000002'::uuid, 'Larry Johnson', 'ad-lj-' || g FROM generate_series(1, 2) g
UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, 'd0000000-0000-0000-0000-000000000001'::uuid, 'Lone Name', '4:' || g FROM generate_series(1, 3) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, 'e0000000-0000-0000-0000-000000000002'::uuid, 'No Editions', 'packcard-100_' || (20 + g) FROM generate_series(1, 2) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, 'f0000000-0000-0000-0000-000000000001'::uuid, 'Josh Allen', 'packcard-200_' || g FROM generate_series(1, 2) g
UNION ALL SELECT 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid, 'f0000000-0000-0000-0000-000000000002'::uuid, 'Josh Allen', 'ad-ja-' || g FROM generate_series(1, 3) g
UNION ALL SELECT '11111111-1111-1111-1111-111111111111'::uuid, '90000000-0000-0000-0000-000000000001'::uuid, 'Inactive Coll', 'ufc-' || g FROM generate_series(1, 2) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, '90000000-0000-0000-0000-000000000002'::uuid, 'Inactive Coll', 'packcard-200_' || (10 + g) FROM generate_series(1, 2) g
UNION ALL SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid, '80000000-0000-0000-0000-000000000001'::uuid, 'Ødegaard Twin', '5:' || g FROM generate_series(1, 2) g
UNION ALL SELECT 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid, '80000000-0000-0000-0000-000000000002'::uuid, 'Odegaard Twin', 'packcard-100_' || (30 + g) FROM generate_series(1, 2) g;
-- a Top Shot FOSSIL external_id (hyphenated) does not count toward the hub's editions
INSERT INTO editions (collection_id, player_id, player_name, external_id)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'e0000000-0000-0000-0000-000000000001', 'No Editions', 'fossil-no-editions-1');

-- franchises: NBA (league collection enabled) blazers mapped to Panini → listed;
-- lakers with no Panini card → not; NFL chiefs mapped but no enabled league collection → not;
-- NBA sonics inactive but mapped → not; a listing mapped to a different key is not the blazers'
INSERT INTO teams_master VALUES ('NBA', 'blazers', true), ('NBA', 'lakers', true), ('NFL', 'chiefs', true), ('NBA', 'sonics', false), ('MLB', 'tigers', true);
INSERT INTO league_collections VALUES ('NBA', '95f28a17-224a-4025-96ad-adf8a4c63bfd', true), ('NFL', 'dee28451-5d62-409e-a1ad-a83f763ac070', false), ('MLB', '20000000-0000-0000-0000-000000000000', true);
INSERT INTO panini_edition_team_keys VALUES
  ('packcard-100_1', ARRAY['NBA:blazers']),
  ('packcard-100_2', ARRAY['NBA:sonics', 'NBA:blazers']),
  ('packcard-200_1', ARRAY['NFL:chiefs']),
  ('packcard-200_2', ARRAY['NBA:lakers-not-this-key']),
  ('packcard-100_4', '{}'::text[]),           -- a catalogued edition placed on NO team (source none): never a hub
  ('packcard-100_99', ARRAY['MLB:tigers']); -- a map row whose id is NOT a catalogued edition: not a card

-- ── function under test (VERBATIM from the migration) ──────────────────────
CREATE OR REPLACE FUNCTION public.list_indexable_player_hubs()
RETURNS TABLE(slug text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cand AS (
    SELECT p.id, p.collection_id, c.slug::text AS coll, p.name::text AS name,
           regexp_replace(lower(btrim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') AS s
    FROM public.players p
    JOIN public.collections c ON c.id = p.collection_id
    WHERE p.collection_id <> '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
      AND (c.is_active OR c.slug = 'panini_blockchain')
  ),
  -- MATERIALIZED: the count is referenced twice below; without it the planner
  -- re-ran the per-player edition probe (measured 2× buffers).
  counted AS MATERIALIZED (
    SELECT k.id, k.collection_id, k.coll, k.s,
      (SELECT count(*) FROM public.editions e
        WHERE e.collection_id = k.collection_id
          AND (e.player_id = k.id OR (e.player_name = k.name AND NOT public.edition_player_is_other_person(e.player_id, k.id)))
          AND (e.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
               OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'))::int AS n
    FROM cand k
  ),
  panini_sport AS (
    SELECT e.player_id,
           array_agg(DISTINCT CASE WHEN pp.last_grid_sport ILIKE '%basketball%' THEN 'basketball'
                                   ELSE lower(pp.last_grid_sport) END) AS sports
    FROM public.editions e
    JOIN public.panini_products pp ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.external_id LIKE 'packcard-%'
      AND pp.last_grid_sport IS NOT NULL
      AND e.player_id IS NOT NULL
    GROUP BY e.player_id
  ),
  sported AS (
    SELECT k.id, k.collection_id, k.coll, k.s, k.n,
      CASE k.coll
        WHEN 'nba_top_shot'      THEN ARRAY['basketball']
        WHEN 'nfl_all_day'       THEN ARRAY['football']
        WHEN 'laliga_golazos'    THEN ARRAY['soccer']
        WHEN 'candy_mlb'         THEN ARRAY['baseball']
        WHEN 'ufc_strike'        THEN ARRAY['mma']
        WHEN 'panini_blockchain' THEN ps.sports
      END AS sports
    FROM counted k
    LEFT JOIN panini_sport ps ON ps.player_id = k.id
    WHERE k.n > 0
  ),
  -- Every key a player answers to: its own name slug, plus each alias spelling
  -- (get_player_hub folds aliases both ways; listing the member under each key
  -- reproduces the gather for every spelling a reader could request).
  keyed AS (
    SELECT m.id, m.collection_id, m.coll, m.s, m.n, m.sports, m.s AS key FROM sported m
    UNION ALL
    SELECT m.id, m.collection_id, m.coll, m.s, m.n, m.sports, a.alias_slug AS key
    FROM sported m JOIN public.player_name_aliases a ON a.player_id = m.id
  ),
  best AS (
    SELECT DISTINCT ON (key, collection_id) key, collection_id, coll, s, n, sports
    FROM keyed
    ORDER BY key, collection_id, n DESC, id
  ),
  ex AS (
    SELECT key, collection_id, unnest(coalesce(sports, ARRAY[]::text[])) AS sport FROM best
  ),
  indexable_keys AS (
    SELECT key FROM ex GROUP BY key, sport HAVING count(DISTINCT collection_id) >= 2
  )
  SELECT DISTINCT (array_agg(b.s ORDER BY b.n DESC, b.coll))[1] AS slug
  FROM best b
  JOIN (SELECT DISTINCT key FROM indexable_keys) i ON i.key = b.key
  GROUP BY b.key;
$function$;

CREATE OR REPLACE FUNCTION public.list_indexable_franchise_hubs()
 RETURNS TABLE(league text, slug text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT tm.league::text, tm.slug::text
  FROM public.teams_master tm
  WHERE tm.active
    AND EXISTS (SELECT 1 FROM public.league_collections lc WHERE lc.league = tm.league AND lc.enabled)
    AND EXISTS (
      SELECT 1
      FROM public.panini_edition_team_keys t
      JOIN public.editions e ON e.external_id = t.external_id
      WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
        AND t.franchise_keys @> ARRAY[tm.league::text || ':' || tm.slug]
    )
  ORDER BY tm.league::text, tm.slug;
$function$;

-- ── assertions ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_slugs text;
  v_n int;
BEGIN
  SELECT string_agg(slug, ',' ORDER BY slug), count(*) INTO v_slugs, v_n FROM public.list_indexable_player_hubs();

  -- exactly the four hubs, each once, under its canonical slug
  PERFORM _assert_eq(v_slugs, 'damian-lillard,josh-allen,odegaard-twin,stephen-curry',
    'player hubs: one basketball name, one via an alias (canonical = the member with more editions), one football name, one accent-folded name');
  PERFORM _assert_eq(v_n::text, '4', 'player hubs: listed once each');

  -- the negative controls, named
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.list_indexable_player_hubs() WHERE slug = 'larry-johnson'),
    'two people sharing a name across two SPORTS are not one hub');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.list_indexable_player_hubs() WHERE slug = 'lone-name'),
    'a one-collection name is not a hub');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.list_indexable_player_hubs() WHERE slug = 'no-editions'),
    'a member whose only edition is a Top Shot fossil id does not count as a collection');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.list_indexable_player_hubs() WHERE slug = 'inactive-coll'),
    'an inactive collection (UFC) is never gathered');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.list_indexable_player_hubs() WHERE slug = 'steph-curry'),
    'the alias spelling is not listed beside the canonical one (it would 308/canonicalise away)');

  -- franchise hubs
  SELECT string_agg(league || '/' || slug, ',' ORDER BY league, slug), count(*) INTO v_slugs, v_n FROM public.list_indexable_franchise_hubs();
  PERFORM _assert_eq(v_slugs, 'NBA/blazers', 'franchise hubs: only the active NBA team with a mapped, catalogued Panini card');
  PERFORM _assert_eq(v_n::text, '1', 'franchise hubs: one row');
END $$;

-- a mapped Panini card for the lakers flips them in (positive control on the Panini predicate)
INSERT INTO panini_edition_team_keys VALUES ('packcard-100_3', ARRAY['NBA:lakers']);
DO $$
BEGIN
  PERFORM _assert_eq((SELECT string_agg(slug, ',' ORDER BY slug) FROM public.list_indexable_franchise_hubs() WHERE league = 'NBA'), 'blazers,lakers',
    'a franchise gains its hub the moment a catalogued Panini card maps to it');
END $$;

SELECT '✓ list_indexable_player_hubs / list_indexable_franchise_hubs invariants pass' AS result;

ROLLBACK;
