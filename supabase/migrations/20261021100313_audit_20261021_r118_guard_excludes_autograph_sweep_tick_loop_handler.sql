-- audit_20261021_r118_guard_excludes_autograph_sweep_tick_loop_handler
-- anon-exec: intentional — same signature + CREATE OR REPLACE preserves the ACLs set in
--   20260920144120 (anon/authenticated EXECUTE false, service_role true); re-asserted below.
--
-- 2026-10-21 3:03 AM PT (Claude Code cloud; Trevor: "work on roadmap items and known issues"; the
-- 10-21 night-pass handoff, Queued #1). check_when_others_timeout_blind() read 1:
-- autograph_sweep_tick, shipped 10-19 by 20261020030228. Its only WHEN OTHERS handler is a
-- swallow-and-continue inside the per-answer drain LOOP (prosrc: LOOP < EXCEPTION < END LOOP),
-- and the author's comment above it already states the R118 reasoning ("a caught 57014 would run
-- on with the timer disarmed; a kill must end the run"). That is the per-item class the guard's
-- own rule sends to this exclusion list, with the loop argument written inline. The handler is NOT
-- changed. Body otherwise byte-identical to 20261011015333 (live prosrc md5 af06075c… re-read and
-- matched to that file's body before this write).
--
-- REVERT: re-apply the CREATE OR REPLACE from 20261011015333 (drops the name again).

CREATE OR REPLACE FUNCTION public.check_when_others_timeout_blind()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'when_others_handler_blind_to_query_canceled',
           'function', p.proname,
           'handlers', public.r118_blind_handler_count(p.prosrc),
           'detail', 'PL/pgSQL WHEN OTHERS excludes QUERY_CANCELED: a statement_timeout kill escapes this handler and the row/sentinel it promises is never written. Use WHEN query_canceled OR OTHERS for record-and-exit handlers; if this handler sits in a per-item loop with real statements, add the function to the exclusion list with the loop argument. A handler whose only statement is <ident> := NULL is read as a parse guard and does not count (r118_blind_handler_count).'
         ) ORDER BY p.proname), '[]'::jsonb)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
    AND p.prosrc ~* 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN'
    AND p.prosrc !~* 'WHEN\s+query_canceled'
    AND p.prosrc ~* 'log_pipeline_run|pipeline_runs|999|statement_timeout|57014|query_canceled'
    AND public.r118_blind_handler_count(p.prosrc) > 0
    AND p.proname NOT IN (
      -- swallow-and-continue loops with real statements in the handler, classified
      -- 2026-09-20 (R118 batch two header). collect_pack_nft_identity left this list
      -- 2026-10-02: its handler is a null-assignment guard, which the rule reads by SHAPE.
      'atlas_editions_drain', 'atlas_market_drain', 'bulk_insert_pinnacle_sales',
      'public_board_liveness_sweep', 'reconcile_all_seeded_wallet_stats',
      'refresh_series_detail_rollup', 'remap_topshot_wmc_from_onchain_map', 'analytics_smoke_run',
      'resolve_moment_id', 'submit_allow_list_request', 'roll_pack_ask_hourly_low',
      -- 2026-10-10: run_chain_arrival_refloor (20261010231932) — its one WHEN OTHERS wraps the
      -- base64/jsonb decode of ONE pg_net answer inside the per-request collect LOOP; the handler
      -- marks that request 'failed' and CONTINUEs to the next. Catching a 57014 there would let
      -- the remaining requests run past the 60 s budget (the timer is not re-armed after a catch).
      -- The run's own record is written by log_pipeline_run AFTER the loop, outside any handler.
      'run_chain_arrival_refloor',
      -- 2026-10-21: autograph_sweep_tick (20261020030228) — its one WHEN OTHERS sits inside the
      -- per-answer drain LOOP: it counts the page bad, keeps SQLERRM, stamps that request's row
      -- 'parse_or_write: …' and the loop CONTINUES to the next answer. Catching a 57014 there would
      -- let the remaining pages run with the timer disarmed; a kill must end the tick (the next tick
      -- retries). The function writes no pipeline_runs row of its own, so no record is lost.
      'autograph_sweep_tick'
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.check_when_others_timeout_blind() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_when_others_timeout_blind() TO service_role;

DO $$
DECLARE v jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'autograph_sweep_tick') THEN
    RAISE EXCEPTION 'autograph_sweep_tick is missing — this exclusion has no subject';
  END IF;
  -- positive control: the subject still reads as a loop handler under the shape rule (count > 0),
  -- i.e. the name list is what clears it, not a body change.
  IF (SELECT public.r118_blind_handler_count(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'autograph_sweep_tick') <= 0 THEN
    RAISE EXCEPTION 'autograph_sweep_tick no longer has a WHEN OTHERS loop handler — drop this exclusion instead';
  END IF;
  IF has_function_privilege('anon', 'public.check_when_others_timeout_blind()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_when_others_timeout_blind()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
  v := public.check_when_others_timeout_blind();
  IF jsonb_array_length(v) <> 0 THEN
    RAISE EXCEPTION 'R118: handlers still blind after the exclusion: %', v;
  END IF;
END $$;
