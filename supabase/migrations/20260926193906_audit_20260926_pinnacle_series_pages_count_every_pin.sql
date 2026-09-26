-- audit_20260926_pinnacle_series_pages_count_every_pin
--
-- WHY. Every Pinnacle series surface read pinnacle_editions by series_year,
-- which is set on 87 of its rows. Measured 2026-09-26, series page vs catalog:
-- 2023 6 vs 183 pins, 2024 35 vs 787, 2025 35 vs 739, 2026 11 vs 1,023 — the
-- header, the grid, the "sets in this series" and "top characters" lists all
-- described a small fraction of the series (and the grid also dropped rows
-- without a thumbnail).
--
-- WHAT. The Pinnacle branch of four functions reads pinnacle_catalog by its
-- own season (series_name):
--   refresh_series_detail_rollup — the hourly header stats (rpc-series-detail-rollup)
--   get_series_detail            — its live fallback when no rollup row exists
--   get_series_editions          — the grid (render_id routes, own art + FMV)
--   get_series_rollups           — sets + top characters (characters[1], whose
--                                  pages all exist since 20260926193316)
-- Every non-Pinnacle line is byte-for-byte the live body. Base prosrc md5s:
--   get_series_editions          ecc7a842b4211d51eb53edd12d4cb12b
--   get_series_rollups           88631b50cb6efb8c2961c82fa9aed373
--   get_series_detail            2092241d507be0bf99a82d5b6d041513
--   refresh_series_detail_rollup b73919c3eb8938f7750769f4013c2f8d
-- ⚠ None of the four had a pin; get_series_rollups and refresh_series_detail_rollup
--   had DDL in the repo only as older snapshots.
--
-- REVERT: re-apply each function from its base body (the prosrc md5s above
--   identify the previous definitions in production history).

-- anon-exec: unchanged (refresh_series_detail_rollup) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
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
  EXCEPTION WHEN OTHERS THEN
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
         fmv_total_usd, floor_total_usd, set_count, player_count, computed_at)
      -- 2026-09-26: Pinnacle series counted from the render catalog (its own
      -- season); pinnacle_editions.series_year was set on 87 rows only, so the
      -- rollup read 11 editions for a year with 1,023 pins.
      SELECT
        v_coll.id, cs.series_number,
        count(pc.render_id),
        sum(pc.total_minted) FILTER (WHERE pc.total_minted IS NOT NULL),
        sum(pc.fmv_usd)      FILTER (WHERE pc.fmv_usd > 0),
        sum(COALESCE(pc.floor_ask, pc.fmv_usd)) FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
        count(DISTINCT btrim(pc.set_name)),
        count(DISTINCT btrim(pc.characters[1])),
        now()
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
        computed_at = EXCLUDED.computed_at;
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

-- anon-exec: unchanged (get_series_detail) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
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
         r.floor_total_usd, r.set_count, r.player_count, r.computed_at
  INTO v_hit, v_edition_count, v_total_circulation, v_fmv_total,
       v_floor_total, v_set_count, v_player_count, v_computed_at
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
          SUM(COALESCE(pc.floor_ask, pc.fmv_usd)) FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
          COUNT(DISTINCT btrim(pc.set_name)),
          COUNT(DISTINCT btrim(pc.characters[1]))
        INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
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
    'set_count',         COALESCE(v_set_count, 0),
    'player_count',      COALESCE(v_player_count, 0),
    'stats_computed_at', v_computed_at
  );
END;
$function$;

-- anon-exec: unchanged (get_series_editions) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_series_editions(p_collection_id uuid, p_series_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_series        RECORD;
  v_pinnacle_year int;
  v_have_current  boolean;
  result          jsonb;
BEGIN
  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN '[]'::jsonb; END IF;

    -- 2026-09-26: the render catalog, keyed on its own series (season) — the
    -- old read was pinnacle_editions.series_year, set on only 87 rows, so a
    -- series page listed 11 editions for a year with 1,023 pins.
    WITH ed AS (
      SELECT
        pc.render_id                                        AS route_slug,
        btrim(pc.characters[1])                             AS player_name,
        regexp_replace(lower(btrim(pc.characters[1])), '[^a-z0-9]+', '-', 'g') AS player_slug,
        btrim(pc.character_name) || ' (' || pc.variant || ')' AS name,
        btrim(pc.set_name)                                  AS set_name,
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pc.variant                                          AS tier,
        public.series_display_label(p_collection_id, v_pinnacle_year) AS series_label,
        pc.total_minted                                     AS circulation_count,
        pc.thumbnail_url,
        pc.fmv_usd,
        pc.floor_ask                                        AS floor_usd,
        pc.fmv_confidence::text                             AS fmv_confidence,
        pc.fmv_usd                                          AS fmv_min,
        pc.fmv_usd                                          AS fmv_max,
        1                                                   AS render_count
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
      ORDER BY pc.fmv_usd DESC NULLS LAST, pc.render_id
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
    RETURN result;
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH pick AS (
      -- PHASE 1: ordering only, from the hourly rollup. No probes.
      SELECT e.id, e.first_minted_at, c.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
      ORDER BY c.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: live FMV + entity_rep_nft_id, over v_safe_limit rows only.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    -- No rollup for this collection. Original path: correct, and slow enough to
    -- notice, which is the point.
    WITH pick AS (
      SELECT e.id, e.first_minted_at, fmv.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        public.series_display_label(p_collection_id, e.series::int)                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.subedition_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;

-- anon-exec: unchanged (get_series_rollups) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
CREATE OR REPLACE FUNCTION public.get_series_rollups(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_empty         CONSTANT jsonb := jsonb_build_object('sets', '[]'::jsonb, 'players', '[]'::jsonb);
  v_series        RECORD;
  v_pinnacle_year int;
  v_have_current  boolean;
  result          jsonb;
BEGIN
  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN v_empty; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN v_empty; END IF;

    -- 2026-09-26: from the render catalog (see get_series_editions).
    WITH ed AS (
      SELECT
        regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g') AS set_slug,
        btrim(pc.set_name) AS set_name,
        regexp_replace(lower(btrim(pc.characters[1])), '[^a-z0-9]+', '-', 'g') AS player_slug,
        btrim(pc.characters[1]) AS player_name,
        pc.fmv_usd
      FROM pinnacle_catalog pc
      WHERE pc.series_name = v_pinnacle_year::text
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;

    RETURN COALESCE(result, v_empty);
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        c.fmv_usd
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  ELSE
    WITH ed AS (
      SELECT
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.set_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.player_name,
        fmv.fmv_usd
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = ANY (public.series_chain_numbers(p_collection_id, v_series.series_number))
        AND e.thumbnail_url IS NOT NULL
    ),
    s AS (
      SELECT set_slug, set_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE set_slug IS NOT NULL AND set_name IS NOT NULL
      GROUP BY set_slug, set_name
    ),
    p AS (
      SELECT player_slug, player_name, count(*) AS edition_count, COALESCE(sum(fmv_usd), 0) AS fmv_total
      FROM ed WHERE player_slug IS NOT NULL AND player_name IS NOT NULL
      GROUP BY player_slug, player_name
      ORDER BY fmv_total DESC LIMIT 12
    )
    SELECT jsonb_build_object(
      'sets',    (SELECT COALESCE(jsonb_agg(to_jsonb(s.*) ORDER BY s.fmv_total DESC), '[]'::jsonb) FROM s),
      'players', (SELECT COALESCE(jsonb_agg(to_jsonb(p.*) ORDER BY p.fmv_total DESC), '[]'::jsonb) FROM p)
    ) INTO result;
  END IF;

  RETURN COALESCE(result, v_empty);
END;
$function$;

-- ⚠ No refresh here: the rollup walks every collection under a 240 s budget,
-- which does not belong inside a migration. The hourly rpc-series-detail-rollup
-- (:59) rewrites the Pinnacle header stats; until then get_series_detail serves
-- the previous rollup row, and the grid/lists are live immediately.
