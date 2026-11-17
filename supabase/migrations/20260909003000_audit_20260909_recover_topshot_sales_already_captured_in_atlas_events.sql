-- 20260909003000_audit_20260909_recover_topshot_sales_already_captured_in_atlas_events
--
-- 81,337 completed Top Shot listing sales are ALREADY IN THIS DATABASE, in
-- `topshot_atlas_market_events`, with no `sales` row. Recovering them costs ZERO Atlas reads —
-- the firehose already paid for them.
--
-- WHY THIS MATTERS TO USERS, measured 2026-09-09: **7,071 of them fall inside the live 30-day FMV
-- window, across 2,418 distinct editions.** FMV confidence is a count over that window (MEDIUM >= 5
-- sales, HIGH >= 7), and **722 canonical Top Shot editions currently sit exactly ONE sale short of
-- MEDIUM** with another 1,105 two short of HIGH. Accuracy is the roadmap's GATE, so sales we already
-- hold and have not written are the cheapest accuracy on the board.
--
-- ⛔⛔ THE GUARD IS THE WHOLE MIGRATION, AND THE OBVIOUS ONE IS WRONG. The live lane
-- `sync_sales_from_atlas` dedupes on "no `sales` row for this nft within ±10 min". Applied to this
-- BACKFILL that guard is unsafe, and the check that proved it: **4,644 candidates matched a row the
-- 2026-09-08 #68 dedup had just DELETED.** Inserting them would have silently re-added rows another
-- session removed hours earlier and re-inflated the go-live metric with duplicates — the exact harm
-- #68 existed to fix.
--
-- ⭐ Why ±10 min fails HERE but not there: #68's duplicate pairs share tx/nft/price and differ in
-- `sold_at`, because two writers disagreed about the clock. Atlas's `purchased_at` lines up with the
-- DELETED (`topshot_gql`) row's timestamp, while the SURVIVING on-chain row sits further away — so a
-- ±10 min probe finds nothing live, and the candidate looks free when it is the same sale.
--
-- ⭐ THE KEY THAT WORKS, chosen by measurement not intuition. On a 2,000-row sample of exactly those
-- dangerous candidates:
--
--     (nft_id, price)            caught 1,542 / 2,000   (77%)  -- insufficient
--     (nft_id, sold_at::date)    caught 2,000 / 2,000   (100%) -- used here
--
-- ⚠ AND ITS DIRECTION IS A COST ARGUMENT, stated rather than assumed. The day key is CONSERVATIVE:
-- a genuine same-day re-sale of the same Moment is skipped (they exist — one measured this session
-- sold twice 94 s apart at $0.30 then $1.00). Failing that way loses some real sales, which stay
-- recoverable later. Failing the other way puts duplicates into the table every FMV reads and makes
-- the accuracy metric look BETTER than reality. **Under-counting our own accuracy is the safe
-- direction; inflating it is not.**
--
-- ⚠ INTRA-STATEMENT SELF-DUPLICATION, handled: `NOT EXISTS` is evaluated against the snapshot at
-- statement start, so two candidate events for the same (nft, day) would BOTH insert — the guard
-- cannot see rows its own statement is writing. `DISTINCT ON (nft_id, purchased_at::date)` collapses
-- them first, keeping the newest.
--
-- ⚠ The LIVE lane was checked and is NOT affected: of 8,854 `source='atlas'` rows, **0** have a
-- ±10 min non-atlas twin and only **64 (0.7%)** have a same-day one, some of which are real
-- re-sales. Its ±10 min guard is fine for forward traffic, which only ever meets same-clock rows.
-- No change is made to it here.
--
-- REVERT, deliberately trivial: rows land with `source = 'atlas_backfill'`, distinct from the live
-- lane's `'atlas'`, so
--     DELETE FROM public.sales WHERE collection = 'nba_top_shot' AND source = 'atlas_backfill';
-- removes exactly this migration's writes and nothing else.
--
-- anon-exec: REVOKEd below explicitly — this is a NEW function that writes to `sales`, so it must
-- never be anon/authenticated reachable.

CREATE OR REPLACE FUNCTION public.backfill_topshot_sales_from_atlas_events(
  p_max   integer     DEFAULT 2000,
  p_since timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_cid      uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_written  integer := 0;
  v_remain   bigint;
BEGIN
  WITH cand AS (
    -- newest first: the 30-day FMV window is what moves confidence, so it drains first.
    SELECT DISTINCT ON (ev.nft_id, ev.purchased_at::date)
           ev.nft_id, ev.serial_number, ev.purchased_at,
           (ev.price_cents / 100.0)::numeric AS price,
           ev.seller_address, ev.buyer_address, m.rpc_edition_id
      FROM public.topshot_atlas_market_events ev
      JOIN public.topshot_atlas_edition_map m
        ON m.atlas_edition_id = ev.atlas_edition_id AND m.rpc_edition_id IS NOT NULL
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND ev.completed IS TRUE
       AND ev.nft_id IS NOT NULL AND ev.serial_number IS NOT NULL
       AND ev.price_cents > 0 AND ev.purchased_at IS NOT NULL
       AND (p_since IS NULL OR ev.purchased_at >= p_since)
       AND NOT EXISTS (
             SELECT 1 FROM public.sales s
              WHERE s.collection = 'nba_top_shot'
                AND s.nft_id = ev.nft_id
                AND s.sold_at::date = ev.purchased_at::date)
     ORDER BY ev.nft_id, ev.purchased_at::date, ev.purchased_at DESC
     LIMIT GREATEST(p_max, 0)
  ), ins AS (
    INSERT INTO public.sales
      (id, edition_id, collection_id, collection, nft_id, price_usd, serial_number,
       sold_at, marketplace, source, seller_address, buyer_address, ingested_at)
    SELECT gen_random_uuid(), c.rpc_edition_id, v_cid, 'nba_top_shot', c.nft_id, c.price,
           c.serial_number, c.purchased_at, 'topshot', 'atlas_backfill',
           public.flow_addr_0x(c.seller_address), public.flow_addr_0x(c.buyer_address), now()
      FROM cand c
    RETURNING 1
  )
  SELECT count(*) INTO v_written FROM ins;

  SELECT count(*) INTO v_remain
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m
      ON m.atlas_edition_id = ev.atlas_edition_id AND m.rpc_edition_id IS NOT NULL
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND ev.completed IS TRUE
     AND ev.nft_id IS NOT NULL AND ev.serial_number IS NOT NULL
     AND ev.price_cents > 0 AND ev.purchased_at IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM public.sales s
            WHERE s.collection = 'nba_top_shot'
              AND s.nft_id = ev.nft_id
              AND s.sold_at::date = ev.purchased_at::date);

  PERFORM public.log_pipeline_run('topshot-sales-atlas-backfill', v_started,
    v_written, v_written, 0, true, NULL, 'nba-top-shot', NULL, NULL,
    jsonb_build_object('written', v_written, 'remaining', v_remain,
                       'since', p_since, 'max', p_max));

  RETURN jsonb_build_object('ok', true, 'written', v_written, 'remaining', v_remain);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.backfill_topshot_sales_from_atlas_events(integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
