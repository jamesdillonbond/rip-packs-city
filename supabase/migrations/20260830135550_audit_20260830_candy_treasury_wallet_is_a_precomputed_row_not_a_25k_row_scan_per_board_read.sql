-- audit_20260830_candy_treasury_wallet_is_a_precomputed_row_not_a_25k_row_scan_per_board_read
--
-- FINDING 13:5xZ (ledger 2026-08-30): `candy_pack_market` (1 row) took 11.9 s under contention,
-- 15,677 hit + 3,187 read buffers, of which 85 % was the `candy_treasury_wallet` CTE — an Index
-- Only Scan over 25,375 idx_wmc_candy_holder_cover entries with Heap Fetches 4,734 (the wmc
-- visibility map is churned by every FMV refresh), GROUPed and sorted to find the ONE wallet that
-- holds the most Candy moments. `candy_special_serials_board` embeds the same view; both are
-- rebuilt by refresh-insights-cache every tick and read by the candy-mlb page. The answer is a
-- single wallet address that has not changed since the collection launched.
--
-- FIX: a 1-row cache table refreshed hourly by pg_cron, and the view reads the cache. Same
-- column (wallet_address), same reloptions (security_invoker=on — CREATE OR REPLACE VIEW resets
-- them, so re-set), same grants (preserved by CREATE OR REPLACE VIEW). Dependents
-- (candy_pack_market, candy_special_serials_board) bind by OID and need no change. The seed is
-- computed at apply time by the same GROUP BY, so the view answers identically from the first
-- read. Freshness: hourly; the treasury identity is stable, and a wrong answer would need the
-- largest holder to change AND a board to be read within the hour after.
--
-- anon-exec: NOT granted — refresh function is postgres/service_role only (refresh_candy_treasury_wallet).
-- REVERT: CREATE OR REPLACE VIEW public.candy_treasury_wallet AS SELECT wallet_address FROM
--   wallet_moments_cache WHERE collection_id = '209ade70-...' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1;
--   ALTER VIEW public.candy_treasury_wallet SET (security_invoker = on);
--   SELECT cron.unschedule('rpc-refresh-candy-treasury-wallet'); DROP FUNCTION public.refresh_candy_treasury_wallet();
--   DROP TABLE public.candy_treasury_wallet_cache;

CREATE TABLE IF NOT EXISTS public.candy_treasury_wallet_cache (
  wallet_address text NOT NULL,
  serials bigint NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.candy_treasury_wallet_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.candy_treasury_wallet_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.candy_treasury_wallet_cache TO service_role;

CREATE OR REPLACE FUNCTION public.refresh_candy_treasury_wallet()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '110s'
AS $function$
DECLARE v_wallet text; v_n bigint;
BEGIN
  SELECT wallet_address, count(*) INTO v_wallet, v_n
  FROM public.wallet_moments_cache
  WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
  GROUP BY wallet_address ORDER BY count(*) DESC LIMIT 1;
  IF v_wallet IS NULL THEN RETURN NULL; END IF;
  DELETE FROM public.candy_treasury_wallet_cache;
  INSERT INTO public.candy_treasury_wallet_cache (wallet_address, serials) VALUES (v_wallet, v_n);
  RETURN v_wallet;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_candy_treasury_wallet() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_candy_treasury_wallet() TO service_role;

SELECT public.refresh_candy_treasury_wallet();

DO $$ BEGIN
  IF (SELECT count(*) FROM public.candy_treasury_wallet_cache) <> 1 THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: seed did not produce exactly one treasury row';
  END IF;
END $$;

CREATE OR REPLACE VIEW public.candy_treasury_wallet AS
  SELECT wallet_address FROM public.candy_treasury_wallet_cache ORDER BY computed_at DESC LIMIT 1;
ALTER VIEW public.candy_treasury_wallet SET (security_invoker = on);

SELECT cron.schedule('rpc-refresh-candy-treasury-wallet', '39 * * * *', 'SELECT public.refresh_candy_treasury_wallet()');
