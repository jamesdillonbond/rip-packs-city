-- audit_20261110_chain_arrivals_seed_estimates_height_only_for_new_sold_moments
--
-- WHY. pg_cron 638 `rpc-chain-arrivals-seed` (daily 3:13 AM PT, runs as postgres) failed
-- 11-10 with `canceling statement due to statement timeout` inside flow_height_estimate
-- (daytime-monitor filing 2026-11-10T1607Z). Its durations had climbed 56 s (11-03) →
-- 74–89 s → 104 s (11-09) → killed at 120 s. The function's own `SET statement_timeout
-- = 300s` is INERT on pg_cron (CLAUDE.md), so the 120 s global applied — and the kill
-- wrote no pipeline_runs row.
--
-- CAUSE (measured 11-10 ~9 AM PT). The `sold` CTE computed `hi` — calling
-- flow_height_estimate (~270 buffers, ~5 ms) for every group with no block height — for
-- ALL 142,250 sold (wallet, moment) groups over 49 saved wallets (44,032 need the
-- estimate), and only THEN dropped the ones already probed / pulled / bought. The set
-- grows with every saved wallet (11 new on 11-09).
--
-- FIX. The exclusions run first (`sold_new`, MATERIALIZED so `hi > v_floor` is not pushed
-- ahead of them) and the estimate runs only for the survivors. Same rows inserted: every
-- predicate is unchanged and none depends on `hi` except `hi > v_floor`, still applied.
-- Paired with `cron.alter_job(638, command := 'SET statement_timeout = ''300s''; …')` so
-- the budget the function always declared is the one that applies (job 818 precedent).
--
-- Pin: supabase/tests/run_chain_arrival_lane.sql (verbatim block + S3: the estimate is
-- never called for an already-probed sold moment). Drift guard re-pointed here.
--
-- anon-exec: unchanged (seed_saved_wallet_chain_arrivals) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false on 11-10.
--
-- REVERT: re-apply the body from 20261004160000; `SELECT cron.alter_job(638, command := 'SELECT public.seed_saved_wallet_chain_arrivals();');`
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
           min(s.block_height) AS bh, min(s.sold_at) AS first_sold
      FROM w
      JOIN public.sales s ON s.seller_address = w.wallet
     WHERE s.collection_id = v_ts AND s.nft_id ~ '^[0-9]{1,15}$' AND s.sold_at > timestamptz '2023-11-09'
     GROUP BY 1, 2
  ), sold_new AS MATERIALIZED (
    -- 2026-11-10: the exclusions run BEFORE the height estimate. It was computed for
    -- every sold group (142,250 over 49 wallets; 44,032 with no block height, ~5 ms a
    -- call) and then all but 11,658 were dropped by the exclusions; the 11-10 3:13 AM PT
    -- run hit the 120 s pg_cron timeout. MATERIALIZED keeps `hi > v_floor` from being
    -- pushed in front of the anti-joins. Same rows inserted.
    SELECT so.wallet, so.nft_id,
           coalesce(so.bh, public.flow_height_estimate(so.first_sold)) - 100 AS hi
      FROM sold so
     WHERE NOT EXISTS (SELECT 1 FROM public.chain_arrival_probes p
                        WHERE p.wallet = so.wallet AND p.nft_id = so.nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = so.nft_id::text)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = so.wallet AND a.collection_id = v_ts AND a.nft_id = so.nft_id::text
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM bought b WHERE b.wallet = so.wallet AND b.nft_id = so.nft_id::text)
  ), sold_ok AS (
    SELECT sn.wallet, sn.nft_id, sn.hi FROM sold_new sn WHERE sn.hi > v_floor
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

SELECT cron.alter_job(638, command := 'SET statement_timeout = ''300s''; SELECT public.seed_saved_wallet_chain_arrivals();');
