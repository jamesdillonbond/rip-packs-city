-- audit_20260823_series_detail_rollup
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- `get_series_detail` is deterministically over its own 8 s ceiling on the
-- large series, and 26 sitemap URLs depend on it. Measured 2026-08-23 (the
-- Cowork filing 2026-08-23T0210Z, re-derived here before acting):
--
--   NFL All Day series-4      54 editions        10 ms
--   LaLiga Golazos series-1  575 editions     1,573 ms warm / 4,610 ms cold
--   NBA Top Shot series-4  3,600 editions    21,229 ms warm / 43,750 ms cold
--
-- ⚠ The 8 s `proconfig` on this function is INERT under psql/pg_cron but BINDS
-- on the PostgREST `rpc/` path, which is how production reaches it. So those
-- numbers are the TRUE cost and production simply gets 57014. Vercel runtime
-- logs, 24 h: five distinct series URLs, all HTTP 500,
-- `canceling statement due to statement timeout`. R19 counts 259
-- "series detail unavailable" across 38 users in 7 days.
--
-- The cost is the per-edition `LEFT JOIN LATERAL` top-1 over `fmv_snapshots`.
-- EXPLAIN at 1,465 editions: 9,660 buffers, ~240 of them HEAP READS on a
-- 690 MB partition, ~2.5 s warm. It scales worse than linearly because the
-- working set stops fitting.
--
-- ⚠ THE OBVIOUS REWRITES ARE BOTH MEASURED DEAD ENDS, so neither is used here:
--   * `JOIN fmv_current` / `IN (subquery)` — 1.05M buffers / 28.7 s (recorded
--     2026-08-18). Re-confirmed today: the `= ANY(<array from a CTE>)` variant
--     TIMED OUT rather than pushing the qual below the view's `DISTINCT ON`.
--   * dropping the `LIMIT` or narrowing it — a LIMIT bounds OUTPUT, not COST.
--
-- The page needs six aggregates for 26 series. That is 26 rows of slowly
-- changing data being recomputed from 1.16M snapshot rows on every crawl and
-- every visit. Precompute it.
--
-- ── WHAT THIS DOES NOT FIX ──────────────────────────────────────────────────
-- ⚠ Mode 2 in the same filing — `/nfl-all-day/series/series-4` renders all
-- 71,982 characters into `<div hidden id="S:0">` and the Suspense boundary
-- never completes — is a CLIENT-side streaming failure on a page the server
-- rendered correctly in 10 ms. No amount of query tuning touches it, and this
-- migration must not be credited with fixing it.
-- ⚠ `get_series_editions` and `get_series_rollups` are untouched. This bounds
-- the read that 500s the whole page; the sections have their own budgets.
--
-- Revert:
--   DROP FUNCTION public.refresh_series_detail_rollup(integer);
--   DROP TABLE public.series_detail_rollup;
--   -- and restore get_series_detail's body from this migration's PREVIOUS
--   -- definition (git: supabase/migrations, `git log -S get_series_detail`).

CREATE TABLE IF NOT EXISTS public.series_detail_rollup (
  collection_id     uuid        NOT NULL,
  series_number     int         NOT NULL,
  edition_count     int,
  total_circulation bigint,
  fmv_total_usd     numeric,
  floor_total_usd   numeric,
  set_count         int,
  player_count      int,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  duration_ms       int,
  PRIMARY KEY (collection_id, series_number)
);

COMMENT ON TABLE public.series_detail_rollup IS
  'Precomputed per-series aggregates for /[collection]/series/[slug]. Refreshed by refresh_series_detail_rollup(). ⚠ A MISSING ROW MEANS UNKNOWN, NOT ZERO — get_series_detail returns NULL aggregates for a series with no row here, and the page renders an em dash. Never COALESCE these to 0 on the read path: a fabricated 0 renders as "this series has no editions" on a series holding thousands.';

REVOKE ALL ON TABLE public.series_detail_rollup FROM PUBLIC, anon, authenticated;

-- ── The refresh ─────────────────────────────────────────────────────────────
--
-- Per COLLECTION, not per series: one pass over a collection's editions
-- computes every one of its series at once, so Top Shot's eight series cost one
-- scan instead of eight. Collections are visited oldest-rollup-first, so a run
-- that exhausts its budget still rotates rather than starving the same tail.
--
-- ⚠ The time budget is checked BETWEEN collections, never inside one. A
-- collection is one statement and `COMMIT` does not re-arm `statement_timeout`
-- — the whole CALL shares one budget — so the only honest thing a budget can do
-- here is decline to START the next collection.
CREATE OR REPLACE FUNCTION public.refresh_series_detail_rollup(p_max_seconds int DEFAULT 240)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
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
BEGIN
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
      SELECT
        v_coll.id,
        cs.series_number,
        count(pe.id),
        sum(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
        sum(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
        sum(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
        count(DISTINCT pe.set_name),
        count(DISTINCT pe.character_name),
        now()
      FROM collection_series cs
      LEFT JOIN pinnacle_editions pe
        ON pe.series_year = NULLIF(regexp_replace(cs.season, '[^0-9]', '', 'g'), '')::int
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON pe.id IS NOT NULL
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
        v_coll.id,
        cs.series_number,
        count(e.id),
        sum(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
        sum(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        sum(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        count(DISTINCT e.set_name),
        count(DISTINCT COALESCE(e.player_id::text, e.player_name)),
        now()
      FROM collection_series cs
      LEFT JOIN editions e
        ON e.collection_id = cs.collection_id AND e.series = cs.series_number
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON e.id IS NOT NULL
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
    WHERE collection_id = v_coll.id AND computed_at >= v_t0;

    -- A series deleted from collection_series must not keep serving its last
    -- known aggregates. (Two phantom Golazos series were deleted 2026-08-23.)
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

  PERFORM log_pipeline_run(
    'series-detail-rollup', v_started, NULL, v_written, NULL, true, NULL, NULL, NULL, NULL,
    jsonb_build_object(
      'collections_done', v_done,
      'collections_skipped_over_budget', v_skipped,
      'max_seconds', p_max_seconds,
      'per_collection', v_detail
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'collections_done', v_done,
    'collections_skipped_over_budget', v_skipped,
    'series_written', v_written,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
    'per_collection', v_detail
  );
END;
$fn$;

COMMENT ON FUNCTION public.refresh_series_detail_rollup(integer) IS
  'Recomputes public.series_detail_rollup one COLLECTION at a time, oldest rollup first, declining to START a collection once p_max_seconds is spent. ⚠ The budget cannot interrupt a collection: the whole call is one statement_timeout budget and COMMIT does not re-arm it.';

REVOKE ALL ON FUNCTION public.refresh_series_detail_rollup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_series_detail_rollup(integer) TO service_role;
