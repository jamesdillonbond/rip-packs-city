-- audit_20261009_chain_arrival_pack_pulls_checks_each_probe_once
--
-- 2026-10-09 ~9:15 AM PT (Claude Code, cloud). The durable bound for rpc-chain-arrival-pack-pulls,
-- QUEUED P1 since 10-06 (5 nights wedged; hand-drained 10-06 and 10-07, drain declined 10-08/09).
--
-- MEASURED TODAY (rolled-back probes; nothing kept):
--   · every :41 tick since 10-07 died at the flat 120 s pg_cron statement_timeout (the function's
--     own SET statement_timeout='300s' is inert under pg_cron), CONTEXT in the rebuild's WITH pulls.
--   · backlog: 11 wallets / 2,506 Dapper deliveries (largest 842).
--   · the all-wallets INSERT alone took 54.1 s: it re-checks EVERY done Dapper probe ever found
--     (62,866 of 160,337 probes) against moment_acquisitions on each run, ~0.9 ms a probe through
--     idx_moment_acquisitions_nft_id + a heap filter. The same insert for one 842-delivery wallet
--     took 0.75 s; that wallet's rebuild 0.45 s; the largest wallet's (32,703 pulls) 4.5 s.
--   So the cost is the RE-CHECK of history, which grows with every probe ever finished, and then the
--   rebuild loop runs out what is left of 120 s and the whole run rolls back -- no progress, ever.
--
-- WHAT THIS DOES.
--   · chain_arrival_probes.pack_pull_checked / pack_pull_checked_finished_at: the finished_at value
--     this lane last checked a probe at. Every writer that finishes a probe or changes its sender sets
--     finished_at = now() (run_chain_arrival_lane, run_chain_arrival_flip_lane), so a probe is checked
--     again exactly when it finishes again; one changed mid-check keeps the OLD value and is re-read.
--     Partial index over the unchecked set, so a run reads only what finished since the last one.
--   · chain_arrival_rebuild_queue: a wallet that got new pack pulls waits here (rebuilt_at NULL) until
--     rebuilt, so a run that runs out of budget leaves the rest for the next tick instead of rolling
--     everything back. One row per wallet, stamped rather than deleted (no DELETE in the body: the
--     Supabase MCP held the first apply of this migration for confirmation and timed out).
--   · apply_chain_arrival_pack_pulls: checks 2,000 probes a chunk while < 45 s have passed, then
--     rebuilds queued wallets (oldest first) while < 75 s have passed -- ~45 s under the 120 s wall.
--     Each chunk inserts, queues and marks in ONE statement, so a probe is never marked unchecked-for.
--     Same eligibility as before (Dapper sender, arrived_at + tx_id, no existing pack-pull row, not a
--     known NFT pack's pull). No exception handler: any write error aborts the run, so a
--     pipeline_runs row exists only when every write landed. extra carries probes_unchecked and
--     wallets_queued, so a lane falling behind reads as a growing backlog, not a clean run.
--
-- FIRST RUNS: all 160,337 done probes start unchecked; ~97k non-Dapper ones are marked without a
-- lookup, the 62,866 Dapper ones cost the ~0.9 ms each. Expect ~2 ticks to drain the backlog and the
-- 11 pending wallets rebuilt over the first 1-2 ticks.
--
-- anon-exec: unchanged (apply_chain_arrival_pack_pulls) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) 7bd3ce9846028661a7dfc05f99f9c222 = the body
-- in 20260930180000, the newest migration defining this function.
--
-- REVERT: re-apply the apply_chain_arrival_pack_pulls block of
--   20260930180000_audit_20260930_custodial_pulls_0xfa57_is_a_dapper_delivery_source.sql verbatim, then
--   DROP TABLE public.chain_arrival_rebuild_queue;
--   DROP INDEX public.idx_chain_arrival_probes_pack_pull_unchecked;
--   ALTER TABLE public.chain_arrival_probes DROP COLUMN pack_pull_checked, DROP COLUMN pack_pull_checked_finished_at;
-- (the pre-fix body wedges again on the current backlog -- revert only to undo a defect).

ALTER TABLE public.chain_arrival_probes
  ADD COLUMN IF NOT EXISTS pack_pull_checked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pack_pull_checked_finished_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_chain_arrival_probes_pack_pull_unchecked
  ON public.chain_arrival_probes (wallet, nft_id)
  WHERE status = 'done' AND (NOT pack_pull_checked OR pack_pull_checked_finished_at IS DISTINCT FROM finished_at);

CREATE TABLE IF NOT EXISTS public.chain_arrival_rebuild_queue (
  wallet      text        PRIMARY KEY,
  queued_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  rebuilt_at  timestamptz   -- NULL = waiting; set when rebuilt (the table holds one row per wallet)
);
ALTER TABLE public.chain_arrival_rebuild_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.chain_arrival_rebuild_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.chain_arrival_rebuild_queue TO service_role;

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
