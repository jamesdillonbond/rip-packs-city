-- Big-spender watch: ask Atlas for the usernames of unnamed Flow whales (2026-11-27, "Keep going").
-- 66 of 404 tracked Flow wallets had no username and had never been asked about (no wallet_usernames
-- row), so Whale Watch showed them as shortened wallets. Same polite pattern as run_sold_pack_opener_names():
-- one Atlas profile batch (<= 25 wallets) per run, dispatched into member_wallet_username_requests so
-- resolve_member_wallet_usernames_via_atlas (pg_cron rpc-member-wallet-usernames-atlas) collects it and
-- writes wallet_usernames — and only when that lane has nothing in flight, so it never doubles its
-- request rate. A miss is re-asked after 14 days. refresh_big_spender_wallets() copies new names in.
-- Revert: select cron.unschedule('rpc-big-spender-usernames'); DROP FUNCTION public.run_big_spender_usernames();

-- anon-exec: revoked (run_big_spender_usernames) — new SECDEF writer; service_role/postgres only.
CREATE FUNCTION public.run_big_spender_usernames()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallets text[]; v_asked integer := 0; v_err text;
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.member_wallet_username_requests WHERE drained_at IS NULL) THEN
      SELECT array_agg(w ORDER BY w) INTO v_wallets
        FROM (
          SELECT bw.wallet_key AS w
            FROM public.big_spender_wallets bw
            LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = bw.wallet_key
           WHERE bw.chain = 'flow'
             AND bw.username IS NULL
             AND bw.wallet_key ~ '^0x[0-9a-f]{16}$'
             AND (wu.wallet_addr IS NULL
                  OR (wu.username IS NULL AND (wu.last_attempted_at IS NULL OR wu.last_attempted_at < now() - interval '14 days')))
           ORDER BY bw.top_sale_usd DESC, bw.wallet_key
           LIMIT 25
        ) c;
      IF v_wallets IS NOT NULL THEN
        INSERT INTO public.member_wallet_username_requests (request_id, wallets)
        VALUES (net.http_post(
                  url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
                  body := jsonb_build_object('product', 'nba', 'flow_addresses', to_jsonb(v_wallets)),
                  headers := public.atlas_market_headers('nba'),
                  timeout_milliseconds := 15000),
                v_wallets);
        v_asked := cardinality(v_wallets);
      END IF;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
    v_asked := 0;
  END;

  -- A username that arrived since the last 6-hourly refresh is copied in now, so the board can use it.
  UPDATE public.big_spender_wallets bw
     SET username = wu.username, updated_at = now()
    FROM public.wallet_usernames wu
   WHERE bw.chain = 'flow' AND bw.username IS NULL
     AND wu.wallet_addr = bw.wallet_key AND wu.username IS NOT NULL;

  PERFORM public.log_pipeline_run('big_spender_usernames', v_err IS NULL,
    jsonb_build_object('asked', v_asked, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('asked', v_asked, 'error', v_err);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.run_big_spender_usernames() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_big_spender_usernames() TO postgres, service_role;
