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
--   A6. (2026-10-09) Every DONE probe a run reads is marked checked at the finished_at it saw;
--       an unfinished probe is not marked; a second run reads nothing.
--   A7. A probe that finishes AGAIN (a writer sets a new finished_at, e.g. the flip lane filling
--       a sender) is checked again and, if now custodial, written.
--   A8. The check walks past one chunk (2,000) in a single run.
--   A9. A wallet left in the rebuild queue by an earlier run is rebuilt and stamped; nothing
--       waits after a run with budget to spare.
--   A10. A wallet rebuilt earlier that gets a new pull is queued and rebuilt again.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261009162222_audit_20261009_chain_arrival_pack_pulls_checks_each_probe_once.sql).
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
  pack_pull_checked boolean NOT NULL DEFAULT false, pack_pull_checked_finished_at timestamptz,
  PRIMARY KEY (wallet, nft_id));
CREATE TABLE public.chain_arrival_rebuild_queue (wallet text PRIMARY KEY, queued_at timestamptz NOT NULL DEFAULT clock_timestamp(), rebuilt_at timestamptz);

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
  -- 2026-10-09: pg_cron runs this under the database's 120 s statement_timeout (the SET above is
  -- inert there). Check new probes for 45 s, rebuild queued wallets until 75 s, stop.
  CHECK_BUDGET   constant interval := '45 seconds';
  REBUILD_CUTOFF constant interval := '75 seconds';
  CHUNK          constant integer  := 2000;
  v_checked int := 0; v_inserted int := 0; v_wallets int := 0; v_rips int := 0;
  v_chunk int; v_n int; v_unchecked bigint; v_queued bigint;
  w record; v_res jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('apply_chain_arrival_pack_pulls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- 1. Probes that finished since this lane last checked them, a chunk at a time. One statement
  --    inserts the custodial pulls, queues their wallets and marks every probe it read.
  LOOP
    EXIT WHEN clock_timestamp() - v_started > CHECK_BUDGET;
    WITH c AS MATERIALIZED (
      SELECT p.wallet, p.nft_id, p.finished_at, p.arrived_at, p.tx_id, p.from_address
        FROM public.chain_arrival_probes p
       WHERE p.status = 'done'
         AND (NOT p.pack_pull_checked OR p.pack_pull_checked_finished_at IS DISTINCT FROM p.finished_at)
       ORDER BY p.wallet, p.nft_id
       LIMIT CHUNK
    ), ins AS (
      INSERT INTO public.moment_acquisitions
        (nft_id, wallet, collection_id, acquired_date, acquired_type, transaction_hash,
         source, acquisition_method, acquisition_confidence, source_address)
      SELECT c.nft_id::text, c.wallet, v_ts, c.arrived_at, 1, c.tx_id,
             'chain_history', 'pack_pull', 'verified', c.from_address
        FROM c
       WHERE c.from_address = ANY (v_dapper)
         AND c.arrived_at IS NOT NULL AND c.tx_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions m
                          WHERE m.wallet = c.wallet AND m.collection_id = v_ts
                            AND m.nft_id = c.nft_id::text AND m.acquisition_method = 'pack_pull')
         -- an NFT pack's pull (same delivery account) is that pack's, never custodial
         AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o
                          WHERE o.collection_id = v_ts AND o.nft_id = c.nft_id::text)
      ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
      RETURNING wallet
    ), q AS (
      -- a data-modifying CTE runs to completion whether or not it is read. A wallet already
      -- waiting keeps its place; a rebuilt one is queued again, at the back.
      INSERT INTO public.chain_arrival_rebuild_queue AS q (wallet)
      SELECT DISTINCT wallet FROM ins
      ON CONFLICT (wallet) DO UPDATE
        SET queued_at = CASE WHEN q.rebuilt_at IS NULL THEN q.queued_at ELSE clock_timestamp() END,
            rebuilt_at = NULL
    ), mark AS (
      -- the finished_at this check SAW: a probe re-finished meanwhile stays unchecked
      UPDATE public.chain_arrival_probes p
         SET pack_pull_checked = true, pack_pull_checked_finished_at = c.finished_at
        FROM c
       WHERE p.wallet = c.wallet AND p.nft_id = c.nft_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM mark), (SELECT count(*) FROM ins) INTO v_chunk, v_n;
    v_checked := v_checked + v_chunk;
    v_inserted := v_inserted + v_n;
    EXIT WHEN v_chunk < CHUNK;
  END LOOP;

  -- 2. Rebuild queued wallets, oldest first; what the budget does not reach waits for the next run.
  FOR w IN SELECT wallet FROM public.chain_arrival_rebuild_queue WHERE rebuilt_at IS NULL
            ORDER BY queued_at, wallet LOOP
    EXIT WHEN clock_timestamp() - v_started > REBUILD_CUTOFF;
    v_res := public.rebuild_wallet_reconstructed_rips(w.wallet);
    UPDATE public.chain_arrival_rebuild_queue SET rebuilt_at = clock_timestamp() WHERE wallet = w.wallet;
    v_wallets := v_wallets + 1;
    v_rips := v_rips + coalesce((v_res->>'reconstructed')::int, 0);
  END LOOP;

  SELECT count(*) INTO v_unchecked FROM public.chain_arrival_probes p
   WHERE p.status = 'done'
     AND (NOT p.pack_pull_checked OR p.pack_pull_checked_finished_at IS DISTINCT FROM p.finished_at);
  SELECT count(*) INTO v_queued FROM public.chain_arrival_rebuild_queue WHERE rebuilt_at IS NULL;

  PERFORM public.log_pipeline_run('chain-arrival-pack-pulls', v_started, v_checked, v_inserted, 0, true, NULL,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('probes_checked', v_checked, 'pack_pulls_inserted', v_inserted,
                       'wallets_rebuilt', v_wallets, 'rips_reconstructed', v_rips,
                       'probes_unchecked', v_unchecked, 'wallets_queued', v_queued));
  RETURN jsonb_build_object('ok', true, 'probes_checked', v_checked, 'pack_pulls_inserted', v_inserted,
                            'wallets_rebuilt', v_wallets, 'rips_reconstructed', v_rips,
                            'probes_unchecked', v_unchecked, 'wallets_queued', v_queued);
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
  PERFORM _assert_eq(v->>'probes_checked', '0', 'A6: a second run reads no probe');

  -- A6
  PERFORM _assert((SELECT count(*) = 9 FROM public.chain_arrival_probes
                    WHERE pack_pull_checked AND pack_pull_checked_finished_at IS NOT DISTINCT FROM finished_at),
                  'A6: every done probe is marked at the finished_at it was read at');
  PERFORM _assert((SELECT NOT pack_pull_checked FROM public.chain_arrival_probes WHERE nft_id = 5),
                  'A6: an unfinished probe is not marked');
  PERFORM _assert_eq((SELECT probes_unchecked FROM (SELECT (v->>'probes_unchecked') probes_unchecked) z), '0', 'A6: nothing left unchecked');

  -- A7: the flip lane finds 0xbb/7 was a Dapper delivery after all and re-finishes it
  UPDATE public.chain_arrival_probes
     SET from_address = '0xe1f2a091f7bb5245', tx_id = 'T9', arrived_at = '2025-01-05 00:00:00+00',
         finished_at = '2026-10-09 00:00:00+00'
   WHERE wallet = '0xbb' AND nft_id = 7;
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq((v->>'probes_checked') || '/' || (v->>'pack_pulls_inserted'), '1/1',
                     'A7: only the re-finished probe is read again, and written');
  PERFORM _assert((SELECT count(*) = 1 FROM public.moment_acquisitions WHERE wallet = '0xbb' AND nft_id = '7' AND transaction_hash = 'T9'),
                  'A7: the re-finished custodial pull is a pack pull');
  PERFORM _assert((SELECT count(*) = 1 FROM public.rebuild_calls WHERE wallet = '0xbb'), 'A7: and its wallet is rebuilt');

  -- A8: 2,500 new probes (2,499 bought, 1 custodial at the far end of the order) in one run
  INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status, arrived_height, arrived_at, tx_id, from_address, finished_at)
  SELECT '0xdd', 1000 + i, 0, 1, 'done', 600, '2025-02-01 00:00:00+00', 'TB' || i,
         CASE WHEN i = 2500 THEN '0xe1f2a091f7bb5245' ELSE '0x3333333333333333' END, now()
    FROM generate_series(1, 2500) i;
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq((v->>'probes_checked') || '/' || (v->>'pack_pulls_inserted') || '/' || (v->>'probes_unchecked'), '2500/1/0',
                     'A8: one run walks past a 2,000-probe chunk and reaches the last probe');

  PERFORM _assert((SELECT count(*) = 2 AND bool_and(rebuilt_at IS NOT NULL) FROM public.chain_arrival_rebuild_queue WHERE wallet IN ('0xaa', '0xcc')),
                  'A9: a rebuilt wallet is stamped, not left waiting');
  -- A9: a wallet an earlier run queued but did not reach
  INSERT INTO public.chain_arrival_rebuild_queue (wallet, queued_at) VALUES ('0xee', now() - interval '1 hour');
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq((v->>'wallets_rebuilt') || '/' || (v->>'wallets_queued'), '1/0', 'A9: the carried wallet is rebuilt and the queue empties');
  PERFORM _assert((SELECT count(*) = 1 FROM public.rebuild_calls WHERE wallet = '0xee'), 'A9: rebuilt once');
  -- A10: a wallet rebuilt earlier gets a new pull: queued again, rebuilt again
  INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status, arrived_height, arrived_at, tx_id, from_address, finished_at)
  VALUES ('0xaa', 11, 0, 1, 'done', 700, '2025-03-01 00:00:00+00', 'T10', '0xe1f2a091f7bb5245', now());
  v := public.apply_chain_arrival_pack_pulls();
  PERFORM _assert_eq((v->>'pack_pulls_inserted') || '/' || (v->>'wallets_rebuilt') || '/' || (v->>'wallets_queued'), '1/1/0',
                     'A10: a rebuilt wallet with a new pull is queued and rebuilt again');
  PERFORM _assert((SELECT count(*) = 2 FROM public.rebuild_calls WHERE wallet = '0xaa'), 'A10: 0xaa rebuilt twice in all');
  PERFORM _assert((SELECT count(*) = 6 AND bool_and(ok AND extra ? 'probes_unchecked' AND extra ? 'wallets_queued')
                     FROM public.pipeline_runs_stub WHERE pipeline = 'chain-arrival-pack-pulls'),
                  'every run logs its backlog (probes_unchecked, wallets_queued)');
END $$;

ROLLBACK;
