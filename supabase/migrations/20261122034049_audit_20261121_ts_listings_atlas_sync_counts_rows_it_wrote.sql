-- audit_20261121_ts_listings_atlas_sync_counts_rows_it_wrote
--
-- 2026-11-21 ~8:00 PM PT (Claude Code cloud, autonomous pass; Trevor: "work autonomously ... fix anything").
-- `ts-listings-atlas-sync` logged rows_written = sync.rows, the SIZE of the open Top Shot book (86,731 at
-- 7:50 PM PT), while the differential sync wrote ~640 rows a tick (inserted 213 / updated 188 / deleted 238).
-- pipeline_runs_daily therefore read 16.7M rows written a day -- the largest writer on the estate by 100x --
-- and the count could never fall to show a write collapse (CLAUDE.md: "make a count mean rows WRITTEN").
-- It also published the sync's counts on a tick whose block FAILED and rolled every write back.
-- Now: rows_found = the book size (what the tick read); rows_written = inserted + updated + deleted of
-- ts_listings AND cached_listings, and 0 when the tick errored. Nothing else changes; `extra` is unchanged,
-- so every count it carried before is still there.
-- Readers checked 11-21: no view, function or app code reads this lane's rows_found / rows_written
-- (close_sold_topshot_listings_and_floors names it in a comment only; the cadence watchlist row is
-- silence-only; lib/sentinel/blind-checks.ts names it in prose).
-- Header (SECURITY DEFINER, search_path, temp_buffers) copied from pg_get_functiondef; live prosrc md5
-- 6cf3cc464a35f562708d20912beac868 checked by the guard below.
-- anon-exec: unchanged (atlas_listing_verify_tick) — CREATE OR REPLACE of an existing fn; ACL preserved
-- (service_role + postgres only, anon false, verified 11-21).
-- REVERT: re-apply the body read from pg_get_functiondef on 11-21 -- identical to this file except the
--   log_pipeline_run arguments 3-4, which were `1, COALESCE((v_sync->>'rows')::int, 0)`.

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.atlas_listing_verify_tick(integer)'::regprocedure) <> '6cf3cc464a35f562708d20912beac868' THEN
    RAISE EXCEPTION 'live atlas_listing_verify_tick is not the body this migration was written against; re-read it';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max integer DEFAULT 2)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET temp_buffers TO '48MB'
AS $function$
DECLARE v_started timestamptz := clock_timestamp(); v_settle jsonb; v_sync jsonb; v_cl jsonb; v_eo jsonb; v_disp jsonb; v_edisp jsonb; v_err text;
BEGIN
  BEGIN
    v_settle := public.atlas_edition_verify_settle();
    -- The two ~400k-row diagnostic counts run twice an hour (the :00/:01 and :30/:31 ticks), not
    -- every 2 minutes; the other ticks publish them as NULL with diag_sampled = false.
    v_sync := public.sync_ts_listings_from_atlas((extract(minute from clock_timestamp())::int % 30) < 2);
    v_cl := public.sync_cached_listings_from_atlas();
    v_eo := public.sync_edition_offers_from_atlas();
    v_disp := public.atlas_listing_verify_dispatch(p_max);
    v_edisp := public.atlas_edition_verify_dispatch(4);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  -- 2026-11-21: found = the open book read; written = rows this tick actually inserted/updated/deleted in
  -- ts_listings + cached_listings (was the book size), and 0 on an errored tick (its writes rolled back).
  PERFORM public.log_pipeline_run('ts-listings-atlas-sync', v_started,
    COALESCE((v_sync->>'rows')::int, 0),
    CASE WHEN v_err IS NULL THEN
      COALESCE((v_sync->>'inserted')::int, 0) + COALESCE((v_sync->>'updated')::int, 0) + COALESCE((v_sync->>'deleted')::int, 0)
      + COALESCE((v_cl->>'inserted')::int, 0) + COALESCE((v_cl->>'updated')::int, 0) + COALESCE((v_cl->>'deleted')::int, 0)
    ELSE 0 END,
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('settle', v_settle, 'sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo,
                       'verify', v_disp, 'edition_verify', v_edisp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('settle', v_settle, 'sync', v_sync, 'cached_listings', v_cl, 'edition_offers', v_eo,
                            'verify', v_disp, 'edition_verify', v_edisp, 'error', v_err);
END $function$;
