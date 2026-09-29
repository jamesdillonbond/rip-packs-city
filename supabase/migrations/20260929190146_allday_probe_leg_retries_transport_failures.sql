-- anon-exec: intentional — CREATE OR REPLACE of an existing SECURITY DEFINER pipeline function, same signature (ACLs preserved: anon/authenticated EXECUTE false, service_role true) (allday_resolve_unmapped_via_atlas)
-- 2026-09-29: All Day leg 2's 14-day "already probed" stamp must not be earned by a probe that never
-- reached Atlas — the fix 20260908190033 made for Top Shot, which named this lane as carrying the same
-- flaw and left it.
--
-- WHY NOW. Since ~4–5 AM PT 09-29 30–50 % of every Atlas lane's requests come back as the Cloudflare
-- challenge (HTTP 403 "Just a moment…"). This lane stamps `atlas_probe_at` at DISPATCH, so each 403'd nft
-- was parked for 14 days behind a request that never arrived upstream — while 10k All Day rows priced
-- today (multi-NFT recovery) wait on exactly this resolver for an edition.
--
-- WHAT (identical in shape to the Top Shot fix). Record the pg_net request id at dispatch
-- (`resolution_hint.atlas_probe_req`) and let the stamp bind only while that response is not a recorded
-- failure:  eligible again <=> the response exists AND (status <> 200 OR timed_out). A missing / aged-out
-- response honours the stamp (spends no upstream budget). ⛔ The request row cannot carry this:
-- atlas_market_drain() overwrites its `__nft__<id>` marker with the error text on any non-200.
-- Deliberately NOT ported: Top Shot's `v_retried` census — here it would be a full scan of the open
-- backlog every tick, the exact cost 20260920171500 sampled away.
--
-- Built on the LIVE prosrc read 2026-09-29 (md5 93f745e6607699c396268367d6472bee). It differs from
-- 20260920171500's file only in one comment (live `--`, file an em dash) — kept as live.
-- REVERT: re-apply the body of 20260920171500; rows carrying `atlas_probe_req` are harmless to it.
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
         AND NOT (us.resolution_hint ? 'atlas_probe_at' AND (us.resolution_hint->>'atlas_probe_at')::timestamptz > now() - interval '14 days'
                  AND NOT EXISTS (SELECT 1 FROM net._http_response rr
                                   WHERE rr.id = (us.resolution_hint->>'atlas_probe_req')::bigint
                                     AND (rr.status_code IS DISTINCT FROM 200 OR rr.timed_out)))
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
         SET resolution_hint = COALESCE(resolution_hint, '{}'::jsonb) || jsonb_build_object('atlas_probe_at', to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'), 'atlas_probe_req', v_req)
       WHERE collection_id = c_allday AND resolved_at IS NULL AND nft_id = r.nft_id;
      v_probed := v_probed + 1;
    END LOOP;

    -- Backlog depth. SAMPLED (minutes 4 and 34 on a 4-59/5 schedule): the scan
    -- is 74,219 rows / ~31k buffers / 33 s and the stock it measures moves by
    -- tens per hour, so paying it every tick bought nothing and cost the ticks
    -- themselves. An unsampled tick publishes NULL, never 0 -- a 0 here would
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
