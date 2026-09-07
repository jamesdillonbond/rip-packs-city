-- audit_20260907: Atlas addresses carry no 0x prefix -- both Atlas-fed writers normalise them, and the rows already
-- written are repaired.
--
-- Found reading the first sales-atlas-sync page back: 586 rows, 0 with a buyer or seller. Every address in
-- topshot_atlas_market_events is 16 hex chars WITHOUT 0x (40,438 of 40,438 purchased listings), so a
-- `~ '^0x[0-9a-f]{16}$'` guard drops all of them -- and the wmc hydrator's Atlas arm (20260907152641), which
-- had no guard, wrote 1,773 `moments.owner_address` values without the prefix (exactly the rows that arm
-- resolved; 0 elsewhere in moments, wallet_moments_cache or sales). The ledger's convention is 0x-prefixed
-- lower-case, and every owner/buyer comparison on the platform assumes it.
--
-- `flow_addr_0x(text)`: NULL-safe, IMMUTABLE; accepts 16 hex chars with or without 0x, returns the
-- 0x-prefixed lower-case form, NULL for anything else. Both writers use it; the 1,773 moments rows are
-- prefixed in place and the 586 atlas sales rows get their buyer/seller from the events they came from.
--
-- REVERT: re-apply hydrate_topshot_moments_from_wmc from 20260907213736 and sync_sales_from_atlas from
--         20260907233444; DROP FUNCTION public.flow_addr_0x(text). (The repaired values are the same
--         addresses in the platform's own convention; nothing to restore.)

CREATE OR REPLACE FUNCTION public.flow_addr_0x(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN lower(p) ~ '^0x[0-9a-f]{16}$' THEN lower(p)
              WHEN lower(p) ~ '^[0-9a-f]{16}$'   THEN '0x' || lower(p)
         END
$$;
REVOKE ALL ON FUNCTION public.flow_addr_0x(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_addr_0x(text) TO service_role;

CREATE OR REPLACE FUNCTION public.hydrate_topshot_moments_from_wmc(p_scan int DEFAULT 15000)
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
  v_todo      int := 0;
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
    -- The page: the next p_scan pack-pull rows behind the cursor, RESOLVED OR NOT -- so a tick examines a
    -- bounded number of index rows however many of them are already named (the earlier "p_scan unresolved
    -- rows" page had to walk every already-named row at the top of each pass to find them: unbounded once
    -- the backlog is gone). The moments check is applied to the page afterwards.
    DROP TABLE IF EXISTS _hyd_raw;
    CREATE TEMP TABLE _hyd_raw ON COMMIT DROP AS
    SELECT ma.nft_id, ma.acquired_date
      FROM public.moment_acquisitions ma
     WHERE ma.collection_id = v_coll
       AND ma.acquisition_method = 'pack_pull'
       AND ma.acquisition_confidence = 'verified'
       AND (v_cur_date IS NULL OR (ma.acquired_date, ma.nft_id) < (v_cur_date, v_cur_nft))
     ORDER BY ma.acquired_date DESC, ma.nft_id DESC
     LIMIT p_scan;

    SELECT count(*) INTO v_scanned FROM _hyd_raw;

    SELECT p.acquired_date, p.nft_id INTO v_next_date, v_next_nft
      FROM _hyd_raw p ORDER BY p.acquired_date ASC, p.nft_id ASC LIMIT 1;

    DROP TABLE IF EXISTS _hyd_page;
    CREATE TEMP TABLE _hyd_page ON COMMIT DROP AS
    SELECT r.nft_id, r.acquired_date
      FROM _hyd_raw r
     WHERE NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = r.nft_id AND m.collection_id = v_coll);

    SELECT count(*) INTO v_todo FROM _hyd_page;

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
                   -- Atlas addresses come WITHOUT the 0x prefix (16 hex chars); the ledger's convention is 0x-prefixed.
                   public.flow_addr_0x(CASE WHEN ev.purchased THEN ev.buyer_address
                                            WHEN ev.kind = 'listing' THEN ev.seller_address END) AS owner_address,
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
    'topshot-moments-hydrate-wmc', v_started, v_scanned, v_written, GREATEST(v_todo - v_resolved, 0),
    v_err IS NULL, v_err, 'nba_top_shot', v_cursor,
    CASE WHEN v_wrapped THEN NULL ELSE v_next_date::text || '|' || v_next_nft END,
    jsonb_build_object('scanned', v_scanned, 'unresolved', v_todo, 'resolvable', v_resolved, 'written', v_written,
                       'wrapped', v_wrapped, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('scanned', v_scanned, 'unresolved', v_todo, 'resolvable', v_resolved, 'written', v_written,
                            'wrapped', v_wrapped, 'error', v_err);
END $$;

-- anon-exec: intentional — same signature as 20260907213736, ACLs preserved (hydrate_topshot_moments_from_wmc)

CREATE OR REPLACE FUNCTION public.sync_sales_from_atlas(p_max int DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_coll     uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_state_id text := 'sales-atlas-sync';
  v_cursor   timestamptz;
  v_upper    timestamptz := now() - interval '2 hours';
  v_examined int := 0; v_eligible int := 0; v_unmapped int := 0; v_dup int := 0; v_written int := 0;
  v_next     timestamptz;
  v_err      text;
BEGIN
  INSERT INTO public.backfill_state (id, cursor, total_ingested, status, notes)
  VALUES (v_state_id, NULL, 0, 'running',
          'Atlas nba listing sales -> public.sales; cursor = last_seen_at of the last event examined (events are examined once; sales are deduped by nft_id +- 10 min)')
  ON CONFLICT (id) DO NOTHING;
  SELECT NULLIF(cursor, '')::timestamptz INTO v_cursor FROM public.backfill_state WHERE id = v_state_id;

  BEGIN
    -- The page: the next p_max purchased listing events by last_seen_at, behind the cursor and at least
    -- 2 h old (an event seen more recently is left for a later tick, so the on-chain indexer's row, if
    -- it writes one, is already there to dedupe against).
    DROP TABLE IF EXISTS _sa_page;
    CREATE TEMP TABLE _sa_page ON COMMIT DROP AS
    SELECT ev.uuid, ev.nft_id, ev.serial_number, ev.price_cents, ev.buyer_address, ev.seller_address,
           ev.purchased_at, ev.last_seen_at, m.rpc_edition_id
      FROM public.topshot_atlas_market_events ev
      LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND ev.purchased
       AND ev.last_seen_at <= v_upper
       AND (v_cursor IS NULL OR ev.last_seen_at > v_cursor)
     ORDER BY ev.last_seen_at ASC
     LIMIT p_max;

    SELECT count(*), max(last_seen_at) INTO v_examined, v_next FROM _sa_page;

    -- Eligible: a mapped canonical edition, a real serial, a real price, a purchase time, a numeric nft id.
    DROP TABLE IF EXISTS _sa_cand;
    CREATE TEMP TABLE _sa_cand ON COMMIT DROP AS
    SELECT p.*
      FROM _sa_page p
     WHERE p.rpc_edition_id IS NOT NULL
       AND p.serial_number > 0
       AND p.price_cents > 0
       AND p.purchased_at IS NOT NULL
       AND p.purchased_at <= v_upper
       AND p.nft_id ~ '^[0-9]+$';
    SELECT count(*) INTO v_eligible FROM _sa_cand;
    v_unmapped := v_examined - v_eligible;

    -- Dedupe: any sales row for the same nft within +-10 min of the purchase means the sale is already
    -- in the ledger (the on-chain indexer, an offer fill, or this lane on a re-seen event).
    DELETE FROM _sa_cand c
     WHERE EXISTS (SELECT 1 FROM public.sales s
                    WHERE s.nft_id = c.nft_id AND s.collection_id = v_coll
                      AND s.sold_at BETWEEN c.purchased_at - interval '10 minutes'
                                        AND c.purchased_at + interval '10 minutes');
    GET DIAGNOSTICS v_dup = ROW_COUNT;

    WITH ins AS (
      INSERT INTO public.sales
        (id, moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
         seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at, ingested_at,
         nft_id, collection, source, payer_address, proposer_address)
      SELECT DISTINCT ON (c.nft_id, c.purchased_at)
             gen_random_uuid(), NULL, c.rpc_edition_id, v_coll, c.serial_number,
             round(c.price_cents / 100.0, 2), NULL, 'USD',
             public.flow_addr_0x(c.seller_address), public.flow_addr_0x(c.buyer_address),
             'topshot', NULL, NULL, c.purchased_at, now(),
             c.nft_id, 'nba_top_shot', 'atlas', NULL, NULL
        FROM _sa_cand c
       ORDER BY c.nft_id, c.purchased_at, c.last_seen_at DESC
      RETURNING 1)
    SELECT count(*) INTO v_written FROM ins;

    -- Advance the cursor past the page (a short page means the lane is caught up to now() - 2 h).
    UPDATE public.backfill_state
       SET cursor = COALESCE(v_next, v_cursor)::text, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_written, status = 'running'
     WHERE id = v_state_id;
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'sales-atlas-sync', v_started, v_examined, v_written, v_unmapped + v_dup,
    v_err IS NULL, v_err, 'nba_top_shot', v_cursor::text, COALESCE(v_next, v_cursor)::text,
    jsonb_build_object('examined', v_examined, 'eligible', v_eligible, 'unmapped', v_unmapped,
                       'already_in_sales', v_dup, 'written', v_written, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('examined', v_examined, 'eligible', v_eligible, 'unmapped', v_unmapped,
                            'already_in_sales', v_dup, 'written', v_written, 'error', v_err);
END $$;

-- anon-exec: intentional — same signature as 20260907233444, ACLs preserved (sync_sales_from_atlas)

-- Repair: the 1,773 owner addresses the Atlas arm wrote without the prefix.
UPDATE public.moments
   SET owner_address = '0x' || owner_address
 WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND owner_address ~ '^[0-9a-f]{16}$';

-- Repair: buyer / seller on the atlas sales rows, from the events they were written from.
UPDATE public.sales s
   SET buyer_address  = public.flow_addr_0x(ev.buyer_address),
       seller_address = public.flow_addr_0x(ev.seller_address)
  FROM public.topshot_atlas_market_events ev
 WHERE s.source = 'atlas'
   AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND ev.product = 'nba' AND ev.kind = 'listing' AND ev.purchased
   AND ev.nft_id = s.nft_id AND ev.purchased_at = s.sold_at
   AND s.buyer_address IS NULL AND s.seller_address IS NULL;
