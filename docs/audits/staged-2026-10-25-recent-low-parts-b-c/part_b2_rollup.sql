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

-- PART B2 of part B (refresh_series_detail_rollup — the rollup get_series_detail's fast path reads).

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.refresh_series_detail_rollup(integer)'::regprocedure) IS DISTINCT FROM '0cb641fc0b801a83f786fb2935337c2a' THEN
    RAISE EXCEPTION 'refresh_series_detail_rollup changed since the splice base -- re-splice';
  END IF;
END
$guard$;

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
