-- 2026-09-29 (PT) — a custodial Top Shot pull FOUND ON CHAIN becomes a
-- verified pack-pull acquisition, so the wallet's reconstructed rips (and the
-- pack history that reads them) include it.
--
-- WHY. run_chain_arrival_lane (20260929170000) finds when and from whom a
-- wallet received each moment. Measured 2026-09-29 (9:00-10:00 AM PT):
--   * chain arrival times match 0xbd94...'s CSV pack-pull times within 15 s
--     on 57 of 62 of its 0xe1f2... arrivals;
--   * a custodial REVEAL is one tx from 0xe1f2a091f7bb5245 depositing the
--     whole pack (5 moments in 2024, 3 in 2025-26) with NO PackNFT event
--     (12 of 12 of Rigged's sampled); 0xe1f2... has sold 0 moments and bought
--     94,479 in our sales -- a Dapper account, the same one NFT pack opens
--     withdraw from;
--   * 0xb6f2481eba4df97b (Dapper PDS) delivers the 2026 flowty-ingest pulls;
--   * 0xb5b717909b9c5ea5 and 0xf2b9a392351deff1, which delivered some of
--     0xbd94...'s CSV "pack pulls", have SOLD 644 and 193 moments on the
--     marketplace: collector wallets, NOT delivery accounts (the CSV's
--     pack-pull label is heuristic). Excluded.
-- So: an arrival from a Dapper delivery account that is not a known NFT pack
-- pull (pack_open_pulls -- walked completely for saved wallets) is a
-- custodial pull. rebuild_wallet_reconstructed_rips() already turns pack-pull
-- acquisitions into rips; until now its only inputs were one owner's CSV and
-- flowty_ingest (2026-04 on), so Rigged's custodial rips read as none.
--
-- WHAT. apply_chain_arrival_pack_pulls(): for every done probe whose sender
-- is a Dapper delivery account (0xe1f2..., 0xb6f2...) and whose moment is
-- not in pack_open_pulls, insert moment_acquisitions (acquisition_method 'pack_pull',
-- source 'chain_history', confidence 'verified', acquired_date = block time,
-- transaction_hash = the delivering tx, source_address = the sender) -- never
-- for a moment the wallet already has a pack-pull row for (a CSV or flowty
-- record stands) -- then rebuild the reconstructed rips of each wallet it
-- wrote for. pg_cron rpc-chain-arrival-pack-pulls hourly at :41.
-- anon-exec: apply_chain_arrival_pack_pulls() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-chain-arrival-pack-pulls');
--   DELETE FROM public.moment_acquisitions WHERE source = 'chain_history';
--   SELECT public.rebuild_saved_wallet_reconstructed_rips();
--   DROP FUNCTION public.apply_chain_arrival_pack_pulls();

CREATE OR REPLACE FUNCTION public.apply_chain_arrival_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_ts        constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  -- Dapper delivery accounts (evidence above); a collector wallet is never one
  v_dapper    constant text[] := ARRAY['0xe1f2a091f7bb5245', '0xb6f2481eba4df97b'];
  v_inserted int := 0; v_wallets int := 0; v_rips int := 0;
  w record; v_res jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('apply_chain_arrival_pack_pulls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _cap_wallets (wallet text PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE _cap_wallets;

  WITH ins AS (
    INSERT INTO public.moment_acquisitions
      (nft_id, wallet, collection_id, acquired_date, acquired_type, transaction_hash,
       source, acquisition_method, acquisition_confidence, source_address)
    SELECT p.nft_id::text, p.wallet, v_ts, p.arrived_at, 1, p.tx_id,
           'chain_history', 'pack_pull', 'verified', p.from_address
      FROM public.chain_arrival_probes p
     WHERE p.status = 'done' AND p.from_address = ANY (v_dapper)
       AND p.arrived_at IS NOT NULL AND p.tx_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions m
                        WHERE m.wallet = p.wallet AND m.collection_id = v_ts
                          AND m.nft_id = p.nft_id::text AND m.acquisition_method = 'pack_pull')
       -- an NFT pack's pull (same delivery account) is that pack's, never custodial
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                        WHERE o.collection_id = v_ts AND o.nft_id = p.nft_id::text)
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING wallet
  ), w AS (
    INSERT INTO _cap_wallets SELECT DISTINCT wallet FROM ins ON CONFLICT DO NOTHING RETURNING 1
  )
  SELECT (SELECT count(*) FROM ins) INTO v_inserted;

  FOR w IN SELECT wallet FROM _cap_wallets ORDER BY wallet LOOP
    v_res := public.rebuild_wallet_reconstructed_rips(w.wallet);
    v_wallets := v_wallets + 1;
    v_rips := v_rips + coalesce((v_res->>'reconstructed')::int, 0);
  END LOOP;

  PERFORM public.log_pipeline_run('chain-arrival-pack-pulls', v_started, v_inserted, v_inserted, 0, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('pack_pulls_inserted', v_inserted, 'wallets_rebuilt', v_wallets, 'rips_reconstructed', v_rips));
  RETURN jsonb_build_object('ok', true, 'pack_pulls_inserted', v_inserted, 'wallets_rebuilt', v_wallets,
                            'rips_reconstructed', v_rips);
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_chain_arrival_pack_pulls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_chain_arrival_pack_pulls() TO postgres, service_role;

SELECT cron.schedule('rpc-chain-arrival-pack-pulls', '41 * * * *', 'SELECT public.apply_chain_arrival_pack_pulls();');
