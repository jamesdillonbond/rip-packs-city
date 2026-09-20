-- R118 (2026-09-20, filed from Cowork cloud ~7:20 AM PT). PL/pgSQL's `EXCEPTION WHEN OTHERS`
-- does NOT catch `query_canceled` (57014) — the docs say so ("OTHERS matches every error type
-- except QUERY_CANCELED and ASSERT_FAILURE"), and it was proven on this instance minutes ago:
--   SET LOCAL statement_timeout = '1500ms'; DO $$ BEGIN BEGIN PERFORM pg_sleep(3);
--   EXCEPTION WHEN OTHERS THEN … END; END $$;            → ERROR 57014 escapes the block
--   … EXCEPTION WHEN query_canceled THEN … END; END $$;  → caught, execution continues
-- So every wrapper in this estate that promises "a killed run still lands its pipeline_runs
-- row / writes 999" is blind to the ONE failure it was written for — the statement_timeout kill.
-- Tonight's evidence: jobid 324's four kills at 600 s (:48, :31, :59, :52 slots) left
-- rpc_trust_health_precompute.topshot_impossible_parallel_serials at its 5:48 PM value (no 999,
-- no terminal `thp-leg-impossible-parallel` row — only the '-heartbeat' row); jobid 539's kill
-- at 09:36Z left no `edition-fmv-current-full-reconcile` row. Estate-wide: 49 plpgsql functions
-- use WHEN OTHERS, ONE (get_set_detail) names query_canceled, 12 explicitly claim timeout handling
-- in their own comments, and all 8 rpc_thp_leg_* functions carry the 999-on-failure pattern.
--
-- This file fixes the five UNPINNED pg_cron wrappers (same signatures ⇒ ACLs preserved) with a
-- one-token change per handler: `WHEN OTHERS` → `WHEN query_canceled OR OTHERS`. The rewrite is
-- mechanical (regexp on pg_get_functiondef, executed here) and GATED on the exact live bodies
-- read at 7:15 AM PT (md5 of prosrc asserted below), so it cannot touch a body it did not see.
-- The 8 pinned legs and the other 34 functions are R118's follow-up (three-file discipline each).
-- ⚠ That session's push tooling is its own concern; this file commits as usual.
--
-- ✅ Positive control 7:16 AM PT (one-off cron_heavy job, `SET statement_timeout = '3s'` prefix,
-- unscheduled in-session): run_thp_leg_logged wrote the terminal `thp-leg-impossible-parallel`
-- row ok=false, error '57014: canceling statement due to statement timeout', 3,024 ms, and the
-- cron run read `succeeded`; before this file the identical kill left only the heartbeat row.
-- (Two earlier attempts of that control read `job startup timeout` — a topshot_pack_sales_history
-- autovacuum and wmc's 07:08Z pass were saturating the disk; 27 startup timeouts 07:00–07:13 PT.)
--
-- EXIT: the next 600 s kill of any thp leg writes a terminal `thp-leg-*` row with ok=false and
--   error '57014: …' (the heartbeat row alone is the old symptom); the next killed reconcile /
--   precompute / matcher / portfolio run writes its ok=false row.
-- FALSIFIER: a kill that still leaves only the heartbeat ⇒ the cancel arrived outside the
--   EXECUTE (e.g. inside log_pipeline_run itself) — widen the block, do not re-litigate the catch.
-- REVERT: the reverse regexp on the same five functions (or re-apply 20260920020102 /
--   20260920022633 / 20260920023318 / 20260920054402 bodies and 20260908xxxxxx for run_thp_leg_logged).
--
-- anon-exec: intentional — same signatures, existing ACLs preserved on all five; pg_cron callers only (run_thp_leg_logged, run_edition_fmv_current_full_reconcile_job, run_match_topshot_players_full_job, run_portfolio_snapshot_job, refresh_fmv_confidence_precompute)

DO $$
DECLARE
  r record;
  v_expected jsonb := '{
    "refresh_fmv_confidence_precompute": "59e0d82f3009f3452c7407a69b401382",
    "run_edition_fmv_current_full_reconcile_job": "f74d162c1c84656f5054652444211988",
    "run_match_topshot_players_full_job": "9820139d772ad4ddb39b13926ab3e17e",
    "run_portfolio_snapshot_job": "edb3c13132c22463430f00eca547efc7",
    "run_thp_leg_logged": "f1ca7b818d9b9c4b413f35f8515564a9"
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
    v_ddl := regexp_replace(pg_get_functiondef(r.oid), 'EXCEPTION WHEN OTHERS THEN', 'EXCEPTION WHEN query_canceled OR OTHERS THEN', 'g');
    IF strpos(v_ddl, 'WHEN query_canceled OR OTHERS') = 0 THEN
      RAISE EXCEPTION 'R118: % has no WHEN OTHERS handler to rewrite', r.proname;
    END IF;
    EXECUTE v_ddl;
    v_n := v_n + 1;
  END LOOP;
  IF v_n <> 5 THEN RAISE EXCEPTION 'R118: expected 5 functions, rewrote %', v_n; END IF;
END $$;

DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO v_bad
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('run_thp_leg_logged','run_edition_fmv_current_full_reconcile_job','run_match_topshot_players_full_job','run_portfolio_snapshot_job','refresh_fmv_confidence_precompute')
    AND (p.prosrc ~ 'EXCEPTION WHEN OTHERS THEN' OR p.prosrc !~ 'WHEN query_canceled OR OTHERS');
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION 'R118: still blind to query_canceled: %', v_bad; END IF;
  IF has_function_privilege('anon', 'public.run_thp_leg_logged(regprocedure, text)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked on run_thp_leg_logged'; END IF;
  IF has_function_privilege('anon', 'public.refresh_fmv_confidence_precompute()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked on refresh_fmv_confidence_precompute'; END IF;
END $$;
