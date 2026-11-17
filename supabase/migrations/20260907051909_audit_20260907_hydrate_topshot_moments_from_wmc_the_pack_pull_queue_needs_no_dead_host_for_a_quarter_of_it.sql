-- audit_20260907: Top Shot pack-pull moments are hydrated from wallet_moments_cache — no external call.
--
-- WHY. `topshot-moments-hydrator` (Cloudflare worker, cron-job.org, INACTIVE since 2026-08-30) filled
-- public.moments for pack-pulled Top Shot moments (v_moments_needing_hydration: pack_pull + verified
-- acquisitions with no moments row) by asking public-api.nbatopshot.com for each nft's serial +
-- set/play ids. That host answers 530 since ~08-28; the queue is 212,479 rows and growing with every
-- pack opened, and every pack-history surface that names what was pulled reads `moments`.
--
-- Measured 2026-09-07 04:20Z: 50,414 of those 212,479 nfts (23.7%) already sit in
-- wallet_moments_cache with a serial_number and an edition_key that resolves to an editions row —
-- the wallet backfills walked them on-chain. Hydrating those is a join, not a fetch. (Only 1,858 are
-- in the Atlas marketplace events — a freshly pulled moment has no marketplace history — so Atlas is
-- NOT the source for this queue; the on-chain read via wmc is.)
--
-- `hydrate_topshot_moments_from_wmc(p_scan)` walks the hydration queue newest-first behind a
-- (acquired_date, nft_id) cursor in backfill_state (id 'topshot-moments-hydrate-wmc'), resolves the
-- page against wmc (latest-seen row per nft) → editions, and writes through the EXISTING
-- `replace_topshot_moments_batch(payload)` — the same dual-constraint writer the worker used, so the
-- parallel→base serial redirect (P8) and the (edition, serial) / nft_id conflict handling are
-- unchanged. When a pass reaches the end of the queue the cursor wraps to NULL and the next tick
-- starts a new pass from the newest row, so new pulls AND newly-walked wallets are picked up on the
-- following pass. Rows still unresolvable stay in the queue for the worker (or an on-chain port) —
-- this function never fabricates a row.
--
-- Measured shape (EXPLAIN ANALYZE, 5,000-row page): 2.7 s, 37.7K buffers (5.3K cold), 1,342 rows
-- resolvable — idx_ma_hydration_queue_desc (queue) + idx_wmc_moment_collection_cover (covering) +
-- editions_external_id_collection_id_key. Three ticks an hour at 5,000 = a full pass in ~14 h.
--
-- pg_cron `rpc-topshot-moments-hydrate-wmc` at 19,35,55 (all free minutes; the stagger ban 0/1/20/21/
-- 40/41 respected). Pipeline `topshot-moments-hydrate-wmc` (a NEW name — the paused worker's
-- suppression predicates name `topshot-moments-hydrator` and must keep meaning that).
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-moments-hydrate-wmc');
--         DROP FUNCTION public.hydrate_topshot_moments_from_wmc(int);
--         DELETE FROM public.backfill_state WHERE id = 'topshot-moments-hydrate-wmc';
--         (moments rows written are correct on-chain facts; nothing to restore.)

CREATE OR REPLACE FUNCTION public.hydrate_topshot_moments_from_wmc(p_scan int DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_coll      uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_state_id  text := 'topshot-moments-hydrate-wmc';
  v_cursor    text;
  v_cur_date  timestamptz;
  v_cur_nft   text;
  v_scanned   int := 0;
  v_resolved  int := 0;
  v_written   int := 0;
  v_next_date timestamptz;
  v_next_nft  text;
  v_wrapped   boolean := false;
  v_payload   jsonb;
  v_err       text;
BEGIN
  INSERT INTO public.backfill_state (id, cursor, total_ingested, status, notes)
  VALUES (v_state_id, NULL, 0, 'running',
          'Top Shot pack-pull moments hydrated from wallet_moments_cache; cursor = <acquired_date>|<nft_id> of the last scanned row, NULL = start a new pass from the newest')
  ON CONFLICT (id) DO NOTHING;

  SELECT cursor INTO v_cursor FROM public.backfill_state WHERE id = v_state_id;
  IF v_cursor IS NOT NULL AND v_cursor <> '' THEN
    v_cur_date := split_part(v_cursor, '|', 1)::timestamptz;
    v_cur_nft  := split_part(v_cursor, '|', 2);
  END IF;

  BEGIN
    -- The page: newest-first walk of the hydration queue behind the cursor.
    CREATE TEMP TABLE _hyd_page ON COMMIT DROP AS
    SELECT ma.nft_id, ma.acquired_date
      FROM public.moment_acquisitions ma
     WHERE ma.collection_id = v_coll
       AND ma.acquisition_method = 'pack_pull'
       AND ma.acquisition_confidence = 'verified'
       AND (v_cur_date IS NULL OR (ma.acquired_date, ma.nft_id) < (v_cur_date, v_cur_nft))
       AND NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = ma.nft_id AND m.collection_id = ma.collection_id)
     ORDER BY ma.acquired_date DESC, ma.nft_id DESC
     LIMIT p_scan;

    SELECT count(*) INTO v_scanned FROM _hyd_page;

    SELECT p.acquired_date, p.nft_id INTO v_next_date, v_next_nft
      FROM _hyd_page p ORDER BY p.acquired_date ASC, p.nft_id ASC LIMIT 1;

    -- Resolve against the wallet cache: the latest-seen row per nft, its edition, its serial.
    SELECT jsonb_agg(jsonb_build_object(
             'nft_id', r.nft_id, 'edition_id', r.edition_id,
             'serial_number', r.serial_number, 'owner_address', r.wallet_address)),
           count(*)
      INTO v_payload, v_resolved
      FROM (
        SELECT DISTINCT ON (p.nft_id) p.nft_id, e.id AS edition_id, w.serial_number, w.wallet_address
          FROM _hyd_page p
          JOIN public.wallet_moments_cache w
            ON w.moment_id = p.nft_id AND w.collection_id = v_coll AND w.serial_number IS NOT NULL
          JOIN public.editions e
            ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
         ORDER BY p.nft_id, w.last_seen_at DESC NULLS LAST
      ) r;

    IF v_resolved > 0 THEN
      v_written := public.replace_topshot_moments_batch(v_payload);
    END IF;

    -- Advance, or wrap when the queue is exhausted for this pass.
    IF v_scanned < p_scan THEN
      v_wrapped := true;
      UPDATE public.backfill_state
         SET cursor = NULL, last_run_at = now(), total_ingested = COALESCE(total_ingested, 0) + v_written,
             status = 'running'
       WHERE id = v_state_id;
    ELSE
      UPDATE public.backfill_state
         SET cursor = v_next_date::text || '|' || v_next_nft, last_run_at = now(),
             total_ingested = COALESCE(total_ingested, 0) + v_written, status = 'running'
       WHERE id = v_state_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-moments-hydrate-wmc', v_started, v_scanned, v_written, GREATEST(v_scanned - v_resolved, 0),
    v_err IS NULL, v_err, 'nba_top_shot', v_cursor,
    CASE WHEN v_wrapped THEN NULL ELSE v_next_date::text || '|' || v_next_nft END,
    jsonb_build_object('scanned', v_scanned, 'resolvable', v_resolved, 'written', v_written,
                       'wrapped', v_wrapped, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('scanned', v_scanned, 'resolvable', v_resolved, 'written', v_written,
                            'wrapped', v_wrapped, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.hydrate_topshot_moments_from_wmc(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hydrate_topshot_moments_from_wmc(int) TO service_role;

SELECT cron.schedule('rpc-topshot-moments-hydrate-wmc', '19,35,55 * * * *',
  $cron$ SELECT public.hydrate_topshot_moments_from_wmc(5000) $cron$);
