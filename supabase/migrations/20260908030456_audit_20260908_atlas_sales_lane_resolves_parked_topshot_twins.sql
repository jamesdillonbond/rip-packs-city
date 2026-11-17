-- anon-exec: intentional — CREATE OR REPLACE with the SAME signature (p_max integer) preserves the existing ACL (service_role only, anon/authenticated EXECUTE false, verified post-apply) (sync_sales_from_atlas)
-- audit_20260908: the Atlas sales lane RESOLVES a parked Top Shot copy of the same sale instead of leaving
-- it for the promoter to duplicate.
--
-- WHY (found 2026-09-08 ~03:00Z, minutes after `83820bd8` shipped #67 (1)). Two writers now record the
-- same Top Shot listing sale: the on-chain indexer PARKS an unresolvable sale in `unmapped_sales`
-- (with its `transaction_hash`) and `promote_unmapped_sales` (pg_cron jobid 474, hourly) inserts it
-- once the nft resolves; `sync_sales_from_atlas` (jobid 471) writes the SAME sale from the Atlas feed
-- ~2 h after purchase — with `transaction_hash` NULL, because Atlas does not carry it. The promoter's
-- only duplicate guard is `ON CONFLICT DO NOTHING` on `idx_sales_tx_nft_sold`, which is PARTIAL
-- (`WHERE transaction_hash IS NOT NULL`), so an Atlas row can never conflict with a promoted row, and
-- the only cross-source twin trigger on `sales` (`trg_zzz_allday_cross_source_dedup`) is All Day only.
-- Order of events for a typical parked sale: parked within minutes → Atlas row at +2 h (its own
-- ±10 min nft dedupe finds nothing yet) → nft resolves via the hydrators → promoter inserts a SECOND
-- row. Every FMV reads `sales`; a duplicated sale is fabricated volume. Measured at filing: 0 parked
-- rows yet (the route half had just deployed), 0 duplicates — this closes the window before it opens.
--
-- THE FIX, in the lane that already dedupes: after inserting its rows, this function marks any OPEN
-- parked row for the same collection + nft within ±10 min of the written sale as RESOLVED
-- (`resolved_at`, `resolved_sale_id` = the Atlas row, a `resolution_hint` note), so the promoter never
-- sees it. The reverse race (promoter first, Atlas later) is already covered by the existing
-- ±10 min dedupe against `sales`. Nothing in `promote_unmapped_sales` or the route changes.
-- `unmapped_sales_resolver_targets_idx (collection_id, nft_id, sold_at) WHERE resolved_at IS NULL`
-- serves the join. New telemetry: `extra.parked_resolved`.
--
-- Body otherwise VERBATIM from 20260907233444 (the RETURNING now captures id/nft_id/sold_at).
--
-- REVERT: re-apply the function body from 20260907233444 (drops the parked-resolve step); rows it
-- already resolved stay resolved (they are recorded on the Atlas twin, which is the point).

CREATE OR REPLACE FUNCTION public.sync_sales_from_atlas(p_max integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
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
  v_parked   int := 0;
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
    -- in the ledger (the on-chain indexer, an offer fill, a PROMOTED parked row, or this lane on a
    -- re-seen event).
    DELETE FROM _sa_cand c
     WHERE EXISTS (SELECT 1 FROM public.sales s
                    WHERE s.nft_id = c.nft_id AND s.collection_id = v_coll
                      AND s.sold_at BETWEEN c.purchased_at - interval '10 minutes'
                                        AND c.purchased_at + interval '10 minutes');
    GET DIAGNOSTICS v_dup = ROW_COUNT;

    DROP TABLE IF EXISTS _sa_ins;
    CREATE TEMP TABLE _sa_ins ON COMMIT DROP AS
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
      RETURNING id, nft_id, sold_at)
    SELECT id, nft_id, sold_at FROM ins;
    SELECT count(*) INTO v_written FROM _sa_ins;

    -- A parked copy of a sale this lane just wrote (the on-chain indexer's Step 6b, #67 (1)) is the
    -- same sale: resolve it onto the Atlas row so `promote_unmapped_sales` never inserts a second one.
    WITH res AS (
      UPDATE public.unmapped_sales us
         SET resolved_at = now(),
             resolved_sale_id = i.id,
             resolution_hint = COALESCE(us.resolution_hint, '{}'::jsonb)
               || jsonb_build_object('resolved_by', 'sales-atlas-sync',
                                     'resolved_note', 'same nft sold within 10 min of the Atlas listing sale; that row is the sale, promoting this copy would have duplicated it')
        FROM _sa_ins i
       WHERE us.collection_id = v_coll
         AND us.resolved_at IS NULL
         AND us.nft_id = i.nft_id
         AND us.sold_at BETWEEN i.sold_at - interval '10 minutes' AND i.sold_at + interval '10 minutes'
      RETURNING 1)
    SELECT count(*) INTO v_parked FROM res;

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
                       'already_in_sales', v_dup, 'written', v_written, 'parked_resolved', v_parked, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('examined', v_examined, 'eligible', v_eligible, 'unmapped', v_unmapped,
                            'already_in_sales', v_dup, 'written', v_written, 'parked_resolved', v_parked, 'error', v_err);
END $$;
