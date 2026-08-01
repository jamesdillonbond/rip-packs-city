-- DB invariant: public.get_team_detail — the team/franchise hub read behind
-- /[collection]/team/[slug]: roster size, edition count, circulation, FMV/floor
-- totals, teams_master branding, and 30d sales activity. The slug is resolved via
-- a functional regexp (see the idx_editions_collection_team_slug incident), so a
-- regression can mis-scope the whole team or silently drop its branding.
--
-- Pins (standard / sports branch):
--   * team resolved by slugified team_name; no match -> NULL;
--   * team_name_variants = DISTINCT matching names; player_count = DISTINCT
--     slugified non-empty player_name (a NULL-player edition counts toward
--     edition_count + circulation but NOT player_count);
--   * fmv_total sums latest-snapshot fmv_usd > 0; floor_total sums
--     COALESCE(floor,fmv) > 0; latest snapshot per edition wins;
--   * teams_master branding is read from the ACTIVE row on the same slug;
--   * sales_30d / volume_30d count only in-window sales on this team's editions
--     (other teams excluded via the team_name filter);
-- Pins (Pinnacle branch): franchise-slug resolution + per-render FMV collapse.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260801231400_audit_20260801_snapshot_get_team_detail_unaccented.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, team_name text, player_name text,
  circulation_count int);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, floor_price_usd numeric, computed_at timestamptz);
CREATE TABLE public.teams_master (
  slug text, team_name text, primary_color text, secondary_color text,
  abbreviation text, external_id text, league text, active boolean);
CREATE TABLE public.sales (
  edition_id uuid, collection_id uuid, price_usd numeric, sold_at timestamptz);
-- Pinnacle-branch stubs (only exercised by the franchise case below).
CREATE TABLE public.pinnacle_editions (
  id uuid PRIMARY KEY, franchise text, character_name text, mint_count int);
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id uuid)
 RETURNS TABLE(fmv_usd numeric, floor_usd numeric) LANGUAGE sql STABLE AS $$
  SELECT 12::numeric, 10::numeric WHERE p_id IS NOT NULL
$$;

-- >>> BEGIN verbatim get_team_detail (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT array_agg(DISTINCT franchise),
           (array_agg(franchise ORDER BY franchise))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: accept the diacritic-stripped slug the frontend emits.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT franchise),
             (array_agg(franchise ORDER BY franchise))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_editions
      WHERE franchise IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(franchise))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
    SELECT
      COUNT(DISTINCT pe.character_name),
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.franchise = ANY(v_team_variants);
    -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
  ELSE
    SELECT array_agg(DISTINCT team_name),
           (array_agg(team_name ORDER BY team_name))[1]
    INTO v_team_variants, v_team_canonical
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: accept the diacritic-stripped slug the frontend emits
    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a
    -- would-be 404, so the functional index still serves the hot path.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT team_name),
             (array_agg(team_name ORDER BY team_name))[1]
      INTO v_team_variants, v_team_canonical
      FROM editions
      WHERE collection_id = p_collection_id
        AND team_name IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;
-- <<< END verbatim get_team_detail <<<

\set cid '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set e3 '''33333333-3333-3333-3333-333333333333'''
\set e4 '''44444444-4444-4444-4444-444444444444'''
\set e5 '''55555555-5555-5555-5555-555555555555'''
\set e6 '''66666666-6666-6666-6666-666666666666'''

INSERT INTO public.collections (id, slug) VALUES (:cid::uuid, 'nba_top_shot'), (:pin::uuid, 'disney_pinnacle');

-- Trail Blazers roster (slug 'trail-blazers'): e1,e2,e3,e5. e4 is Lakers (excluded).
INSERT INTO public.editions (id, collection_id, team_name, player_name, circulation_count) VALUES
  (:e1::uuid, :cid::uuid, 'Trail Blazers', 'Damian Lillard',  100),
  (:e2::uuid, :cid::uuid, 'Trail Blazers', 'Anfernee Simons',  50),
  (:e3::uuid, :cid::uuid, 'Trail Blazers', 'Damian Lillard',   30),  -- same player, 2nd edition
  (:e4::uuid, :cid::uuid, 'Lakers',        'LeBron James',    999),  -- other team, excluded
  (:e5::uuid, :cid::uuid, 'Trail Blazers', NULL,               10);  -- null player: counts circ, not player_count

-- e6: a diacritic team ('Atletico Madrid' with an accent) that resolves ONLY via the
-- unaccent FALLBACK lane (its accented slug 'atl-tico-madrid' != the emitted 'atletico-madrid').
INSERT INTO public.editions (id, collection_id, team_name, player_name, circulation_count) VALUES
  (:e6::uuid, :cid::uuid, 'Atlético Madrid', 'Antoine Griezmann', 5);

-- e1 latest-snapshot-wins (50 over stale 999); e2 priced (20); e3/e5 unpriced.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, floor_price_usd, computed_at) VALUES
  (:e1::uuid, 999, 900, now() - interval '2 days'),
  (:e1::uuid,  50,  40, now() - interval '1 hour'),
  (:e2::uuid,  20,  15, now() - interval '1 hour');

-- Branding: active row wins; an inactive same-slug row must be ignored.
INSERT INTO public.teams_master (slug, team_name, primary_color, secondary_color, abbreviation, external_id, league, active) VALUES
  ('trail-blazers', 'Trail Blazers', '#E03A2F', '#000000', 'POR', 'POR1', 'NBA', true),
  ('trail-blazers', 'Trail Blazers', '#FFFFFF', '#FFFFFF', 'OLD', 'OLD1', 'NBA', false);

-- Sales: e1 in-window (25) counts; e2 out-of-window (40d) excluded; e4 Lakers excluded.
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at) VALUES
  (:e1::uuid, :cid::uuid, 25, now() - interval '5 days'),
  (:e2::uuid, :cid::uuid, 30, now() - interval '40 days'),
  (:e4::uuid, :cid::uuid, 500, now() - interval '5 days');

-- Pinnacle franchise: two renders under 'Marvel' (slug 'marvel'), FMV 12/floor 10 each.
INSERT INTO public.pinnacle_editions (id, franchise, character_name, mint_count) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'Marvel', 'Iron Man', 500),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Marvel', 'Thor',     400);

-- ── 1. not found -> NULL ─────────────────────────────────────────────────────
SELECT _assert(public.get_team_detail(:cid::uuid, 'no-such-team') IS NULL, 'unmatched team slug -> NULL');

-- ── 2. slug scope + aggregation ──────────────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'edition_count'), '4', 'edition_count = 4 (Lakers excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'player_count'), '2', 'player_count = 2 distinct players (null-player edition excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'total_circulation'), '190', 'total_circulation = 100+50+30+10');

-- ── 3. latest-snapshot FMV/floor totals ──────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'fmv_total_usd'), '70', 'fmv_total = 50 (fresh) + 20');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'floor_total_usd'), '55', 'floor_total = 40 + 15');

-- ── 4. branding from the ACTIVE teams_master row ─────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'abbreviation'), 'POR', 'branding read from ACTIVE row (not the inactive OLD row)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'league'), 'NBA', 'league passthrough');

-- ── 5. 30d activity scoped to team + window ──────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'sales_30d'), '1', 'sales_30d = 1 (out-of-window + other-team sales excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'volume_30d_usd'), '25', 'volume_30d = 25');

-- ── 6. Pinnacle franchise branch ─────────────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'is_franchise'), 'true', 'Pinnacle collection -> is_franchise true');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'player_count'), '2', 'Pinnacle: distinct characters = 2');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'fmv_total_usd'), '24', 'Pinnacle: per-render FMV collapse 12+12');
SELECT _assert(public.get_team_detail(:pin::uuid,'marvel') ->> 'abbreviation' IS NULL, 'Pinnacle: no teams_master branding');

-- ── 7. UNACCENT FALLBACK lane (2026-08-01 audit change) ──────────────────────
SELECT _assert(public.get_team_detail(:cid::uuid,'atletico-madrid') IS NOT NULL, 'diacritic team resolves via the unaccent fallback (accented slug would 404)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'atletico-madrid') ->> 'team_name'), 'Atlético Madrid', 'unaccent fallback returns the canonical accented team_name');

SELECT '✓ get_team_detail: all assertions passed' AS result;

ROLLBACK;
