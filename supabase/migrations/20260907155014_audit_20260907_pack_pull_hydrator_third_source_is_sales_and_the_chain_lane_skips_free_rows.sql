-- audit_20260907: the pack-pull hydrator's third free source is our own sales ledger — and the chain lane stops
-- spending scripts on rows a free source will name.
--
-- Measured 2026-09-07 15:5xZ on the newest 20,000 queue rows: 1,132 (5.7 %) have a `sales` row carrying
-- edition_id + serial_number (every one a canonical edition; 1,125 with a buyer address) — and of the
-- chain lane's first 54 `no_nft` answers (the pull has left the puller's wallet), 22 are named by a sale.
-- A Moment that moved usually moved by selling; the sale is already in our ledger. Sales join by
-- `idx_sales_nft_id` per yearly partition; the `sold_at >= acquired_date - 1 day` predicate (true by
-- construction — a pull is the mint) lets the executor prune the partitions per row: 15.5K buffers for
-- the leg on a 5,000-row page (105K without it).
--
-- The chain dispatcher: its first two cron ticks spent 160 scripts newest-first, and ~34 % of the newest
-- rows are resolvable by wmc (23.7 %), the Atlas events (1.4 %) or sales (8.7 %) with no script at all.
-- Those rows are excluded from dispatch now (the same three predicates the hydrator resolves on), so
-- the 28.8K-script daily budget goes only to rows nothing else can name.
--
-- REVERT: re-apply hydrate_topshot_moments_from_wmc from 20260907152641 and
--         topshot_moment_hydrate_dispatch from 20260907153117.

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

    -- Resolve from three on-chain-derived sources, wallet cache first (its row names the current
    -- holder), then the Atlas marketplace events (a listing or sale carries the edition and serial;
    -- the owner is the seller or buyer of that event, whichever the event names last), then our
    -- own sales ledger.
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
            UNION ALL
            -- 3. our own sales ledger: a recorded sale of the nft names edition + serial; the latest buyer holds it.
            --    `sold_at >= acquired_date - 1 day` is true by construction (a pull is the mint) and lets the
            --    executor prune the yearly partitions per row (105K -> 15K buffers per 5,000-row page).
            SELECT p.nft_id, sl.edition_id, sl.serial_number,
                   CASE WHEN sl.buyer_address ~ '^0x[0-9a-f]{16}$' THEN sl.buyer_address END AS owner_address,
                   3 AS pri, sl.sold_at AS seen
              FROM _hyd_page p
              JOIN public.sales sl
                ON sl.nft_id = p.nft_id AND sl.collection_id = v_coll
               AND sl.edition_id IS NOT NULL AND sl.serial_number > 0
               AND sl.sold_at >= p.acquired_date - interval '1 day'
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

-- anon-exec: intentional — same signature as 20260907152641, ACLs preserved (hydrate_topshot_moments_from_wmc)

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch(p_max int DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record; v_req bigint; v_n int := 0;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  FOR r IN
    SELECT ma.nft_id, ma.wallet
      FROM public.moment_acquisitions ma
     WHERE ma.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND ma.acquisition_method = 'pack_pull'
       AND ma.acquisition_confidence = 'verified'
       AND ma.wallet ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = ma.nft_id AND m.collection_id = ma.collection_id)
       -- a row one of the free sources will name on its next pass is not worth a script
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
                       WHERE w.moment_id = ma.nft_id AND w.collection_id = ma.collection_id AND w.serial_number IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id AND m.rpc_edition_id IS NOT NULL
                       WHERE ev.product = 'nba' AND ev.nft_id = ma.nft_id AND ev.serial_number IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.sales sl
                       WHERE sl.nft_id = ma.nft_id AND sl.collection_id = ma.collection_id
                         AND sl.edition_id IS NOT NULL AND sl.serial_number > 0
                         AND sl.sold_at >= ma.acquired_date - interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM public.topshot_moment_hydrate_requests q
          WHERE q.nft_id = ma.nft_id
            AND q.dispatched_at > now() - CASE
                  WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                  WHEN q.outcome IS NULL THEN interval '10 minutes'   -- in flight
                  ELSE interval '1 day' END)
     ORDER BY ma.acquired_date DESC, ma.nft_id DESC
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
      body := jsonb_build_object(
        'script', v_script,
        'arguments', jsonb_build_array(
          encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
          encode(convert_to('{"type":"UInt64","value":"' || r.nft_id || '"}', 'UTF8'), 'base64'))),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet) VALUES (v_req, r.nft_id, r.wallet);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
-- anon-exec: intentional — same signature as 20260907153117, ACLs preserved (topshot_moment_hydrate_dispatch)
