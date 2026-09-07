-- audit_20260907: Top Shot marketplace sales the on-chain indexer DROPS are written from the Atlas events --
-- the sales ledger has been missing ~70 % of Top Shot listing sales since the GraphQL host died.
--
-- MEASURED 2026-09-07 23:3xZ. `sales` (nba_top_shot) per day: ~4,200 on 08-23..25 (onchain ~2,500 +
-- topshot_gql ~1,300 + offer_fill ~450) -> ~1,000-1,600 since 08-29 (onchain ~550 + offer_fill ~700,
-- topshot_gql 0). Two things died with public-api.nbatopshot.com (~08-28): the GraphQL sales ingest
-- (/api/ingest, GHA rpc-pipeline.yml -- 5 of 5 runs 530 today) AND the on-chain indexer's GQL resolver
-- for nfts the wallet cache / moments tables do not know: `topshot-sales-indexer` today saw 1,894
-- sales, wrote 546 and SKIPPED 1,348 (`gql_resolved: 0`, `unresolved_count` ~21 per tick) -- and its
-- own source says what happens to those: "never written to `sales` and never parked in
-- `unmapped_sales`, and Step 7 advances the cursor anyway" (app/api/sales-indexer/route.ts).
-- Cross-check by the Atlas feed: of 1,334 nba listing sales Atlas saw in a 24-h window, 241 (18 %)
-- have a `sales` row for the nft within 3 days (225 at the same price). Every FMV on the platform reads
-- `sales`; "accuracy is the gate" (roadmap). This is the largest accuracy defect on the register today.
--
-- THE SOURCE. `topshot_atlas_market_events` (20260906203504) carries every marketplace sale the firehose
-- sees (kind='listing', purchased, price_cents, buyer, seller, nft_id, serial_number, atlas_edition_id
-- -> topshot_atlas_edition_map.rpc_edition_id, all 13,891 mapped editions canonical) -- ~1,100/day live,
-- plus the histories the edition verify lane walks (~100-300 older sales/day, back into August).
--
-- THE LANE. `sync_sales_from_atlas(p_max)`: walks the events behind a `last_seen_at` cursor
-- (backfill_state 'sales-atlas-sync'; each event examined once; bounded page), takes nba listing sales
-- with a mapped edition, a serial and a price, purchased more than 2 h ago (the on-chain indexer has had
-- its chance -- it writes or drops within its 20-min tick), and inserts a `sales` row (source 'atlas',
-- marketplace 'topshot', currency USD, sold_at = purchased_at, price_usd = price_cents/100, buyer +
-- seller, NO transaction_hash / block_height -- Atlas does not carry them) UNLESS a sales row for the
-- same nft already exists within +-10 min of the purchase (the indexer's, an offer fill, or this lane's
-- own row on a re-seen event). Nothing is guessed: no mapped edition or no serial -> counted `unmapped`,
-- not written. pg_cron `rpc-sales-atlas-sync` every 10 min at 6-59/10 (free minutes; stagger ban kept),
-- pipeline `sales-atlas-sync`, cadence watchlist 30/60 min. No HTTP calls -- nothing to wire into the
-- 4xx arm.
--
-- REVERT: SELECT cron.unschedule('rpc-sales-atlas-sync');
--         DROP FUNCTION public.sync_sales_from_atlas(int);
--         DROP INDEX public.idx_tame_sales_seen;
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'sales-atlas-sync';
--         DELETE FROM public.backfill_state WHERE id = 'sales-atlas-sync';
--         DELETE FROM public.sales WHERE source = 'atlas';   -- the rows this lane wrote, and only those

CREATE INDEX IF NOT EXISTS idx_tame_sales_seen
  ON public.topshot_atlas_market_events (product, last_seen_at)
  WHERE purchased AND kind = 'listing';

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
             CASE WHEN lower(c.seller_address) ~ '^0x[0-9a-f]{16}$' THEN lower(c.seller_address) END,
             CASE WHEN lower(c.buyer_address)  ~ '^0x[0-9a-f]{16}$' THEN lower(c.buyer_address)  END,
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

REVOKE ALL ON FUNCTION public.sync_sales_from_atlas(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_sales_from_atlas(int) TO service_role;

SELECT cron.schedule('rpc-sales-atlas-sync', '6-59/10 * * * *',
  $cron$ SELECT public.sync_sales_from_atlas(2000) $cron$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, is_active, notes)
VALUES ('sales-atlas-sync', 30, 60, 'medium', true,
        'pg_cron rpc-sales-atlas-sync every 10 min since 2026-09-07 (this migration): writes Top Shot listing sales the on-chain indexer dropped (no edition resolver since the GraphQL host died) from topshot_atlas_market_events into public.sales (source atlas). rows_written follows the market (~1,000/day); 0 is not a failure once caught up. Health is silence.')
ON CONFLICT (pipeline) DO NOTHING;
