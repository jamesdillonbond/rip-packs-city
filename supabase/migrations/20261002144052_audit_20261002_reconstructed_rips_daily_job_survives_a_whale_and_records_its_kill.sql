-- audit_20261002_reconstructed_rips_daily_job_survives_a_whale_and_records_its_kill
--
-- 2026-10-02 ~7:50 AM PT (Claude Code, cloud, autonomous pass).
--
-- WHAT HAPPENED. pg_cron job rpc-wallet-reconstructed-rips (37 10 * * *, 3:37 AM PT)
-- FAILED today: "canceling statement due to statement timeout" after exactly
-- 00:02:00 — the pg_cron session default, 120 s. The run before it took 80.9 s
-- (10-01), 56.8 s (09-30), 13.6 s (09-29): the lane's input has quadrupled in three
-- days because the chain-arrival lanes are seeding pack-pull deliveries for every
-- saved wallet (+37,906 pack_pull rows across the 33 saved wallets in 72 h,
-- 78,912 total). Per-wallet cost measured today (EXPLAIN ANALYZE, BUFFERS, warm):
-- 2,862 pulls → 0.9 s / 13.7k buffers; 8,442 pulls → 2.0 s / 49.5k buffers — linear
-- in pulls, and the 3:37 AM run is COLD.
--
-- TWO DEFECTS, both in the outer function, not the per-wallet rebuild:
--   1. `SET statement_timeout TO '600s'` in the function header is INERT under
--      pg_cron (CLAUDE.md, database.md): the job was killed at the 120 s session
--      default with that clause in place. The budget has to ride on the COMMAND —
--      the same `SET statement_timeout = '600s'; SELECT …` prefix jobid 651 uses.
--   2. No handler: the kill rolled back every wallet's rewrite AND the
--      log_pipeline_run row, so pipeline_runs shows nothing for 10-02 and
--      wallet_reconstructed_rips still carries 10-01's rows for all 33 wallets.
--      A reader of pipeline_runs_daily sees a lane that simply did not run.
--
-- WHAT THIS DOES.
--   * Wallets are rebuilt SMALLEST FIRST (by pack-pull count), each inside its own
--     sub-transaction, so a budget spent on a whale costs that whale's day, not
--     everyone's.
--   * `WHEN query_canceled` is a record-and-EXIT handler (R118): the loop stops,
--     the wallets already rebuilt stay written, and log_pipeline_run records
--     ok=false with the wallet it stopped at and how many it finished. Everything
--     after the catch is bounded by construction (one log call, one RETURN) — the
--     timer is not re-armed after a catch, so nothing else may follow it.
--   * `WHEN OTHERS` on a single wallet records that wallet's error and CONTINUES —
--     one bad wallet no longer blocks the other 32.
--   * ok is DERIVED: true only when every wallet rebuilt and nothing was killed.
--   * The pg_cron command carries the 600 s budget (prefix form; the inert header
--     clause is dropped so the file does not claim a budget it cannot deliver).
--
-- NOT CHANGED: rebuild_wallet_reconstructed_rips(text) (pinned, 20260926170000) —
-- this file does not define it.
--
-- EXIT: the 10-03 3:37 AM PT run writes a pipeline_runs row (ok, or ok=false
-- naming the wallet it stopped at), and wallet_reconstructed_rips.computed_at
-- moves for every wallet that finished.
--
-- REVERT: re-apply the outer function from 20260926170000 (verbatim there) and
--   SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-wallet-reconstructed-rips'),
--                         command => 'SELECT public.rebuild_saved_wallet_reconstructed_rips();');
--
-- anon-exec: unchanged (rebuild_saved_wallet_reconstructed_rips) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege('anon', …, 'EXECUTE') = false live 2026-10-02, re-asserted below.

CREATE OR REPLACE FUNCTION public.rebuild_saved_wallet_reconstructed_rips()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  w record;
  v_res jsonb;
  v_total int := 0;
  v_wallets int := 0;
  v_failed int := 0;
  v_rows int := 0;
  v_valued int := 0;
  v_err text;
  v_stopped_at text;
  v_first_error text;
BEGIN
  SELECT count(*) INTO v_total
    FROM (SELECT DISTINCT lower(trim(wallet_addr)) FROM public.saved_wallets
           WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$') s;

  FOR w IN
    SELECT s.wallet,
           (SELECT count(*) FROM public.moment_acquisitions ma
             WHERE ma.wallet = s.wallet AND ma.acquisition_method = 'pack_pull') AS pulls
      FROM (SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
             WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$') s
     ORDER BY 2, 1
  LOOP
    BEGIN
      v_res := public.rebuild_wallet_reconstructed_rips(w.wallet);
      v_wallets := v_wallets + 1;
      v_rows := v_rows + coalesce((v_res->>'reconstructed')::int, 0);
      v_valued := v_valued + coalesce((v_res->>'valued')::int, 0);
    EXCEPTION
      WHEN query_canceled THEN
        -- record-and-exit: the budget is spent; nothing unbounded may follow
        v_stopped_at := w.wallet;
        v_err := left('statement_timeout after ' || v_wallets || ' of ' || v_total
                      || ' wallets; stopped at ' || w.wallet || ' (' || w.pulls || ' pulls): ' || SQLERRM, 300);
        EXIT;
      WHEN OTHERS THEN
        v_failed := v_failed + 1;
        v_first_error := coalesce(v_first_error, left(w.wallet || ': ' || SQLERRM, 300));
    END;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'wallet-reconstructed-rips', v_started, v_total, v_rows, v_failed,
    v_err IS NULL AND v_failed = 0,
    coalesce(v_err, v_first_error), NULL, NULL, NULL,
    jsonb_build_object('wallets', v_wallets, 'wallets_total', v_total, 'wallets_failed', v_failed,
                       'reconstructed', v_rows, 'valued', v_valued,
                       'stopped_at', v_stopped_at, 'first_error', v_first_error,
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('ok', v_err IS NULL AND v_failed = 0, 'wallets', v_wallets,
                            'wallets_total', v_total, 'wallets_failed', v_failed,
                            'reconstructed', v_rows, 'valued', v_valued,
                            'stopped_at', v_stopped_at, 'error', coalesce(v_err, v_first_error));
END;
$function$;

-- the budget rides on the command (the header SET is inert under pg_cron)
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'rpc-wallet-reconstructed-rips'),
                      command => 'SET statement_timeout = ''600s''; SELECT public.rebuild_saved_wallet_reconstructed_rips();');

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.rebuild_saved_wallet_reconstructed_rips()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rebuild_saved_wallet_reconstructed_rips()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on rebuild_saved_wallet_reconstructed_rips';
  END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'rpc-wallet-reconstructed-rips'
        AND command = 'SET statement_timeout = ''600s''; SELECT public.rebuild_saved_wallet_reconstructed_rips();'
        AND schedule = '37 10 * * *' AND active) <> 1 THEN
    RAISE EXCEPTION 'rpc-wallet-reconstructed-rips command did not take the 600 s prefix';
  END IF;
  IF (SELECT proconfig FROM pg_proc WHERE proname = 'rebuild_saved_wallet_reconstructed_rips')::text ~ 'statement_timeout' THEN
    RAISE EXCEPTION 'the inert header statement_timeout is still on the function';
  END IF;
END
$mig$;
