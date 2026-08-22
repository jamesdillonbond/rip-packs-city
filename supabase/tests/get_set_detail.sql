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
--   * latest-snapshot-wins: the newest snapshot per edition wins (a stale higher
--     one does not inflate the total). ⚠ The mechanism is a LEFT JOIN LATERAL
--     ... ORDER BY computed_at DESC LIMIT 1, NOT `DISTINCT ON` — this line said
--     "DISTINCT-latest" until 2026-08-22 and had not described its own pinned
--     DDL for some time. Assertion 4 pins the PROPERTY (freshest 50 beats stale
--     999), which is why it survived the wording being wrong; a probe for
--     `DISTINCT ON` against live does NOT indicate drift here;
--   * D20 underlying_set_count: how many rows of `sets` merge into this slug,
--     scoped by BOTH collection_id and name — the set page keys a "merged set"
--     banner on it being > 1;
--   * the jsonb envelope carries the summary passthrough fields + collection slug.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260822193500_audit_20260822_snapshot_get_set_detail_underlying_set_count.sql);
-- re-pinned 2026-08-22: `db-pin-staleness` had reported this pin STALE on every
-- run since 2026-08-10 (13 consecutive, known-issues #24). Diffed rather than
-- assumed — the ENTIRE drift was the D20 underlying_set_count rollup. Neither the
-- lateral FMV read nor the Pinnacle branch changed; both were already pinned.
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- That migration wraps the expensive per-edition FMV rollup in BEGIN/EXCEPTION
-- WHEN query_canceled so a request-level statement timeout on a pathological set
-- (Top Shot "Base Set", ~3,600 editions) degrades the header stats to NULL instead
-- of throwing and erroring the whole public set page (Sentry NEXTJS-22). The happy
-- path asserted below is unchanged.
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
CREATE TABLE public.sets (
  collection_id uuid, name text);

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
  v_underlying_set_count int;
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  -- The per-edition latest-FMV rollup is the only expensive read here. On the
  -- largest sets it can exceed the request statement budget cold and would
  -- otherwise error the whole page (Sentry JAVASCRIPT-NEXTJS-22). Catch that
  -- cancellation and degrade the header stats to NULL (rendered "-") instead of
  -- throwing; normal-sized sets finish in a few ms and never trip this.
  BEGIN
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
  EXCEPTION WHEN query_canceled THEN
    -- Rollup blew the request statement budget: return the header with NULL stats
    -- (page shows "-") rather than throwing the whole page away.
    v_edition_count := NULL;
    v_fmv_total := NULL;
    v_floor_total := NULL;
    v_editions_with_fmv := NULL;
  END;

  -- D20: how many underlying `sets` rows merged into this slug. Complete-by-
  -- construction merge signal (name-identical seasonal repeats included, which
  -- set_name_variants misses). Reads the 914-row `sets` table — trivially cheap.
  -- Pinnacle has no `sets` rows → 0 (page keys the banner on > 1).
  SELECT count(*) INTO v_underlying_set_count
  FROM sets s
  WHERE s.collection_id = p_collection_id
    AND s.name::text = ANY(v_set.set_name_variants);

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'underlying_set_count', v_underlying_set_count,
    'edition_count',       v_edition_count,
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

-- D20 `underlying_set_count`: two `sets` rows merge into this one slug (a
-- name-identical seasonal repeat), plus one row from a DIFFERENT collection and
-- one with an unrelated name that must BOTH be excluded. Without the
-- collection_id predicate the count reads 3; without the name predicate, 3.
INSERT INTO public.sets (collection_id, name) VALUES
  (:cid::uuid, 'Base Set'),
  (:cid::uuid, 'Base'),
  ('99999999-9999-9999-9999-999999999999'::uuid, 'Base Set'),
  (:cid::uuid, 'Unrelated Set');

-- ── 1. not found -> NULL ─────────────────────────────────────────────────────
SELECT _assert(public.get_set_detail(:cid::uuid, 'no-such-set') IS NULL, 'unmatched set slug -> NULL');

-- ── 2. edition_count spans variants but only rendered rows (e1 + e2 = 2) ─────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'edition_count'), '2', 'edition_count = 2 (variant Base counted, thumbnail-less e3 + wrong-set e4 excluded)');

-- ── 3. editions_with_fmv = 1 (only e1 priced) ────────────────────────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'editions_with_fmv'), '1', 'editions_with_fmv = 1');

-- ── 4. latest-snapshot-wins: fmv_total = 50 (not the stale 999) ──────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'fmv_total_usd'), '50', 'fmv_total uses the freshest snapshot (50), not the stale 999');
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'floor_total_usd'), '40', 'floor_total uses the freshest snapshot (40)');

-- ── 5. D20 underlying_set_count: counts merged `sets` rows, scoped BOTH ways ──
-- Pinned because the page keys a "merged set" banner on this being > 1, so a
-- silent 0 or an unscoped 3 both mis-state the page. This is the ONLY behaviour
-- that had drifted from the pin (see the file header).
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'underlying_set_count'), '2', 'underlying_set_count = 2 (other-collection row and unrelated name excluded)');

-- ── 5. envelope passthrough ──────────────────────────────────────────────────
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'set_name'), 'Base Set', 'set_name passthrough');
SELECT _assert_eq((public.get_set_detail(:cid::uuid,'base-set') ->> 'collection_slug'), 'nba_top_shot', 'collection_slug resolved');

SELECT '✓ get_set_detail: all assertions passed' AS result;

ROLLBACK;
