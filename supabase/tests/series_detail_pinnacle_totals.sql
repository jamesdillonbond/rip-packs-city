-- DB invariant: public.get_series_detail + public.refresh_series_detail_rollup —
-- the Pinnacle series header totals. Added 2026-09-28 (#24): the header's
-- "Recent-Low Total" summed COALESCE(floor_ask, fmv_usd), publishing a pin's
-- FMV as a low when it had no live ask, and its "FMV Total" (77% ask-derived
-- across the catalog) carried nothing saying so. Claims:
--
--   1. The rollup (the page's fast path) and the live path agree: Recent-Low
--      Total = live asks only, listed_count = pins with a live ask,
--      fmv_ask_derived_usd = the ASK_ONLY part of the FMV total.
--   2. A series with no ASK_ONLY pin reads fmv_ask_derived_usd NULL.
--   3. A non-Pinnacle series row leaves the new columns NULL.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929063531_audit_20260928_pinnacle_entity_totals_say_what_they_sum.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.collection_series (id serial, collection_id uuid, series_number int, display_label text, season text);
CREATE TABLE public.series_detail_rollup (
  collection_id uuid, series_number int, edition_count int, total_circulation bigint,
  fmv_total_usd numeric, floor_total_usd numeric, set_count int, player_count int,
  computed_at timestamptz, duration_ms int, fmv_ask_derived_usd numeric, listed_count int,
  PRIMARY KEY (collection_id, series_number));
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, series_name text, set_name text, characters text[],
  total_minted int, fmv_usd numeric, floor_ask numeric, fmv_confidence text);
CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, series int, set_name text,
  player_id uuid, player_name text, circulation_count int);
CREATE TABLE public.fmv_snapshots (edition_id uuid, fmv_usd numeric, floor_price_usd numeric, computed_at timestamptz);
CREATE TABLE public.edition_fmv_current (edition_id uuid, fmv_usd numeric, floor_price_usd numeric);
CREATE FUNCTION public.series_chain_numbers(p_collection_id uuid, p_series_number int) RETURNS int[]
  LANGUAGE sql IMMUTABLE AS $$ SELECT ARRAY[p_series_number] $$;
CREATE FUNCTION public.refresh_edition_fmv_current(p_full boolean DEFAULT false) RETURNS jsonb
  LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
  RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;

CREATE OR REPLACE FUNCTION public.get_series_detail(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid     CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series            RECORD;
  v_collection_slug   text;
  v_edition_count     int;
  v_total_circulation bigint;
  v_fmv_total         numeric;
  v_floor_total       numeric;
  v_fmv_ask_derived   numeric;
  v_listed_count      int;
  v_set_count         int;
  v_player_count      int;
  v_computed_at       timestamptz;
  v_pinnacle_year     int;
  v_hit               boolean := false;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN NULL; END IF;

  -- FAST PATH: the rollup refreshed by jobid 357 `rpc-series-detail-rollup`.
  SELECT true, r.edition_count, r.total_circulation, r.fmv_total_usd,
         r.floor_total_usd, r.set_count, r.player_count, r.computed_at,
         r.fmv_ask_derived_usd, r.listed_count
  INTO v_hit, v_edition_count, v_total_circulation, v_fmv_total,
       v_floor_total, v_set_count, v_player_count, v_computed_at,
       v_fmv_ask_derived, v_listed_count
  FROM series_detail_rollup r
  WHERE r.collection_id = p_collection_id
    AND r.series_number = v_series.series_number;

  IF NOT COALESCE(v_hit, false) THEN
    -- No rollup row yet. Correctness over latency: compute it live rather than
    -- report zeros. v_computed_at stays NULL, which is the honest answer for a
    -- value that did not come from the rollup.
    IF p_collection_id = v_pinnacle_uuid THEN
      BEGIN
        v_pinnacle_year := v_series.season::int;
      EXCEPTION WHEN invalid_text_representation THEN
        v_pinnacle_year := NULL;
      END;

      IF v_pinnacle_year IS NOT NULL THEN
        -- 2026-09-26: from the render catalog, as refresh_series_detail_rollup.
        SELECT
          COUNT(*),
          SUM(pc.total_minted) FILTER (WHERE pc.total_minted IS NOT NULL),
          SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
          SUM(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
          COUNT(DISTINCT btrim(pc.set_name)),
          COUNT(DISTINCT btrim(pc.characters[1])),
          SUM(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
          COUNT(*)             FILTER (WHERE pc.floor_ask > 0)
        INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count, v_fmv_ask_derived, v_listed_count
        FROM pinnacle_catalog pc
        WHERE pc.series_name = v_pinnacle_year::text;
      END IF;
    ELSE
      SELECT
        COUNT(*),
        SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
        SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(DISTINCT e.set_name),
        COUNT(DISTINCT COALESCE(e.player_id::text, e.player_name))
      INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number));
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'series_slug',       p_series_slug,
    'series_number',     v_series.series_number,
    'display_label',     v_series.display_label,
    'season',            v_series.season,
    'edition_count',     COALESCE(v_edition_count, 0),
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'fmv_ask_derived_usd', v_fmv_ask_derived,
    'listed_count',      v_listed_count,
    'set_count',         COALESCE(v_set_count, 0),
    'player_count',      COALESCE(v_player_count, 0),
    'stats_computed_at', v_computed_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.refresh_series_detail_rollup(p_max_seconds integer DEFAULT 240)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pinnacle CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_started  timestamptz := clock_timestamp();
  v_coll     record;
  v_t0       timestamptz;
  v_ms       int;
  v_rows     int;
  v_done     int := 0;
  v_written  int := 0;
  v_skipped  int := 0;
  v_detail   jsonb := '[]'::jsonb;
  v_fmv      jsonb;
  v_fmv_err  text := NULL;
  v_ok       boolean := true;
BEGIN
  -- Must run before the loop reads the table. Isolated so it cannot take the
  -- job down: a stale edition_fmv_current still produces a correct-shaped
  -- rollup, one tick behind.
  BEGIN
    v_fmv := public.refresh_edition_fmv_current();
  -- query_canceled named (2026-09-28): a statement_timeout kill (57014) escapes
  -- WHEN OTHERS, which took the whole rollup down instead of isolating this step.
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_fmv_err := SQLSTATE || ' ' || SQLERRM;
    v_fmv := jsonb_build_object('failed', true, 'error', v_fmv_err);
    v_ok := false;
  END;

  FOR v_coll IN
    SELECT c.id, c.slug
    FROM collections c
    WHERE EXISTS (SELECT 1 FROM collection_series cs WHERE cs.collection_id = c.id)
    ORDER BY (SELECT min(r.computed_at) FROM series_detail_rollup r WHERE r.collection_id = c.id)
             ASC NULLS FIRST, c.slug
  LOOP
    IF extract(epoch FROM (clock_timestamp() - v_started)) > p_max_seconds THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_t0 := clock_timestamp();

    IF v_coll.id = v_pinnacle THEN
      INSERT INTO series_detail_rollup AS r
        (collection_id, series_number, edition_count, total_circulation,
         fmv_total_usd, floor_total_usd, set_count, player_count, computed_at,
         fmv_ask_derived_usd, listed_count)
      -- 2026-09-26: Pinnacle series counted from the render catalog (its own
      -- season); pinnacle_editions.series_year was set on 87 rows only, so the
      -- rollup read 11 editions for a year with 1,023 pins.
      SELECT
        v_coll.id, cs.series_number,
        count(pc.render_id),
        sum(pc.total_minted) FILTER (WHERE pc.total_minted IS NOT NULL),
        sum(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
        sum(pc.floor_ask)    FILTER (WHERE pc.floor_ask > 0),
        count(DISTINCT btrim(pc.set_name)),
        count(DISTINCT btrim(pc.characters[1])),
        now(),
        sum(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0 AND pc.fmv_confidence::text = 'ASK_ONLY'),
        count(pc.render_id)  FILTER (WHERE pc.floor_ask > 0)
      FROM collection_series cs
      LEFT JOIN pinnacle_catalog pc
        ON pc.series_name = NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')
      WHERE cs.collection_id = v_coll.id
      GROUP BY cs.series_number
      ON CONFLICT (collection_id, series_number) DO UPDATE SET
        edition_count = EXCLUDED.edition_count,
        total_circulation = EXCLUDED.total_circulation,
        fmv_total_usd = EXCLUDED.fmv_total_usd,
        floor_total_usd = EXCLUDED.floor_total_usd,
        set_count = EXCLUDED.set_count,
        player_count = EXCLUDED.player_count,
        computed_at = EXCLUDED.computed_at,
        fmv_ask_derived_usd = EXCLUDED.fmv_ask_derived_usd,
        listed_count = EXCLUDED.listed_count;
    ELSE
      INSERT INTO series_detail_rollup AS r
        (collection_id, series_number, edition_count, total_circulation,
         fmv_total_usd, floor_total_usd, set_count, player_count, computed_at)
      SELECT
        v_coll.id, cs.series_number,
        count(e.id),
        sum(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
        sum(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        sum(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        count(DISTINCT e.set_name),
        count(DISTINCT COALESCE(e.player_id::text, e.player_name)),
        now()
      FROM collection_series cs
      LEFT JOIN editions e
        ON e.collection_id = cs.collection_id AND e.series = ANY (public.series_chain_numbers(cs.collection_id, cs.series_number))
      LEFT JOIN edition_fmv_current fmv
        ON fmv.edition_id = e.id
      WHERE cs.collection_id = v_coll.id
      GROUP BY cs.series_number
      ON CONFLICT (collection_id, series_number) DO UPDATE SET
        edition_count = EXCLUDED.edition_count,
        total_circulation = EXCLUDED.total_circulation,
        fmv_total_usd = EXCLUDED.fmv_total_usd,
        floor_total_usd = EXCLUDED.floor_total_usd,
        set_count = EXCLUDED.set_count,
        player_count = EXCLUDED.player_count,
        computed_at = EXCLUDED.computed_at;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_ms := (extract(epoch FROM (clock_timestamp() - v_t0)) * 1000)::int;

    UPDATE series_detail_rollup SET duration_ms = v_ms
    WHERE collection_id = v_coll.id;

    DELETE FROM series_detail_rollup r
    WHERE r.collection_id = v_coll.id
      AND NOT EXISTS (
        SELECT 1 FROM collection_series cs
        WHERE cs.collection_id = r.collection_id AND cs.series_number = r.series_number
      );

    v_done := v_done + 1;
    v_written := v_written + v_rows;
    v_detail := v_detail || jsonb_build_object('collection', v_coll.slug, 'series', v_rows, 'ms', v_ms);
  END LOOP;

  IF v_skipped > 0 THEN v_ok := false; END IF;

  PERFORM log_pipeline_run(
    'series-detail-rollup', v_started, NULL, v_written, NULL, v_ok, v_fmv_err, NULL, NULL, NULL,
    jsonb_build_object(
      'collections_done', v_done,
      'collections_skipped_over_budget', v_skipped,
      'max_seconds', p_max_seconds,
      'edition_fmv_current', v_fmv,
      'per_collection', v_detail
    )
  );

  RETURN jsonb_build_object(
    'ok', v_ok,
    'collections_done', v_done,
    'collections_skipped_over_budget', v_skipped,
    'series_written', v_written,
    'edition_fmv_current', v_fmv,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
    'per_collection', v_detail
  );
END;
$function$;

\set pin '7dd9dd11-e8b6-45c4-ac99-71331f959714'
\set ts '00000000-0000-4000-8000-0000000000aa'
INSERT INTO public.collections VALUES (:'pin'::uuid, 'disney_pinnacle'), (:'ts'::uuid, 'nba_top_shot');
INSERT INTO public.collection_series (collection_id, series_number, display_label, season) VALUES
  (:'pin'::uuid, 2026, 'Series 2026', '2026'),
  (:'pin'::uuid, 2025, 'Series 2025', '2025'),
  (:'ts'::uuid, 1, 'Series 1', '2019-20');
INSERT INTO public.pinnacle_catalog VALUES
  ('a', '2026', 'Set A', ARRAY['Aurora'],   100, 10, 12,   'HIGH'),
  ('b', '2026', 'Set A', ARRAY['Belle'],    100, 18, 20,   'ASK_ONLY'),
  ('c', '2026', 'Set B', ARRAY['Cinder'],   100, 30, NULL, 'MEDIUM'),   -- no live ask
  ('d', '2025', 'Set C', ARRAY['Dopey'],    100,  5,  6,   'HIGH');
INSERT INTO public.editions VALUES ('00000000-0000-4000-8000-000000000001', :'ts'::uuid, 1, 'TS Set', NULL, 'Player', 10);
INSERT INTO public.edition_fmv_current VALUES ('00000000-0000-4000-8000-000000000001', 4, 3);

-- 1. live path (no rollup row yet)
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'floor_total_usd'), '32', 'live: Recent-Low Total = live asks 12 + 20; the unlisted pin adds nothing, never its FMV 30');
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'listed_count'), '2', 'live: 2 of 3 pins listed');
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'fmv_ask_derived_usd'), '18', 'live: the ASK_ONLY part of the FMV total (18 of 58)');
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'fmv_total_usd'), '58', 'live: FMV total unchanged');
-- 2. no ASK_ONLY pin
SELECT _assert((public.get_series_detail(:'pin'::uuid, 'series-2025') ->> 'fmv_ask_derived_usd') IS NULL, 'no ASK_ONLY pin -> NULL, never 0');

-- 1. the rollup (fast path) agrees with the live path
SELECT (public.refresh_series_detail_rollup(60) ->> 'ok') IS NOT NULL AS refreshed \gset
SELECT _assert_eq((SELECT floor_total_usd || '|' || listed_count || '|' || fmv_ask_derived_usd FROM public.series_detail_rollup WHERE collection_id = :'pin'::uuid AND series_number = 2026),
  '32|2|18', 'rollup: live asks only, listed count, ask-derived part');
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'fmv_ask_derived_usd'), '18', 'fast path returns the rollup''s ask-derived part');
SELECT _assert_eq((public.get_series_detail(:'pin'::uuid, 'series-2026') ->> 'listed_count'), '2', 'fast path returns the rollup''s listed count');
-- a REFRESH (the ON CONFLICT path) moves the new columns too, not only the first insert
UPDATE public.pinnacle_catalog SET floor_ask = 25, fmv_confidence = 'ASK_ONLY' WHERE render_id = 'c';
SELECT (public.refresh_series_detail_rollup(60) ->> 'ok') IS NOT NULL AS refreshed2 \gset
SELECT _assert_eq((SELECT floor_total_usd || '|' || listed_count || '|' || fmv_ask_derived_usd FROM public.series_detail_rollup WHERE collection_id = :'pin'::uuid AND series_number = 2026),
  '57|3|48', 'rollup refresh updates the listed count and ask-derived part');
-- 3. non-Pinnacle row leaves the new columns NULL
SELECT _assert((SELECT fmv_ask_derived_usd IS NULL AND listed_count IS NULL FROM public.series_detail_rollup WHERE collection_id = :'ts'::uuid AND series_number = 1), 'non-Pinnacle rollup row: new columns NULL');
SELECT _assert_eq((SELECT floor_total_usd::text FROM public.series_detail_rollup WHERE collection_id = :'ts'::uuid AND series_number = 1), '3', 'non-Pinnacle Recent-Low unchanged');

SELECT '✓ series_detail_pinnacle_totals: all assertions passed' AS result;

ROLLBACK;
