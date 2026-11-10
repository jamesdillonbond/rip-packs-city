-- anon-exec: unchanged (check_when_others_timeout_blind) — CREATE OR REPLACE of an existing fn; ACL preserved (service_role + postgres only), read from proacl 2026-11-09 before this write.
-- 2026-11-09 ~10:08 PM PT (Cowork cloud; Trevor: "deep dive audit ... take care of everything you can").
-- check_when_others_timeout_blind() read 1: candy_collections_discover_collect, shipped 11-08. Its
-- only WHEN OTHERS handler sits inside the per-account LOOP and its author's comment already states
-- the R118 reasoning (a kill aborts the collect; a timeout must not be recorded as "unparsed").
-- That is the per-item class the guard's own rule sends to this exclusion list. The handler is NOT
-- changed. Body otherwise identical to 20261108174250 (live prosrc md5 0ace65db... matched first).
-- Revert: re-apply the body from 20261108174250 (this one minus the 'candy_collections_discover_collect' entry).
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
      'autograph_sweep_tick',
      -- 2026-11-08: espn_gamelog_drain (20261108174208) — its one WHEN OTHERS sits inside the
      -- per-request drain LOOP: it marks that ESPN answer failed and CONTINUEs. A 57014 must end the
      -- tick (the request stays undrained and is retried); log_pipeline_run runs after the loop.
      'espn_gamelog_drain',
      -- 2026-11-09: candy_collections_discover_collect (20261108215922) — its one WHEN OTHERS is a
      -- per-account parse guard inside the account LOOP: a malformed account is counted and named
      -- and the rest still load. A 57014 must abort the whole collect (nothing commits, the next
      -- day's begin/collect pair retries); log_pipeline_run runs after the loop, outside any handler.
      'candy_collections_discover_collect'
    );
$function$;