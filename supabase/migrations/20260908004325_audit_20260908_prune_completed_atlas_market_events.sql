-- anon-exec: intentional — new SECURITY DEFINER maintenance function; REVOKEd from PUBLIC/anon/authenticated below, service_role + pg_cron only (prune_topshot_atlas_market_events)
-- audit_20260908: `topshot_atlas_market_events` gets a retention policy — completed Top Shot events
-- older than 7 days are pruned hourly behind two guards, in bounded pages.
--
-- WHY. Filed 2026-09-08T0015Z (inbox): the Atlas feed table had NO retention and was growing ~90K rows /
-- ~45 MB a day (131,734 / 55 MB at 09-07 16Z -> 223,643 / 98 MB at 09-08 00:12Z). Re-measured before
-- shipping: 225,179 rows / 99 MB at 00:28Z (~5.8K rows/h at that moment). At ~100K/day that is ~36M
-- rows / ~16 GB a year on a Small instance whose IO budget is the constraint — the never-pruned
-- audit-table shape that already bit the Atlas edition dispatcher (20260907055104) and the chain
-- hydrator (20260907161134). Composition at 00:30Z: completed offers 99,162 · completed listings 78,271
-- · open listings 35,041 · open offers 7,654 (nba); nfl 7,069 total.
--
-- WHO READS IT (every reader re-enumerated from pg_proc/pg_views/cron.job by strpos, and the repo:
-- app/, lib/, components/, supabase/functions/, scripts/ carry ZERO references):
--   1. sync_ts_listings_from_atlas / sync_cached_listings_from_atlas / sync_edition_offers_from_atlas —
--      OPEN rows seen in the last 24 h. Never pruned (NOT completed is excluded by the predicate).
--   2. atlas_listing_verify_settle / atlas_edition_verify_settle / atlas_market_upsert_events — upsert
--      by uuid. A pruned completed event that a later history read re-sees is simply re-inserted.
--   3. sync_sales_from_atlas — purchased listings behind a `last_seen_at` cursor (backfill_state
--      'sales-atlas-sync'). GUARD 1: nothing with last_seen_at >= that cursor is pruned, so an event
--      the lane has not examined yet cannot be lost, however far behind it falls.
--   4. hydrate_topshot_moments_from_wmc (source 2) / topshot_moment_hydrate_dispatch (exclusion 2) —
--      any event naming an nft's edition + serial, for nfts still in v_moments_needing_hydration.
--      GUARD 2: an event whose nft_id is still in that queue is kept (a free name beats a chain script).
--   5. allday_resolve_unmapped_via_atlas — product = 'nfl' rows. Out of scope: only product = 'nba'
--      is pruned (nfl is ~7K rows; its leg-2 NOT EXISTS would re-probe a pruned nft).
--   6. check_edge_fn_http_failures — max(listed_at) only; unaffected by removing old rows.
--
-- WHY 7 DAYS (a decision, recorded so it can be re-litigated): the widest reader window is 24 h (the
-- syncs); the sales lane is protected by its cursor, not by the window; the hydrators by the queue
-- guard. Steady state at ~100K/day ≈ 700K rows / ~300 MB instead of unbounded. The filing suggested
-- N ≥ 30 "by a wide margin" — the margin is now structural (guard 1), so the window can follow the
-- readers. Raise via cron.schedule(... prune_topshot_atlas_market_events(30, 20000)) if a 30-day
-- reader is ever added; and REGISTER that reader here.
--
-- BOUNDED WALK (CLAUDE.md): candidates come off a new partial index (product, last_seen_at) WHERE
-- completed, oldest first, LIMIT p_max per run (20,000 hourly = 480K/day capacity, ~4-5x the inflow),
-- then the two guards are applied to that page. Rows guard 2 keeps sit at the head of the index and
-- are re-examined each run — counted as `kept_hydration` in pipeline_runs.extra so the head cannot
-- silently fill with them.
--
-- FIRST 7 DAYS: prunes 0 (oldest completed row is 2026-09-06 21:03Z). First non-zero run ~2026-09-14.
--
-- REVERT (a stranger can run this):
--   SELECT cron.unschedule('rpc-prune-atlas-market-events');
--   DROP FUNCTION public.prune_topshot_atlas_market_events(int, int);
--   DROP INDEX public.idx_tame_completed_seen;
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'atlas-market-events-prune';
-- Pruned rows are not recoverable, but every one was a completed event older than 7 days that the
-- verify lanes re-insert on their next history read of that edition.

CREATE INDEX IF NOT EXISTS idx_tame_completed_seen
  ON public.topshot_atlas_market_events (product, last_seen_at)
  WHERE completed;

CREATE OR REPLACE FUNCTION public.prune_topshot_atlas_market_events(p_days int DEFAULT 7, p_max int DEFAULT 20000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_started      timestamptz := clock_timestamp();
  v_ts           constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sales_cursor timestamptz;
  v_cutoff       timestamptz;
  v_page         int := 0;
  v_kept_hyd     int := 0;
  v_deleted      int := 0;
  v_err          text;
BEGIN
  PERFORM set_config('statement_timeout', '110000', true);

  SELECT NULLIF(cursor, '')::timestamptz INTO v_sales_cursor
    FROM public.backfill_state WHERE id = 'sales-atlas-sync';

  -- Guard 1: never ahead of the sales lane's cursor. No cursor (lane never ran) => prune nothing.
  v_cutoff := LEAST(now() - make_interval(days => p_days), v_sales_cursor);

  BEGIN
    IF v_cutoff IS NOT NULL THEN
      DROP TABLE IF EXISTS _tame_prune_page;
      CREATE TEMP TABLE _tame_prune_page ON COMMIT DROP AS
      SELECT ev.uuid, ev.nft_id
        FROM public.topshot_atlas_market_events ev
       WHERE ev.product = 'nba' AND ev.completed AND ev.last_seen_at < v_cutoff
       ORDER BY ev.last_seen_at
       LIMIT p_max;
      SELECT count(*) INTO v_page FROM _tame_prune_page;

      -- Guard 2: keep any event that still names a pack-pull nft the hydrators have not resolved.
      DELETE FROM _tame_prune_page p
       WHERE p.nft_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM public.v_moments_needing_hydration q
                      WHERE q.collection_id = v_ts AND q.nft_id = p.nft_id);
      GET DIAGNOSTICS v_kept_hyd = ROW_COUNT;

      DELETE FROM public.topshot_atlas_market_events e
       USING _tame_prune_page p
       WHERE e.uuid = p.uuid;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'atlas-market-events-prune', v_started, v_page, v_deleted, v_kept_hyd,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('page', v_page, 'deleted', v_deleted, 'kept_hydration', v_kept_hyd,
                       'cutoff', v_cutoff, 'sales_cursor', v_sales_cursor, 'days', p_days, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('page', v_page, 'deleted', v_deleted, 'kept_hydration', v_kept_hyd,
                            'cutoff', v_cutoff, 'sales_cursor', v_sales_cursor, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.prune_topshot_atlas_market_events(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_topshot_atlas_market_events(int, int) TO service_role;

-- Minute 27 is unused by any hourly job (free-set read from cron.job 2026-09-08 00:4xZ; the stagger
-- ban excludes 0,1,20,21,40,41).
SELECT cron.schedule('rpc-prune-atlas-market-events', '27 * * * *',
  $cron$ SELECT public.prune_topshot_atlas_market_events(7, 20000) $cron$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES ('atlas-market-events-prune', 180, 360, 'info', true,
        'pg_cron rpc-prune-atlas-market-events hourly at :27 since 2026-09-08 (migration audit_20260908_prune_completed_atlas_market_events): deletes completed nba topshot_atlas_market_events older than 7 days, never past the sales-atlas-sync cursor, never an nft still in v_moments_needing_hydration; 20,000 per run. rows_written = deleted (0 until ~2026-09-14 by construction). Watch extra.kept_hydration — if it approaches the page size the head is full of kept rows and the walk needs a cursor.')
ON CONFLICT (pipeline) DO NOTHING;
