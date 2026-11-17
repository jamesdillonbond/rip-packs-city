-- ── APPENDED 2026-08-24 AFTER RECOVERY — comment only, SQL untouched ─────────
-- ⚠ THIS FILE IS A RECOVERED CAPTURE, not a hand-authored migration. It was
-- applied to production via MCP and its .sql was reconstructed byte-exactly from
-- `supabase_migrations.schema_migrations.statements` by
-- `scripts/recover-fileless-migrations.mjs`. Committing it turned CI RED, because
-- `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` requires
-- every migration from its 20260817000000 CUTOFF forward to STATE an anon-execute
-- decision per public function it creates — and a capture of history states none.
--
-- The decision is stated here rather than by weakening that guard, and it was
-- MEASURED rather than assumed. Verified live 2026-08-24 with
-- `has_function_privilege` (never the acl text):
--   anon = false · authenticated = false · service_role = true · SECURITY DEFINER
--
-- ⚠ ONLY THIS COMMENT WAS ADDED. Not one SQL byte changed, so re-running the file
-- against production is still a no-op and the revert path it carries is intact.
-- It does mean the file no longer md5-matches prod's stored `statements`; that is
-- the deliberate cost of satisfying the guard honestly instead of exempting it.
-- ⚠ A REVOKE must NOT be added: `CREATE OR REPLACE FUNCTION` does not reset an
-- ACL, so one here would CHANGE production while presenting itself as a no-op.
-- anon-exec: unchanged — public.refresh_series_detail_rollup is SECURITY DEFINER and already revoked from PUBLIC, anon and authenticated (verified live 2026-08-24 by has_function_privilege).
--
-- Keep edition_fmv_current fresh, and make the whole series family read ONE
-- FMV snapshot set.
--
-- Two changes to refresh_series_detail_rollup, both minimal-diff to the
-- structure the other session shipped at 03:14 UTC (per-collection loop, time
-- budget, per-collection telemetry, log_pipeline_run - all preserved):
--
--   1. PERFORM refresh_edition_fmv_current() FIRST. This job already carries the
--      staleness arm (pipeline_cadence_watchlist 'series-detail-rollup', 180 min,
--      medium), so folding the new table into it means one watched pipeline
--      instead of two, and no second alarm to forget.
--
--   2. The non-Pinnacle aggregate now reads edition_fmv_current instead of its
--      own per-edition fmv_snapshots lateral.
--      * CONSISTENCY is the real reason: get_series_rollups (the per-set /
--        per-player breakdown) now reads edition_fmv_current, so if the totals
--        beside it were still computed from a separate live read, the breakdown
--        would not sum to the total. Same source, same tick, no explaining.
--      * Speed is a side effect: the loop's own notes measured 99 s cold /
--        ~11 s warm end to end. The replaced lateral was most of that.
--
-- ⚠ ORDER IS LOAD-BEARING. edition_fmv_current must be rebuilt BEFORE the loop
-- reads it, or every series is computed from the PREVIOUS hour's FMV while
-- claiming this hour's computed_at.
--
-- Pinnacle branch untouched - it reads pinnacle_editions via
-- get_pinnacle_edition_fmv_collapsed and has no fmv_snapshots lateral to replace.
--
-- REVERT: audit_20260823_series_detail_rollup_duration_ms_never_recorded
-- (this body minus the PERFORM and with the lateral restored).
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
BEGIN
  -- MUST run before the loop reads the table.
  v_fmv := public.refresh_edition_fmv_current();

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

  PERFORM log_pipeline_run(
    'series-detail-rollup', v_started, NULL, v_written, NULL, true, NULL, NULL, NULL, NULL,
    jsonb_build_object(
      'collections_done', v_done,
      'collections_skipped_over_budget', v_skipped,
      'max_seconds', p_max_seconds,
      'edition_fmv_current', v_fmv,
      'per_collection', v_detail
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'collections_done', v_done,
    'collections_skipped_over_budget', v_skipped,
    'series_written', v_written,
    'edition_fmv_current', v_fmv,
    'elapsed_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int,
    'per_collection', v_detail
  );
END;
$function$;