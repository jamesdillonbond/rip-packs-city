-- R118, second batch (2026-09-20 ~8:15 AM PT, Cowork cloud). `EXCEPTION WHEN OTHERS` does not
-- catch query_canceled (57014) — see 20260920140611 for the proof and the first five wrappers.
-- This file rewrites the SIXTEEN remaining UNPINNED functions whose handler RECORDS the failure
-- and EXITS (sets v_err / v_ok := false / writes a pipeline_runs row or a 999 sentinel, then
-- returns) — the shape where catching the cancel is strictly better: the row lands instead of
-- the run vanishing into cron.job_run_details. Same one-token change per handler:
-- `WHEN OTHERS` → `WHEN query_canceled OR OTHERS`, mechanical regexp on pg_get_functiondef,
-- gated on the md5 of each live body read at 8:05 AM PT.
--
-- Classified and deliberately LEFT on `WHEN OTHERS` (a cancel caught inside a per-item loop
-- would let the loop run on past its budget with the timer already spent):
--   atlas_editions_drain (2 handlers in page/request loops) · atlas_market_drain (request loop) ·
--   bulk_insert_pinnacle_sales (row loop) · public_board_liveness_sweep (per-board loop with its
--   own p_budget_ms) · reconcile_all_seeded_wallet_stats (wallet loop, soft deadline) ·
--   refresh_series_detail_rollup (handler precedes a per-collection loop) ·
--   remap_topshot_wmc_from_onchain_map (NULL-swallow in a loop) · analytics_smoke_run (10
--   per-check handlers) · resolve_moment_id, submit_allow_list_request, mcp_compute_pack_ev,
--   mcp_get_badge_data, roll_pack_ask_hourly_low (parse / API guards, no run record at stake).
-- The 14 PINNED functions (8 rpc_thp_leg_* + refresh_allday_badge_low_ask,
-- refresh_golazos_badge_low_ask, refresh_insights_new_collectors,
-- refresh_topshot_special_serial_owners_mv, run_topshot_onchain_rekey, refresh_atlas_pack_ev)
-- take the literal-DDL route with their pins in 20260920143959 (next file).
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- EXIT: check_when_others_timeout_blind() (20260920144120, this pass) lists none of these 16.
-- REVERT: reverse regexp on the same sixteen names.
--
-- anon-exec: intentional — same signatures, existing ACLs preserved on all sixteen; pg_cron / service_role callers only (atlas_listing_verify_tick, check_topshot_dupe_sales, hydrate_topshot_moments_from_wmc, prune_topshot_atlas_market_events, reconcile_saved_wallets_wmc_fmv, rekey_topshot_wmc_parallels, rpc_wmc_metadata_selfheal, rpc_wmc_selfheal_recent, run_populate_pinnacle_wmc_fmv_job, run_price_snapshots_hourly_job, run_refresh_pack_grail_metrics_mv_job, sync_sales_from_atlas, topshot_moment_hydrate_tick, topshot_resolve_unmapped_via_atlas, record_instance_load_series, rpc_trust_health_precompute_refresh)

DO $$
DECLARE
  r record;
  v_expected jsonb := '{
    "atlas_listing_verify_tick": "7a9775159c8648d474c8167581b7fd2a",
    "check_topshot_dupe_sales": "a87ad08e2e609879fac1cdd669ece797",
    "hydrate_topshot_moments_from_wmc": "15575b86a160045c8c1db63dfa4e8b0c",
    "prune_topshot_atlas_market_events": "feed45873c02e80eb4e111d38199743f",
    "reconcile_saved_wallets_wmc_fmv": "7cd19d589b419f7401685fef1adddc0c",
    "rekey_topshot_wmc_parallels": "82b049fd5386fe53d44b84e5b40bcfb3",
    "rpc_wmc_metadata_selfheal": "b1f446be4037d157faf932fc7d0bb04a",
    "rpc_wmc_selfheal_recent": "faa2c2ce89d996c9892dfaa0d4017079",
    "run_populate_pinnacle_wmc_fmv_job": "4815d35d08632e57e1bd3707f16aa5f6",
    "run_price_snapshots_hourly_job": "644a7c202149825eee5b82f5e93c60f0",
    "run_refresh_pack_grail_metrics_mv_job": "4c7535ab5de12875511e86f22e2d32f0",
    "sync_sales_from_atlas": "042d62ad9676dc83aef15f4e43fd44c1",
    "topshot_moment_hydrate_tick": "ca17a8eb9a175c29b76bca3c17c046cc",
    "topshot_resolve_unmapped_via_atlas": "4f406227dff4b44359b5dfe302a710ce",
    "record_instance_load_series": "3b6b41715ff302b024140fff34e109fe",
    "rpc_trust_health_precompute_refresh": "e9f3d5efcfd678ddbd74f18521983975"
  }'::jsonb;
  v_ddl text;
  v_n int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, md5(p.prosrc) AS m
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (SELECT jsonb_object_keys(v_expected))
  LOOP
    IF r.m <> (v_expected ->> r.proname) THEN
      RAISE EXCEPTION 'R118: % body changed since it was read (md5 % vs expected %) — re-read before rewriting', r.proname, r.m, v_expected ->> r.proname;
    END IF;
    v_ddl := regexp_replace(pg_get_functiondef(r.oid), 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN', 'EXCEPTION WHEN query_canceled OR OTHERS THEN', 'g');
    IF strpos(v_ddl, 'WHEN query_canceled OR OTHERS') = 0 THEN
      RAISE EXCEPTION 'R118: % has no WHEN OTHERS handler to rewrite', r.proname;
    END IF;
    EXECUTE v_ddl;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 16 THEN RAISE EXCEPTION 'R118: expected 16 functions, rewrote %', v_n; END IF;
END $$;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('atlas_listing_verify_tick','check_topshot_dupe_sales','hydrate_topshot_moments_from_wmc','prune_topshot_atlas_market_events','reconcile_saved_wallets_wmc_fmv','rekey_topshot_wmc_parallels','rpc_wmc_metadata_selfheal','rpc_wmc_selfheal_recent','run_populate_pinnacle_wmc_fmv_job','run_price_snapshots_hourly_job','run_refresh_pack_grail_metrics_mv_job','sync_sales_from_atlas','topshot_moment_hydrate_tick','topshot_resolve_unmapped_via_atlas','record_instance_load_series','rpc_trust_health_precompute_refresh')
    AND (p.prosrc ~* 'EXCEPTION\s+WHEN\s+OTHERS\s+THEN' OR p.prosrc !~ 'WHEN query_canceled OR OTHERS');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'R118: still blind to query_canceled: %', v_bad; END IF;
END $$;
