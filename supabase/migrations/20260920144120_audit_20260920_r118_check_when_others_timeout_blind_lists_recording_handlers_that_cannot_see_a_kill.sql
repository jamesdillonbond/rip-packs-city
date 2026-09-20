-- R118 instrument (2026-09-20 ~8:45 AM PT, Cowork cloud). After three batches (20260920140611,
-- the sixteen-unpinned and the fourteen-pinned files) every RECORDING handler in the estate
-- names query_canceled. This function keeps it that way: it lists plpgsql functions in public
-- whose EXCEPTION WHEN OTHERS handler sits in a body that claims to record failures
-- (log_pipeline_run / pipeline_runs insert / a 999 sentinel / statement_timeout, 57014) and
-- that never names query_canceled — i.e. a wrapper that will silently lose its row on the next
-- statement_timeout kill. The deliberate swallow-and-continue loops (a cancel caught inside a
-- per-item loop would run on past its budget) are excluded by name; add to the list ONLY with
-- the loop argument written in the migration that adds it.
--
-- Health shape: returns [] when clean (a jsonb array, like check_secdef_anon_exec_drift) — read
-- the payload, never count(*) of the one row. Wire: the nightly pass's security-invariants block.
-- Control 8:45 AM PT: the first apply of this file RAISED on collect_pack_nft_identity — a
-- `WHEN others THEN v_body := NULL` JSON-parse guard inside its per-request loop that the hand
-- classification had missed — which is the instrument catching what the sweep did not; it is
-- added to the loop list below with that reason. [] after that.
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
-- REVERT: DROP FUNCTION public.check_when_others_timeout_blind();
--
-- anon-exec: intentional — REVOKEd from PUBLIC, anon, authenticated below; service_role / postgres only, a catalog read (check_when_others_timeout_blind)

CREATE OR REPLACE FUNCTION public.check_when_others_timeout_blind()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'kind', 'when_others_handler_blind_to_query_canceled',
           'function', p.proname,
           'handlers', (SELECT count(*) FROM regexp_matches(p.prosrc, 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN', 'gi')),
           'detail', 'PL/pgSQL WHEN OTHERS excludes QUERY_CANCELED: a statement_timeout kill escapes this handler and the row/sentinel it promises is never written. Use WHEN query_canceled OR OTHERS for record-and-exit handlers; if this handler sits in a per-item loop, add the function to the exclusion list with the loop argument.'
         ) ORDER BY p.proname), '[]'::jsonb)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
    AND p.prosrc ~* 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN'
    AND p.prosrc !~* 'WHEN\s+query_canceled'
    AND p.prosrc ~* 'log_pipeline_run|pipeline_runs|999|statement_timeout|57014|query_canceled'
    AND p.proname NOT IN (
      -- swallow-and-continue loops, classified 2026-09-20 (R118 batch two header), plus
      -- collect_pack_nft_identity (a JSON-parse guard inside its per-request loop):
      'atlas_editions_drain', 'atlas_market_drain', 'bulk_insert_pinnacle_sales',
      'public_board_liveness_sweep', 'reconcile_all_seeded_wallet_stats',
      'refresh_series_detail_rollup', 'remap_topshot_wmc_from_onchain_map', 'analytics_smoke_run',
      'resolve_moment_id', 'submit_allow_list_request', 'roll_pack_ask_hourly_low',
      'collect_pack_nft_identity'
    );
$function$;

REVOKE EXECUTE ON FUNCTION public.check_when_others_timeout_blind() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_when_others_timeout_blind() TO service_role;

COMMENT ON FUNCTION public.check_when_others_timeout_blind() IS
  'R118 (2026-09-20): lists plpgsql functions whose WHEN OTHERS handler claims to record failures but cannot see a statement_timeout kill (query_canceled is excluded from OTHERS). [] = clean. Part of the nightly security/structural invariants block.';

DO $$
DECLARE v jsonb;
BEGIN
  v := public.check_when_others_timeout_blind();
  IF jsonb_array_length(v) <> 0 THEN
    RAISE EXCEPTION 'R118: handlers still blind after the three batches: %', v;
  END IF;
  IF has_function_privilege('anon', 'public.check_when_others_timeout_blind()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked'; END IF;
END $$;
