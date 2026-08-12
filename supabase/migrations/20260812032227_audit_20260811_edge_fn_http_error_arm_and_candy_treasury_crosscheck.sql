-- 2026-08-11 (PT) — two additive detectors.
--
-- (1) check_edge_fn_http_failures(): the missing instrument behind the 24h
--     AllDay pack-opens outage. pg_cron dispatched fine ("succeeded"), pg_net
--     got HTTP 403 {"error":"forbidden"} because the job's ?key= gate no longer
--     matched the deployed edge fn, and the fn therefore wrote NO pipeline_runs
--     row -- so every silence-based check read it as the documented "no-op
--     walk" false positive. Four consecutive monitor runs misdiagnosed it as
--     spork/Flow unreachability. A 4xx from a pg_net-dispatched edge fn is
--     always a MISCONFIGURATION and is never ambiguous, so it gets its own arm.
--     Deliberately scoped to 4xx: 5xx and pg_net 55s timeouts are transient
--     upstream noise and already routinely present.
--
-- (2) check_candy_treasury_divergence(): cross-check for the candy_treasury_wallet
--     argmax heuristic. Standalone ON PURPOSE -- its wmc leg measures 2,854 ms
--     COLD (EXPLAIN ANALYZE, 2026-08-11), so it must NOT go inside
--     get_pipeline_alerts(), whose 45s budget was already blown once by a single
--     heavy arm taking the whole alert aggregation down with it.
--
-- get_pipeline_alerts() is extended by RENAME + thin wrapper rather than a
-- re-emit of its 11,383-char body: zero transcription risk to a load-bearing
-- Telegram/email path. The core keeps its original ACL; callers are unchanged.

CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(p_window interval DEFAULT interval '2 hours')
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '10s'
AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'severity', CASE WHEN x.status_code IN (401, 403) THEN 'critical' ELSE 'high' END,
           'type',     'edge_fn_http_error',
           'pipeline', 'pg_net_http_' || x.status_code::text,
           'detail',   x.n || ' pg_net-dispatched edge-function call(s) returned HTTP '
                       || x.status_code || ' in the last ' || p_window::text
                       || '. A 4xx here is a MISCONFIGURATION (stale ?key= gate, rotated secret, bad route), not an upstream blip: '
                       || 'pg_cron still logs "succeeded" because DISPATCH worked, and the function writes NO pipeline_runs row at all, '
                       || 'so silence-based checks misread it as a completed no-op walk. Sample body: '
                       || coalesce(x.sample, '(empty)')
         ) ORDER BY x.status_code), '[]'::jsonb)
  FROM (
    SELECT r.status_code,
           count(*)              AS n,
           left(min(r.content), 80) AS sample
    FROM net._http_response r
    WHERE r.created > now() - p_window
      AND r.status_code >= 400
      AND r.status_code <  500
    GROUP BY r.status_code
  ) x;
$fn$;

COMMENT ON FUNCTION public.check_edge_fn_http_failures(interval) IS
'Flags 4xx responses to pg_net-dispatched Supabase edge functions. Catches the "dispatched OK but never executed" class that cron.job_run_details and every pipeline_runs-silence check are structurally blind to. Note net._http_response retains only ~1.6h, and net.http_request_queue is pruned on completion so the response CANNOT be joined back to its URL -- status code + body are the available attribution.';

CREATE OR REPLACE FUNCTION public.check_candy_treasury_divergence()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $fn$
  WITH wmc_argmax AS (
    SELECT wallet_address, count(*) AS serials
    FROM public.wallet_moments_cache
    WHERE collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'::uuid
    GROUP BY wallet_address
    ORDER BY count(*) DESC
    LIMIT 1
  ),
  packs_argmax AS (
    SELECT owner, count(*) AS packs
    FROM public.candy_packs
    WHERE NOT is_burnt
    GROUP BY owner
    ORDER BY count(*) DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'diverged',        (SELECT wallet_address FROM wmc_argmax) IS DISTINCT FROM (SELECT owner FROM packs_argmax),
    'wmc_argmax',      (SELECT wallet_address FROM wmc_argmax),
    'wmc_serials',     (SELECT serials       FROM wmc_argmax),
    'packs_argmax',    (SELECT owner          FROM packs_argmax),
    'packs_held',      (SELECT packs          FROM packs_argmax),
    'packs_last_seen', (SELECT max(last_seen_at) FROM public.candy_packs),
    'note', 'candy_treasury_wallet is an ORDER BY count(*) DESC LIMIT 1 heuristic over wallet_moments_cache, consumed by candy_pack_market / candy_scarcity_board / candy_special_serials_board and used as the exclusion in candy_holder_board. candy_packs.owner is an INDEPENDENT signal (sealed-pack custody). While the two agree the label is corroborated; on divergence a real collector may be silently labelled treasury on public boards. Does NOT self-heal. Caveats: candy_packs.is_burnt is 0 across all rows (verify it is maintained before promoting packs to the primary definition), and candy_packs refreshes on a multi-hour cadence, so treat this as a cross-check rather than a live board dependency.'
  );
$fn$;

COMMENT ON FUNCTION public.check_candy_treasury_divergence() IS
'Cross-check for the candy_treasury_wallet argmax heuristic against the independent candy_packs custody signal. Standalone (NOT wired into get_pipeline_alerts) because its wmc leg is ~2.85s cold and that function has a 45s budget already proven fragile under disk-IO saturation.';

ALTER FUNCTION public.get_pipeline_alerts() RENAME TO get_pipeline_alerts_core;

CREATE OR REPLACE FUNCTION public.get_pipeline_alerts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '45s'
AS $fn$
  SELECT coalesce(public.get_pipeline_alerts_core(), '[]'::jsonb)
      || coalesce(public.check_edge_fn_http_failures(interval '2 hours'), '[]'::jsonb);
$fn$;

COMMENT ON FUNCTION public.get_pipeline_alerts() IS
'Thin wrapper: get_pipeline_alerts_core() (the original 11,383-char body, renamed 2026-08-11, unchanged) plus the edge_fn_http_error arm. Extended by wrapper rather than re-emit so the load-bearing Telegram/email alert body was never retyped.';

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_candy_treasury_divergence()     FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_pipeline_alerts()                 FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO service_role;
GRANT  EXECUTE ON FUNCTION public.check_candy_treasury_divergence()     TO service_role;
GRANT  EXECUTE ON FUNCTION public.get_pipeline_alerts()                 TO service_role;
