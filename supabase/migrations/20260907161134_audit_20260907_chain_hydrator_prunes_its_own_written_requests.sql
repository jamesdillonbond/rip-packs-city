-- audit_20260907: the chain hydrator's request table is pruned by the tick that fills it.
--
-- `topshot_moment_hydrate_requests` gains ~28.8K rows/day and nothing removed them — the same
-- never-pruned audit-table shape that made the Atlas edition dispatcher's in-flight check a
-- 2.5 s per-candidate scan this morning (20260907055104). A `written` row is consulted by nothing
-- after its `moments` row exists (the dispatcher excludes those on `moments`, not on the request
-- table), so the tick deletes `written` rows drained more than 2 days ago. Every other outcome
-- (`no_nft` / `no_collection` 30-day retry window, `error` / `timeout` 1 day, `unmapped`) is kept
-- for the window that reads it — nothing that decides a retry is pruned. Steady state ≈ 60K rows.
-- The count goes in the tick's `pipeline_runs.extra.pruned`.
--
-- REVERT: re-apply topshot_moment_hydrate_tick from 20260907153117 (no prune).

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_tick(p_max int DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_drain jsonb; v_disp jsonb; v_err text; v_pruned int := 0;
BEGIN
  BEGIN
    v_drain := public.topshot_moment_hydrate_drain();
    v_disp  := public.topshot_moment_hydrate_dispatch(p_max);
    -- a written request is consulted by nothing once its moments row exists
    DELETE FROM public.topshot_moment_hydrate_requests
     WHERE outcome = 'written' AND drained_at < now() - interval '2 days';
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-moments-hydrate-chain', v_started,
    COALESCE((v_drain->>'drained')::int, 0), COALESCE((v_drain->>'written')::int, 0),
    COALESCE((v_drain->>'no_nft')::int, 0) + COALESCE((v_drain->>'no_collection')::int, 0) + COALESCE((v_drain->>'unmapped')::int, 0),
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('drain', v_drain, 'dispatch', v_disp, 'pruned', v_pruned, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('drain', v_drain, 'dispatch', v_disp, 'pruned', v_pruned, 'error', v_err);
END $$;
-- anon-exec: intentional — same signature as 20260907153117, ACLs preserved (topshot_moment_hydrate_tick)
