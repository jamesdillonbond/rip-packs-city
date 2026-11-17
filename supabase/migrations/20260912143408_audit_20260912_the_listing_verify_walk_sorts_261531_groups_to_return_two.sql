-- audit_20260912: the listing-verify dispatcher grouped and sorted 261,531 nft_ids, every 2 minutes, to return TWO.
--
-- WHAT IT COST, measured 2026-09-12 ~07:2x PT with EXPLAIN (ANALYZE, BUFFERS) on production:
--   old  57,176 shared buffers + temp read 838 / written 1,570 (HashAggregate Batches: 5,
--        Disk Usage: 7,624 kB), 264,187 rows scanned, 261,531 groups, 424 ms — to emit 2 rows
--   new  54 shared buffers, no temp at all, 500 rows scanned, 2.2 ms
-- **1,059x fewer buffers**, and the spill to disk is gone. ⚠ Both readings were taken back to
-- back on the same warm cache WITH the new index already present, so 57,176 is the OLD QUERY'S
-- BEST CASE, not its production cost: before the index the same scan took its `last_seen_at` and
-- `nft_id` from the heap through `idx_tame_open_by_edition`. The rewrite's gain is understated
-- here on purpose — an A/B across two different index sets would not have been one measurement.
--
-- WHY IT MATTERED RIGHT NOW. This tick is the single largest consumer in the fleet. In the
-- UNCONTENDED window (02:00-06:00Z, where nothing is queuing) `rpc-ts-listings-atlas-sync`
-- burned 666 busy-seconds per hour out of 1,857 for all 117 pg_cron jobs combined — **36% of the
-- estate's quiet-window database work, from one job**. And it was the visible half of a live
-- saturation spell: at 14:4xZ `pg_stat_activity` showed 10 of 11 active backends in IO wait with
-- `atlas_listing_verify_tick(2)` 80 s in and waiting on **BuffileWrite** — that wait event IS the
-- 7.6 MB hash-aggregate spill this migration deletes. Over the 36 h to 14:20Z the job logged 502
-- failures against 576 successes, 252 of them naming `atlas_listing_verify_dispatch` in the error
-- context: it was timing out on this sort roughly half of every day and throwing the work away.
--
-- ⭐ THE ACTUAL ROOT IS A 428x POPULATION DRIFT, NOT A BAD QUERY. 20260907020428, which created
-- this function five days ago, states its own sizing in the header: "611 open nba listings at
-- write time ... 3 per 2-min tick is a full pass over ~600 listings in ~7 h". Today the same
-- predicate matches **264,187 rows over 261,531 distinct nft_ids**. The query was correct and
-- cheap when written. Nothing about it changed; the thing it walks grew 428-fold.
--
-- ⭐⭐ AND THE TRANSFERABLE HALF: 20260907055104 FIXED THIS EXACT SHAPE IN THE SIBLING FUNCTION
-- AND LOOKED STRAIGHT AT THIS ONE. Its header says, verbatim, "The listing dispatcher's
-- equivalent clause already planned with a Materialize node (11 ms) and is left alone." That was
-- TRUE and is STILL true — the in-flight anti-join is 6 buffers here. But it is a claim about the
-- ONE CLAUSE that was measured, and it got read ever after as a claim about the FUNCTION. The
-- clause nobody measured is the one that grew. **A scoped "measured, left alone" must name its
-- scope, because the next reader will not re-derive it** — this repo's "grep for the EXPRESSION,
-- not the file" lesson, reached from the other direction: the right file was already open.
--
-- THE FIX is CLAUDE.md's own prescribed remedy for a compounding queue walk, verbatim: "page a
-- BOUNDED slice of the INDEX behind a cursor, filter the page". The dispatcher wants the p_max
-- nft_ids with the OLDEST min(last_seen_at); walking the index ascending by `last_seen_at`, those
-- nft_ids are exactly the first ones encountered, so a 250*p_max-row slice of the index contains
-- every candidate that could win. Grouping and ordering then happen over 500 rows, not 264,187.
--
-- ⚠ EQUIVALENCE, stated rather than assumed. The slice returns the same top-p_max whenever it
-- holds at least p_max DISTINCT nft_ids. Measured today: 500 slice rows carry ~500 distinct
-- nft_ids (261,531 ids over 264,187 rows — relists are rare), so the margin is ~250x. In the
-- degenerate case where it did not hold, the tick dispatches FEWER probes; it can never dispatch
-- a WRONG one, and the next tick re-reads from the same cursor position. The in-flight exclusion
-- is applied INSIDE the slice, before the LIMIT, so an in-flight nft_id cannot displace a real
-- candidate out of the window. `p_max`, the ordering, the probe body, the `-3` / '__verify__'
-- request bookkeeping and the return shape are all unchanged.
--
-- ⛔ WHAT THIS DOES **NOT** FIX, said plainly so it is not read as an all-clear. The lane is now
-- fast but still 428x under-provisioned as a DELISTING DETECTOR: 2 probes x 720 ticks = 1,440/day
-- against 261,531 open listings is a full pass every **182 days**, where the design promised 7
-- hours. Readers are protected by `sync_ts_listings_from_atlas`'s own `last_seen_at > now() - 24h`
-- cut (a listing nobody re-verified simply stops being published), so this is a COVERAGE gap, not
-- a stale-price gap. Raising `p_max` is a separate decision with an Atlas rate-limit ceiling
-- attached (20260907020428 sizes total Atlas traffic at ~4.5 req/min against a burst challenge),
-- so it is filed, not shipped here. Two other clauses in the same tick walk the same 264K
-- population every 2 minutes -- `sync_ts_listings_from_atlas`'s two telemetry `count(*)`s
-- (`v_unmapped`, `v_unverified`) -- and are 68 of the 464 timeouts. Same class, separate change,
-- because that function carries a DB-invariant pin.
--
-- THE INDEX was built CONCURRENTLY on production at 07:2x PT before this file existed (12 MB) and
-- is recorded here IF NOT EXISTS so it is not fileless, per CLAUDE.md.
--
-- REVERT: re-apply the function body from 20260907020428 (the ungrouped-slice form);
--         DROP INDEX CONCURRENTLY public.idx_tame_open_listing_by_seen;

CREATE INDEX IF NOT EXISTS idx_tame_open_listing_by_seen
  ON public.topshot_atlas_market_events (product, last_seen_at, nft_id)
  WHERE kind = 'listing' AND NOT completed AND nft_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_dispatch(p_max int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; v_req bigint; v_n int := 0;
BEGIN
  FOR r IN
    WITH inflight AS MATERIALIZED (
      -- the probes dispatched in the last 10 min and not yet drained: 10-16 rows, read once
      SELECT q.error
        FROM public.topshot_atlas_market_requests q
       WHERE q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes'
    ), slice AS (
      -- the bounded window: the oldest-seen open listings, straight off
      -- idx_tame_open_listing_by_seen as an index-only scan. 250 rows of headroom per
      -- probe means the p_max oldest DISTINCT nft_ids are always inside it.
      SELECT ev.nft_id, ev.last_seen_at
        FROM public.topshot_atlas_market_events ev
        LEFT JOIN inflight i ON i.error = '__verify__' || ev.nft_id
       WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
         AND ev.nft_id IS NOT NULL
         AND i.error IS NULL
       ORDER BY ev.last_seen_at ASC
       LIMIT GREATEST(p_max, 0) * 250
    )
    SELECT s.nft_id, min(s.last_seen_at) AS seen
      FROM slice s
     GROUP BY s.nft_id
     ORDER BY min(s.last_seen_at) ASC
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', 'nba', 'nftId', r.nft_id, 'limit', 50),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
    VALUES (v_req, 'nba', -3, '__verify__' || r.nft_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
-- anon-exec: intentional -- same signature as 20260907020428, ACLs preserved (atlas_listing_verify_dispatch)
