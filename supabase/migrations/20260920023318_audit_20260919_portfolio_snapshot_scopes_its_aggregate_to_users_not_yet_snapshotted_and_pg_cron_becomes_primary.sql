-- `daily-portfolio-snapshot` had TWO callers of `snapshot_all_user_portfolios()` a day — the
-- cron-job.org route at 07:05Z (PostgREST, ~120 s gateway) and pg_cron jobid 490 at 11:17Z — and
-- each of them re-ran the WHOLE aggregate (every saved wallet's moments out of
-- wallet_moments_cache: 5 s quiet, 45 s loaded, killed at 120 s inside an IO spell) only to have
-- `ON CONFLICT DO NOTHING` discard the rows a previous caller had already written. The retry has
-- been the one landing (27 rows/day, 09-16 → 09-19) while the route died at 07:05Z on 09-18 and
-- 09-19 and the sentinel read the day as `0/1 ok`.
--
-- Two changes, both bounded by measurement:
--
-- 1. The aggregate is SCOPED to the users who do not yet have today's row. Same result set as the
--    ON CONFLICT semantics (a user who saves their first wallet after the first run still gets a
--    row from the next), but a caller that finds the day done reads 34 buffers / 13 ms with the
--    wmc scan `never executed` (EXPLAIN 2026-09-19 7:4x PM PT against 09-19's 27 rows) instead of
--    the full pass. The function now also returns `already_snapshotted` and `candidates`, so a
--    `rows_written = 0` row from a later caller is interpretable (zero because DONE, not because
--    the aggregate found nothing). Same signature ⇒ the ACL is preserved (anon/authenticated
--    false, service_role true — the route's caller — asserted below).
--
-- 2. pg_cron becomes the PRIMARY at 06:46Z (11:46 PM PT; the quietest 06Z minute over 7 days,
--    75 busy-seconds, banned :40/:41 excluded — hour 6 is in the every-3-hours band, but the
--    measurement is what this minute has, not what the band suggests), with a `SET
--    statement_timeout = '300s'` prefix (the proconfig 120 s is inert under pg_cron; the prefix
--    binds — jobid 4 precedent). The 07:05Z route then finds the day done and returns in
--    milliseconds, so it can no longer die at the gateway on a day the primary landed; on a day
--    the primary dies in a spell the route is the first retry and jobid 490 at 11:17Z the second,
--    exactly as today. The wrapper is generalised to take the job name (`run_portfolio_snapshot_job(text)`
--    replaces `run_portfolio_snapshot_retry_job()` — a defaulted overload beside the zero-arg
--    function would make `f()` ambiguous, so it is DROPped and jobid 490's command re-pointed
--    in place; jobid preserved, asserted). Every pg_cron row still lands under the route's own
--    pipeline name with `extra.via = 'pg_cron'` and `extra.jobname` telling the two apart.
--
-- Applied from Cowork cloud 2026-09-19 7:33 PM PT (primary jobid 546; retry jobid 490 kept). ⚠ That session's push tooling is its own
-- concern; this file commits as usual.
--
-- EXIT: 11:46 PM PT tick → `pipeline_runs` row `daily-portfolio-snapshot`, via pg_cron, jobname
-- rpc-portfolio-snapshot-primary, ok, rows_written = the day's user count; the 12:05 AM PT route
-- run then logs ok with `already_snapshotted` = that count and `inserted` 0 in well under a second.
-- FALSIFIER: the route still dying at 120 s on a day the primary succeeded ⇒ the scoping did not
-- bind (re-read `pg_get_functiondef`) — the wmc scan must read `never executed` when the day is done.
-- REVERT: re-apply the function body from 20260920014230's era (the unscoped CTE — it is the
--         body above minus the NOT EXISTS clause and the two extra return keys);
--         SELECT cron.unschedule('rpc-portfolio-snapshot-primary');
--         SELECT cron.schedule('rpc-portfolio-snapshot-retry', '17 11 * * *',
--           'SELECT public.run_portfolio_snapshot_retry_job();');  -- after recreating that wrapper
--         DROP FUNCTION public.run_portfolio_snapshot_job(text);
--
-- anon-exec: intentional — snapshot_all_user_portfolios() keeps its existing ACL (same signature;
-- anon/authenticated EXECUTE false, service_role true, asserted); run_portfolio_snapshot_job(text)
-- is REVOKEd from PUBLIC, anon, authenticated below and only pg_cron as postgres calls it
-- (snapshot_all_user_portfolios, run_portfolio_snapshot_job)

CREATE OR REPLACE FUNCTION public.snapshot_all_user_portfolios()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_inserted int := 0;
  v_already  int := 0;
  v_cands    int := 0;
BEGIN
  -- Users whose row for today already exists (a previous caller landed): excluded from the
  -- aggregate, not merely from the insert. This is what makes a second call cost milliseconds.
  SELECT count(*) INTO v_already
  FROM portfolio_snapshots ps
  WHERE ps.snapshot_date = CURRENT_DATE;

  WITH user_wallets AS (
    -- All saved wallets, grouped by user — minus the users already snapshotted today
    SELECT
      sw.user_id::text AS owner_key,
      array_agg(DISTINCT sw.wallet_addr) AS wallets
    FROM saved_wallets sw
    WHERE sw.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM portfolio_snapshots ps
        WHERE ps.owner_key = sw.user_id::text
          AND ps.snapshot_date = CURRENT_DATE)
    GROUP BY sw.user_id
  ),
  portfolios AS (
    SELECT
      uw.owner_key,
      SUM(wmc.fmv_usd) AS total_fmv,
      COUNT(*) AS moment_count,
      array_length(uw.wallets, 1) AS wallet_count
    FROM user_wallets uw
    JOIN wallet_moments_cache wmc
      ON wmc.wallet_address = ANY(uw.wallets)
    WHERE wmc.fmv_usd IS NOT NULL AND wmc.fmv_usd > 0
    GROUP BY uw.owner_key, uw.wallets
  ),
  ins AS (
    INSERT INTO portfolio_snapshots (owner_key, snapshot_date, total_fmv, moment_count, wallet_count)
    SELECT
      owner_key,
      CURRENT_DATE,
      ROUND(total_fmv::numeric, 2),
      moment_count,
      wallet_count
    FROM portfolios
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_inserted FROM ins;

  SELECT count(*) INTO v_cands FROM saved_wallets sw WHERE sw.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM portfolio_snapshots ps WHERE ps.owner_key = sw.user_id::text AND ps.snapshot_date = CURRENT_DATE);

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'snapshot_date', CURRENT_DATE,
    'already_snapshotted', v_already,
    -- saved-wallet rows (not users) still without today's row AFTER this call: users with no
    -- priced moments in wallet_moments_cache legitimately stay here.
    'unsnapshotted_wallet_rows_after', v_cands);
END;
$function$;

DROP FUNCTION IF EXISTS public.run_portfolio_snapshot_retry_job();

CREATE OR REPLACE FUNCTION public.run_portfolio_snapshot_job(p_jobname text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_res     jsonb;
  v_ok      boolean := true;
  v_err     text := NULL;
  v_rows    integer := NULL;
BEGIN
  BEGIN
    v_res := public.snapshot_all_user_portfolios();
    v_rows := (v_res->>'inserted')::integer;
  EXCEPTION WHEN OTHERS THEN
    -- includes 57014 query_canceled at the prefix budget: the insert rolls back, the row below
    -- still lands, and rows_written stays NULL (unmeasured, not zero).
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run(
    'daily-portfolio-snapshot', v_started, 0, v_rows, 0, v_ok, v_err,
    p_extra => jsonb_build_object(
      'via', 'pg_cron',
      'jobname', p_jobname,
      'snapshot_date', v_res->>'snapshot_date',
      'already_snapshotted', v_res->'already_snapshotted',
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN coalesce(v_res, jsonb_build_object('ok', false, 'error', v_err));
END
$function$;

REVOKE EXECUTE ON FUNCTION public.run_portfolio_snapshot_job(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.run_portfolio_snapshot_job(text) IS
  'pg_cron wrapper for snapshot_all_user_portfolios(): jobid 490 rpc-portfolio-snapshot-retry (17 11 UTC) and rpc-portfolio-snapshot-primary (46 6 UTC, added 2026-09-19). Writes a terminal pipeline_runs row under the route''s own name, daily-portfolio-snapshot, with extra.via = pg_cron and extra.jobname = the argument. Replaces run_portfolio_snapshot_retry_job() (2026-09-19).';

SELECT cron.schedule(
  'rpc-portfolio-snapshot-retry',
  '17 11 * * *',
  $cmd$SET statement_timeout = '300s'; SELECT public.run_portfolio_snapshot_job('rpc-portfolio-snapshot-retry');$cmd$
);

SELECT cron.schedule(
  'rpc-portfolio-snapshot-primary',
  '46 6 * * *',
  $cmd$SET statement_timeout = '300s'; SELECT public.run_portfolio_snapshot_job('rpc-portfolio-snapshot-primary');$cmd$
);

DO $$
DECLARE v_id int; v_cmd text; v_user text; v_def text;
BEGIN
  SELECT jobid, command, username INTO v_id, v_cmd, v_user FROM cron.job WHERE jobname = 'rpc-portfolio-snapshot-retry';
  IF v_id IS DISTINCT FROM 490 THEN RAISE EXCEPTION 'retry jobid changed: %', v_id; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'retry owner changed: %', v_user; END IF;
  IF strpos(v_cmd, 'run_portfolio_snapshot_job(''rpc-portfolio-snapshot-retry'')') = 0 THEN RAISE EXCEPTION 'retry command not applied: %', v_cmd; END IF;

  SELECT jobid, command, username INTO v_id, v_cmd, v_user FROM cron.job WHERE jobname = 'rpc-portfolio-snapshot-primary';
  IF v_id IS NULL THEN RAISE EXCEPTION 'primary not scheduled'; END IF;
  IF v_user <> 'postgres' THEN RAISE EXCEPTION 'primary owner: %', v_user; END IF;
  IF strpos(v_cmd, 'run_portfolio_snapshot_job(''rpc-portfolio-snapshot-primary'')') = 0 THEN RAISE EXCEPTION 'primary command not applied: %', v_cmd; END IF;

  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'run_portfolio_snapshot_retry_job') THEN RAISE EXCEPTION 'old wrapper survived'; END IF;

  IF has_function_privilege('anon', 'public.run_portfolio_snapshot_job(text)', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (wrapper)'; END IF;
  IF has_function_privilege('anon', 'public.snapshot_all_user_portfolios()', 'EXECUTE') THEN RAISE EXCEPTION 'anon EXECUTE leaked (snapshot fn)'; END IF;
  IF has_function_privilege('authenticated', 'public.snapshot_all_user_portfolios()', 'EXECUTE') THEN RAISE EXCEPTION 'authenticated EXECUTE leaked (snapshot fn)'; END IF;
  IF NOT has_function_privilege('service_role', 'public.snapshot_all_user_portfolios()', 'EXECUTE') THEN RAISE EXCEPTION 'service_role lost EXECUTE — the route would break'; END IF;

  v_def := pg_get_functiondef('public.snapshot_all_user_portfolios()'::regprocedure);
  IF strpos(v_def, 'ps.snapshot_date = CURRENT_DATE') = 0 THEN RAISE EXCEPTION 'scoping not applied'; END IF;
END $$;
