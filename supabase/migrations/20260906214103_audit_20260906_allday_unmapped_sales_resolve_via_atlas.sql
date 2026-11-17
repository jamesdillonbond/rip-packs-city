-- audit_20260906_allday_unmapped_sales_resolve_via_atlas
--
-- Trust Health `unmapped_resolution_backlog_max = 119` (breach at 100) on the
-- 09-06 sentinel — the arm's own text calls it "an honest open finding": All
-- Day sales whose Moment moved into an escrow / non-public / burned state
-- before the on-chain resolver could borrow it from a holder. "There is no
-- ownerless on-chain edition read", so those rows were a PERMANENT class:
-- 42,007 unresolved priced All Day sales (38,564 distinct NFTs) as of tonight,
-- 119 of them inside the 30-day window the metric watches, all attempted
-- (max 3 on-chain attempts), replenished at ~100 per 30 days.
--
-- THERE IS AN OWNERLESS READ NOW. Atlas `MarketplaceService/
-- SearchMarketplaceTransactions {product:'nfl', nftId}` answers the NFT's
-- listing/sale history with `editionId` + `serialNumber` regardless of who
-- holds it. Positive control tonight: unmapped nft 10513144 (v1_dapper, 3
-- failed on-chain attempts) → edition 5100 / serial 199, and All Day's Atlas
-- `edition.id` IS our `editions.external_id` (2470 → John Elway, Playoff
-- Legacies — exact). So the mapping is one `nft_edition_map` row and the
-- existing `promote_unmapped_sales` does the rest on its next scoped drain.
--
-- Two legs, DB-only:
--   Leg 1 (free): every nfl event the market firehose has already seen carries
--     nft_id → atlas_edition_id (+ serial). Join, guard the edition exists,
--     upsert the map.
--   Leg 2 (bounded probes): for unresolved rows the firehose has not seen,
--     post `{product:'nfl', nftId}` through pg_net — p_probe_limit per tick,
--     newest sale first so the 30-day window (the metric) drains before the
--     historical floor — recorded in `topshot_atlas_market_requests` with
--     offset_at = -2 and error = '__nft__<id>' so the market DRAIN upserts the
--     answer into `topshot_atlas_market_events` on its next tick (the
--     transactions[] shape is identical), and Leg 1 maps it on the tick after.
--     `resolution_hint.atlas_probe_at` prevents re-probing for 14 days.
--
-- `atlas_market_dispatch()` is amended so an in-flight NFT probe (offset_at < 0)
-- does not block the firehose's one-in-flight-per-product rule.
--
-- Traffic: 10 probes / 5 min = 2 req/min on top of ~5 req/min today. The
-- 09-06 A/B showed Cloudflare's challenge is BURST-sensitive, not rate-
-- sensitive at this level; the 403 arm attributes these as market-lane rows.
-- ~2,900 probes/day clears the 38.6k floor in ~2 weeks; the 30-day window
-- (119) inside the first hour.
--
-- Revert: cron.unschedule('rpc-allday-unmapped-atlas-resolver');
--         DROP FUNCTION public.allday_resolve_unmapped_via_atlas(int);
--         re-apply atlas_market_dispatch from 20260906203504 (in-flight check
--         without the offset_at >= 0 clause). Map rows already written stay —
--         they are correct.

CREATE OR REPLACE FUNCTION public.atlas_market_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_req bigint; v_n int := 0; p text; v_offset int;
BEGIN
  FOREACH p IN ARRAY ARRAY['nba','nfl'] LOOP
    -- One FIREHOSE page in flight per product (offset_at >= 0). NFT probes
    -- (offset_at = -2, the All Day resolver) and session probes (-1) do not count.
    -- A request older than 10 min with no response is abandoned by the drain.
    IF EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q
                WHERE q.product = p AND q.offset_at >= 0 AND q.drained_at IS NULL
                  AND q.dispatched_at > now() - interval '10 minutes') THEN
      CONTINUE;
    END IF;
    SELECT COALESCE((SELECT q.offset_at FROM public.topshot_atlas_market_requests q WHERE q.product = p AND q.error = '__next_offset__' ORDER BY q.dispatched_at DESC LIMIT 1), 0) INTO v_offset;
    DELETE FROM public.topshot_atlas_market_requests WHERE product = p AND error = '__next_offset__';
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', p, 'limit', 200, 'offset', v_offset),
      headers := public.atlas_market_headers(p),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at) VALUES (v_req, p, v_offset);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
REVOKE ALL ON FUNCTION public.atlas_market_dispatch() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.allday_resolve_unmapped_via_atlas(p_probe_limit int DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE
  c_allday constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_started timestamptz := clock_timestamp();
  v_rows jsonb; v_mapped int := 0; v_probed int := 0; v_open int; v_open_30d int; v_inflight int;
  r record; v_req bigint;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('allday_resolve_unmapped_via_atlas')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

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

  SELECT count(*), count(*) FILTER (WHERE sold_at > now() - interval '30 days' AND sold_at < now() - interval '24 hours')
    INTO v_open, v_open_30d
    FROM public.unmapped_sales
   WHERE collection_id = c_allday AND resolved_at IS NULL AND COALESCE(price_usd, 0) > 0
     AND COALESCE(resolution_hint->>'promote_blocked', '') <> 'sales_tx_hash_unique_collision';

  PERFORM public.log_pipeline_run('allday-unmapped-atlas-resolver', v_started, v_probed, v_mapped, 0, true, NULL,
    'nfl_all_day', NULL, NULL,
    jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                       'mapped_from_events', v_mapped, 'probes_dispatched', v_probed, 'probes_inflight_before', v_inflight,
                       'open_unresolved', v_open, 'open_unresolved_30d', v_open_30d, 'via', 'pg_cron',
                       'note', 'mapped rows are promoted into sales by promote_unmapped_sales on its next nfl_all_day drain (20-min gap)'));
  RETURN jsonb_build_object('mapped_from_events', v_mapped, 'probes_dispatched', v_probed, 'open_unresolved', v_open, 'open_unresolved_30d', v_open_30d);
END $$;
REVOKE ALL ON FUNCTION public.allday_resolve_unmapped_via_atlas(int) FROM PUBLIC, anon, authenticated;

DO $sched$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-allday-unmapped-atlas-resolver') THEN
    PERFORM cron.schedule('rpc-allday-unmapped-atlas-resolver', '4-59/5 * * * *', $$SELECT public.allday_resolve_unmapped_via_atlas(10);$$);
  END IF;
END $sched$;

-- The 403 arm's market denominator now counts nft probes (offset_at = -2) as
-- dispatches — they are real market-lane requests — and excludes only session
-- probes (offset_at = -1). Same body as 20260906213057 otherwise.
CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(p_window interval DEFAULT '02:00:00'::interval)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
  WITH bounds AS (
    SELECT (p_window <= interval '12 hours') AS can_attribute
  ),
  resp AS (
    SELECT r.status_code,
           r.content,
           CASE
             WHEN (SELECT can_attribute FROM bounds) AND a.request_id IS NOT NULL THEN 'editions'
             WHEN (SELECT can_attribute FROM bounds) AND m.request_id IS NOT NULL AND m.error LIKE '\_\_probe\_\_%' THEN 'probe'
             WHEN (SELECT can_attribute FROM bounds) AND m.request_id IS NOT NULL THEN 'market'
             ELSE 'unknown'
           END AS lane
      FROM net._http_response r
      LEFT JOIN public.atlas_edition_requests a ON a.request_id = r.id
      LEFT JOIN public.topshot_atlas_market_requests m ON m.request_id = r.id
     WHERE r.created > now() - p_window
       AND r.status_code >= 400
       AND r.status_code <  500
  ),
  atlas AS (
    SELECT count(*)::int AS sets_total,
           count(*) FILTER (WHERE last_completed_at IS NULL
                               OR last_completed_at < now() - interval '6 hours')::int AS sets_stalled,
           COALESCE(round((extract(epoch FROM max(now() - last_completed_at))/3600.0)::numeric, 1), 0) AS max_staleness_h
      FROM public.atlas_set_refresh_state
  ),
  denom AS (
    SELECT count(*)::int AS dispatched
      FROM public.atlas_edition_requests
     WHERE dispatched_at > now() - p_window
  ),
  market AS (
    SELECT (SELECT count(*)::int FROM public.topshot_atlas_market_requests
             WHERE dispatched_at > now() - p_window AND request_id > 0
               AND offset_at <> -1) AS dispatched,   -- firehose pages AND nft probes (offset -2); session probes (-1) excluded
           (SELECT count(*)::int FROM public.topshot_atlas_market_requests
             WHERE dispatched_at > now() - p_window AND error LIKE '\_\_probe\_\_%') AS probes,
           (SELECT max(started_at) FROM public.pipeline_runs
             WHERE pipeline = 'atlas-market-feed' AND ok AND rows_written > 0) AS last_good_drain,
           (SELECT max(listed_at) FROM public.topshot_atlas_market_events) AS newest_event
  ),
  grp AS (
    SELECT status_code, lane, count(*)::int AS n, left(min(content), 200) AS sample
      FROM resp GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_agg(s.j ORDER BY s.ord, s.code), '[]'::jsonb)
  FROM (
    SELECT
      CASE g.lane WHEN 'editions' THEN 1 WHEN 'market' THEN 2 WHEN 'probe' THEN 3 ELSE 0 END AS ord,
      g.status_code AS code,
      CASE g.lane
      WHEN 'editions' THEN
        jsonb_build_object(
          'severity', CASE WHEN a.sets_stalled > 0 THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-editions-upstream-' || g.status_code::text,
          'detail',   g.n || ' of ' || d.dispatched || ' Atlas edition dispatch(es) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ' (' || CASE WHEN d.dispatched > 0
                                      THEN round(100.0 * g.n / d.dispatched, 1)::text ELSE '?' END
                      || '%). ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'atlas_edition_requests.request_id, which atlas_editions_dispatch() records at '
                      || 'dispatch time. This is NOT the body-shape heuristic the 2026-08-30 arm deliberately '
                      || 'refused; that migration named persisting the dispatch identity as the real fix, and '
                      || 'the Atlas walk is the one dispatcher that already persists it. '
                      || 'NO ROWS ARE LOST: atlas_editions_drain() RAISEs on any non-200, and its handler '
                      || 'increments pages_err WITHOUT advancing next_offset, so the same page is re-walked '
                      || 'on the next cycle. The thing actually worth watching is whether that retry keeps up: '
                      || a.sets_stalled || ' of ' || a.sets_total || ' set(s) have not completed a walk in 6h '
                      || '(oldest ' || a.max_staleness_h || 'h; a full cycle is ~75 min). '
                      || 'THIS ROW ESCALATES TO high the moment that count goes non-zero, which is the only '
                      || 'reading under which an upstream challenge costs catalog freshness. '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'market' THEN
        jsonb_build_object(
          'severity', CASE WHEN mk.last_good_drain IS NULL OR mk.last_good_drain < now() - interval '30 minutes'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-market-upstream-' || g.status_code::text,
          'detail',   g.n || ' of ' || mk.dispatched || ' Atlas MARKET-FEED dispatch(es)'
                      || ' returned HTTP ' || g.status_code || ' in the last ' || p_window::text
                      || ' (' || CASE WHEN mk.dispatched > 0
                                      THEN round(100.0 * g.n / mk.dispatched, 1)::text ELSE '?' END
                      || '% of dispatches). ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'topshot_atlas_market_requests.request_id, which atlas_market_dispatch() records at '
                      || 'dispatch time (migration 20260906203504). Cloudflare challenges this egress at a '
                      || '~5-15% base rate and escalates to 100% for minutes after a BURST (measured 09-06) -- '
                      || 'a single failed tick loses nothing, because each firehose page spans ~50 min of events '
                      || 'and the next tick re-reads from offset 0. What matters is FRESHNESS: last successful '
                      || 'drain ' || COALESCE(to_char(mk.last_good_drain AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || ', newest event ' || COALESCE(to_char(mk.newest_event AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'none')
                      || '. THIS ROW ESCALATES TO high when no successful drain has landed in 30 min. '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'probe' THEN
        jsonb_build_object(
          'severity', 'info',
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-session-probe-' || g.status_code::text,
          'detail',   g.n || ' of ' || mk.probes || ' RECORDED SESSION PROBE(S) returned HTTP ' || g.status_code
                      || ' in the last ' || p_window::text || '. SELF-INFLICTED BY DESIGN: a session posted these '
                      || 'through pg_net and recorded the ids in topshot_atlas_market_requests with error '
                      || '''__probe__ <what>'', so this is a labelled experiment, not an outage and not an edge '
                      || 'function. Nothing to do; the rows age out with the drain''s 24 h prune. Label: '
                      || COALESCE((SELECT left(min(error), 160) FROM public.topshot_atlas_market_requests
                                    WHERE error LIKE '\_\_probe\_\_%' AND dispatched_at > now() - p_window), '(none)')
        )
      ELSE
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (401, 403) THEN 'critical' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'pg_net_http_' || g.status_code::text,
          'detail',   g.n || ' pg_net-dispatched call(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ', NOT attributable to the Atlas editions walk or the Atlas market feed (both ARE '
                      || 'attributable, by a request_id join, and their failures are reported as separate rows). '
                      || 'WHICH ENDPOINT IS UNKNOWN: net._http_response has no url column (the URL lives in '
                      || 'net.http_request_queue, drained on completion), so this arm cannot tell an EDGE FUNCTION '
                      || 'from one of our own DB-dispatched probes. Two readings, and the body below usually settles it: '
                      || '(a) an edge-function MISCONFIGURATION (stale ?key= gate, rotated secret, bad route) -- pg_cron '
                      || 'still logs "succeeded" because DISPATCH worked and the function writes NO pipeline_runs row, '
                      || 'so silence-based checks misread it as a completed no-op walk; '
                      || '(b) SELF-INFLICTED -- a strict upstream rejecting one of our schema probes (a GraphQL-shaped '
                      || 'body, e.g. GRAPHQL_VALIDATION_FAILED, is this case and is not an outage), or a session '
                      || 'probe that did not record its request id in topshot_atlas_market_requests (error '
                      || '''__probe__ <what>'', offset_at -1, drained_at now()) -- record it and this row clears. '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
      END AS j
    FROM grp g CROSS JOIN atlas a CROSS JOIN denom d CROSS JOIN market mk
  ) s;
$function$;

REVOKE ALL ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
