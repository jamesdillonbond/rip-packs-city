-- audit_20261109_the_4xx_arm_attributes_the_dapper_ondemand_and_studio_lanes
--
-- WHY. 2026-11-09 ~7:00 AM PT (Claude Code cloud; Trevor: "keep working through these" -- the
-- sentinel's `pg_net_http_403 · 2 pg_net-dispatched call(s) ... WHICH ENDPOINT IS UNKNOWN`, CRITICAL).
-- The two 403s landed 4:04:29 and 4:05:27 AM PT with a Cloudflare "Just a moment..." body. Measured:
-- they join NO request table. Every scheduled Atlas dispatcher records its id in a joined table
-- (alert-candidate / edition / listing verify, sold-floor clear, misattrib and unmapped resolvers all
-- write topshot_atlas_market_requests). Two Atlas callers record NOTHING: atlas_resolve_username_begin
-- and atlas_verify_listing_begin, called on demand by the app (lib/chains/flow/atlas.ts: username
-- resolve for wallet search / profile association, and wallet verification by listing). They are the
-- only unrecorded Atlas egress, so any Cloudflare challenge on a user's lookup pages CRITICAL.
-- Widening __tests__/atlas-pgnet-lanes-are-attributed-by-the-4xx-arm.test.ts from the Atlas host to
-- every Cloudflare-fronted Dapper API host (api.production.{atlas,studio-platform}.dapperlabs.com)
-- found four more request tables the arm never joined: pack_pull_requests (wallet pack pulls),
-- allday_drop_window_pages, pack_index_mint_requests, pinnacle_sale_serial_reads. None of the first
-- three recorded a 403 in 24 h (all 200), so they are not today's source -- but each would file its
-- first challenge as an unattributed CRITICAL.
--
-- WHAT.
--   1. public.atlas_ondemand_requests (request_id PK, fn, dispatched_at): both *_begin functions record
--      the id they return and prune rows older than 1 day. Their validation, URL, body, headers,
--      timeout and return value are unchanged (bodies otherwise verbatim from 20260906203504; live
--      prosrc md5 82870c451a27de3d6a43c0eec673054a / 1eccdbfff0b6e6bb01c99b62d3229ee7 = that file).
--   2. check_edge_fn_http_failures() joins atlas_ondemand_requests, pack_pull_requests,
--      allday_drop_window_pages and pack_index_mint_requests (all request_id PRIMARY KEY -- no row
--      multiplication) and reports each as its own row `dapper-<lane>-upstream-<code>`: info for a
--      403 (Cloudflare challenge) or 429 while the lane still gets 200s, high when in the window the
--      lane got NO 200 and 3+ 4xx (blocked, not challenged), and high for any other 4xx.
--   pinnacle_sale_serial_reads is NOT joined: the lane clears request_id on collect (0 of 325 rows
--   hold one), so a join could never attribute it -- it is a named suppression in the test instead.
--   pack_nft_identity is a results table; its dispatch identity is pack_nft_identity_requests,
--   already joined -- also a named suppression.
--
-- Base: check_edge_fn_http_failures live prosrc md5 86eb4914e3c2d739f7d7637b61de19e2 (= the result of
-- 20261109134500), read immediately before this migration.
-- anon-exec: unchanged -- both *_begin stay service_role only (REVOKE/GRANT restated); the arm's ACL
--   restated. New table: RLS on, no policy, anon/authenticated revoked.
-- Revert: re-apply both *_begin bodies from 20260906203504; re-apply the arm prosrc with md5
--   86eb4914e3c2d739f7d7637b61de19e2 (the 20261109134500 result) via the EXECUTE shape below;
--   DROP TABLE public.atlas_ondemand_requests.

CREATE TABLE IF NOT EXISTS public.atlas_ondemand_requests (
  request_id    bigint PRIMARY KEY,
  fn            text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS atlas_ondemand_requests_dispatched_at_idx ON public.atlas_ondemand_requests (dispatched_at);
ALTER TABLE public.atlas_ondemand_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.atlas_ondemand_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.atlas_ondemand_requests TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.atlas_resolve_username_begin(p_username text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_id bigint;
BEGIN
  IF p_username IS NULL OR length(trim(p_username)) = 0 OR length(p_username) > 64 THEN
    RAISE EXCEPTION 'bad_username' USING ERRCODE = '22023';
  END IF;
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
    body := jsonb_build_object('product', 'nba', 'username', trim(p_username)),
    headers := public.atlas_market_headers('nba'), timeout_milliseconds := 8000);
  -- 2026-11-09: recorded so check_edge_fn_http_failures() can attribute a challenge to this lane
  INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_id, 'resolve_username')
  ON CONFLICT (request_id) DO NOTHING;
  DELETE FROM public.atlas_ondemand_requests WHERE dispatched_at < now() - interval '1 day';
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.atlas_resolve_username_begin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_resolve_username_begin(text) TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_verify_listing_begin(p_nft_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_id bigint;
BEGIN
  IF p_nft_id IS NULL OR p_nft_id !~ '^[0-9]{1,12}$' THEN RAISE EXCEPTION 'bad_nft_id' USING ERRCODE = '22023'; END IF;
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
    body := jsonb_build_object('product', 'nba', 'nftId', p_nft_id, 'limit', 20),
    headers := public.atlas_market_headers('nba'), timeout_milliseconds := 8000);
  -- 2026-11-09: recorded so check_edge_fn_http_failures() can attribute a challenge to this lane
  INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_id, 'verify_listing')
  ON CONFLICT (request_id) DO NOTHING;
  DELETE FROM public.atlas_ondemand_requests WHERE dispatched_at < now() - interval '1 day';
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.atlas_verify_listing_begin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_verify_listing_begin(text) TO service_role;

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.chain_arrival_requests caq ON caq.request_id = r.id';
  c_join_new    constant text := E'      LEFT JOIN public.chain_arrival_requests caq ON caq.request_id = r.id\n      LEFT JOIN public.atlas_ondemand_requests aod ON aod.request_id = r.id\n      LEFT JOIN public.pack_pull_requests ppr ON ppr.request_id = r.id\n      LEFT JOIN public.allday_drop_window_pages adw ON adw.request_id = r.id\n      LEFT JOIN public.pack_index_mint_requests pim ON pim.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_lane_new    constant text := E'             WHEN (SELECT can_attribute FROM bounds) AND aod.request_id IS NOT NULL THEN ''atlas-ondemand''\n             WHEN (SELECT can_attribute FROM bounds) AND ppr.request_id IS NOT NULL THEN ''pack-pulls''\n             WHEN (SELECT can_attribute FROM bounds) AND adw.request_id IS NOT NULL THEN ''drop-windows''\n             WHEN (SELECT can_attribute FROM bounds) AND pim.request_id IS NOT NULL THEN ''pack-mints''\n             ELSE ''unknown''';
  c_cte_anchor  constant text := E'  atlas AS (\n';
  c_cte_new     constant text := $c$  dlane AS (
    -- 2026-11-09: per-lane 200 vs 4xx in the window, for the four Dapper lanes below
    SELECT CASE WHEN dx_aod.request_id IS NOT NULL THEN 'atlas-ondemand'
                WHEN dx_ppr.request_id IS NOT NULL THEN 'pack-pulls'
                WHEN dx_adw.request_id IS NOT NULL THEN 'drop-windows'
                ELSE 'pack-mints' END AS lane,
           count(*) FILTER (WHERE dr.status_code = 200)::int AS ok200,
           count(*) FILTER (WHERE dr.status_code >= 400)::int AS bad
      FROM net._http_response dr
      LEFT JOIN public.atlas_ondemand_requests dx_aod ON dx_aod.request_id = dr.id
      LEFT JOIN public.pack_pull_requests dx_ppr ON dx_ppr.request_id = dr.id
      LEFT JOIN public.allday_drop_window_pages dx_adw ON dx_adw.request_id = dr.id
      LEFT JOIN public.pack_index_mint_requests dx_pim ON dx_pim.request_id = dr.id
     WHERE dr.created > now() - p_window
       AND (dx_aod.request_id IS NOT NULL OR dx_ppr.request_id IS NOT NULL
            OR dx_adw.request_id IS NOT NULL OR dx_pim.request_id IS NOT NULL)
     GROUP BY 1
  ),
  atlas AS (
$c$;
  c_ord_anchor  constant text := 'WHEN ''chain-arrivals'' THEN 16 ELSE 0 END AS ord,';
  c_ord_new     constant text := 'WHEN ''chain-arrivals'' THEN 16 WHEN ''atlas-ondemand'' THEN 17 WHEN ''pack-pulls'' THEN 18 WHEN ''drop-windows'' THEN 19 WHEN ''pack-mints'' THEN 20 ELSE 0 END AS ord,';
  c_else_anchor constant text := E'      ELSE\n        jsonb_build_object(\n          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'atlas-ondemand' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (403, 429)
                            AND NOT COALESCE((SELECT dl.ok200 = 0 AND dl.bad >= 3 FROM dlane dl WHERE dl.lane = g.lane), false)
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'dapper-' || g.lane || '-upstream-' || g.status_code::text,
          'detail',   g.n || ' ON-DEMAND Atlas call(s) (atlas_resolve_username_begin / atlas_verify_listing_begin -- a user''s '
                      || 'username lookup or wallet verification by listing, lib/chains/flow/atlas.ts) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to atlas_ondemand_requests, recorded by the '
                      || 'begin functions (2026-11-09). Cloudflare challenges this egress at a ~5-15% base rate; the app '
                      || 'returns an honest failure for that one lookup and the user can retry. THIS ROW ESCALATES TO high '
                      || 'when, in the window, the lane got no 200 and 3+ 4xx (blocked, not challenged), or for any other 4xx. '
                      || '200s in window: ' || COALESCE((SELECT dl.ok200 FROM dlane dl WHERE dl.lane = g.lane), 0)
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'pack-pulls' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (403, 429)
                            AND NOT COALESCE((SELECT dl.ok200 = 0 AND dl.bad >= 3 FROM dlane dl WHERE dl.lane = g.lane), false)
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'dapper-' || g.lane || '-upstream-' || g.status_code::text,
          'detail',   g.n || ' wallet PACK-PULL call(s) (request_wallet_pack_pulls -> studio-platform GraphQL) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to pack_pull_requests.request_id. '
                      || 'Cloudflare challenges this egress at a ~5-15% base rate; read pack_pull_requests.status_code '
                      || 'for the wallet. THIS ROW ESCALATES TO high when, in the window, the lane got no 200 and 3+ 4xx, '
                      || 'or for any other 4xx. 200s in window: ' || COALESCE((SELECT dl.ok200 FROM dlane dl WHERE dl.lane = g.lane), 0)
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'drop-windows' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (403, 429)
                            AND NOT COALESCE((SELECT dl.ok200 = 0 AND dl.bad >= 3 FROM dlane dl WHERE dl.lane = g.lane), false)
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'dapper-' || g.lane || '-upstream-' || g.status_code::text,
          'detail',   g.n || ' All Day DROP-WINDOW page(s) (run_allday_drop_windows_lane -> studio-platform) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to allday_drop_window_pages.request_id. '
                      || 'Cloudflare challenges this egress at a ~5-15% base rate. THIS ROW ESCALATES TO high when, in the '
                      || 'window, the lane got no 200 and 3+ 4xx, or for any other 4xx. 200s in window: '
                      || COALESCE((SELECT dl.ok200 FROM dlane dl WHERE dl.lane = g.lane), 0)
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
      WHEN 'pack-mints' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (403, 429)
                            AND NOT COALESCE((SELECT dl.ok200 = 0 AND dl.bad >= 3 FROM dlane dl WHERE dl.lane = g.lane), false)
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'dapper-' || g.lane || '-upstream-' || g.status_code::text,
          'detail',   g.n || ' PACK-INDEX MINT call(s) (run_pack_index_mint_lane -> studio-platform) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to pack_index_mint_requests.request_id. '
                      || 'Cloudflare challenges this egress at a ~5-15% base rate. THIS ROW ESCALATES TO high when, in the '
                      || 'window, the lane got no 200 and 3+ 4xx, or for any other 4xx. 200s in window: '
                      || COALESCE((SELECT dl.ok200 FROM dlane dl WHERE dl.lane = g.lane), 0)
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
  IF md5(v_src) <> '86eb4914e3c2d739f7d7637b61de19e2' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF position('''atlas-ondemand''' in v_src) > 0 THEN
    RAISE EXCEPTION 'already patched -- refusing to double-patch';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_cte_anchor, ''))) / length(c_cte_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not unique';
  END IF;
  v_new := replace(v_src, c_join_anchor, c_join_new);
  v_new := replace(v_new, c_lane_anchor, c_lane_new);
  v_new := replace(v_new, c_cte_anchor, c_cte_new);
  v_new := replace(v_new, c_ord_anchor, c_ord_new);
  v_new := replace(v_new, c_else_anchor, c_branch || c_else_anchor);
  IF position('JOIN public.atlas_ondemand_requests aod ON aod.request_id = r.id' in v_new) = 0
     OR position('JOIN public.pack_pull_requests ppr ON ppr.request_id = r.id' in v_new) = 0
     OR position('JOIN public.allday_drop_window_pages adw ON adw.request_id = r.id' in v_new) = 0
     OR position('JOIN public.pack_index_mint_requests pim ON pim.request_id = r.id' in v_new) = 0
     OR position('dlane AS (' in v_new) = 0
     OR position('WHEN ''pack-mints'' THEN 20' in v_new) = 0
     OR position('''dapper-'' || g.lane' in v_new) = 0 THEN
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
     OR has_function_privilege('authenticated', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.atlas_resolve_username_begin(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.atlas_verify_listing_begin(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked';
  END IF;
END
$mig$;
