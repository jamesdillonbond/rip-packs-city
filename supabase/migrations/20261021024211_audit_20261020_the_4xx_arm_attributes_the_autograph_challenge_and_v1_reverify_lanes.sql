-- audit_20261020_the_4xx_arm_attributes_the_autograph_challenge_and_v1_reverify_lanes
--
-- 2026-10-20 ~7:55 PM PT (Cowork cloud; Trevor: "work on roadmap items and known issues … anything sql").
--
-- WHAT PAGED. get_pipeline_alerts() carried `pg_net_http_403 · CRITICAL · 17 calls … NOT attributable`,
-- body a Cloudflare "Just a moment" challenge. Measured ~7:45 PM PT by joining every 4xx response in the
-- trailing 6 h (net._http_response) to EVERY public table carrying a request_id (28 tables): all 41
-- unattributed 403s joined to `autograph_sweep_requests` — the Atlas autograph sweep shipped 10-19/20
-- (20261020030228), which persists its dispatch id but was never taught to this arm. Same class as
-- 20261002150259 (usernames) and 20261004015738 (the two supply lanes). Lane health at the same read:
-- nba 145×200 / 25×403, nfl 118×200 / 30×403 — the ~15 % Cloudflare base rate; each failed page is
-- re-dispatched (status recorded per row), so nothing is lost.
--
-- Two more lanes dispatch through pg_net, persist their id, and are equally unknown to this arm, so
-- they are taught in the same splice before they page:
--   topshot_challenge_ingest_requests  ingest_topshot_challenges_atlas_begin() (Atlas QuestService,
--                                      20261021022355; hourly, 1 request)
--   allday_v1_reverify_requests        the #198 All Day V1 re-verify lane (Flow REST, 20261020144618)
--
-- The remaining unknown rows in that window (5 × 404 "404 page not found" at 6:17 PM PT and
-- 2 × 400 Flow "[Error Code: 1101]" at 6:23 PM PT) are Claude Code's recorded read-only Flow REST probes
-- for the storefront root cause (ledger 10-20, "requests 1876199/1876200") — session probes; they age
-- out of the 2 h window on their own and stay unknown on purpose.
--
-- WHAT THIS DOES. Splices three lanes into the LIVE body on unique anchors, refusing if already patched
-- (the 20261004015738 technique):
--   'autograph'   (ord 11) — info while a page answered 200 in the last 2 h, high otherwise.
--   'challenges'  (ord 12) — info while ingest-topshot-challenges logged ok in the last 3 h, high otherwise.
--   'v1-reverify' (ord 13) — high: a Flow REST 4xx on this lane is a script/argument the node rejected
--                            (no Cloudflare in front of the access node), read the row's outcome.
--
-- CONTROL. After apply, the 2 h window's pg_net_http_403 row loses exactly the autograph count and an
-- `atlas-autograph-upstream-403` row appears with the same n; no other row changes.
--
-- REVERT: re-apply 20261004015738's DO-block body over the pre-10-03 body, or simpler: re-apply the
-- prosrc read immediately before this migration (md5 recorded in the ledger entry).
--
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261004015738.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.topshot_atlas_pack_requests ps ON ps.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''pack-supply'' THEN 10 ELSE 0 END AS ord,';
  c_else_anchor constant text := '          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'autograph' THEN
        jsonb_build_object(
          'severity', CASE WHEN (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) < now() - interval '2 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-autograph-upstream-' || g.status_code::text,
          'detail',   g.n || ' of '
                      || (SELECT count(*) FROM public.autograph_sweep_requests WHERE dispatched_at > now() - p_window)
                      || ' Atlas autograph-sweep page(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'autograph_sweep_requests.request_id, recorded at dispatch time. '
                      || 'NOTHING IS LOST: a failed page writes nothing and is re-dispatched; '
                      || 'Cloudflare challenges this egress at the same ~5-15% base rate as the Atlas market feed. '
                      || 'THIS ROW ESCALATES TO high when no page has answered 200 in 2 h (only matters mid-cycle: '
                      || 'a closed cycle dispatches nothing and so cannot be challenged). '
                      || 'Last 200: ' || COALESCE(to_char((SELECT max(drained_at) FROM public.autograph_sweep_requests WHERE status_code = 200) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'challenges' THEN
        jsonb_build_object(
          'severity', CASE WHEN (SELECT max(started_at) FROM public.pipeline_runs WHERE pipeline = 'ingest-topshot-challenges' AND ok) IS NULL
                             OR (SELECT max(started_at) FROM public.pipeline_runs WHERE pipeline = 'ingest-topshot-challenges' AND ok) < now() - interval '3 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-challenges-upstream-' || g.status_code::text,
          'detail',   g.n || ' Atlas QuestService call(s) from the Top Shot challenge ingest returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'topshot_challenge_ingest_requests.request_id, recorded by ingest_topshot_challenges_atlas_begin(). '
                      || 'The collect step logs the failed run itself (ok=false) and the next hourly begin re-asks. '
                      || 'THIS ROW ESCALATES TO high when ingest-topshot-challenges has not logged ok in 3 h. '
                      || 'Last ok: ' || COALESCE(to_char((SELECT max(started_at) FROM public.pipeline_runs WHERE pipeline = 'ingest-topshot-challenges' AND ok) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'v1-reverify' THEN
        jsonb_build_object(
          'severity', 'high',
          'type',     'edge_fn_http_error',
          'pipeline', 'flow-rest-allday-v1-reverify-' || g.status_code::text,
          'detail',   g.n || ' All Day V1 re-verify script(s) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'allday_v1_reverify_requests.request_id. The Flow access node has no Cloudflare in front of it, '
                      || 'so a 4xx is a script or argument the node rejected -- read allday_v1_reverify_requests.outcome '
                      || 'for that seller before trusting the lane''s closes. '
                      || 'Body: ' || COALESCE(g.sample, '(empty)')
        )
$b$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('autograph_sweep_requests' in v_src) > 0
     OR position('topshot_challenge_ingest_requests' in v_src) > 0
     OR position('allday_v1_reverify_requests' in v_src) > 0 THEN
    RAISE EXCEPTION 'body already references one of these lanes -- refusing to double-patch';
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1 THEN
    RAISE EXCEPTION 'join anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1 THEN
    RAISE EXCEPTION 'lane anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1 THEN
    RAISE EXCEPTION 'ord anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'else anchor is not unique';
  END IF;

  v_new := replace(v_src, c_join_anchor,
                   c_join_anchor
                   || E'\n      LEFT JOIN public.autograph_sweep_requests ag ON ag.request_id = r.id'
                   || E'\n      LEFT JOIN public.topshot_challenge_ingest_requests cq ON cq.request_id = r.id'
                   || E'\n      LEFT JOIN public.allday_v1_reverify_requests v1 ON v1.request_id = r.id');
  v_new := replace(v_new, c_lane_anchor,
                   '             WHEN (SELECT can_attribute FROM bounds) AND ag.request_id IS NOT NULL THEN ''autograph''' ||
                   E'\n' ||
                   '             WHEN (SELECT can_attribute FROM bounds) AND cq.request_id IS NOT NULL THEN ''challenges''' ||
                   E'\n' ||
                   '             WHEN (SELECT can_attribute FROM bounds) AND v1.request_id IS NOT NULL THEN ''v1-reverify''' ||
                   E'\n' || c_lane_anchor);
  v_new := replace(v_new, c_ord_anchor,
                   'WHEN ''pack-supply'' THEN 10 WHEN ''autograph'' THEN 11 WHEN ''challenges'' THEN 12 WHEN ''v1-reverify'' THEN 13 ELSE 0 END AS ord,');
  v_new := replace(v_new, '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor,
                   c_branch || '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor);

  IF position('autograph_sweep_requests ag' in v_new) = 0
     OR position('topshot_challenge_ingest_requests cq' in v_new) = 0
     OR position('allday_v1_reverify_requests v1' in v_new) = 0
     OR position('atlas-autograph-upstream-' in v_new) = 0
     OR position('atlas-challenges-upstream-' in v_new) = 0
     OR position('flow-rest-allday-v1-reverify-' in v_new) = 0
     OR position('THEN 13 ELSE 0 END AS ord' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform did not land every splice';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

DO $mig$
DECLARE v jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon EXECUTE leaked on check_edge_fn_http_failures';
  END IF;
  v := public.check_edge_fn_http_failures(interval '2 hours');
  IF v IS NULL THEN RAISE EXCEPTION 'check_edge_fn_http_failures returned NULL'; END IF;
END
$mig$;
