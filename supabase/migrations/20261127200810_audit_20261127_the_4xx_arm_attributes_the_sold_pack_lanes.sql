-- audit_20261127_the_4xx_arm_attributes_the_sold_pack_lanes
--
-- 2026-11-27 (PT, afternoon; Claude Code cloud; Trevor: "Keep digging and probing").
--
-- WHY: the two Sold-tab lanes added today -- sold_pack_open_tx_reads (Flow REST
-- /v1/transaction_results, current spork + the mainnet27 node) and sold_container_open_search (Flow REST
-- /v1/events PackNFT.Opened windows) -- record their pg_net request ids, but check_edge_fn_http_failures()
-- was never taught them. Their first hours already held 5 HTTP 429s (Flow access-node rate limit, 295
-- 200s beside them): each filed as an unattributed `pg_net_http_429` at severity HIGH. The tree-walking
-- guard atlas-pgnet-lanes-are-attributed-by-the-4xx-arm caught the same gap from the migration side
-- (the runner's opener-username leg names the Atlas host in the same migration).
--
-- WHAT: splice two LEFT JOINs + one lane ('sold-pack-reads') into the arm. Its row
-- `sold-pack-reads-upstream-<code>` is info for a 429 while the lanes still get 200s, high for a 429 with
-- no 200 in the window (throttled shut) or any other 4xx (a routing bug: a 404 there means a tx asked of
-- the wrong spork node). Splice, not rewrite: the base prosrc md5 is asserted, anchors must be unique,
-- the transform must land, privileges are re-asserted.
--
-- REVERT: re-run the DO block below with the anchors and replacements swapped (each replacement is a
-- pure insertion beside its anchor), or restore the base body (prosrc md5 55c00a2b73e253d7be6265cc603c6d21)
-- from 20261119074500_audit_20261118_pack_identity_4xx_arm_reads_atlas_base_rate.sql's result.

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.pack_index_mint_requests pim ON pim.request_id = r.id';
  c_join_new    constant text := E'      LEFT JOIN public.pack_index_mint_requests pim ON pim.request_id = r.id\n      LEFT JOIN public.sold_pack_open_tx_reads spr ON spr.request_id = r.id\n      LEFT JOIN public.sold_container_open_search scs ON scs.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_lane_new    constant text := E'             WHEN (SELECT can_attribute FROM bounds) AND (spr.request_id IS NOT NULL OR scs.request_id IS NOT NULL) THEN ''sold-pack-reads''\n             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''pack-mints'' THEN 20 ELSE 0 END AS ord';
  c_ord_new     constant text := 'WHEN ''pack-mints'' THEN 20 WHEN ''sold-pack-reads'' THEN 21 ELSE 0 END AS ord';
  c_else_anchor constant text := E'      ELSE\n        jsonb_build_object(\n          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch      constant text := $c$      WHEN 'sold-pack-reads' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code = 429
                            AND (SELECT count(*) FROM net._http_response sr
                                   LEFT JOIN public.sold_pack_open_tx_reads sx1 ON sx1.request_id = sr.id
                                   LEFT JOIN public.sold_container_open_search sx2 ON sx2.request_id = sr.id
                                  WHERE sr.created > now() - p_window AND sr.status_code = 200
                                    AND (sx1.request_id IS NOT NULL OR sx2.request_id IS NOT NULL)) > 0
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'sold-pack-reads-upstream-' || g.status_code::text,
          'detail',   g.n || ' Flow REST read(s) by the Sold-tab lanes (run_sold_pack_open_tx_reads -> '
                      || '/v1/transaction_results; run_sold_container_open_search -> /v1/events) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to sold_pack_open_tx_reads / '
                      || 'sold_container_open_search.request_id. A 429 is the Flow access node rate-limiting; the '
                      || 'lanes re-dispatch an uncollected read on a later tick. THIS ROW IS high for a 429 with no 200 '
                      || 'in the window or for any other 4xx (a 404 = a tx asked of the wrong spork node). Body: '
                      || COALESCE(g.sample, '(empty)')
        )
$c$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF md5(v_src) <> '55c00a2b73e253d7be6265cc603c6d21' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF position('''sold-pack-reads''' in v_src) > 0 THEN
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
  IF position('JOIN public.sold_pack_open_tx_reads spr ON spr.request_id = r.id' in v_new) = 0
     OR position('JOIN public.sold_container_open_search scs ON scs.request_id = r.id' in v_new) = 0
     OR position('WHEN ''sold-pack-reads'' THEN 21' in v_new) = 0
     OR position('''sold-pack-reads-upstream-'' || g.status_code' in v_new) = 0 THEN
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
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
END
$mig$;
