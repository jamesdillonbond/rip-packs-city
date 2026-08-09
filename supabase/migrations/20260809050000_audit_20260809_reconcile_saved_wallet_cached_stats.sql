-- audit_20260809_reconcile_saved_wallet_cached_stats
--
-- PROBLEM
-- `saved_wallets.cached_moment_count` / `cached_fmv_usd` / `cached_top_tier` are
-- the numbers the dashboard, /profile/<username>, /share and the profile OG card
-- render. They are written ONLY by `aggregate_saved_wallet_stats(user, wallet)`,
-- which is called only on the signup / wallet-association path and from the
-- saved-wallets flow -- never on a schedule. `wallet_moments_cache` meanwhile
-- keeps growing via the scheduled wallet walks, so every card drifts further
-- below reality every day.
--
-- Measured live 2026-08-08 (PT), before this landed: 99 saved_wallets rows,
-- 21 of 21 users affected, 45 rows with a NULL count, 41 rows drifting >5 from
-- wmc -- e.g. Edogg1976 Top Shot NULL vs 12,552 actual, Rigged 33,374 vs 38,097,
-- ThunderHour 50 vs 1,474 (the shallow first-paint value, frozen since signup).
--
-- FIX
-- `reconcile_all_saved_wallet_stats()` -- sweeps every saved wallet through the
-- existing per-wallet RPC, then closes the one case that RPC structurally cannot
-- reach (see the zero pass below). Scheduled nightly so a card can never be more
-- than a day behind wmc.
--
-- WHY IT LOOPS THE EXISTING RPC RATHER THAN RE-IMPLEMENTING THE AGGREGATE:
-- `aggregate_saved_wallet_stats` is the definition of what these columns mean
-- (the tier ladder, the "0 fmv -> NULL" convention). A second set-based copy of
-- that logic would be a second source of truth for the same three columns and
-- would drift. The wallet count here is the USER count (21 today), not the
-- moment count, so the loop is cheap: measured 21 wallets in ~10s warm, worst
-- single wallet ~6s at 43k wmc rows.
--
-- THE ZERO PASS (the gap the per-wallet RPC cannot close):
-- `aggregate_saved_wallet_stats` runs `UPDATE ... FROM agg` where `agg` is a
-- GROUP BY over that wallet's wmc rows. A (wallet, collection) pair with ZERO
-- wmc rows produces no `agg` row, so the join matches nothing and the
-- saved_wallets row is never touched -- it keeps whatever it last had, forever.
-- Today that shows up as 21 rows stuck at NULL; the sharper failure is a wallet
-- that SELLS OUT of a collection and displays its old count indefinitely. The
-- zero pass writes an explicit 0 for those. It is guarded so it only writes rows
-- that are not already zeroed, i.e. it is a no-op on subsequent nightly runs
-- rather than re-stamping 21 rows every night.
--
-- Display impact of NULL -> 0: none. Every consumer already coalesces
-- (`w.cached_moment_count ?? 0` in ProfileClient / the collection profile page,
-- `Number(...) || 0` in the OG route and CrossCollectionHoldingsCard), so the
-- rendered output is identical -- but the stored value is now honest and
-- `cache_updated_at` becomes a meaningful freshness stamp.
--
-- SAFETY: display columns only. No auth, ownership, lockdown or FMV-math impact.
-- Idempotent -- re-running only makes counts match wmc more exactly.
--
-- Rollback:
--   SELECT cron.unschedule('rpc-reconcile-saved-wallet-stats');
--   DROP FUNCTION IF EXISTS public.reconcile_all_saved_wallet_stats();
-- (No data unwind -- the reconcile only makes cached counts accurate.)

CREATE OR REPLACE FUNCTION public.reconcile_all_saved_wallet_stats()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
-- Generous but bounded: the whole sweep is ~10s warm / <60s cold today. A cap
-- means a pathological run releases its pooler connection instead of pinning it
-- while the disk-IO budget is depleted.
SET statement_timeout TO '300s'
AS $function$
DECLARE
  r          record;
  v_wallets  integer := 0;
  v_refreshed integer := 0;
  v_zeroed   integer := 0;
  v_started  timestamptz := clock_timestamp();
BEGIN
  -- Pass 1: recompute every saved wallet from wallet_moments_cache.
  FOR r IN
    SELECT DISTINCT user_id, wallet_addr
    FROM public.saved_wallets
    WHERE wallet_addr IS NOT NULL
      AND user_id IS NOT NULL
  LOOP
    v_wallets   := v_wallets + 1;
    v_refreshed := v_refreshed
                 + COALESCE(public.aggregate_saved_wallet_stats(r.user_id, r.wallet_addr), 0);
  END LOOP;

  -- Pass 2: zero the (wallet, collection) pairs pass 1 structurally skips
  -- because the wallet holds nothing there. See the header note.
  UPDATE public.saved_wallets sw
  SET cached_moment_count = 0,
      cached_fmv_usd      = NULL,
      cached_top_tier     = NULL,
      cache_updated_at    = NOW()
  WHERE sw.wallet_addr IS NOT NULL
    AND (sw.cached_moment_count IS DISTINCT FROM 0
         OR sw.cached_fmv_usd IS NOT NULL
         OR sw.cached_top_tier IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1
      FROM public.wallet_moments_cache w
      WHERE w.wallet_address = sw.wallet_addr
        AND w.collection_id  = sw.collection_id
    );
  GET DIAGNOSTICS v_zeroed = ROW_COUNT;

  RETURN jsonb_build_object(
    'wallets',        v_wallets,
    'rows_refreshed', v_refreshed,
    'rows_zeroed',    v_zeroed,
    'elapsed_ms',     round(extract(epoch FROM (clock_timestamp() - v_started)) * 1000)
  );
END;
$function$;

COMMENT ON FUNCTION public.reconcile_all_saved_wallet_stats() IS
  'Nightly reconcile of saved_wallets.cached_moment_count/cached_fmv_usd/cached_top_tier '
  'against wallet_moments_cache. Loops aggregate_saved_wallet_stats per saved wallet (so the '
  'column semantics stay single-sourced) then zeroes the (wallet, collection) pairs that RPC '
  'skips because the wallet holds nothing there. Display columns only; idempotent.';

-- Service-role / pg_cron only. Supabase grants EXECUTE to PUBLIC by default, and
-- a REVOKE from anon/authenticated alone leaves that PUBLIC grant in place, so
-- has_function_privilege('anon', ...) would stay true -- revoke PUBLIC too.
REVOKE EXECUTE ON FUNCTION public.reconcile_all_saved_wallet_stats() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reconcile_all_saved_wallet_stats() FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_all_saved_wallet_stats() TO service_role;

-- Nightly at 13:33 UTC = 06:33 PT. Deliberately off the :17-past and */6-hourly
-- pileups that already contend for the depleted disk-IO budget; hour 13 UTC
-- carries no other pg_cron job today.
SELECT cron.unschedule('rpc-reconcile-saved-wallet-stats')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-reconcile-saved-wallet-stats');

SELECT cron.schedule(
  'rpc-reconcile-saved-wallet-stats',
  '33 13 * * *',
  $cron$SELECT public.reconcile_all_saved_wallet_stats()$cron$
);
