-- audit_20260925_saved_wallet_fmv_reconcile_stops_folding_base58
--
-- The saved-wallet FMV reconcile lane (pg_cron job 446, every 30 min) folded every saved wallet
-- with lower() before matching wallet_moments_cache. That is a no-op for Flow (hex, stored
-- lowercase: 27/27 saved wallets, 0 mixed case), but base58 (Candy/Solana) is CASE-SENSITIVE, so a
-- folded Candy key matches NO row: the lane "reconciled" a saved Candy wallet, fixed 0, and
-- reported ok. Unreachable until 2026-09-25, when saving a Candy wallet became possible (free cap
-- 1 -> 5, 20260925233206).
--
-- MEASURED before, live 2026-09-25 ~5:45 PM PT: Candy wallet 1BWutmTv...X6NDix has 1,022 wmc rows
-- whose fmv_usd/fmv_confidence differ from edition_fmv_current; reconcile_wmc_fmv_for_wallet on it
-- returned 0. Estate-wide 14,330 of 25,375 Candy rows drift (822 on price).
--
-- FIX: fold only hex (`~* '^0x'`); base58 passes through verbatim. A base58 string can never match
-- '^0x' (the alphabet has no '0'), so the Flow arm is byte-identical to before.
-- Both bodies are otherwise VERBATIM from the live prosrc (re-read immediately before this
-- migration), including the R118 `WHEN query_canceled OR OTHERS` handler.
--
-- anon-exec: unchanged (reconcile_wmc_fmv_for_wallet) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
-- anon-exec: unchanged (reconcile_saved_wallets_wmc_fmv) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false.
--
-- SECURITY DEFINER + search_path + the `DEFAULT 20` parameter default restated: both live functions carry them (read 2026-09-25), and a
-- CREATE OR REPLACE without them would silently turn them into invoker functions.
--
-- REVERT: re-apply both bodies from 20260904055844 (per-wallet) and 20260920143546 (sweep).

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
     WHERE w.wallet_address = CASE WHEN p_wallet ~* '^0x' THEN lower(p_wallet) ELSE p_wallet END
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
        FROM (SELECT DISTINCT CASE WHEN wallet_addr ~* '^0x' THEN lower(wallet_addr) ELSE wallet_addr END AS w
                FROM public.saved_wallets WHERE wallet_addr IS NOT NULL) sw
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
  EXCEPTION WHEN query_canceled OR OTHERS THEN
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
