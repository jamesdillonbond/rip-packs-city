-- ─────────────────────────────────────────────────────────────────────────────
-- jobid 464 `rpc-allday-unmapped-atlas-resolver`: sample the diagnostic, and
-- record a timeout kill instead of vanishing.
--
-- ── THE #124 TEST, RUN BEFORE TOUCHING ANYTHING ─────────────────────────────
-- The lane IS backlog-bound, so "shed the schedule" and "cut items per tick"
-- are both the WRONG direction — they would slow the drain:
--   open_unresolved 17,529 (09-19 20:00 PT) → 16,842 (09-20 09:00 PT)
--   = -687 in 13 h ≈ -53/h, i.e. ~13 days to clear at the current rate.
-- And the lane is losing most of its ticks: 65 of ~168 expected runs logged in
-- those 14 h (39 %). The function logs UNCONDITIONALLY on success, so the
-- missing 61 % are ticks killed at the 120 s wall before reaching the log.
--
-- ── WHERE THE BUDGET GOES ───────────────────────────────────────────────────
-- Not the probes. The final `open_unresolved` count is PURELY DIAGNOSTIC — it
-- exists only to publish a number into the run record — and measured 09-20
-- 09:55 PT it costs:
--   Execution Time: 33,105 ms · Buffers: shared hit=27046 read=4367
--   Index Scan on unmapped_sales_unresolved_idx: 74,219 rows scanned to keep
--   16,800 (Rows Removed by Filter: 57,419)
-- 33 s of a 120 s budget, ~12x an hour, to log a slow-moving stock.
--
-- ⚠ `p_probe_limit` was never the lever: it bounds LEG 2 only. Leg 1's bulk map
-- and this count are both unbounded by it. Same shape as
-- `atlas_listing_verify_tick`, where p_max bounds one of six steps.
--
-- ── THE FIX IS THE PRECEDENT ALREADY IN THIS FAMILY ─────────────────────────
-- `sync_ts_listings_from_atlas` carries exactly this problem and solved it: the
-- ~400k-row diagnostic counts are SAMPLED, and an unsampled tick publishes NULL
-- rather than 0. Copied here verbatim in spirit. The schedule is `4-59/5`, so
-- `minute % 30 < 5` fires on minutes 4 and 34 — twice an hour, as intended.
--
-- ⚠ NULL, NEVER 0. `open_unresolved` is a backlog depth; publishing 0 on an
-- unsampled tick would read as "the queue is clear" — a fabricated measurement
-- of exactly the kind the honesty rules ban. `diag_sampled` states which it is.
--
-- ── AND IT RECORDS ITS OWN KILLS NOW (R118) ─────────────────────────────────
-- This function had NO exception handler at all, so a statement-timeout kill
-- left nothing behind: no pipeline_runs row, no error, just a gap. That is why
-- the 61 % loss above had to be inferred from a row-count deficit instead of
-- being read off the instrument. `WHEN query_canceled OR OTHERS` now records it.
--
-- ⚠ The handler's TAIL must be cheap, because the statement timer is NOT
-- re-armed after the catch — that is the whole reason database.md's rule is
-- conditional. The tail here is one log_pipeline_run with NO counts in it;
-- sampling the diagnostic above is what makes that true.
--
-- Body is the live definition (md5 bc7f4d97bee3e32c60933b0c6a0c9351, read
-- immediately before this replace) with only those two changes.
--
-- EXIT: logged runs per hour rises from ~4.6 toward 12, and open_unresolved
--       falls faster than -53/h.
-- FALSIFIER: if logged runs stay near 4.6/h, the cost is leg 1's bulk map (a
--       DISTINCT ON over topshot_atlas_market_events with three correlated
--       EXISTS), not the diagnostic — measure that next, do not re-cut items.
-- REVERT: re-apply the prior body from md5 bc7f4d97bee3e32c60933b0c6a0c9351.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allday_resolve_unmapped_via_atlas(p_probe_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_started timestamptz := clock_timestamp();
  v_rows jsonb; v_mapped int := 0; v_probed int := 0; v_open int; v_open_30d int; v_inflight int;
  r record; v_req bigint;
  v_diag boolean := (extract(minute from clock_timestamp())::int % 30) < 5;
  v_err text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('allday_resolve_unmapped_via_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  BEGIN
    -- Leg 1: map every unresolved All Day nft the firehose (or a probe answer) has seen.
    SELECT jsonb_agg(jsonb_build_object('nft_id', x.nft_id, 'edition_external_id', x.atlas_edition_id, 'serial_number', x.serial_number))
      INTO v_rows
      FROM (
        SELECT DISTINCT ON (ev.nft_id) ev.nft_id, ev.atlas_edition_id, ev.serial_number
          FROM public.topshot_atlas_market_events ev
         WHERE ev.product = 'nfl' AND ev.nft_id IS NOT NULL AND ev.atlas_edition_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM public.unmapped_sales us
                        WHERE us.collection_id = c_allday AND us.resolved_at IS NULL AND us.nft_id = ev.nft_id)
           AND NOT EXISTS (SELECT 1 FROM public.nft_edition_map m
                            WHERE m.collection_id = c_allday AND m.nft_id = ev.nft_id AND m.edition_external_id = ev.atlas_edition_id)
           AND EXISTS (SELECT 1 FROM public.editions e WHERE e.collection_id = c_allday AND e.external_id = ev.atlas_edition_id)
         ORDER BY ev.nft_id, ev.last_seen_at DESC
      ) x;
    IF v_rows IS NOT NULL THEN
      v_mapped := public.upsert_nft_edition_map_batch(c_allday, v_rows);
    END IF;

    -- Leg 2: probe Atlas for unresolved nfts nothing has seen. Newest sale first.
    SELECT count(*) INTO v_inflight FROM public.topshot_atlas_market_requests
     WHERE product = 'nfl' AND offset_at = -2 AND drained_at IS NULL AND dispatched_at > now() - interval '10 minutes';
    FOR r IN
      SELECT us.nft_id, max(us.sold_at) AS newest_sale
        FROM public.unmapped_sales us
       WHERE us.collection_id = c_allday AND us.resolved_at IS NULL AND COALESCE(us.price_usd, 0) > 0
         AND us.nft_id ~ '^[0-9]{1,12}$'
         AND COALESCE(us.resolution_hint->>'promote_blocked', '') <> 'sales_tx_hash_unique_collision'
         AND NOT (us.resolution_hint ? 'atlas_probe_at' AND (us.resolution_hint->>'atlas_probe_at')::timestamptz > now() - interval '14 days')
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev WHERE ev.product = 'nfl' AND ev.nft_id = us.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.nft_edition_map m WHERE m.collection_id = c_allday AND m.nft_id = us.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q WHERE q.error = '__nft__' || us.nft_id AND q.drained_at IS NULL)
       GROUP BY us.nft_id
       ORDER BY max(us.sold_at) DESC
       LIMIT GREATEST(LEAST(p_probe_limit, 25) - v_inflight, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', 'nfl', 'nftId', r.nft_id, 'limit', 20),
        headers := public.atlas_market_headers('nfl'),
        timeout_milliseconds := 15000);
      INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error) VALUES (v_req, 'nfl', -2, '__nft__' || r.nft_id);
      UPDATE public.unmapped_sales
         SET resolution_hint = COALESCE(resolution_hint, '{}'::jsonb) || jsonb_build_object('atlas_probe_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
       WHERE collection_id = c_allday AND resolved_at IS NULL AND nft_id = r.nft_id;
      v_probed := v_probed + 1;
    END LOOP;

    -- Backlog depth. SAMPLED (minutes 4 and 34 on a 4-59/5 schedule): the scan
    -- is 74,219 rows / ~31k buffers / 33 s and the stock it measures moves by
    -- tens per hour, so paying it every tick bought nothing and cost the ticks
    -- themselves. An unsampled tick publishes NULL, never 0 — a 0 here would
    -- read as "the queue is clear".
    IF v_diag THEN
      SELECT count(*), count(*) FILTER (WHERE sold_at > now() - interval '30 days' AND sold_at < now() - interval '24 hours')
        INTO v_open, v_open_30d
        FROM public.unmapped_sales
       WHERE collection_id = c_allday AND resolved_at IS NULL AND COALESCE(price_usd, 0) > 0
         AND COALESCE(resolution_hint->>'promote_blocked', '') <> 'sales_tx_hash_unique_collision';
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    -- R118. Without this the kill left NO row at all and the lane's 61 % loss
    -- had to be inferred from a row-count deficit. Tail is deliberately one
    -- cheap insert: the statement timer is not re-armed after the catch.
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('allday-unmapped-atlas-resolver', v_started, v_probed, v_mapped,
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err,
    'nfl_all_day', NULL, NULL,
    jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                       'mapped_from_events', v_mapped, 'probes_dispatched', v_probed, 'probes_inflight_before', v_inflight,
                       'open_unresolved', v_open, 'open_unresolved_30d', v_open_30d, 'diag_sampled', v_diag, 'via', 'pg_cron',
                       'note', 'mapped rows are promoted into sales by promote_unmapped_sales on its next nfl_all_day drain (20-min gap)'));
  RETURN jsonb_build_object('mapped_from_events', v_mapped, 'probes_dispatched', v_probed,
                            'open_unresolved', v_open, 'open_unresolved_30d', v_open_30d,
                            'diag_sampled', v_diag, 'error', v_err);
END $function$;
