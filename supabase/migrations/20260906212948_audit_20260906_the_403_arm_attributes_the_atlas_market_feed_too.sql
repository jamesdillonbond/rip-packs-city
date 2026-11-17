-- audit_20260906_the_403_arm_attributes_the_atlas_market_feed_too
--
-- The `pg_net_http_403` CRITICAL fired within minutes of the Atlas market feed
-- going live (2026-09-06 20:35Z: "3 pg_net-dispatched call(s) returned HTTP
-- 403 … NOT attributable to the Atlas editions walk"). All three were ours:
-- two firehose dispatches and one resolver probe, all Cloudflare `Just a
-- moment…` challenges at the ~5–15 % base rate the editions walk has run at for
-- weeks. The 09-05 arm attributes ONLY `atlas_edition_requests`; the market
-- feed records its own request ids in `topshot_atlas_market_requests` in
-- exactly the same shape, and the arm did not know to look there. Left alone,
-- every base-rate 403 on the market lane is a CRITICAL page forever.
--
-- What changes: a second attributed class, `atlas-market-upstream-<code>`,
-- reported as its own row — `info` while the feed is healthy, `high` when the
-- feed has NOT written a successful drain in 30 minutes (the only reading under
-- which a challenge costs market freshness; a full firehose page spans ~50 min
-- of events, so one missed tick loses nothing). The unattributed CRITICAL row
-- is byte-for-byte unchanged for everything else (an edge function on a stale
-- gate key is still a page).
--
-- Also attributed: session probes. A DB-dispatched probe MUST record its
-- request id in `topshot_atlas_market_requests` (product, offset_at = -1,
-- drained_at = now(), error = '__probe__ <what>') or it pages as an unknown
-- edge-function failure for two hours. The 09-06 A/B burst did not, and is
-- back-filled below so the page clears.
--
-- ACL: re-asserted after CREATE OR REPLACE (a REPLACE keeps the old ACL, but
-- the standing rule is to REVOKE anyway and re-run check_secdef_anon_exec_drift()).
-- Revert: re-apply 20260905110532's body.

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
               AND (error IS NULL OR error NOT LIKE '\_\_%')) AS dispatched,
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
      CASE g.lane WHEN 'editions' THEN 1 WHEN 'market' THEN 2 ELSE 0 END AS ord,
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
                      || CASE WHEN mk.probes > 0 THEN ' (+ ' || mk.probes || ' recorded session probe(s))' ELSE '' END
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

-- Back-fill the 2026-09-06 session probes (the resolver's first positive-control
-- request and the 32-request header A/B) so they attribute as probes, not as an
-- unknown edge-function failure. Retention (drain's 24 h prune) removes them.
INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, dispatched_at, drained_at, status_code, error)
SELECT r.id, 'nba', -1, r.created, r.created, r.status_code, '__probe__ 2026-09-06 session: resolver control + header A/B (Cloudflare challenge burst)'
  FROM net._http_response r
 WHERE r.id IN (84158) OR r.id BETWEEN 84161 AND 84180 OR r.id BETWEEN 84192 AND 84203
ON CONFLICT (request_id) DO NOTHING;
