-- audit_20261031_the_4xx_arm_attributes_the_atlas_pack_book_lane
--
-- 2026-10-31 ~7:45 PM PT (Claude Code cloud). The new Atlas pack-book lane (20261101022135,
-- atlas_pack_market_tick) dispatches ~4 DistributionService pages per product per minute; Cloudflare
-- challenges this egress at a ~5-15 % base rate (measured on the lane's first pass: ~25 % of pages
-- 403'd and were re-asked). check_edge_fn_http_failures() files a 4xx it cannot join to a lane as
-- `pg_net_http_403` — CRITICAL — so every challenge on the new lane paged. That is the class
-- __tests__/atlas-pgnet-lanes-are-attributed-by-the-4xx-arm.test.ts bans (four earlier instances).
--
-- WHAT THIS DOES: the same splice as 20261021024211 — a LEFT JOIN on
-- atlas_pack_market_requests, a 'pack-book' lane, its ord, and its branch. Severity: info, escalating
-- to high when no page of the lane has answered 200 in 1 h AND the last 3+ responses since all failed
-- (a pass runs every 15 min, so an hour with no 200 is a lane that cannot complete a book).
-- NOTHING IS LOST on a challenge: the tick re-asks the page up to 3 attempts and a pass is only
-- published when every page landed.
--
-- Base: prosrc md5 d5676b86d5235ea423528c2ab13a986d (read live immediately before this migration).
-- REVERT: re-apply the prosrc with md5 d5676b86d5235ea423528c2ab13a986d (= the body after
--   20261028005531) via the same EXECUTE format(...) shape below.
-- anon-exec: unchanged (check_edge_fn_http_failures) — ACL restated below as in 20261028005531.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_base_md5    constant text := 'd5676b86d5235ea423528c2ab13a986d';
  c_join_anchor constant text := '      LEFT JOIN public.allday_v1_reverify_requests v1 ON v1.request_id = r.id';
  c_join_new    constant text := E'      LEFT JOIN public.allday_v1_reverify_requests v1 ON v1.request_id = r.id\n      LEFT JOIN public.atlas_pack_market_requests apm ON apm.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_lane_new    constant text := E'             WHEN (SELECT can_attribute FROM bounds) AND apm.request_id IS NOT NULL THEN ''pack-book''\n             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''v1-reverify'' THEN 13 ELSE 0 END AS ord,';
  c_ord_new     constant text := 'WHEN ''v1-reverify'' THEN 13 WHEN ''pack-book'' THEN 14 ELSE 0 END AS ord,';
  c_else_anchor constant text := E'      ELSE\n        jsonb_build_object(\n          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'pack-book' THEN
        jsonb_build_object(
          'severity', CASE WHEN ((SELECT max(drained_at) FROM public.atlas_pack_market_requests WHERE status_code = 200) IS NULL
                             OR (SELECT max(drained_at) FROM public.atlas_pack_market_requests WHERE status_code = 200) < now() - interval '1 hour')
                            AND (SELECT count(*) FROM public.atlas_pack_market_requests
                                  WHERE drained_at IS NOT NULL AND status_code IS DISTINCT FROM 200
                                    AND drained_at > COALESCE((SELECT max(drained_at) FROM public.atlas_pack_market_requests WHERE status_code = 200), '-infinity'::timestamptz)) >= 3
                           THEN 'high' ELSE 'info' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'atlas-pack-book-upstream-' || g.status_code::text,
          'detail',   g.n || ' of '
                      || (SELECT count(*) FROM public.atlas_pack_market_requests WHERE dispatched_at > now() - p_window)
                      || ' Atlas DistributionService page(s) from the pack ASK BOOK lane returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to '
                      || 'atlas_pack_market_requests.request_id, which atlas_pack_market_request_page() records at dispatch time. '
                      || 'NOTHING IS LOST: atlas_pack_market_tick() re-asks a challenged page up to 3 attempts and publishes a pass '
                      || 'only when every page landed; Cloudflare challenges this egress at the same ~5-15% base rate as the Atlas market feed. '
                      || 'THIS ROW ESCALATES TO high when no page has answered 200 in 1 h AND the last 3+ responses since it all failed '
                      || '(a pass runs every 15 min). Last 200: '
                      || COALESCE(to_char((SELECT max(drained_at) FROM public.atlas_pack_market_requests WHERE status_code = 200) AT TIME ZONE 'UTC', 'HH24:MI') || 'Z', 'never')
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
  IF md5(v_src) <> c_base_md5 THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;
  IF position('''pack-book''' in v_src) > 0 THEN
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

  IF position('JOIN public.atlas_pack_market_requests apm ON apm.request_id = r.id' in v_new) = 0
     OR position('THEN ''pack-book''' in v_new) = 0
     OR position('WHEN ''pack-book'' THEN 14' in v_new) = 0
     OR position('atlas-pack-book-upstream-' in v_new) = 0 THEN
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
