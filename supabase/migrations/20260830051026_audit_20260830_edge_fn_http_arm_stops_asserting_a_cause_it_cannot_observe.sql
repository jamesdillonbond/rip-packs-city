-- audit_20260830_edge_fn_http_arm_stops_asserting_a_cause_it_cannot_observe
--
-- known-issues #51. `check_edge_fn_http_failures()` pages on ANY pg_net 4xx and
-- its `detail` asserted, as fact:
--     "A 4xx here is a MISCONFIGURATION (stale ?key= gate, rotated secret, bad
--      route), not an upstream blip"
--
-- ⛔ IT CANNOT KNOW THAT. `net._http_response` has NO url column -- the URL lives
-- in `net.http_request_queue`, which pg_net DRAINS on completion -- so this arm
-- sees a status code and a body and nothing else. It has already asserted
-- "edge-function call ... MISCONFIGURATION" for three GRAPHQL_VALIDATION_FAILED
-- replies from the Dapper Studio endpoint dispatched BY THE DATABASE. pg_net is
-- now the repo's general egress path for schema probes, so that recurs on every
-- strict-endpoint probe.
--
-- ⭐ This is the platform's own top defect class pointed at an ALERT: publishing
-- a conclusion the read cannot support. The fix is to say what is known and name
-- the ambiguity, not to guess better.
--
-- WHAT CHANGES: the `detail` text, and the body sample widens 80 -> 200 chars
-- (80 truncates before a GraphQL error envelope is recognisable, which is what
-- made the false attribution stick). Verified by a rolled-back positive control:
-- a synthetic 422 with a GRAPHQL_VALIDATION_FAILED body now renders that code
-- inside the alert, where at 80 chars it was cut off.
--
-- ⛔ WHAT DELIBERATELY DOES NOT CHANGE: the severity mapping. It would be easy to
-- downgrade a "GraphQL-shaped body" to low on a heuristic -- and that heuristic
-- would eventually silence a REAL gate-key outage that happened to return JSON.
-- An alert whose output is silence is the least falsifiable failure there is, so
-- this keeps failing loud and fixes only the false CLAIM. Severity and the 401/403
-- critical mapping are byte-identical.
--
-- 👉 THE REAL FIX IS STILL OWED and is deliberately not attempted here: persist
-- the dispatch URL (a wrapper that records request_id -> url at dispatch, joined
-- back on `net._http_response.id`). That needs all 15 call sites changed -- 14
-- pg_cron commands plus `resolve_topshot_username_live` -- and, measured
-- 2026-08-30 05:0xZ, `net._http_response` currently holds **683 rows over a ~6 h
-- retention window with ZERO 4xx in it**, so the arm is quiet and the wrapper is
-- not justified by present incidence. Recorded so the next session inherits the
-- measurement rather than the urge.
--
-- anon-exec: unchanged -- check_edge_fn_http_failures is service_role-only already (anon=false, authenticated=false, measured live 2026-08-30); CREATE OR REPLACE does not reset a function's ACL, so no revoke is added here.
--
-- REVERT: restore the prior body from this file's git history (the only change is
-- the `detail` string and the left(...) width).

CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(p_window interval DEFAULT '02:00:00'::interval)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '10s'
AS $function$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'severity', CASE WHEN x.status_code IN (401, 403) THEN 'critical' ELSE 'high' END,
           'type',     'edge_fn_http_error',
           'pipeline', 'pg_net_http_' || x.status_code::text,
           'detail',   x.n || ' pg_net-dispatched call(s) returned HTTP '
                       || x.status_code || ' in the last ' || p_window::text
                       || '. WHICH ENDPOINT IS UNKNOWN: net._http_response has no url column (the URL lives in '
                       || 'net.http_request_queue, drained on completion), so this arm cannot tell an EDGE FUNCTION '
                       || 'from one of our own DB-dispatched probes. Two readings, and the body below usually settles it: '
                       || '(a) an edge-function MISCONFIGURATION (stale ?key= gate, rotated secret, bad route) -- pg_cron '
                       || 'still logs "succeeded" because DISPATCH worked and the function writes NO pipeline_runs row, '
                       || 'so silence-based checks misread it as a completed no-op walk; '
                       || '(b) SELF-INFLICTED -- a strict upstream rejecting one of our schema probes (a GraphQL-shaped '
                       || 'body, e.g. GRAPHQL_VALIDATION_FAILED, is this case and is not an outage). '
                       || 'Body: ' || coalesce(x.sample, '(empty)')
         ) ORDER BY x.status_code), '[]'::jsonb)
  FROM (
    SELECT r.status_code,
           count(*)               AS n,
           left(min(r.content), 200) AS sample
    FROM net._http_response r
    WHERE r.created > now() - p_window
      AND r.status_code >= 400
      AND r.status_code <  500
    GROUP BY r.status_code
  ) x;
$function$;
