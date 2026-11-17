-- audit_20260907: the pack-pull hydrator gains its second on-chain-derived source — the Atlas marketplace events.
--
-- After the first 26 ticks (34,854 rows) the wallet-cache source is draining as designed; 176,337
-- Top Shot pack pulls still wait. Measured 14:20Z: **2,478 of them appear in
-- `topshot_atlas_market_events`** with a serial and a mapped edition — a listing or a sale names the
-- edition and the serial exactly as a wallet walk does — and that number grows every day the feed
-- runs, so the queue keeps shrinking without any new call. Owner: the buyer of a purchase, the
-- seller of a listing (still the holder), NULL for an offer (an offer's `buyer_address` is the
-- bidder, not the owner — the batch writer accepts NULL). Wallet-cache rows win when both exist.
-- Same signature, same cursor, same writer; `resolvable` now counts both sources.
--
-- The remaining ~174K need an on-chain read (a `borrowMoment(id)` script on the puller's wallet via
-- the Flow REST API — the next lever, not built here).
--
-- REVERT: re-apply the body from 20260907051909 (wallet-cache source only).

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
    DROP TABLE IF EXISTS _hyd_page;
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

    -- Resolve from two on-chain-derived sources, wallet cache first (its row names the current
    -- holder), then the Atlas marketplace events (a listing or sale carries the edition and serial;
    -- the owner is the seller or buyer of that event, whichever the event names last).
    SELECT jsonb_agg(jsonb_build_object(
             'nft_id', r.nft_id, 'edition_id', r.edition_id,
             'serial_number', r.serial_number, 'owner_address', r.owner_address)),
           count(*)
      INTO v_payload, v_resolved
      FROM (
        SELECT DISTINCT ON (s.nft_id) s.nft_id, s.edition_id, s.serial_number, s.owner_address
          FROM (
            SELECT p.nft_id, e.id AS edition_id, w.serial_number, w.wallet_address AS owner_address,
                   1 AS pri, w.last_seen_at AS seen
              FROM _hyd_page p
              JOIN public.wallet_moments_cache w
                ON w.moment_id = p.nft_id AND w.collection_id = v_coll AND w.serial_number IS NOT NULL
              JOIN public.editions e
                ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
            UNION ALL
            SELECT p.nft_id, m.rpc_edition_id, ev.serial_number,
                   CASE WHEN ev.purchased THEN ev.buyer_address
                        WHEN ev.kind = 'listing' THEN ev.seller_address END AS owner_address,
                   2 AS pri, ev.last_seen_at AS seen
              FROM _hyd_page p
              JOIN public.topshot_atlas_market_events ev
                ON ev.product = 'nba' AND ev.nft_id = p.nft_id AND ev.serial_number IS NOT NULL
              JOIN public.topshot_atlas_edition_map m
                ON m.atlas_edition_id = ev.atlas_edition_id AND m.rpc_edition_id IS NOT NULL
          ) s
         ORDER BY s.nft_id, s.pri, s.seen DESC NULLS LAST
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

-- anon-exec: intentional — same signature as 20260907051909, ACLs preserved (hydrate_topshot_moments_from_wmc)
