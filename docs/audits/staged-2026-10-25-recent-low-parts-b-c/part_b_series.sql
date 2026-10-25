-- 2026-10-25 (PT) — a "Recent Low" above 3x FMV is an old ask, not a recent low: the
-- Recent-Low Totals stop summing it.
--
-- WHY. Production HTML sweep, 10-25 ~2:50 PM PT: /nba-top-shot/set/2025-rookie-ultimates read
-- "Recent-Low Total $79,070" beside "FMV Total $21,650". $55,300 of the gap is one /1 —
-- Jeremiah Fears (220:7651): fmv_usd $1,700 (its last sale), floor_price_usd $57,000, carried
-- forward by apply_fmv_thin_sales_guard from an older snapshot. floor_price_usd means "lowest
-- recent sale or ask" (#143); an ask 33x the price the edition sells for is neither. Same shape,
-- smaller: ~200 All Day `_salescap` rows (#208 capped fmv_usd to recent sales, not the floor
-- field), ~$8.5k in all. The header totals are SUM(COALESCE(floor_price_usd, fmv_usd)).
--
-- WHAT. public.recent_low_usd(floor, fmv): the floor when it is > 0 and at most 3x FMV (or FMV is
-- unknown), else NULL — the same 3x bound the live-ask readers use (lib/asks/edition-live-ask.ts).
-- The six SUM / MIN sites of the non-Pinnacle branches call it, so an out-of-band floor
-- contributes FMV instead: get_player_detail, get_set_detail, get_series_detail (live path) +
-- refresh_series_detail_rollup (its fast path), get_team_detail, get_team_sets (cheapest entry).
-- Pinnacle branches (live render asks, their own rule) are untouched. The STORED floor_price_usd
-- is untouched on purpose: fmv_apply_thin_sale_haircut prices from it (floor x 0.75).
-- Everything else in each body is byte-identical; signatures, SECURITY DEFINER, search_path,
-- statement_timeout and ACLs unchanged (CREATE OR REPLACE).
-- anon-exec: intentional — revoked (recent_low_usd); only the SECURITY DEFINER readers above (owner postgres) call it.
-- anon-exec: unchanged (get_player_detail, get_set_detail, get_series_detail, refresh_series_detail_rollup, get_team_detail, get_team_sets) — CREATE OR REPLACE of existing fns; ACLs preserved.
--
-- Revert: re-apply each body from its previous migration (the md5 guard below names the base)
-- and repoint the pins; DROP FUNCTION public.recent_low_usd(numeric, numeric).

-- PART B of 3 (get_series_detail, refresh_series_detail_rollup; needs recent_low_usd from part A). Split only to keep each apply small.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_series_detail(uuid,text)'::regprocedure) IS DISTINCT FROM '7b5d871262a32a9102aa9121c453cd52' THEN
    RAISE EXCEPTION 'get_series_detail changed since the splice base -- re-splice';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_series_detail_rollup(integer)'::regprocedure) IS DISTINCT FROM '0cb641fc0b801a83f786fb2935337c2a' THEN
    RAISE EXCEPTION 'refresh_series_detail_rollup changed since the splice base -- re-splice';
  END IF;
END
$guard$;

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
        SUM(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
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
        sum(COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd)) FILTER (WHERE COALESCE(public.recent_low_usd(fmv.floor_price_usd, fmv.fmv_usd), fmv.fmv_usd) > 0),
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
