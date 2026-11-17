-- 2026-09-23 · Head-first hydration, follow-up measured on its first two ticks.
--
-- MEASURED (9:39 / 9:43 PM PT, the first 240 head dispatches):
--   * 94 of 120 drained answers were `unmapped` — the chain named setID/playID,
--     but no `editions` row exists: set 258, plays 9272–9303 (a new drop; the
--     newest Top Shot edition in the table is from 09-15). Hydration cannot
--     name a moment whose edition the catalog does not hold.
--   * 20 of 120 were HTTP 429 from rest-mainnet.onflow.org ("100/second request
--     limit reached"): head 120 + walk 80 fire as one burst.
--
-- FIX:
--   1. topshot_moment_hydrate_drain(): before resolving editions, call the
--      existing ensure_topshot_edition_stub(set, play) for every Standard
--      (sub empty/0) setID:playID the chain returned. That function inherits
--      tier/series from the parent `sets` row and returns NULL (writes nothing)
--      when the set itself is uncatalogued, so it cannot invent a set. The
--      downstream stub resolver fills player/team as it already does for every
--      stub. Parallels (sub > 0) are NOT stubbed here and stay `unmapped`.
--      Applied as an asserted in-DB replacement of the live body (exactly one
--      match required) so no other line of the drain can change.
--   2. Burst under the provider's 100/s: head 60 per tick, walk (jobid 469)
--      80 -> 30. 90 per tick, every 4 min.
--
-- REVERT: re-run 20260924043605's tick body (head 120); cron.alter_job(469,
-- command := ' SELECT public.topshot_moment_hydrate_tick(80) '); and
--   DO $$ BEGIN EXECUTE (SELECT def FROM public.audit_20260923_hydrate_drain_prev); END $$;

CREATE TABLE IF NOT EXISTS public.audit_20260923_hydrate_drain_prev AS
SELECT pg_get_functiondef('public.topshot_moment_hydrate_drain()'::regprocedure) AS def, now() AS saved_at;
ALTER TABLE public.audit_20260923_hydrate_drain_prev ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260923_hydrate_drain_prev FROM anon, authenticated;

DO $mig$
DECLARE
  d text := pg_get_functiondef('public.topshot_moment_hydrate_drain()'::regprocedure);
  anchor text := '  -- Resolve editions: the parallel keys';
  ins text := $q$  -- 2026-09-23: catalog a Standard edition the chain just named but the table
  -- lacks (new drops). NULL-returning, set-inheriting, never invents a set.
  PERFORM public.ensure_topshot_edition_stub(s.set_id, s.play_id)
     FROM (SELECT DISTINCT set_id, play_id FROM _hyd_dec
            WHERE status_code = 200 AND set_id IS NOT NULL AND play_id IS NOT NULL
              AND COALESCE(sub_id, 0) = 0) s;

$q$;
  n int;
BEGIN
  n := (length(d) - length(replace(d, anchor, ''))) / length(anchor);
  IF n <> 1 THEN RAISE EXCEPTION 'drain anchor matched % times', n; END IF;
  d := replace(d, anchor, ins || anchor);
  EXECUTE d;
END
$mig$;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_tick(p_max integer DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET statement_timeout = '110s'
AS $fn$
DECLARE v_started timestamptz := clock_timestamp(); v_drain jsonb; v_head jsonb; v_disp jsonb; v_err text; v_pruned int := 0;
BEGIN
  BEGIN
    v_drain := public.topshot_moment_hydrate_drain();
    -- 2026-09-23: HEAD FIRST. Today's pulls before the history walk. 60 + the
    -- walk's p_max stays under the Flow access node's 100 req/s burst limit.
    v_head  := public.topshot_moment_hydrate_dispatch_head(60);
    v_disp  := public.topshot_moment_hydrate_dispatch(p_max);
    -- a written request is consulted by nothing once its moments row exists
    DELETE FROM public.topshot_moment_hydrate_requests
     WHERE outcome = 'written' AND drained_at < now() - interval '2 days';
    GET DIAGNOSTICS v_pruned = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-moments-hydrate-chain', v_started,
    COALESCE((v_drain->>'drained')::int, 0), COALESCE((v_drain->>'written')::int, 0),
    COALESCE((v_drain->>'no_nft')::int, 0) + COALESCE((v_drain->>'no_collection')::int, 0) + COALESCE((v_drain->>'unmapped')::int, 0),
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('drain', v_drain, 'head', v_head, 'dispatch', v_disp, 'pruned', v_pruned, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('drain', v_drain, 'head', v_head, 'dispatch', v_disp, 'pruned', v_pruned, 'error', v_err);
END
$fn$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_tick(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_tick(integer) TO service_role, postgres;

SELECT cron.alter_job(469, command := ' SELECT public.topshot_moment_hydrate_tick(30) ');
