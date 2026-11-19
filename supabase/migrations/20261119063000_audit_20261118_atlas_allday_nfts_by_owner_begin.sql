-- audit_20261118_atlas_allday_nfts_by_owner_begin
--
-- 2026-11-18 (PT, ~9:40 PM; Claude Code cloud; Trevor: "Keep going") -- #218.
-- The All Day wallet backfill (/api/wallet-backfill-allday, lib/chains/flow/allday-studio-holdings.ts)
-- reads Dapper-custodied (locked) moments that the on-chain getIDs() cannot see. It read them from
-- Studio GraphQL searchAllDayNft, HTTP 530 since 11-17. While Studio is down that walk is ok:false on
-- every wallet, so locked moments are missing from new scans AND the delete-not-seen step is skipped
-- for every All Day wallet ("studio_custody_walk_degraded").
--
-- Atlas NFTService/SearchNftsByOwner {product:'nfl', ownerAddress (bare hex), limit, offset} answers
-- anonymously with nfts[{id, editionId, serialNumber, isLocked, ...}] + pagination{totalCount, hasMore}.
-- Measured 11-18: limit is CLAMPED to 100; wallet 0xbd94cade097e50ac totalCount 3807 (Studio read
-- 3,707 on 08-08); wallet 0xdcd41c74d2dd0a66 returns its 3 locked moments. Vercel's egress is
-- firewalled by Atlas (06-16), so the route calls this begin + public.atlas_await_response through
-- pg_net. Each request is recorded in atlas_ondemand_requests for 403 attribution.
--
-- REVERT: DROP FUNCTION public.atlas_allday_nfts_by_owner_begin(text, integer);

CREATE OR REPLACE FUNCTION public.atlas_allday_nfts_by_owner_begin(p_wallet text, p_offset integer)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE v_id bigint;
BEGIN
  IF p_wallet IS NULL OR p_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RAISE EXCEPTION 'bad_wallet' USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 OR p_offset > 100000 OR p_offset % 100 <> 0 THEN
    RAISE EXCEPTION 'bad_offset' USING ERRCODE = '22023';
  END IF;
  v_id := net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.NFTService/SearchNftsByOwner',
    body := jsonb_build_object('product', 'nfl', 'ownerAddress', substr(p_wallet, 3), 'limit', 100, 'offset', p_offset),
    headers := public.atlas_market_headers('nfl'),
    timeout_milliseconds := 10000);
  INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_id, 'allday-nfts-by-owner')
  ON CONFLICT (request_id) DO NOTHING;
  RETURN v_id;
END
$function$;

REVOKE ALL ON FUNCTION public.atlas_allday_nfts_by_owner_begin(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_allday_nfts_by_owner_begin(text, integer) TO service_role;
