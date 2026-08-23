-- ⛔ I BROKE jobid 357 AND THE NEXT TICK CAUGHT IT.
--
-- 17:59 UTC run: FAILED at exactly 600 s — cron_heavy's ceiling — inside the
-- `WITH latest AS MATERIALIZED (SELECT DISTINCT ON (s.edition_id) …)` rebuild I
-- added to refresh_series_detail_rollup seven minutes earlier. Prior ticks:
-- 16:59 49 s · 15:59 177 s · 14:59 351 s. The job already had minutes of
-- variance and my full-population pass pushed it over.
--
-- ⚠ My one-off verification runs were 76 s and 2 s. Both ran seconds after a
-- previous run had warmed the same pages. **I verified a scheduled job with
-- back-to-back manual runs, which is the warmest possible condition — the exact
-- error this whole day has been about, committed while writing it up.** A
-- scheduled job must be verified on a tick it does not share a cache with.
--
-- FIX: refresh incrementally off a watermark instead of rescanning 1.23M rows.
--   * watermark = max(computed_at) already in edition_fmv_current
--   * minus a 2 h SAFETY LAG, because FMV backfills write rows with OLDER
--     computed_at than the run that follows them; a bare `> watermark` would
--     skip those forever. The lag costs one extra hour of already-indexed rows.
--   * `computed_at > cutoff` is served by idx_fmv_snapshots_2026_computed_at_desc,
--     so the scan is proportional to what CHANGED, not to the table.
--   * the full pass survives only for the cold-start case (empty table).
--
-- ⚠ TRADE-OFF, stated rather than hidden: the incremental path cannot
-- mark-and-sweep orphans, because it only touches changed editions. An edition
-- whose snapshots are deleted keeps a stale row until a full rebuild. Deleting
-- from fmv_snapshots is not something we do outside a migration, and the
-- `full_rebuild` flag in the return value says which path ran.
--
-- REVERT: audit_20260823_edition_fmv_current_mark_and_sweep_not_probe_per_row
-- (unconditional full pass) — but that is what took down the 17:59 tick.
CREATE OR REPLACE FUNCTION public.refresh_edition_fmv_current()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_stamp     timestamptz := now();
  v_watermark timestamptz;
  v_cutoff    timestamptz;
  v_rows      int;
  v_pruned    int := 0;
  v_full      boolean;
BEGIN
  SELECT max(computed_at) INTO v_watermark FROM edition_fmv_current;
  v_full := v_watermark IS NULL;

  IF v_full THEN
    -- Cold start only. ~1.23M rows, minutes when cold.
    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.edition_id)
             s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM fmv_snapshots s
      ORDER BY s.edition_id, s.computed_at DESC
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    DELETE FROM edition_fmv_current WHERE refreshed_at < v_stamp;
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  ELSE
    v_cutoff := v_watermark - interval '2 hours';

    WITH latest AS MATERIALIZED (
      SELECT DISTINCT ON (s.edition_id)
             s.edition_id, s.collection_id, s.fmv_usd, s.floor_price_usd, s.confidence, s.computed_at
      FROM fmv_snapshots s
      WHERE s.computed_at > v_cutoff
      ORDER BY s.edition_id, s.computed_at DESC
    )
    INSERT INTO edition_fmv_current AS t
      (edition_id, collection_id, fmv_usd, floor_price_usd, confidence, computed_at, refreshed_at)
    SELECT l.edition_id, l.collection_id, l.fmv_usd, l.floor_price_usd, l.confidence, l.computed_at, v_stamp
    FROM latest l
    ON CONFLICT (edition_id) DO UPDATE SET
      collection_id = EXCLUDED.collection_id, fmv_usd = EXCLUDED.fmv_usd,
      floor_price_usd = EXCLUDED.floor_price_usd, confidence = EXCLUDED.confidence,
      computed_at = EXCLUDED.computed_at, refreshed_at = EXCLUDED.refreshed_at
    -- Never move a row backwards: a late-arriving OLDER snapshot must not
    -- overwrite a newer one just because it was written after it.
    WHERE EXCLUDED.computed_at >= t.computed_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'full_rebuild', v_full,
    'watermark', v_watermark,
    'cutoff', v_cutoff,
    'upserted', v_rows,
    'pruned', v_pruned,
    'duration_ms', (extract(epoch FROM (clock_timestamp() - v_started)) * 1000)::int
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_edition_fmv_current() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_edition_fmv_current() TO postgres, service_role, cron_heavy;