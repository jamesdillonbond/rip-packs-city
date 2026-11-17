-- audit_20260828_rwfc_revert_freshness_guarded_fast_path
--
-- REVERT of 20260826143452_audit_20260826_rwfc_freshness_guarded_edition_fmv_current.sql,
-- restoring the body from 20260822213000_audit_20260822_rwfc_temp_build_materialized_cte.sql
-- VERBATIM (extracted from that file programmatically, not retyped).
--
-- WHY. The fast path shipped with an explicitly PRE-REGISTERED exit condition:
-- "re-read in a quiet window >= 24 h out; if reads are still not below the T1
-- per-call figures (74,159 cron / 7,195 PostgREST) the fast path is not paying for
-- itself and should be reverted."  That reading was taken 2026-08-28 and it FAILS
-- on both callers. Measured as a FLOW (delta between the T1_CLEAN snapshot in
-- public._rpc_waste_baseline_20260825 and now, divided by calls in the interval),
-- never as a per-call figure off a cumulative stock:
--
--   caller       n     reads/call   threshold   verdict
--   pg_cron      143      87,352      74,159    +17.8%  FAILS
--   PostgREST    222      10,029       7,195    +39.4%  FAILS
--
-- Independently re-derived 2026-08-28 05:05Z from a second, later window
-- (cron n=160 -> 89,696; PostgREST n=250 -> 10,997) on a quiet instance
-- (1 active backend, 0 IO waiters). pg_stat_statements has not been reset since
-- 2026-08-12, and call counts are monotonic across both snapshots, so the deltas
-- are valid. The CONFOUNDED and CLEAN windows AGREE (86,533 -> 87,352 cron;
-- 10,472 -> 10,029 PostgREST), which is what rules out the index churn that made
-- the first attempt at this measurement unusable.
--
-- IT IS A GENUINE TWO-RESOURCE TRADE: ~26.5% less wall time (297.4 s -> 218.5 s
-- per call) for ~18.5% more disk reads. Reads are the right exit metric because
-- this instance's saturation is IO-bound, not CPU-bound, and that metric was
-- chosen by the fast path's own author BEFORE the result was known.
--
-- REVERTING COSTS NO CORRECTNESS. The freshness guard was scaffolding for the
-- optimisation, not an independent improvement: the 08-26 migration header states
-- that rows failing the guard "fall through to the incumbent subquery and are
-- computed exactly as before". The body restored here reads fmv_snapshots directly
-- and is inherently fresh.
--
-- COORDINATED LANDING (this is a registered DB-invariant pin):
--   1. this migration
--   2. supabase/tests/refresh_wmc_fmv_changed.sql updated to the restored body
--   3. the PINS entry moved with it
--   4. npm run db:pins:check clean, migration-parity green
--
-- Revert-the-revert: re-apply
-- 20260826143452_audit_20260826_rwfc_freshness_guarded_edition_fmv_current.sql.

-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged (refresh_wmc_fmv_changed) — this is a CREATE OR REPLACE of an
-- EXISTING function, and CREATE OR REPLACE does not reset a function ACL, so adding a
-- REVOKE here would be a production ACL change dressed up as a no-op. The marker is the
-- correct form for a snapshot/revert migration.
-- Verified live 2026-08-28, AFTER this body was applied, via has_function_privilege:
--   anon = false, authenticated = false, service_role = true.

CREATE OR REPLACE FUNCTION public.refresh_wmc_fmv_changed(p_since_minutes integer DEFAULT 30, p_limit integer DEFAULT 50000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total      integer := 0;
  v_batch      integer;
  v_cutoff     timestamptz;
  v_new_cutoff timestamptz;
  v_run_start  timestamptz := clock_timestamp();
  v_timeout_ms bigint;
  v_budget     interval;
  v_deadline   timestamptz;
  -- Sized to fit the SMALLEST caller budget (service_role 30s), never scaled up.
  v_chunk      constant integer := 5;
BEGIN
  SELECT setting::bigint INTO v_timeout_ms FROM pg_settings WHERE name = 'statement_timeout';

  IF v_timeout_ms IS NULL OR v_timeout_ms = 0 THEN
    v_budget := interval '300 seconds';
  ELSE
    v_budget := GREATEST(make_interval(secs => (v_timeout_ms / 1000.0) * 0.6),
                         interval '5 seconds');
  END IF;
  v_deadline := clock_timestamp() + v_budget;

  SELECT last_cutoff INTO v_cutoff FROM public.rwfc_state WHERE id = 1;
  IF v_cutoff IS NULL THEN
    v_cutoff := v_run_start - make_interval(mins => GREATEST(p_since_minutes, 1));
  END IF;

  DROP TABLE IF EXISTS _rwfc_recent;
  -- The filter is wrapped in a MATERIALIZED CTE so the planner cannot use
  -- fmv_snapshots_2026_edition_id_computed_at_idx to supply DISTINCT ON's ordering
  -- for free. That index leads on edition_id while the predicate is on computed_at,
  -- so there is no range to seek and the whole 2026 index is walked -- on a 418x row
  -- overestimate. Materialising first removes the ordering incentive; the planner
  -- then seeks idx_fmv_snapshots_2026_computed_at_desc and pays a tiny quicksort.
  -- Measured 2026-08-22, warm-vs-warm, same 563 output rows: 8,402 buffers / 471 ms
  -- as written vs 29 buffers / 0.98 ms wrapped. Output diffed with EXCEPT in BOTH
  -- directions: 0 rows only-in-incumbent, 0 rows only-in-candidate.
  CREATE TEMP TABLE _rwfc_recent ON COMMIT DROP AS
  WITH recent AS MATERIALIZED (
    SELECT fs.edition_id, fs.computed_at
    FROM public.fmv_snapshots fs
    WHERE fs.computed_at > v_cutoff
      AND fs.fmv_usd IS NOT NULL
  )
  SELECT DISTINCT ON (r.edition_id) r.edition_id, r.computed_at
  FROM recent r
  ORDER BY r.edition_id, r.computed_at DESC;
  CREATE INDEX ON _rwfc_recent (computed_at);
  ANALYZE _rwfc_recent;

  LOOP
    WITH popped AS (
      DELETE FROM _rwfc_recent
       WHERE edition_id IN (
         SELECT edition_id FROM _rwfc_recent ORDER BY computed_at LIMIT v_chunk
       )
      RETURNING edition_id
    ),
    latest_fmv AS MATERIALIZED (
      SELECT e.collection_id, e.external_id,
        (SELECT f.fmv_usd
           FROM public.fmv_snapshots f
          WHERE f.edition_id = e.id
            AND f.fmv_usd IS NOT NULL
          ORDER BY f.computed_at DESC
          LIMIT 1) AS fmv_usd
      FROM popped p
      JOIN public.editions e ON e.id = p.edition_id
    ),
    updated AS (
      UPDATE public.wallet_moments_cache wmc
         SET fmv_usd = lf.fmv_usd
        FROM latest_fmv lf
       WHERE wmc.collection_id = lf.collection_id
         AND wmc.edition_key   = lf.external_id
         AND wmc.edition_key IS NOT NULL
         AND lf.fmv_usd IS NOT NULL
         AND wmc.fmv_usd IS DISTINCT FROM lf.fmv_usd
      RETURNING 1
    )
    SELECT COUNT(*)::int INTO v_batch FROM updated;

    v_total := v_total + COALESCE(v_batch, 0);

    EXIT WHEN NOT EXISTS (SELECT 1 FROM _rwfc_recent);
    EXIT WHEN clock_timestamp() > v_deadline;
    EXIT WHEN v_total >= p_limit;
  END LOOP;

  SELECT MIN(computed_at) - interval '1 microsecond' INTO v_new_cutoff FROM _rwfc_recent;
  v_new_cutoff := COALESCE(v_new_cutoff, v_run_start);

  INSERT INTO public.rwfc_state (id, last_cutoff) VALUES (1, v_new_cutoff)
  ON CONFLICT (id) DO UPDATE SET last_cutoff = EXCLUDED.last_cutoff;

  RETURN v_total;
END;
$function$;
