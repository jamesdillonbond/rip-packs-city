-- audit_20260910_the_4xx_arm_can_attribute_the_site_availability_probe
--
-- CLAUDE.md: "Wire a new pg_net lane into the 4xx arm in its creating migration."
-- The previous migration added public.site_probe, a pg_net lane. Unattributed,
-- any 4xx it produced would land in check_edge_fn_http_failures()'s 'unknown'
-- branch, which fires severity CRITICAL for 401/403 and HIGH otherwise and reads
-- as an edge-function misconfiguration. That arm's own text names the remedy --
-- record the dispatch identity so the request_id join can attribute it -- and
-- site_probe.request_id exists precisely so it can.
--
-- VERIFIED BOTH DIRECTIONS ON ONE RESPONSE (2026-09-10, 9:20pm PT). A real 401
-- was dispatched through this lane and read as
--   site-availability-probe-401 [high]   WITH the site_probe row
--   pg_net_http_401       [critical]     after the row was deleted
-- so the attribution does real work rather than merely existing.
--
-- WHY A DO BLOCK RATHER THAN A REWRITE. The function body is ~12.5 KB of
-- carefully worded detail strings. Retyping it to add four lines is a far larger
-- risk than transforming it in place, and a silent transcription slip in a
-- SECDEF function is exactly the class this repo keeps paying for. Every anchor
-- below is asserted to occur EXACTLY ONCE, so a body that has moved on raises
-- instead of being mangled -- and re-running this migration against an
-- already-patched body fails loudly rather than double-patching.
--
-- NOTE ON WHAT THIS LANE CAN AND CANNOT SHOW. A Vercel pause answers 503, which
-- is 5xx and never reaches this arm at all (it filters 400-499). A 4xx here means
-- the HEALTH ROUTE itself is unreachable -- deleted, WAF-challenged, or behind
-- deployment protection -- i.e. the availability prober has gone BLIND. That is
-- worth surfacing on its own terms, which is what the new branch says.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text := 'p_window interval DEFAULT ''02:00:00''::interval';

  c_join_anchor CONSTANT text := 'LEFT JOIN public.topshot_moment_hydrate_requests h ON h.request_id = r.id';
  c_lane_anchor CONSTANT text := 'ELSE ''unknown''';
  c_ord_anchor  CONSTANT text := 'WHEN ''chain-moved'' THEN 4 WHEN ''chain'' THEN 5 ELSE 0 END AS ord,';
  c_else_anchor CONSTANT text := '          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';

  c_branch CONSTANT text :=
'      WHEN ''site-probe'' THEN
        jsonb_build_object(
          ''severity'', ''high'',
          ''type'',     ''edge_fn_http_error'',
          ''pipeline'', ''site-availability-probe-'' || g.status_code::text,
          ''detail'',   g.n || '' site availability probe(s) returned HTTP '' || g.status_code
                      || '' in the last '' || p_window::text
                      || ''. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to ''
                      || ''site_probe.request_id, which probe_site_health() records at dispatch time. ''
                      || ''THIS IS NOT THE SITE BEING DOWN: a Vercel spend-cap pause answers 503, which is ''
                      || ''5xx and never reaches this arm. A 4xx here means /api/health itself is ''
                      || ''unreachable -- removed, WAF-challenged, or behind deployment protection -- so ''
                      || ''the availability prober has gone BLIND and #76 would recur unseen. ''
                      || ''Check check_site_availability() and the route before dismissing it. ''
                      || ''Body: '' || COALESCE(g.sample, ''(empty)'')
        )
';
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('site_probe' in v_src) > 0 THEN
    RAISE EXCEPTION 'body already references site_probe -- refusing to double-patch';
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;

  -- Assert every anchor is unique BEFORE touching anything.
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
                   c_join_anchor || E'\n      LEFT JOIN public.site_probe sp ON sp.request_id = r.id');

  v_new := replace(v_new, c_lane_anchor,
                   'WHEN (SELECT can_attribute FROM bounds) AND sp.request_id IS NOT NULL THEN ''site-probe''' ||
                   E'\n             ' || c_lane_anchor);

  v_new := replace(v_new, c_ord_anchor,
                   'WHEN ''chain-moved'' THEN 4 WHEN ''chain'' THEN 5 WHEN ''site-probe'' THEN 6 ELSE 0 END AS ord,');

  v_new := replace(v_new, '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor,
                   c_branch || '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor);

  IF position('site_probe' in v_new) = 0 OR position('site-probe' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform produced no site_probe reference';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

-- Same signature, so the ACL is not reset -- re-asserted anyway, because this
-- repo has been bitten by assuming it.
REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;
