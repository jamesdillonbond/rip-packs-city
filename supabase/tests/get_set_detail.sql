-- DB invariant: public.get_set_detail — the set-page header read (edition count,
-- FMV/floor totals, series span) for /[collection]/set/[slug]. A regression here
-- mis-states a set's size or aggregate value on a public page.
--
-- Pins:
--   * an unmatched (collection, set_slug) returns NULL (not an empty object);
--   * the standard branch counts editions across ALL set_name_variants but ONLY
--     those with a thumbnail (the ones that actually render), joining each to its
--     LATEST fmv_snapshot;
--   * fmv_total sums fmv_usd > 0; floor_total sums COALESCE(floor,fmv) > 0;
--     editions_with_fmv counts fmv_usd > 0; edition_count counts all rendered rows;
--   * DISTINCT-latest: the newest snapshot per edition wins (a stale higher one
--     does not inflate the total);
--   * the jsonb envelope carries the summary passthrough fields + collection slug.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260626162000_pinnacle_set_grid_render_level.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.sets_summary (
  collection_id uuid, set_slug text, set_name text, set_name_variants text[],
  total_circulation int, tiers_present text[], min_series int, max_series int,
  first_minted_at timestamptz, last_updated_at timestamptz, computed_at timestamptz);
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, set_name text, thumbnail_url text);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, floor_price_usd numeric, computed_at timestamptz);
CREATE TABLE public.pinnacle_catalog (
  set_name text, fmv_usd numeric, floor_ask numeric);

-- >>> BEGIN verbatim get_set_detail (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_set_detail(p_collection_id uuid, p_set_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_set       RECORD;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_editions_with_fmv int;
  v_edition_count int;
  v_collection_slug text;
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- Render-level (per-pin), matching the get_set_editions grid. Joined by
    -- btrim(set_name) to defuse the catalog leading-space quirk.
    SELECT
      COUNT(*),
      SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
      SUM(COALESCE(pc.floor_ask, pc.fmv_usd))          FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
      COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0)
    INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
    FROM pinnacle_catalog pc
    WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_set.set_name_variants) x);
  ELSE
    SELECT
      COUNT(*),
      SUM(fmv.fmv_usd)                                          FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd))           FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      COUNT(fmv.fmv_usd)                                        FILTER (WHERE fmv.fmv_usd > 0)
    INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd
      FROM fmv_snapshots
      WHERE edition_id = e.id
      ORDER BY computed_at DESC
      LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.set_name = ANY(v_set.set_name_variants)
      AND e.thumbnail_url IS NOT NULL;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'edition_count',       COALESCE(v_edition_count, 0),
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   v_set.total_circulation,
    'tiers_present',       v_set.tiers_present,
    'min_series',          v_set.min_series,
    'max_series',          v_set.max_series,
    'first_minted_at',     v_set.first_minted_at,
    'last_updated_at',     v_set.last_updated_at,
    'fmv_total_usd',       v_fmv_total,
    'floor_total_usd',     v_floor_total,
    'summary_computed_at', v_set.computed_at
  );
END;
$function$;
-- <<< END verbatim get_set_detail <<<

\set cid '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set e3 '''33333333-3333-3333-3333-333333333333'''
\set e4 '''44444444-4444-4444-4444-444444444444'''

INSERT INTO public.collections (id, slug) VALUES (:cid::uuid, 'nba_top_shot');
INSERT INTO public.sets_summary (collection_id, set_slug, set_name, set_name_variants, total_circulation, tiers_present, min_series, max_series, computed_at)
VALUES (:cid::uuid, 'base-set', 'Base Set', ARRAY['Base Set','Base'], 100, ARRAY['COMMON'], 1, 2, now());

-- e1 ('Base Set') + e2 ('Base' variant) render (thumbnail set); e3 no thumbnail; e4 wrong set.
INSERT INTO public.editions (id, collection_id, set_name, thumbnail_url) VALUES
  (:e1::uuid, :cid::uuid, 'Base Set', 'https://img/1'),
  (:e2::uuid, :cid::uuid, 'Base',     'https://img/2'),
  (:e3::uuid, :cid::uuid, 'Base Set', NULL),
  (:e4::uuid, :cid::uuid, 'Other',    'https://img/4');

-- e1 has two snapshots; the NEWER (50/40) must win over the stale (999/900).
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, floor_price_usd, computed_at) VALUES
  (:e1::uuid, 999, 900, now() - interval '2 days'),
  (:e1::uuid,  50,  40, now() - interval '1 hour');
-- e2 has NO snapshot -> fmv null (counts toward edition_count, not editions_with_fmv).

-- ── 1. not found -> NULL ─────────────────────────────────────────────────────
SELECT _assert(public.get_set_detail(:cid::uuid, 'no-such-set') IS NULL, 'unmatched set slug -> NULL');

-- ── 2. edition_count spans variants but only rendered rows (e1 + e2 = 2) ─────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'edition_count'), '2', 'edition_count = 2 (variant Base counted, thumbnail-less e3 + wrong-set e4 excluded)');

-- ── 3. editions_with_fmv = 1 (only e1 priced) ────────────────────────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'editions_with_fmv'), '1', 'editions_with_fmv = 1');

-- ── 4. latest-snapshot-wins: fmv_total = 50 (not the stale 999) ──────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'fmv_total_usd'), '50', 'fmv_total uses the freshest snapshot (50), not the stale 999');
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'floor_total_usd'), '40', 'floor_total uses the freshest snapshot (40)');

-- ── 5. envelope passthrough ──────────────────────────────────────────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'set_name'), 'Base Set', 'set_name passthrough');
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'collection_slug'), 'nba_top_shot', 'collection_slug resolved');

SELECT '✓ get_set_detail: all assertions passed' AS result;

ROLLBACK;
