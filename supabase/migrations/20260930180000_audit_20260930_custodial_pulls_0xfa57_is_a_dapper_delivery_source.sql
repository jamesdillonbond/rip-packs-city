-- 2026-09-30 (PT) — apply_chain_arrival_pack_pulls: 0xfa57101aa0d55954 is a
-- Dapper delivery source.
--
-- Deferred on 09-29 as "maybe Rigged's own second wallet". Re-derived
-- 2026-09-30 ~11 AM PT: the chain-arrival lane has since found it delivering
-- 67 moments in 60 txs to 11 saved wallets (2023-12 -> 2025-01), 0 marketplace
-- sales either way. 43 of those 60 txs ALSO deposit moments withdrawn from
-- 0xe1f2a091f7bb5245 (Dapper's pack escrow) to the same wallet. Three txs read
-- from the spork nodes (Rigged's 0e23bd82…, 0x8bf9…'s e1b29252… which carries
-- only 0xfa57 moments, 0x28ed…'s 7465beb2…) are each signed by 0xe1f2… alone
-- (payer 0x18eb4ee6b3c026d2), running Dapper's TopShotShardedCollection
-- delivery script, with no marketplace event. Only Dapper could move them.
-- No other sender shares a tx with a Dapper delivery account.
-- anon-exec: unchanged (apply_chain_arrival_pack_pulls) — CREATE OR REPLACE of an existing fn; ACL preserved (set in 20260929175000).
--
-- Revert: re-apply the body from
--   supabase/migrations/20260929175000_audit_20260929_custodial_pulls_found_on_chain_become_pack_pull_acquisitions.sql
-- and repoint its pin; then
--   DELETE FROM moment_acquisitions WHERE source = 'chain_history' AND source_address = '0xfa57101aa0d55954';
-- and rebuild_wallet_reconstructed_rips() each affected wallet.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.apply_chain_arrival_pack_pulls()'::regprocedure;
  IF v_md5 IS DISTINCT FROM '31fbe24972927856c2dc62c8afbaaa87' THEN
    RAISE EXCEPTION 'apply_chain_arrival_pack_pulls changed since the splice base (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

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
  -- 2026-09-30: + 0xfa57101aa0d55954, a Dapper-controlled source: its moments
  -- leave in txs signed ONLY by 0xe1f2... (Dapper's delivery script), 43 of
  -- its 60 beside 0xe1f2... moments in the same reveal
  v_dapper    constant text[] := ARRAY['0xe1f2a091f7bb5245', '0xb6f2481eba4df97b', '0xfa57101aa0d55954'];
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
