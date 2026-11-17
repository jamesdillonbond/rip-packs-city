-- audit_20260904_saved_wallet_wmc_fmv_reconcile_closes_the_drains_miss_rate
-- Applied to prod via MCP apply_migration 2026-09-04 05:58Z (version 20260904055844).
--
-- FINDING (2026-09-04, the 200-Moment RPC-vs-Top-Shot audit, then measured platform-wide): the
-- wmc.fmv_usd drain (refresh_wmc_fmv_changed, jobid 303) is LOSSY. 1,369 of 15,175 Top Shot rows in
-- the founder wallet (9.0%) and 15,027 of 160,209 rows across the other 20 saved wallets (9.4%)
-- held an fmv_usd that was NOT the edition's current FMV; 403 / 4,464 of those were >5% off. All 61
-- holder rows of 227:7574 read $11.50 (the 08-28 snapshot) while every snapshot since 08-29 said
-- $12.58 and since 09-02 $12.80; the moment page (edition_fmv_current) and the collection tab (wmc)
-- disagreed on the same Moment. Misses cluster 08-29 → 09-02 (100+/day) but exist every day.
-- MECHANISM (best supported): the drain's 08-30 "unchanged" skip drops an edition whose newest
-- snapshot equals the previous one on the premise that wmc already holds that value — false
-- whenever another writer put a different value there: the wallet seed's
-- `fmv_usd = EXCLUDED.fmv_usd` (fmv_current at seed time), a re-index, a rolled-back tick. Once a
-- row is wrong and the price stops moving, nothing revisits it.
-- FIX: reconcile per SAVED WALLET from the wallet's own rows (idx on wallet_address) against
-- edition_fmv_current — cost proportional to the wallet, never to the 2.5M-row table. Measured on
-- the 19,403-Moment founder wallet: ~20K buffers / 4 s cold on the read; 8,467 rows rewritten
-- (fmv and/or the lagging fmv_confidence denorm). First cron tick: 5 wallets, 5,583 rows, 20.9 s.
-- The tick logs `wmc-fmv-reconcile-saved` with per-wallet counts in `extra.fixed_by_wallet` — the
-- drain's miss rate is now an instrument.
-- anon-exec: no — reconcile_wmc_fmv_for_wallet and reconcile_saved_wallets_wmc_fmv are writers;
--   REVOKE … FROM PUBLIC, anon, authenticated; GRANT postgres, service_role, cron_heavy.
-- ⚠ The cron job runs as cron_heavy (600 s statement_timeout). `UPDATE cron.job SET username` and
--   `cron.alter_job(username =>)` are both refused from apply_migration (not superuser); the job
--   was (re)scheduled from a `SET ROLE cron_heavy` execute_sql session: jobid 446, '6,36 * * * *'.
--   The cron.schedule line below therefore lands as `postgres` on a fresh database — re-do the
--   SET ROLE step by hand.
-- REVERT: SELECT cron.unschedule('rpc-wmc-fmv-reconcile-saved'); DROP FUNCTION
--   public.reconcile_saved_wallets_wmc_fmv(integer), public.reconcile_wmc_fmv_for_wallet(text);
--   DROP TABLE public.wmc_fmv_reconcile_state. (The rewritten wmc rows are the CORRECT values —
--   there is nothing to put back.)

-- Per-wallet reconcile: every wmc row of ONE wallet whose fmv_usd disagrees with the edition's
-- CURRENT FMV is rewritten (and the lagging fmv_confidence denorm brought along). Drives from the
-- wallet's own rows (idx on wallet_address), so the cost is proportional to the wallet, never to the
-- 2.5M-row table. Measured on the 19,403-Moment founder wallet: ~20K buffers / 4 s cold, 1,844 fixes.
CREATE OR REPLACE FUNCTION public.reconcile_wmc_fmv_for_wallet(p_wallet text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_n integer;
BEGIN
  WITH fixed AS (
    UPDATE public.wallet_moments_cache w
       SET fmv_usd        = l.fmv_usd,
           fmv_confidence = l.confidence
      FROM public.editions e
      JOIN public.edition_fmv_current l ON l.edition_id = e.id
     WHERE w.wallet_address = lower(p_wallet)
       AND w.edition_key IS NOT NULL
       AND e.external_id   = w.edition_key
       AND e.collection_id = w.collection_id
       AND l.fmv_usd IS NOT NULL
       AND (w.fmv_usd IS DISTINCT FROM l.fmv_usd OR w.fmv_confidence IS DISTINCT FROM l.confidence)
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM fixed;
  RETURN COALESCE(v_n, 0);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_wmc_fmv_for_wallet(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_wmc_fmv_for_wallet(text) TO postgres, service_role, cron_heavy;

CREATE TABLE IF NOT EXISTS public.wmc_fmv_reconcile_state (
  wallet_address text PRIMARY KEY,
  last_run_at    timestamptz NOT NULL DEFAULT now(),
  last_fixed     integer NOT NULL DEFAULT 0,
  runs           integer NOT NULL DEFAULT 0
);
ALTER TABLE public.wmc_fmv_reconcile_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wmc_fmv_reconcile_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.wmc_fmv_reconcile_state TO postgres, service_role, cron_heavy;

-- Round-robin over the SAVED wallets (the ones a signed-in collector actually looks at), least
-- recently reconciled first, inside a wall budget. Logs one pipeline_runs row per tick with the
-- per-wallet fix counts in `extra` — a `rows_written = 0` tick is "nothing drifted", and the
-- drift it DID find is the drain's miss rate, an instrument the drain never had.
CREATE OR REPLACE FUNCTION public.reconcile_saved_wallets_wmc_fmv(p_budget_seconds integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_deadline timestamptz := clock_timestamp() + make_interval(secs => GREATEST(p_budget_seconds, 1));
  v_w        text;
  v_n        integer;
  v_wallets  integer := 0;
  v_fixed    integer := 0;
  v_detail   jsonb := '{}'::jsonb;
  v_ok       boolean := true;
  v_err      text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('reconcile_saved_wallets_wmc_fmv')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;
  BEGIN
    FOR v_w IN
      SELECT sw.w
        FROM (SELECT DISTINCT lower(wallet_addr) AS w FROM public.saved_wallets WHERE wallet_addr IS NOT NULL) sw
        LEFT JOIN public.wmc_fmv_reconcile_state st ON st.wallet_address = sw.w
       ORDER BY st.last_run_at ASC NULLS FIRST, sw.w
    LOOP
      EXIT WHEN clock_timestamp() > v_deadline;
      v_n := public.reconcile_wmc_fmv_for_wallet(v_w);
      INSERT INTO public.wmc_fmv_reconcile_state (wallet_address, last_run_at, last_fixed, runs)
      VALUES (v_w, now(), v_n, 1)
      ON CONFLICT (wallet_address) DO UPDATE
        SET last_run_at = now(), last_fixed = EXCLUDED.last_fixed, runs = wmc_fmv_reconcile_state.runs + 1;
      v_wallets := v_wallets + 1;
      v_fixed   := v_fixed + v_n;
      IF v_n > 0 THEN v_detail := v_detail || jsonb_build_object(v_w, v_n); END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false;
    v_err := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM public.log_pipeline_run('wmc-fmv-reconcile-saved', v_started, v_wallets, v_fixed, 0, v_ok, v_err,
                                  NULL, NULL, NULL,
                                  jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                                                     'wallets', v_wallets, 'fixed', v_fixed, 'fixed_by_wallet', v_detail,
                                                     'budget_s', p_budget_seconds, 'via', 'pg_cron'));
  RETURN jsonb_build_object('wallets', v_wallets, 'fixed', v_fixed, 'ok', v_ok, 'error', v_err);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.reconcile_saved_wallets_wmc_fmv(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_saved_wallets_wmc_fmv(integer) TO postgres, service_role, cron_heavy;

-- Every 30 min at :06/:36 — minutes no other pg_cron job uses (checked 2026-09-04: the drain is
-- 7-57/10, the confidence backfill 2-59/5, :34 carries the offers backstop, :04/:05 the pgss
-- snapshot). 20 s budget; runs as cron_heavy like the other wmc writers.
SELECT cron.schedule('rpc-wmc-fmv-reconcile-saved', '6,36 * * * *', $$SELECT public.reconcile_saved_wallets_wmc_fmv(20)$$);
