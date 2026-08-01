-- DB invariant: public.get_player_detail — the player/character hub read behind
-- /[collection]/player/[slug]. Like get_team_detail it resolves a slug via a
-- functional regexp, and it must pick the RIGHT player row when a slug is
-- ambiguous (same name, different teams) — else the page shows the wrong player's
-- team, editions and FMV.
--
-- Pins:
--   * slug resolved via slugified name; no match -> NULL;
--   * candidate ranking, in order:
--       1. CURRENT-TEAM preference — the row whose team matches the team on the
--          player's most recent moment, but only while the player is still
--          active (that moment is within 18 months of the collection's newest
--          moment). This is what stops a TRADED player being pinned forever to
--          whichever former team they happen to have the most moments for;
--       2. most team-matching editions (the right answer for a RETIRED player:
--          their iconic team, not their final-season team);
--       3. is_active, 4. has-headshot, 5. id.
--     `game_date` is the recency signal, NOT `first_minted_at` — the latter is
--     0% populated on Top Shot, so ordering by it was arbitrary.
--     The horizon is DATA-RELATIVE (collection max(game_date) - 18 months) so it
--     can never go stale;
--   * standard aggregation (edition_count / circulation / latest-snapshot FMV +
--     floor totals) over the player's editions by player_id OR player_name;
--   * team_slug derivation + is_character flag;
--   * Pinnacle branch aggregates by character_name via the FMV-collapse helper.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801220000_audit_20260801_get_player_detail_current_team_tiebreak.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.players (
  id uuid PRIMARY KEY, collection_id uuid, name text, team text, is_active boolean,
  headshot_url text, external_id text, first_name text, last_name text,
  jersey_number int, position text, player_tier text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, player_id uuid, player_name text,
  team_name text, circulation_count int, first_minted_at timestamptz,
  game_date date);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, floor_price_usd numeric, computed_at timestamptz);
CREATE TABLE public.pinnacle_editions (
  id uuid PRIMARY KEY, character_name text, mint_count int, minting_date timestamptz);
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id uuid)
 RETURNS TABLE(fmv_usd numeric, floor_usd numeric) LANGUAGE sql STABLE AS $$
  SELECT 12::numeric, 10::numeric WHERE p_id IS NOT NULL
$$;

-- >>> BEGIN verbatim get_player_detail (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_player_detail(p_collection_id uuid, p_player_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_player           RECORD;
  v_collection_slug  text;
  v_edition_count    int;
  v_total_circulation int;
  v_fmv_total        numeric;
  v_floor_total      numeric;
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR e.player_name = p.name)
           AND e.team_name IS NOT DISTINCT FROM p.team) AS team_edition_count
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
  ),
  recent AS (
    SELECT e.team_name, e.game_date
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.player_name = (SELECT min(name) FROM cand)
      AND e.team_name IS NOT NULL
      AND e.game_date IS NOT NULL
    ORDER BY e.game_date DESC
    LIMIT 1
  ),
  horizon AS (
    SELECT max(game_date) AS max_gd
    FROM editions
    WHERE collection_id = p_collection_id
      AND game_date IS NOT NULL
  )
  SELECT c.* INTO v_player
  FROM cand c
  LEFT JOIN recent r ON true
  CROSS JOIN horizon h
  ORDER BY (CASE WHEN r.team_name IS NOT NULL
                  AND r.game_date >= h.max_gd - interval '18 months'
                  AND c.team = r.team_name
                 THEN 1 ELSE 0 END) DESC,
           c.team_edition_count DESC NULLS LAST,
           (c.is_active IS TRUE) DESC,
           (c.headshot_url IS NOT NULL) DESC,
           c.id
  LIMIT 1;

  IF v_player IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      MIN(pe.minting_date),
      MAX(pe.minting_date)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.character_name = v_player.name;
  ELSE
    SELECT
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      MIN(e.first_minted_at),
      MAX(e.first_minted_at)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR e.player_name = v_player.name);
  END IF;

  RETURN jsonb_build_object(
    'id',                v_player.id,
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'player_slug',       p_player_slug,
    'external_id',       v_player.external_id,
    'name',              v_player.name,
    'first_name',        v_player.first_name,
    'last_name',         v_player.last_name,
    'team',              v_player.team,
    'team_slug',         CASE WHEN v_player.team IS NULL THEN NULL
                              ELSE regexp_replace(lower(trim(v_player.team)), '[^a-z0-9]+', '-', 'g') END,
    'jersey_number',     v_player.jersey_number,
    'position',          v_player.position,
    'player_tier',       v_player.player_tier::text,
    'is_active',         v_player.is_active,
    'headshot_url',      v_player.headshot_url,
    'is_character',      p_collection_id = v_pinnacle_uuid,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;
-- <<< END verbatim get_player_detail <<<

\set TS  '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set PIN '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set p1  '''11111111-1111-1111-1111-111111111111'''
\set p2  '''22222222-2222-2222-2222-222222222222'''
\set p3  '''33333333-3333-3333-3333-333333333333'''
\set p4  '''44444444-4444-4444-4444-444444444444'''
\set p5  '''55555555-5555-5555-5555-555555555555'''
\set p6  '''66666666-6666-6666-6666-666666666666'''
\set p7  '''77777777-7777-7777-7777-777777777777'''

INSERT INTO public.collections (id, slug) VALUES (:TS::uuid, 'nba_top_shot'), (:PIN::uuid, 'disney_pinnacle');

-- Two players share the slug 'damian-lillard'; p1 (Trail Blazers) has 2 team-
-- matching editions AND the most recent moment, p2 (Bucks) has none -> p1 wins.
INSERT INTO public.players (id, collection_id, name, team, is_active, headshot_url, external_id, first_name, last_name, jersey_number, position, player_tier) VALUES
  (:p1::uuid, :TS::uuid, 'Damian Lillard', 'Trail Blazers', true,  'h1', 'PL1', 'Damian', 'Lillard', 0, 'G', 'star'),
  (:p2::uuid, :TS::uuid, 'Damian Lillard', 'Bucks',         false, NULL, 'PL2', 'Damian', 'Lillard', 0, 'G', 'star'),
  (:p3::uuid, :PIN::uuid,'Mickey Mouse',   NULL,            true,  NULL, 'CH1', 'Mickey', 'Mouse',   NULL, NULL, 'chaser'),
  -- TRADED, still active: 3 moments on the old team, 1 RECENT moment on the new
  -- team. The old ranking picked p4 (3 > 1); the current-team rule must pick p5.
  (:p4::uuid, :TS::uuid, 'Traded Player', 'Old Team', true, 'h4', 'PL4', 'Traded', 'Player', 1, 'G', 'star'),
  (:p5::uuid, :TS::uuid, 'Traded Player', 'New Team', true, 'h5', 'PL5', 'Traded', 'Player', 1, 'G', 'star'),
  -- RETIRED: last moment is far outside the activity horizon, so the current-team
  -- preference must NOT fire and the iconic (most-moments) team must win.
  (:p6::uuid, :TS::uuid, 'Retired Player', 'Iconic Team', false, 'h6', 'PL6', 'Retired', 'Player', 2, 'F', 'star'),
  (:p7::uuid, :TS::uuid, 'Retired Player', 'Final Team',  false, 'h7', 'PL7', 'Retired', 'Player', 2, 'F', 'star');

INSERT INTO public.editions (id, collection_id, player_id, player_name, team_name, circulation_count, first_minted_at, game_date) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, :TS::uuid, :p1::uuid, 'Damian Lillard', 'Trail Blazers', 100, now()-interval '10 days', DATE '2026-01-10'),
  ('e2222222-2222-2222-2222-222222222222'::uuid, :TS::uuid, :p1::uuid, 'Damian Lillard', 'Trail Blazers',  50, now()-interval '2 days',  DATE '2026-01-20'),
  -- Traded player: 3 old-team moments, then one newer new-team moment.
  ('e4444444-4444-4444-4444-444444444401'::uuid, :TS::uuid, :p4::uuid, 'Traded Player', 'Old Team', 10, NULL, DATE '2025-11-01'),
  ('e4444444-4444-4444-4444-444444444402'::uuid, :TS::uuid, :p4::uuid, 'Traded Player', 'Old Team', 10, NULL, DATE '2025-11-02'),
  ('e4444444-4444-4444-4444-444444444403'::uuid, :TS::uuid, :p4::uuid, 'Traded Player', 'Old Team', 10, NULL, DATE '2025-11-03'),
  ('e5555555-5555-5555-5555-555555555501'::uuid, :TS::uuid, :p5::uuid, 'Traded Player', 'New Team', 10, NULL, DATE '2026-02-01'),
  -- Retired player: everything is > 18 months before the collection max (2026-02-01).
  ('e6666666-6666-6666-6666-666666666601'::uuid, :TS::uuid, :p6::uuid, 'Retired Player', 'Iconic Team', 10, NULL, DATE '2014-01-01'),
  ('e6666666-6666-6666-6666-666666666602'::uuid, :TS::uuid, :p6::uuid, 'Retired Player', 'Iconic Team', 10, NULL, DATE '2014-02-01'),
  ('e7777777-7777-7777-7777-777777777701'::uuid, :TS::uuid, :p7::uuid, 'Retired Player', 'Final Team',  10, NULL, DATE '2015-01-01');

INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, floor_price_usd, computed_at) VALUES
  ('e1111111-1111-1111-1111-111111111111'::uuid, 50, 40, now()),
  ('e2222222-2222-2222-2222-222222222222'::uuid, 20, 15, now());

-- Pinnacle character with two renders (FMV 12 each via the stub).
INSERT INTO public.pinnacle_editions (id, character_name, mint_count, minting_date) VALUES
  ('aa000000-0000-0000-0000-000000000001'::uuid, 'Mickey Mouse', 500, now()-interval '5 days'),
  ('aa000000-0000-0000-0000-000000000002'::uuid, 'Mickey Mouse', 400, now()-interval '3 days');

-- ── 1. not found -> NULL ─────────────────────────────────────────────────────
SELECT _assert(public.get_player_detail(:TS::uuid, 'no-one') IS NULL, 'unmatched slug -> NULL');

-- ── 2. ambiguous slug: picks p1 (current team AND more team-matching editions) ─
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'id'), '11111111-1111-1111-1111-111111111111', 'ranking picks the Trail Blazers row (p1)');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'team'), 'Trail Blazers', 'team from the winning candidate');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'team_slug'), 'trail-blazers', 'team_slug derived');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'is_character'), 'false', 'sports collection -> is_character false');

-- ── 3. aggregation over the player's editions ────────────────────────────────
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'edition_count'), '2', 'edition_count = 2');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'total_circulation'), '150', 'total_circulation = 150');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'fmv_total_usd'), '70', 'fmv_total = 50 + 20');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'damian-lillard') ->> 'floor_total_usd'), '55', 'floor_total = 40 + 15');

-- ── 4. Pinnacle character branch ─────────────────────────────────────────────
SELECT _assert_eq((public.get_player_detail(:PIN::uuid,'mickey-mouse') ->> 'is_character'), 'true', 'Pinnacle -> is_character true');
SELECT _assert_eq((public.get_player_detail(:PIN::uuid,'mickey-mouse') ->> 'edition_count'), '2', 'Pinnacle character: 2 renders');
SELECT _assert_eq((public.get_player_detail(:PIN::uuid,'mickey-mouse') ->> 'fmv_total_usd'), '24', 'Pinnacle: per-render FMV collapse 12+12');

-- ── 5. TRADED + still active: current team beats most-moments ────────────────
-- p4 has 3 team-matching editions and p5 only 1, so the pre-2026-08-01 ladder
-- returned p4 ("Old Team"). The current-team preference must flip this to p5.
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'traded-player') ->> 'team'), 'New Team', 'traded active player shows the team of their most recent moment');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'traded-player') ->> 'id'), '55555555-5555-5555-5555-555555555555', 'traded active player resolves to the new-team row');

-- ── 6. RETIRED: outside the horizon, iconic (most-moments) team still wins ────
-- Guards against the naive "always use the latest moment" rule, which would
-- show a retired player's final-season team instead of the one they are known for.
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'retired-player') ->> 'team'), 'Iconic Team', 'retired player keeps the most-moments team, not the final-season team');
SELECT _assert_eq((public.get_player_detail(:TS::uuid,'retired-player') ->> 'id'), '66666666-6666-6666-6666-666666666666', 'retired player resolves to the iconic-team row');

SELECT '✓ get_player_detail: all assertions passed' AS result;

ROLLBACK;
