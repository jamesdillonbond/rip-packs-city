-- 2026-10-04 (PT) — seed_saved_wallet_chain_arrivals: read the saved wallets'
-- purchases once, and skip moments that already have a probe row.
--
-- WHY. Daytime monitor filing 2026-10-04T1505Z: the daily seed (pg_cron
-- `rpc-chain-arrivals-seed`, 4:13 AM PT) hit its 300 s statement_timeout on
-- 10-04, its first failure in five days. Measured in a quiet window (io_wait 0):
-- the HELD half alone took 67.8 s and 3.58 M buffers. 2.58 M of those were the
-- "not a recorded purchase" check, an anti-join that probed all eight yearly
-- `sales` partitions by nft_id for each of 124 k moments. The overnight Flowty
-- promotion grew `sales`, and a busy 4 AM run did the rest.
--
-- WHAT. Same rows inserted, two cost changes:
--   1. `bought` (MATERIALIZED): every Top Shot nft the saved wallets ever
--      bought, read once by buyer via idx_sales_buyer (~62 k buffers), then
--      hash-anti-joined. It is the same predicate (collection, nft_id, buyer =
--      wallet), read from the other side.
--   2. A moment with an existing chain_arrival_probes row (wallet, nft_id) is
--      dropped first, in both halves. The insert is ON CONFLICT (wallet, nft_id)
--      DO NOTHING, so such a row could never insert; DISTINCT ON shares the same
--      key, so the held-over-sold preference is unchanged. 114,140 of 176,313
--      held moments are already probed.
-- Unchanged: the floor/height logic, `sold`, the insert, the counts, the log,
-- the signature, SECURITY DEFINER, search_path, statement_timeout and ACLs.
--
-- Equivalence + before/after: see the ledger entry of 2026-10-04 (~8:25 AM PT).
-- anon-exec: unchanged (seed_saved_wallet_chain_arrivals) — CREATE OR REPLACE of an existing fn; ACL preserved.
--
-- Revert: re-apply the body from
--   supabase/migrations/20260930190000_audit_20260930_chain_arrivals_seed_sold_moments.sql
-- and repoint the pin (supabase/tests/run_chain_arrival_lane.sql, db-invariants-drift-guard).

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.seed_saved_wallet_chain_arrivals()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '90a736a6876071caf861649cb9b72a2e' THEN
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
  --
  -- 2026-10-04: two cost changes, same rows inserted. (1) A moment that already
  -- has a probe row is dropped FIRST: the insert is ON CONFLICT DO NOTHING, so it
  -- could never insert (114,140 of 176,313 held moments). (2) "not a recorded
  -- purchase" reads the saved wallets' purchases ONCE by buyer (`bought`) and
  -- hash-anti-joins, instead of probing all eight sales partitions per moment
  -- (2.58 M buffers -> ~62 k). The 10-04 4:13 AM PT run hit its 300 s timeout.
  WITH w AS (
    SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
     WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$'
  ), bought AS MATERIALIZED (
    SELECT DISTINCT s.buyer_address::text AS wallet, s.nft_id::text AS nft_id
      FROM w
      JOIN public.sales s ON s.buyer_address = w.wallet
     WHERE s.collection_id = v_ts
  ), held AS (
    SELECT w.wallet, m.moment_id::bigint AS nft_id, v_hi AS hi
      FROM w
      JOIN public.wallet_moments_cache m
        ON m.wallet_address = w.wallet AND m.collection_id = v_ts AND m.moment_id ~ '^[0-9]{1,15}$'
     WHERE NOT EXISTS (SELECT 1 FROM public.chain_arrival_probes p
                        WHERE p.wallet = w.wallet AND p.nft_id = m.moment_id::bigint)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = m.moment_id)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = w.wallet AND a.collection_id = v_ts AND a.nft_id = m.moment_id
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM bought b WHERE b.wallet = w.wallet AND b.nft_id = m.moment_id)
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
       AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_probes p
                        WHERE p.wallet = so.wallet AND p.nft_id = so.nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = so.nft_id::text)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = so.wallet AND a.collection_id = v_ts AND a.nft_id = so.nft_id::text
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM bought b WHERE b.wallet = so.wallet AND b.nft_id = so.nft_id::text)
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
