-- 2026-09-30 (PT) — seed_saved_wallet_chain_arrivals: seed SOLD moments too.
--
-- WHY. The daily seed took only moments a saved wallet still HOLDS, so a
-- custodial pull the wallet sold before the next seed was never traced. A sold
-- moment is bisectable (held just before its first sale), and since
-- 20260930183000 the lane shares calls between probes with different
-- intervals. Measured 2026-09-30: seeding sold moments by hand found 297 more
-- custodial packs for Rigged alone; 14,446 were seeded for 28 wallets at
-- 11:52 AM PT (docs/reference/packs.md).
-- WHAT. Also seed every Top Shot id a saved wallet SOLD after 2023-11-09 that
-- is not an NFT pack pull, has no pack-pull record and was not bought by it,
-- at the floor with hi = its first sale's height (sales.block_height, else
-- flow_height_estimate(sold_at)) - 100. A held row wins over a sold one.
-- Existing probes untouched (ON CONFLICT DO NOTHING). Logs extra.sold.
-- anon-exec: unchanged (seed_saved_wallet_chain_arrivals) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege(anon)=false.
--
-- Revert: re-apply the body from
--   supabase/migrations/20260929180000_audit_20260929_chain_arrivals_for_every_saved_wallet_floor_check_first.sql
-- and repoint its pin.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.seed_saved_wallet_chain_arrivals()'::regprocedure;
  IF v_md5 IS DISTINCT FROM 'fce916f15de58886c1ccc5d286eb297a' THEN
    RAISE EXCEPTION 'seed_saved_wallet_chain_arrivals changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.seed_saved_wallet_chain_arrivals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_floor   constant bigint := 65300000;       -- just past the mainnet24 root
  v_hi      bigint := public.flow_height_estimate(now() - interval '15 minutes');
  v_seeded  int := 0; v_wallets int := 0; v_sold int := 0;
BEGIN
  IF v_hi IS NULL OR v_hi <= v_floor THEN
    PERFORM public.log_pipeline_run('chain-arrivals-seed', v_started, 0, 0, 0, false, 'no height estimate for now()',
      'nba_top_shot', NULL, NULL, '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'reason', 'no height estimate for now()');
  END IF;

  -- every held Top Shot moment of a saved wallet we cannot already explain:
  -- not a known NFT pack pull, no pack-pull record, not a recorded purchase.
  -- It starts at the FLOOR check (held at the mainnet24 root -> done).
  WITH w AS (
    SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
     WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$'
  ), held AS (
    SELECT w.wallet, m.moment_id::bigint AS nft_id, v_hi AS hi
      FROM w
      JOIN public.wallet_moments_cache m
        ON m.wallet_address = w.wallet AND m.collection_id = v_ts AND m.moment_id ~ '^[0-9]{1,15}$'
     WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = m.moment_id)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = w.wallet AND a.collection_id = v_ts AND a.nft_id = m.moment_id
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM public.sales s
                        WHERE s.collection_id = v_ts AND s.nft_id = m.moment_id AND s.buyer_address = w.wallet)
  ), sold AS (
    -- 2026-09-30: a moment the wallet SOLD after the floor is traceable too:
    -- it was held just before its first sale, so hi = that height - 100 (the
    -- estimate is within 22 blocks of the real height; 300 of 300 rips,
    -- 2023-26). Only held moments were seeded before, so a pull flipped
    -- between two seeds was never traced. Same exclusions as held.
    SELECT s.seller_address AS wallet, s.nft_id::bigint AS nft_id,
           coalesce(min(s.block_height), public.flow_height_estimate(min(s.sold_at))) - 100 AS hi
      FROM w
      JOIN public.sales s ON s.seller_address = w.wallet
     WHERE s.collection_id = v_ts AND s.nft_id ~ '^[0-9]{1,15}$' AND s.sold_at > timestamptz '2023-11-09'
     GROUP BY 1, 2
  ), sold_ok AS (
    SELECT so.wallet, so.nft_id, so.hi
      FROM sold so
     WHERE so.hi > v_floor
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = so.nft_id::text)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = so.wallet AND a.collection_id = v_ts AND a.nft_id = so.nft_id::text
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM public.sales b
                        WHERE b.collection_id = v_ts AND b.nft_id = so.nft_id::text AND b.buyer_address = so.wallet)
  ), ids AS (
    SELECT wallet, nft_id, hi, false AS is_sold FROM held
    UNION ALL
    SELECT wallet, nft_id, hi, true FROM sold_ok
  ), ins AS (
    INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
    SELECT DISTINCT ON (wallet, nft_id) wallet, nft_id, v_floor, hi, 'floor' FROM ids
     ORDER BY wallet, nft_id, is_sold
    ON CONFLICT (wallet, nft_id) DO NOTHING
    RETURNING wallet, hi
  )
  SELECT count(*), count(DISTINCT wallet), count(*) FILTER (WHERE hi <> v_hi) INTO v_seeded, v_wallets, v_sold FROM ins;

  PERFORM public.log_pipeline_run('chain-arrivals-seed', v_started, v_seeded, v_seeded, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('seeded', v_seeded, 'sold', v_sold, 'wallets', v_wallets, 'hi', v_hi));
  RETURN jsonb_build_object('ok', true, 'seeded', v_seeded, 'sold', v_sold, 'wallets', v_wallets, 'hi', v_hi);
END;
$function$;
