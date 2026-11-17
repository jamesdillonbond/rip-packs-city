-- audit_20260907: the 4xx arm attributes the pack-pull chain hydrator's scripts -- a moved Moment's panic is
-- its designed outcome, not an unknown edge-function 400.
--
-- The alert this answers (2026-09-07 ~16Z): "pg_net_http_400 -- 32 pg_net-dispatched call(s) returned HTTP 400
-- in the last 02:00:00, NOT attributable to the Atlas editions walk or the Atlas market feed … Body:
-- Invalid Flow argument: failed to execute script … [Error Code: 1101]". Every one of them is
-- topshot_moment_hydrate_dispatch() (20260907153117) asking rest-mainnet.onflow.org to borrowMoment(id) on the
-- puller's wallet for a Moment that has since sold or moved -- the script panics "no nft" / "no collection"
-- by design, and the drain files the row as no_nft / no_collection (retried after 30 days). The lane records
-- every request id in topshot_moment_hydrate_requests at dispatch time, exactly as the two Atlas lanes do, so
-- the arm can attribute it the same way instead of guessing from the body.
--
-- Two new rows: `flow-rest-moment-moved-400` (info: the panic, with the lane's dispatch denominator and last
-- ok tick) and `flow-rest-upstream-<code>` (high: any OTHER 4xx on the lane -- a 429 is the access node
-- throttling this egress, the cue to lower p_max). The unknown row's text names the third attributable lane.
--
-- REVERT: re-apply the body from 20260906214103.

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
             WHEN (SELECT can_attribute FROM bounds) AND h.request_id IS NOT NULL
                  AND r.status_code = 400
                  AND (r.content LIKE '%panic: no nft%' OR r.content LIKE '%panic: no collection%') THEN 'chain-moved'
             WHEN (SELECT can_attribute FROM bounds) AND h.request_id IS NOT NULL THEN 'chain'
             ELSE 'unknown'
           END AS lane
      FROM net._http_response r
      LEFT JOIN public.atlas_edition_requests a ON a.request_id = r.id
      LEFT JOIN public.topshot_atlas_market_requests m ON m.request_id = r.id
      LEFT JOIN public.topshot_moment_hydrate_requests h ON h.request_id = r.id
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
  chain AS (
    SELECT (SELECT count(*)::int FROM public.topshot_moment_hydrate_requests
             WHERE dispatched_at > now() - p_window) AS dispatched,
           (SELECT max(started_at) FROM public.pipeline_runs
             WHERE pipeline = 'topshot-moments-hydrate-chain' AND ok) AS last_ok_tick
  ),
  grp AS (
    SELECT status_code, lane, count(*)::int AS n, left(min(content), 200) AS sample
      FROM resp GROUP BY 1, 2
  )
  SELECT COALESCE(jsonb_agg(s.j ORDER BY s.ord, s.code), '[]'::jsonb)
  FROM (
    SELECT
      CASE g.lane WHEN 'editions' THEN 1 WHEN 'market' THEN 2 WHEN 'probe' THEN 3
                  WHEN 'chain-moved' THEN 4 WHEN 'chain' THEN 5 ELSE 0 END AS ord,
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
      WHEN 'chain-moved' THEN
        jsonb_build_object(
          'severity', 'info',
          'type',     'edge_fn_http_error',
          'pipeline', 'flow-rest-moment-moved-400',
          'detail',   g.n || ' of ' || ch.dispatched || ' pack-pull hydration script(s) answered HTTP 400 with '
                      || '"panic: no nft" / "panic: no collection" in the last ' || p_window::text
                      || ' (' || CASE WHEN ch.dispatched > 0
                                      THEN round(100.0 * g.n / ch.dispatched, 1)::text ELSE '?' END
                      || '%). ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'topshot_moment_hydrate_requests.request_id, which topshot_moment_hydrate_dispatch() records '
                      || 'at dispatch time (migration 20260907153117). THE DESIGNED OUTCOME, NOT A FAILURE: the '
                      || 'Cadence borrowMoment(id) script on the puller''s wallet panics when the Moment has since '
                      || 'been sold or transferred; the drain files it as no_nft / no_collection and re-asks after '
                      || '30 days (a sale usually names it for free before then -- 20260907155014). Nothing to do. '
                      || 'Last ok tick ' || COALESCE(to_char(ch.last_ok_tick AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'chain' THEN
        jsonb_build_object(
          'severity', 'high',
          'type',     'edge_fn_http_error',
          'pipeline', 'flow-rest-upstream-' || g.status_code::text,
          'detail',   g.n || ' of ' || ch.dispatched || ' pack-pull hydration script(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ' that is NOT the moved-Moment panic. ATTRIBUTED by request_id to '
                      || 'topshot_moment_hydrate_requests. A 429 is the public access node throttling this egress '
                      || '(lower p_max in the rpc-topshot-moments-hydrate-chain cron command); any other 4xx is a '
                      || 'script or argument the node rejects and the drain files as error (retried after 1 day) -- '
                      || 'read topshot_moment_hydrate_requests.error for the lane''s own classification. '
                      || 'Last ok tick ' || COALESCE(to_char(ch.last_ok_tick AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      ELSE
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (401, 403) THEN 'critical' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'pg_net_http_' || g.status_code::text,
          'detail',   g.n || ' pg_net-dispatched call(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || ', NOT attributable to the Atlas editions walk, the Atlas market feed or the pack-pull '
                      || 'chain hydrator (all three ARE attributable, by a request_id join, and their failures are '
                      || 'reported as separate rows). '
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
    FROM grp g CROSS JOIN atlas a CROSS JOIN denom d CROSS JOIN market mk CROSS JOIN chain ch
  ) s;
$function$;
-- anon-exec: intentional — same signature as 20260906214103, ACLs preserved (check_edge_fn_http_failures)
