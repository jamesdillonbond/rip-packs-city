-- audit_20261003_the_4xx_arm_attributes_the_two_atlas_supply_lanes
--
-- 2026-10-03 ~7:00 PM PT (Claude Code, cloud).
--
-- WHAT PAGED. get_pipeline_alerts() carried `pg_net_http_403 · CRITICAL · 17 calls … NOT
-- attributable …`, body a Cloudflare "Just a moment" challenge. Measured by joining every
-- 4xx response in the trailing 3 h to every table carrying a request_id: 60 of 73 joined,
-- and 11 of them joined to two tables the arm does not read —
--   atlas_supply_requests        (4)  atlas_supply_dispatch(), the market-cap supply lane
--                                     (20261003213500, Golazos/Pinnacle supply)
--   topshot_atlas_pack_requests  (7)  topshot_pack_supply_tick(), the Top Shot sealed-pack
--                                     vs reserve lane (20261003224608)
-- Both shipped 10-03 and both persist the dispatch id; nobody taught this arm about them,
-- so their Cloudflare base-rate challenges file as an UNKNOWN critical. Same class as the
-- 10-02 username-lane fix (20261002150259).
--
-- The rest of the unattributed set is NOT these lanes and stays unknown on purpose: a burst
-- of 10 Google-front-end `403 Forbidden` at 4:54:49 PM PT and one Flow access-node
-- `height range 4999 exceeds maximum allowed of 250` at 6:48:55 PM PT — no pg_cron job
-- dispatched either (cron.job_run_details read for both windows), so they are session
-- probes. They age out of the 2 h window on their own.
--
-- WHAT THIS DOES. Splices two lanes into the live body on unique anchors, refusing if
-- already patched (the 20260919021500 / 20261002150259 technique):
--   'atlas-supply' (ord 9)  — info while a supply page drained clean in the last 6 h
--                             (the lane refreshes every 2 h), high otherwise.
--   'pack-supply'  (ord 10) — info while a 200 landed in the last 2 h (≤ 2 req/min lane),
--                             high otherwise.
-- Both: nothing is lost on a failed page — each lane re-dispatches it on its next pass.
--
-- CONTROL. After apply, the live 2 h window shows `atlas-supply-upstream-403` /
-- `atlas-pack-supply-upstream-403` rows (when those lanes took a challenge in the window)
-- and the pg_net_http_403 count drops by exactly their n.
--
-- REVERT: re-apply 20261002150259's splice over the pre-10-02 body, or re-apply the body
-- read immediately before this migration (md5 1f5e2a0480d3282a316df9aa0d988a44 of prosrc).
--
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261002150259.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.member_wallet_username_requests un ON un.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''usernames'' THEN 8 ELSE 0 END AS ord,';
  c_else_anchor constant text := '          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'atlas-supply' THEN
        jsonb_build_object(
          'severity', CASE WHEN (SELECT max(drained_at) FROM public.atlas_supply_requests WHERE drained_at IS NOT NULL AND error IS NULL) IS NULL
                             OR (SELECT max(drained_at) FROM public.atlas_supply_requests WHERE drained_at IS NOT NULL AND error IS NULL) < now() - interval '6 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-supply-upstream-' || g.status_code::text,
          'detail',   g.n || ' of '
                      || (SELECT count(*) FROM public.atlas_supply_requests WHERE dispatched_at > now() - p_window)
                      || ' Atlas edition-SUPPLY page(s) (market-cap supply lane) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'atlas_supply_requests.request_id, which atlas_supply_dispatch() records at dispatch time. '
                      || 'NOTHING IS LOST: a failed page writes no supply and is re-dispatched on the next pass; '
                      || 'Cloudflare challenges this egress at the same ~5-15% base rate as the Atlas market feed. '
                      || 'THIS ROW ESCALATES TO high when no page has drained clean in 6 h (the lane refreshes every 2 h). '
                      || 'Last clean drain: ' || COALESCE(to_char((SELECT max(drained_at) FROM public.atlas_supply_requests WHERE drained_at IS NOT NULL AND error IS NULL) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'pack-supply' THEN
        jsonb_build_object(
          'severity', CASE WHEN (SELECT max(drained_at) FROM public.topshot_atlas_pack_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.topshot_atlas_pack_requests WHERE status_code = 200) < now() - interval '2 hours'
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-pack-supply-upstream-' || g.status_code::text,
          'detail',   g.n || ' of '
                      || (SELECT count(*) FROM public.topshot_atlas_pack_requests WHERE dispatched_at > now() - p_window)
                      || ' Atlas DistributionService call(s) from the Top Shot pack-supply lane returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'topshot_atlas_pack_requests.request_id, which topshot_pack_supply_tick() records at dispatch time. '
                      || 'NOTHING IS LOST: the tick re-asks a failed page and backs off on market-lane 403s; '
                      || 'Cloudflare challenges this egress at the same ~5-15% base rate as the Atlas market feed. '
                      || 'THIS ROW ESCALATES TO high when no 200 has landed on this lane in 2 h. '
                      || 'Last 200: ' || COALESCE(to_char((SELECT max(drained_at) FROM public.topshot_atlas_pack_requests WHERE status_code = 200) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
$b$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('atlas_supply_requests' in v_src) > 0 OR position('topshot_atlas_pack_requests' in v_src) > 0 THEN
    RAISE EXCEPTION 'body already references a supply lane -- refusing to double-patch';
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
                   || E'\n      LEFT JOIN public.atlas_supply_requests su ON su.request_id = r.id'
                   || E'\n      LEFT JOIN public.topshot_atlas_pack_requests ps ON ps.request_id = r.id');
  v_new := replace(v_new, c_lane_anchor,
                   '             WHEN (SELECT can_attribute FROM bounds) AND su.request_id IS NOT NULL THEN ''atlas-supply''' ||
                   E'\n' ||
                   '             WHEN (SELECT can_attribute FROM bounds) AND ps.request_id IS NOT NULL THEN ''pack-supply''' ||
                   E'\n' || c_lane_anchor);
  v_new := replace(v_new, c_ord_anchor,
                   'WHEN ''usernames'' THEN 8 WHEN ''atlas-supply'' THEN 9 WHEN ''pack-supply'' THEN 10 ELSE 0 END AS ord,');
  v_new := replace(v_new, '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor,
                   c_branch || '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor);

  IF position('atlas_supply_requests su' in v_new) = 0
     OR position('topshot_atlas_pack_requests ps' in v_new) = 0
     OR position('atlas-supply-upstream-' in v_new) = 0
     OR position('atlas-pack-supply-upstream-' in v_new) = 0
     OR position('THEN 10 ELSE 0 END AS ord' in v_new) = 0 THEN
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
