-- 2026-11-02 (#227) — portfolio_snapshots stops persisting a PARTIAL read as the day's fact.
--
-- Measured: in 60 days, 13 owner-days whose moment_count fell below HALF of that owner's previous
-- snapshot (within 3 days); 8 of the 9 Sunday cases (10-05, 10-12, 10-19, 10-26) were back to full
-- the next day — e.g. 356 moments between 3,164 and 3,167. The weekly movers email then read
-- "+990.9 %" off one. A snapshot is a published fact (portfolio history chart, movers email).
--
-- Rule: an owner whose count would drop below 50 % of their most recent snapshot in the previous
-- 3 days (that snapshot >= 20 moments) is HELD — no row today. Later callers the same day (the
-- 07:05 UTC route, the 11:17 UTC retry) try again. A genuine sell-off is accepted once no
-- pre-drop snapshot is left in the 3-day window, so the hold is at most 3 days. A missing day
-- is honest; the movers reader already needs a like-for-like prior (20261102194500).
-- Returns held_partial (owners held this call) beside the existing keys.
--
-- Also: the primary moves 06:46 -> 07:01 UTC. 06:46 sat inside the nightly window where
-- recalc_ultimate_fmv (06:45) publishes a value the thin-sales guard (fmv-recalc, 06:48) reverses
-- on ~14 ULTIMATE editions (avg 2.7x), and wmc's 10-minute FMV refresh can carry it.
--
-- Revert: re-apply the body from 20260920023318_audit_20260919_portfolio_snapshot_scopes_its_aggregate_to_users_not_yet_snapshotted_and_pg_cron_becomes_primary.sql
--         and SELECT cron.schedule('rpc-portfolio-snapshot-primary', '46 6 * * *', <same command>).
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
  v_held     int := 0;
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
  judged AS (
    SELECT p.*,
      (pr.moment_count IS NOT NULL AND pr.moment_count >= 20
        AND p.moment_count < pr.moment_count * 0.5) AS held
    FROM portfolios p
    LEFT JOIN LATERAL (
      SELECT ps.moment_count
      FROM portfolio_snapshots ps
      WHERE ps.owner_key = p.owner_key
        AND ps.snapshot_date BETWEEN CURRENT_DATE - 3 AND CURRENT_DATE - 1
      ORDER BY ps.snapshot_date DESC
      LIMIT 1
    ) pr ON true
  ),
  ins AS (
    INSERT INTO portfolio_snapshots (owner_key, snapshot_date, total_fmv, moment_count, wallet_count)
    SELECT
      owner_key,
      CURRENT_DATE,
      ROUND(total_fmv::numeric, 2),
      moment_count,
      wallet_count
    FROM judged
    WHERE NOT held
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT COUNT(*) FROM ins), (SELECT COUNT(*) FROM judged WHERE held)
    INTO v_inserted, v_held;

  SELECT count(*) INTO v_cands FROM saved_wallets sw WHERE sw.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM portfolio_snapshots ps WHERE ps.owner_key = sw.user_id::text AND ps.snapshot_date = CURRENT_DATE);

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'snapshot_date', CURRENT_DATE,
    'already_snapshotted', v_already,
    -- owners whose count fell below half their last snapshot: no row this call (retried later)
    'held_partial', v_held,
    -- saved-wallet rows (not users) still without today's row AFTER this call: users with no
    -- priced moments in wallet_moments_cache, and held owners, stay here.
    'unsnapshotted_wallet_rows_after', v_cands);
END;
$function$;

-- anon-execute decision: REVOKED — a writer for scheduled callers only (unchanged grants).
REVOKE ALL ON FUNCTION public.snapshot_all_user_portfolios() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.snapshot_all_user_portfolios() TO service_role;

SELECT cron.schedule('rpc-portfolio-snapshot-primary', '1 7 * * *',
  $cmd$SET statement_timeout = '300s'; SELECT public.run_portfolio_snapshot_job('rpc-portfolio-snapshot-primary');$cmd$);

-- The job wrapper reports held_partial in pipeline_runs.extra (a hold is visible, not silent).
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
  EXCEPTION WHEN query_canceled OR OTHERS THEN
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
      'held_partial', v_res->'held_partial',
      'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN coalesce(v_res, jsonb_build_object('ok', false, 'error', v_err));
END
$function$;
REVOKE ALL ON FUNCTION public.run_portfolio_snapshot_job(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_portfolio_snapshot_job(text) TO service_role;
