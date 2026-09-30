-- DB invariant: public.apply_chain_arrival_pack_pulls — a custodial Top Shot
-- pull found on chain (delivered by a Dapper delivery account) becomes a verified
-- pack-pull acquisition, and the wallet's reconstructed rips are rebuilt.
-- Added 2026-09-29. Claims:
--   A1. Only DONE probes whose sender is a Dapper delivery account (0xe1f2...,
--       0xb6f2...) are written, as pack_pull / chain_history / verified with
--       the block time, tx and sender -- never a collector wallet's delivery.
--   A4. A moment that is a known NFT pack pull is never a custodial pull.
--   A2. A moment the wallet already has a pack-pull row for is not written
--       (a CSV or flowty record stands).
--   A3. Each wallet written for is rebuilt once; a wallet with nothing new is
--       not; a second run writes nothing (idempotent).
--   A5. 0xfa57101aa0d55954 is a Dapper delivery source (added 2026-09-30:
--       its moments move only in txs 0xe1f2... alone signs).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260930180000_audit_20260930_custodial_pulls_0xfa57_is_a_dapper_delivery_source.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;
CREATE TABLE public.rebuild_calls (wallet text);
CREATE FUNCTION public.rebuild_wallet_reconstructed_rips(p_wallet text) RETURNS jsonb LANGUAGE sql AS $$
  INSERT INTO public.rebuild_calls VALUES (p_wallet) RETURNING jsonb_build_object('ok', true, 'reconstructed', 1) $$;
CREATE TABLE public.moment_acquisitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nft_id text NOT NULL, wallet text NOT NULL, acquired_date timestamptz,
  acquired_type int NOT NULL DEFAULT 1, transaction_hash text, source text NOT NULL DEFAULT 'flowty_ingest',
  collection_id uuid, acquisition_method text NOT NULL DEFAULT 'unknown', acquisition_confidence text, source_address text,
  UNIQUE (nft_id, wallet, transaction_hash));
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text);
CREATE TABLE public.chain_arrival_probes (
  wallet text NOT NULL, nft_id bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL, status text NOT NULL,
  request_id bigint, attempts int NOT NULL DEFAULT 0, arrived_height bigint, arrived_at timestamptz, tx_id text,
  from_address text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY (wallet, nft_id));

-- >>> BEGIN verbatim apply_chain_arrival_pack_pulls (body byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status, arrived_height, arrived_at, tx_id, from_address) VALUES
  ('0xaa', 1, 0, 1, 'done', 100, '2025-01-01 00:00:00+00', 'T1', '0xe1f2a091f7bb5245'),   -- custodial reveal
  ('0xaa', 2, 0, 1, 'done', 100, '2025-01-01 00:00:00+00', 'T1', '0xe1f2a091f7bb5245'),   -- same pack, same tx
  ('0xaa', 3, 0, 1, 'done', 200, '2025-01-02 00:00:00+00', 'T2', '0x1111111111111111'),   -- bought
  ('0xaa', 4, 0, 1, 'done', 300, '2025-01-03 00:00:00+00', 'T3', '0xe1f2a091f7bb5245'),   -- a known NFT pack's pull
  ('0xaa', 5, 0, 1, 'bisect', NULL, NULL, NULL, NULL),                                    -- unfinished
  ('0xaa', 6, 0, 1, 'done', 400, '2025-01-04 00:00:00+00', 'T4', '0xe1f2a091f7bb5245'),   -- already a CSV pull
  ('0xaa', 8, 0, 1, 'done', 450, '2025-01-04 12:00:00+00', 'T6', '0xb5b717909b9c5ea5'),   -- a collector wallet (sold 644)
  ('0xcc', 9, 0, 1, 'done', 460, '2026-05-01 00:00:00+00', 'T7', '0xb6f2481eba4df97b'),   -- PDS delivery
  ('0xcc', 10, 0, 1, 'done', 470, '2024-09-01 00:00:00+00', 'T8', '0xfa57101aa0d55954'),  -- a Dapper-signed shard delivery
  ('0xbb', 7, 0, 1, 'done', 500, '2025-01-05 00:00:00+00', 'T5', '0x2222222222222222');   -- nothing custodial
INSERT INTO public.pack_open_pulls VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK', '4');
INSERT INTO public.moment_acquisitions (nft_id, wallet, collection_id, acquired_date, source, acquisition_method)
VALUES ('6', '0xaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '2025-01-04 00:00:02+00', 'bulk_seed', 'pack_pull');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq(v->>'pack_pulls_inserted', '4', 'A1: the two 0xe1f2 reveals, the PDS and the 0xfa57 delivery, nothing else');
  PERFORM _assert((SELECT count(*) = 1 FROM public.moment_acquisitions WHERE nft_id = '10' AND source_address = '0xfa57101aa0d55954'
                      AND acquisition_method = 'pack_pull' AND transaction_hash = 'T8'),
                  'A5: 0xfa57 (moves only in txs 0xe1f2 alone signs) is a Dapper delivery source');
  PERFORM _assert((SELECT count(*) = 2 FROM public.moment_acquisitions
                    WHERE source = 'chain_history' AND acquisition_method = 'pack_pull' AND acquisition_confidence = 'verified'
                      AND wallet = '0xaa' AND nft_id IN ('1', '2') AND transaction_hash = 'T1'
                      AND acquired_date = '2025-01-01 00:00:00+00' AND source_address = '0xe1f2a091f7bb5245'
                      AND collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'),
                  'A1: written as a verified chain_history pack pull with time, tx and sender');
  PERFORM _assert((SELECT count(*) = 1 FROM public.moment_acquisitions WHERE nft_id = '9' AND source_address = '0xb6f2481eba4df97b'),
                  'A1: a PDS delivery is a pack pull');
  PERFORM _assert((SELECT count(*) = 0 FROM public.moment_acquisitions WHERE nft_id IN ('3', '5', '7', '8')),
                  'A1: a purchase, a collector wallet''s delivery and an unfinished probe are not custodial pulls');
  PERFORM _assert((SELECT count(*) = 0 FROM public.moment_acquisitions WHERE nft_id = '4'),
                  'A4: a known NFT pack pull is not a custodial pull');
  PERFORM _assert((SELECT count(*) = 1 FROM public.moment_acquisitions WHERE nft_id = '6'), 'A2: an existing pack-pull record stands alone');
  PERFORM _assert((SELECT array_agg(wallet ORDER BY wallet) = ARRAY['0xaa', '0xcc'] FROM public.rebuild_calls), 'A3: only the wallets written for are rebuilt, once each');
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq(v->>'pack_pulls_inserted', '0', 'A3: a second run writes nothing');
  PERFORM _assert((SELECT count(*) = 2 FROM public.rebuild_calls), 'A3: and rebuilds nothing');
END $$;

ROLLBACK;
