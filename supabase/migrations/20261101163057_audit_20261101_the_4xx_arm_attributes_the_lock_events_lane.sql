-- audit_20261101_the_4xx_arm_attributes_the_lock_events_lane
--
-- 2026-11-01 ~8:40 AM PT (Claude Code cloud; Trevor: "work through anything unresolved from this
-- thread"). The TopShotLocking event lane (20261101052029, topshot_lock_events_tick) records every
-- pg_net request in topshot_lock_event_requests, but check_edge_fn_http_failures() was never taught
-- that table, so any 4xx from it would file as an unattributed `pg_net_http_<code>` (CRITICAL for a
-- 403). The lane has drawn none yet (2,860 pages, all 200, measured 8:30 AM PT) — this closes the gap
-- before it pages, the same splice as 20261101024201 (pack-book) and 20261021024211.
--
-- Severity: the Flow access node has no Cloudflare in front of it, so a 4xx is a request the node
-- rejected — 'info' for a 408/429 throttle (the tick re-asks it, up to 3 attempts), 'high' otherwise
-- (a range or URL the node refuses: read topshot_lock_event_requests.error).
--
-- Base: live prosrc md5 dd7a84a219560c9c5f5793ebdc1ce596 (= the body after 20261101024201, verified
-- immediately before this migration; no later migration defines the function).
-- REVERT: re-apply the prosrc with md5 dd7a84a219560c9c5f5793ebdc1ce596 via the same EXECUTE shape.
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261101024201.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.atlas_pack_market_requests apm ON apm.request_id = r.id';
  c_join_new    constant text := E'      LEFT JOIN public.atlas_pack_market_requests apm ON apm.request_id = r.id\n      LEFT JOIN public.topshot_lock_event_requests lev ON lev.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_lane_new    constant text := E'             WHEN (SELECT can_attribute FROM bounds) AND lev.request_id IS NOT NULL THEN ''lock-events''\n             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''pack-book'' THEN 14 ELSE 0 END AS ord,';
  c_ord_new     constant text := 'WHEN ''pack-book'' THEN 14 WHEN ''lock-events'' THEN 15 ELSE 0 END AS ord,';
  c_else_anchor constant text := E'      ELSE\n        jsonb_build_object(\n          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'lock-events' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (408, 429) THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'flow-rest-lock-events-' || g.status_code::text,
          'detail',   g.n || ' TopShotLocking event read(s) (Flow REST /v1/events or /v1/blocks) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'topshot_lock_event_requests.request_id, recorded by topshot_lock_events_request(). '
                      || 'The Flow access node has no Cloudflare in front of it: a 408/429 is throttling (the tick re-asks it, '
                      || 'up to 3 attempts — info); any other 4xx is a range or URL the node refused — read '
                      || 'topshot_lock_event_requests.error. The 7-day lock poll is the backstop while this lane is impaired. '
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
  IF md5(v_src) <> 'dd7a84a219560c9c5f5793ebdc1ce596' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF position('''lock-events''' in v_src) > 0 THEN
    RAISE EXCEPTION 'already patched -- refusing to double-patch';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not unique';
  END IF;
  v_new := replace(v_src, c_join_anchor, c_join_new);
  v_new := replace(v_new, c_lane_anchor, c_lane_new);
  v_new := replace(v_new, c_ord_anchor, c_ord_new);
  v_new := replace(v_new, c_else_anchor, c_branch || c_else_anchor);
  IF position('JOIN public.topshot_lock_event_requests lev ON lev.request_id = r.id' in v_new) = 0
     OR position('THEN ''lock-events''' in v_new) = 0
     OR position('WHEN ''lock-events'' THEN 15' in v_new) = 0
     OR position('flow-rest-lock-events-' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform did not land';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on check_edge_fn_http_failures';
  END IF;
END
$mig$;
