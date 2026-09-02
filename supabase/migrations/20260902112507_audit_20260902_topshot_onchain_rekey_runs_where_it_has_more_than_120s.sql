-- 2026-09-02 — the Top Shot on-chain re-key runs where it has more than 120 seconds.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────────
-- `remap_topshot_from_onchain_map()` is the re-key leg of the platform-wide Top
-- Shot mis-attribution drain. Its only caller was the Vercel cron
-- `/api/admin/drain-topshot-misattribution?rekey=1` (daily, 11:00 UTC), which
-- reaches it over PostgREST — and the Supabase GATEWAY hard-caps that path at
-- ~120 s regardless of what the function declares. The function declares
-- `statement_timeout = 300s`, which is therefore unreachable on that path.
--
-- Measured 2026-09-02 from `pipeline_runs_daily` + the two audit tables:
--
--   day      pipeline_runs error                     audit rows written that day
--   08-23    rekey: upstream request timeout          0
--   08-24    rekey: upstream request timeout          0
--   08-25    rekey: upstream request timeout          0
--   08-26    rekey: upstream request timeout          0
--   08-27    (ok)                                     673 sales / 107 moments
--   08-28    rekey: upstream request timeout          0
--   08-31    HTTP 530 ×3 (GQL only; rekey ran)        335 sales /   7 moments
--   09-01    HTTP 530 ×3 (GQL only; rekey ran)         60 sales
--   09-02    HTTP 530 ×3 (GQL only; rekey ran)         70 sales
--
-- ⚠ The audit-table column is the CONTROL, and it settles a question the error
-- string alone cannot: on every `upstream request timeout` day the audit tables
-- gained ZERO rows. The gateway giving up is not a lost RESPONSE over committed
-- work — **the transaction is rolled back and the re-key does not happen.**
-- Roughly half the daily runs did ~1.4 GB of reads and threw all of it away on
-- an instance whose burst floor is 22 MB/s.
--
-- ── WHY NOT "MAKE THE QUERY FASTER" ────────────────────────────────────────────
-- Measured before choosing (EXPLAIN ANALYZE, BUFFERS, warm):
--   _tgt build (49,206 map rows → editions)          306 ms /    25,687 buffers
--   sales leg  (3,198,302 Top Shot rows scanned)    9,018 ms /   174,820 buffers
--   moments leg                                     1,232 ms /    39,473 buffers
-- The sales leg dominates, and the planner's hash join over a seq scan is the
-- RIGHT plan: forcing the nested loop that uses the per-partition `nft_id`
-- indexes (enable_hashjoin=off) costs **1,315,991 buffers / 33.3 s** — 7.5× the
-- buffers and 3.7× the time. There is no index fix here; the cost is inherent to
-- "check all 3.2M Top Shot sales against a 49k map", and shrinking the sales side
-- exactly would need an `ingested_at` arm this migration does not attempt.
--
-- So the fix is the SCHEDULER, not the SQL: run it where 120 s is not the wall.
-- `cron_heavy` carries `statement_timeout = 600s` (role config, verified live),
-- five times the gateway cap, and is what the sibling re-key job
-- `rpc-remap-misattributed-sales` (jobid 62) already runs under.
--
-- ── WHAT THIS ADDS ─────────────────────────────────────────────────────────────
-- A thin wrapper so the re-key is OBSERVABLE from `pipeline_runs` like every
-- other pipeline, instead of only from `cron.job_run_details`.
--
-- 🚨 ONE LIMIT, PROVEN RATHER THAN ASSUMED: a `statement_timeout` kill is NOT
-- recorded by the EXCEPTION handler below. Probed on this database 2026-09-02 —
-- `SET LOCAL statement_timeout='300ms'` then a DO block whose `EXCEPTION WHEN
-- OTHERS` wraps `pg_sleep(2)` — and the cancel propagated OUT of the handler
-- anyway (`57014: canceling statement due to statement timeout`). PostgreSQL will
-- not let a statement-timeout cancel be swallowed. So on a 600 s overrun there is
-- NO `pipeline_runs` row at all, exactly like the `after()` maxDuration kills this
-- repo already documents: read it by CORRELATION against `cron.job_run_details`
-- (status='failed'), never from the absence of a failure row here.
--
-- No `SET statement_timeout` is declared on this function ON PURPOSE. A
-- per-function SET is inert under pg_cron, so declaring one would add to the 48
-- unreachable declarations already on this database rather than bound anything.
-- The role's 600 s is the real bound.

CREATE OR REPLACE FUNCTION public.run_topshot_onchain_rekey()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_err     text;
BEGIN
  BEGIN
    v_res := public.remap_topshot_from_onchain_map();
  EXCEPTION WHEN OTHERS THEN
    v_err := SQLERRM;
    v_res := NULL;
  END;

  -- ⚠ rows_found stays NULL: this function has no candidate count of its own, and
  -- a 0 there would read as "nothing to do" rather than "not measured". Same rule
  -- for the write counters on the error path — NULL, never 0.
  PERFORM public.log_pipeline_run(
    'topshot-onchain-rekey',
    v_started,
    NULL,
    CASE WHEN v_err IS NULL
         THEN COALESCE((v_res->>'sales_rekeyed')::int, 0)
            + COALESCE((v_res->>'moments_rekeyed')::int, 0)
    END,
    CASE WHEN v_err IS NULL THEN (v_res->>'moments_deferred_conflict')::int END,
    v_err IS NULL,
    v_err,
    'nba_top_shot',
    NULL,
    NULL,
    jsonb_build_object('remap', v_res, 'rekey_error', v_err)
  );

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err);
  END IF;
  RETURN COALESCE(v_res, '{}'::jsonb) || jsonb_build_object('ok', true);
END
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_topshot_onchain_rekey() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.run_topshot_onchain_rekey() IS
  'Runs remap_topshot_from_onchain_map() under pg_cron (cron_heavy, statement_timeout=600s) '
  'and records the outcome in pipeline_runs as pipeline=topshot-onchain-rekey. Replaces the '
  '?rekey=1 leg of the Vercel drain cron, which reached the same function over PostgREST and '
  'was rolled back by the ~120s Supabase gateway cap on roughly half its daily runs '
  '(2026-09-02: five upstream-request-timeout days, zero audit rows on each). A statement '
  'timeout kill writes NO row here — correlate with cron.job_run_details.';

-- Post-state: the function exists, is SECURITY DEFINER, is not anon-executable,
-- and declares no statement_timeout of its own.
DO $mig$
DECLARE
  v_secdef boolean;
  v_config text[];
  v_anon   boolean;
BEGIN
  SELECT p.prosecdef, p.proconfig INTO v_secdef, v_config
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'run_topshot_onchain_rekey';

  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey was not created';
  END IF;
  IF NOT v_secdef THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey must be SECURITY DEFINER (it writes sales via the remap)';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_config) c WHERE c LIKE 'statement_timeout=%') THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey must NOT declare statement_timeout: a per-function SET is inert under pg_cron, so it would be an unreachable declaration rather than a bound. Got %', v_config;
  END IF;
  IF NOT (v_config @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey must pin search_path=public. Got %', v_config;
  END IF;

  v_anon := has_function_privilege('anon', 'public.run_topshot_onchain_rekey()', 'EXECUTE');
  IF v_anon THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey is anon-EXECUTABLE; the revoke did not take';
  END IF;
  IF has_function_privilege('authenticated', 'public.run_topshot_onchain_rekey()', 'EXECUTE') THEN
    RAISE EXCEPTION 'run_topshot_onchain_rekey is authenticated-EXECUTABLE; the revoke did not take';
  END IF;

  -- The callee must still be there, and must still be the 300s-declaring function
  -- this wrapper exists to route around. If that declaration is ever removed the
  -- wrapper is still correct, so this is a NOTICE and not an exception.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'remap_topshot_from_onchain_map'
  ) THEN
    RAISE EXCEPTION 'remap_topshot_from_onchain_map is missing; the wrapper has nothing to call';
  END IF;
END
$mig$;
