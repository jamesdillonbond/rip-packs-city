-- 2026-11-18 (PT, evening) — atlas_disney_begin(): the pg_net half of the Disney
-- Pinnacle lanes' move off Dapper's dead Studio GraphQL onto Atlas (#218).
--
-- CAUSE: api.production.studio-platform.dapperlabs.com/graphql has answered HTTP 530
-- / "error code: 1033" since 11-17 ~4:23 PM PT, failing pinnacle-catalog-backfill,
-- pinnacle-catalog-floor-refresh and the GQL fallback of pinnacle-wmc-render-id.
-- disneypinnacle.com now calls api.production.atlas.dapperlabs.com, which answers
-- anonymous Connect-RPC JSON — but its WAF 403s Vercel's fetch (verified 06-16 from
-- iad1) while answering Supabase pg_net. So the Vercel routes reach Atlas through
-- the database, the same two-call shape as atlas_resolve_username_begin/_collect:
--   1. atlas_disney_begin(method, body) — enqueues the POST, returns the request id.
--      pg_net only sends once this transaction COMMITS, so the poll is a second call.
--   2. atlas_await_response(request_id, max_ms) — EXISTING, unchanged.
--
-- SCOPE: an allow-list of three read methods, product forced to 'disney' whatever
-- the caller sent, service_role only. Each request is recorded in
-- atlas_ondemand_requests so check_edge_fn_http_failures() attributes a Cloudflare
-- challenge (HTML 403) to 'atlas-ondemand' rather than to an unknown lane.
-- Headers: atlas_market_headers('disney') (the nbatopshot origin) — the exact
-- headers every 11-18 verification probe used (SearchEditions, GetNFTs,
-- SearchMarketplaceTransactions: all 200).
--
-- Callers: lib/pinnacle/atlas-disney.ts (dbAtlasDisneyCall) — used by
-- app/api/admin/backfill-pinnacle-catalog and lib/pinnacle/render-lookup.ts.
--
-- REVERT: DROP FUNCTION public.atlas_disney_begin(text, jsonb);
--   (the routes then fail with "atlas_disney_begin: … does not exist", logged.)

CREATE OR REPLACE FUNCTION public.atlas_disney_begin(p_method text, p_body jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_id bigint;
BEGIN
  IF p_method IS NULL OR p_method NOT IN (
       'EditionService/SearchEditions',
       'MarketplaceService/SearchMarketplaceTransactions',
       'NFTService/GetNFTs') THEN
    RAISE EXCEPTION 'atlas_disney_begin: method % is not allow-listed', p_method USING ERRCODE = '22023';
  END IF;
  IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN
    RAISE EXCEPTION 'atlas_disney_begin: body must be a json object' USING ERRCODE = '22023';
  END IF;
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.' || p_method,
    body := p_body || jsonb_build_object('product', 'disney'),
    headers := public.atlas_market_headers('disney'),
    timeout_milliseconds := 20000);
  INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_id, 'disney:' || p_method)
  ON CONFLICT (request_id) DO NOTHING;
  DELETE FROM public.atlas_ondemand_requests WHERE dispatched_at < now() - interval '1 day';
  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.atlas_disney_begin(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_disney_begin(text, jsonb) TO service_role;
