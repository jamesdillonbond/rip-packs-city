-- audit_20261118_atlas_wallet_pack_counts_begin
--
-- 2026-11-18 (PT, ~9:30 PM; Claude Code cloud; Trevor: "Keep going") -- #218.
-- /api/wallet-packs (the Collection tab's sealed-pack counts) read Studio GraphQL
-- searchPackNftAggregation, HTTP 530 since 11-17 ("wallet packs HTTP 530" in Vercel runtime errors).
-- Atlas PackService/GetPackCountsByOwnerGroupedByDistribution {product, owner} answers anonymously
-- with distributionPackCounts[{distributionId, sealedCount, openedCount, revealedCount, ...}]
-- (measured 11-18 for nba and nfl). Vercel's egress is firewalled by Atlas (06-16), so the route
-- calls this begin + the shared public.atlas_await_response through pg_net, like the username and
-- listing-verify lanes. Each request is recorded in atlas_ondemand_requests for 403 attribution.
--
-- REVERT: DROP FUNCTION public.atlas_wallet_pack_counts_begin(text, text);

CREATE OR REPLACE FUNCTION public.atlas_wallet_pack_counts_begin(p_wallet text, p_product text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_id bigint;
BEGIN
  IF p_wallet IS NULL OR p_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'bad_wallet' USING ERRCODE = '22023';
  END IF;
  IF p_product IS NULL OR p_product NOT IN ('nba', 'nfl', 'laliga') THEN
    RAISE EXCEPTION 'bad_product' USING ERRCODE = '22023';
  END IF;
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.PackService/GetPackCountsByOwnerGroupedByDistribution',
    body := jsonb_build_object('product', p_product, 'owner', substr(p_wallet, 3)),
    headers := public.atlas_market_headers(p_product),
    timeout_milliseconds := 8000);
  INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_id, 'wallet-pack-counts:' || p_product)
  ON CONFLICT (request_id) DO NOTHING;
  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.atlas_wallet_pack_counts_begin(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_wallet_pack_counts_begin(text, text) TO service_role;
