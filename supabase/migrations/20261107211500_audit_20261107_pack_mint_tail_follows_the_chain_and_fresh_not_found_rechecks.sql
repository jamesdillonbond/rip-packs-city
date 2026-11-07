-- audit_20261107_pack_mint_tail_follows_the_chain_and_fresh_not_found_rechecks — 2026-11-07 (Cowork cloud, ~1:15 PM PT).
--
-- WHAT WAS WRONG (Trevor's own binder, 2026-11-07 noon PT): the 15 Top Shot packs he withdrew on
-- 11-06 12:08 PM PT rendered "Pack #057550 · Sealed · distribution not recorded until opened or
-- resold" with no buy price, a day later. Measured:
--   * Dapper Studio's searchPackNft (#218, frozen since ~10-29) answers `not_found` for every pack
--     minted after the freeze. Five of the fifteen are dist 8920, minted 11-05 11:10 AM PT
--     (1,500 mints in blocks 170151715–170151718, read from Flow directly). The other ten ARE in
--     Studio's index (dists 8779 / 8794 / 8796, older drops) — only their owner is stale — but our
--     `not_found` rows for them (checked 11-06 1:38 PM PT, 30 min after the withdraw, before the
--     index had them) are re-asked only after THREE DAYS (`retry_stale_pack_identity_not_found`).
--   * The chain-side resolver (`enqueue_mint_probes_for_unindexed_packs`, 11-02) finds a pack's mint
--     by bracketing its id between KNOWN-TIME neighbours. Top Shot pack ids are random 64-bit, so a
--     brand-new drop has no neighbours: every hourly run since 11-02 reads `too_wide 148 ·
--     bracketed 0 · probes_enqueued 0`, and `pack_nft_mints` stopped at 10-29 6:26 PM PT. Dist
--     8920 is therefore absent from `pack_distributions` too (discovery reads purchases/rips).
--
-- WHAT THIS DOES.
--   1. `enqueue_pack_mint_tail_probes(p_max)` — a FORWARD TAIL. Keeps one cursor per collection in
--      `pack_mint_tail_state.next_probe_at` and enqueues a probe every 3 minutes from the cursor up to
--      now() − 5 min (p_max per run, default 60 → 3 h of chain per run; catch-up 12× real time). The
--      existing lane (`run_pack_mint_probe_lane`) reads 250 blocks (~200 s at 1.25 blocks/s) around
--      each instant, so 3-minute spacing is contiguous coverage with overlap, exactly the spacing the
--      bracket resolver already uses. Every Top Shot PackNFT.Minted from the cursor on lands in
--      `pack_nft_mints`, `fill_pack_dist_from_chain_mints` (:47) stamps purchases/rips, and
--      `discover_missing_topshot_pack_distributions` creates the dist row. Nothing depends on
--      Studio's index. Steady state ≈ 480 probes/day against a dispatch budget of 25/tick/node.
--      Top Shot only (its distribution lives ONLY on the Minted event; All Day's is read from
--      Studio's pack index by `run_pack_index_mint_lane`). The cursor starts at 2026-10-30 02:25 UTC,
--      just past the last contiguous probe window (the 8911 batch), so the 10-30 → 11-07 gap is
--      walked newest-first (the lane orders pending probes by probe_at DESC).
--   2. `retry_fresh_pack_identity_not_found(p_limit)` — a `not_found` identity row for a pack this
--      platform saw MOVE in the last 7 days (a purchase, sale or rip) is re-asked after 2 hours, not
--      3 days; the daily 3-day retry stays for everything else. Hourly at :23.
--   Both log to pipeline_runs (`pack-mint-tail`, `retry-fresh-pack-identity`).
--
-- Pins: supabase/tests/enqueue_pack_mint_tail_probes.sql (registered in db-invariants-drift-guard).
--
-- anon-exec: revoked (enqueue_pack_mint_tail_probes) — maintenance, writes; pg_cron/postgres only.
-- anon-exec: revoked (retry_fresh_pack_identity_not_found) — maintenance, deletes + dispatches; pg_cron/postgres only.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-pack-mint-tail'); SELECT cron.unschedule('rpc-retry-fresh-pack-identity');
--   DROP FUNCTION public.enqueue_pack_mint_tail_probes(integer);
--   DROP FUNCTION public.retry_fresh_pack_identity_not_found(integer);
--   DROP TABLE public.pack_mint_tail_state;
--   (probes already enqueued are harmless: `DELETE FROM pack_mint_probes WHERE priority = 3 AND status = 'pending'` clears the rest.)

CREATE TABLE IF NOT EXISTS public.pack_mint_tail_state (
  collection_id uuid PRIMARY KEY,
  next_probe_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pack_mint_tail_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pack_mint_tail_state FROM PUBLIC, anon, authenticated;

-- The cursor: just past the last contiguous probe window (8911's batch, 10-29 6:25–7:22 PM PT).
INSERT INTO public.pack_mint_tail_state (collection_id, next_probe_at)
VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '2026-10-30 02:25:00+00')
ON CONFLICT (collection_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enqueue_pack_mint_tail_probes(p_max integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_max int := greatest(0, least(coalesce(p_max, 60), 600));
  v_step constant interval := interval '3 minutes';
  -- the chain is read a few minutes behind the head so a window never asks for blocks not yet sealed
  v_horizon timestamptz := now() - interval '5 minutes';
  v_total int := 0;
  v_detail jsonb := '[]'::jsonb;
  r record;
  v_last timestamptz;
  v_n int;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('enqueue_pack_mint_tail_probes')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  FOR r IN SELECT collection_id, next_probe_at FROM public.pack_mint_tail_state ORDER BY collection_id LOOP
    IF v_max = 0 OR r.next_probe_at > v_horizon THEN
      v_detail := v_detail || jsonb_build_object('collection_id', r.collection_id, 'enqueued', 0, 'next_probe_at', r.next_probe_at);
      CONTINUE;
    END IF;

    WITH inst AS (
      SELECT g AS probe_at
      FROM generate_series(r.next_probe_at, v_horizon, v_step) g
      ORDER BY g
      LIMIT v_max
    ), ins AS (
      INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority)
      SELECT r.collection_id, probe_at, 3 FROM inst
      ON CONFLICT (collection_id, probe_at) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins), (SELECT max(probe_at) FROM inst) INTO v_n, v_last;

    -- The cursor advances past every instant OFFERED (a conflict means that instant is already
    -- covered by an earlier probe), never past one it has not offered.
    UPDATE public.pack_mint_tail_state
       SET next_probe_at = v_last + v_step, updated_at = now()
     WHERE collection_id = r.collection_id;

    v_total := v_total + v_n;
    v_detail := v_detail || jsonb_build_object('collection_id', r.collection_id, 'enqueued', v_n,
                                              'offered_through', v_last, 'next_probe_at', v_last + v_step);
  END LOOP;

  PERFORM public.log_pipeline_run('pack-mint-tail', v_started, v_total, v_total, 0, true, NULL,
                                  NULL, NULL, NULL,
                                  jsonb_build_object('enqueued', v_total, 'horizon', v_horizon, 'collections', v_detail));
  RETURN jsonb_build_object('ok', true, 'enqueued', v_total, 'horizon', v_horizon, 'collections', v_detail);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.enqueue_pack_mint_tail_probes(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_pack_mint_tail_probes(integer) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.retry_fresh_pack_identity_not_found(p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '30s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ids text[];
  v_res jsonb;
BEGIN
  -- A pack that MOVED this week (bought, sold or opened on chain) and still reads not_found in
  -- Dapper's index is usually an index that lags the chain by hours, not a pack the index will
  -- never know: ask again after 2 h. Everything else keeps the 3-day cadence.
  WITH fresh AS (
    SELECT pi.collection_id, pi.pack_nft_id
    FROM public.pack_nft_identity pi
    WHERE pi.status = 'not_found'
      AND pi.checked_at < now() - interval '2 hours'
      AND (EXISTS (SELECT 1 FROM public.pack_purchases pp
                    WHERE pp.collection_id = pi.collection_id AND pp.pack_nft_id = pi.pack_nft_id
                      AND pp.sealed_at > now() - interval '7 days')
        OR EXISTS (SELECT 1 FROM public.pack_rips r
                    WHERE r.collection_id = pi.collection_id AND r.pack_nft_id = pi.pack_nft_id
                      AND r.sealed_at > now() - interval '7 days'))
    ORDER BY pi.checked_at
    LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
  ), del AS (
    DELETE FROM public.pack_nft_identity pi
    USING fresh f
    WHERE pi.collection_id = f.collection_id AND pi.pack_nft_id = f.pack_nft_id AND pi.status = 'not_found'
    RETURNING pi.pack_nft_id
  )
  SELECT array_agg(pack_nft_id) INTO v_ids FROM del;

  IF v_ids IS NULL THEN
    PERFORM public.log_pipeline_run('retry-fresh-pack-identity', v_started, 0, 0, 0, true, NULL, NULL, NULL, NULL,
                                    jsonb_build_object('retried', 0));
    RETURN jsonb_build_object('ok', true, 'retried', 0);
  END IF;
  v_res := public.dispatch_pack_nft_identity(least(10, (cardinality(v_ids) + 99) / 100), 100, v_ids);
  PERFORM public.log_pipeline_run('retry-fresh-pack-identity', v_started, cardinality(v_ids), cardinality(v_ids), 0, true, NULL, NULL, NULL, NULL,
                                  jsonb_build_object('retried', cardinality(v_ids), 'dispatch', v_res));
  RETURN jsonb_build_object('ok', true, 'retried', cardinality(v_ids), 'dispatch', v_res);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.retry_fresh_pack_identity_not_found(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retry_fresh_pack_identity_not_found(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-pack-mint-tail', '1-56/5 * * * *', $cron$SELECT public.enqueue_pack_mint_tail_probes(60)$cron$);
SELECT cron.schedule('rpc-retry-fresh-pack-identity', '23 * * * *', $cron$SELECT public.retry_fresh_pack_identity_not_found(200)$cron$);
