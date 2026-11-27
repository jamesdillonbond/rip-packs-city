-- audit_20261127_sold_pack_opener_names_own_job
--
-- 2026-11-27 (PT, ~3:15 PM; Claude Code cloud, autonomous pass). Fixes a regression from 20261127224121.
--
-- WHY: 20261127224121 put collect, dispatch and the opener-username step of run_sold_pack_open_tx_reads in
-- separate exception blocks. At 3:06 PM PT the dispatch hit the 120 s pg_cron statement timeout; that
-- cancel was CAUGHT, and a statement timeout fires once per top-level statement, so the username step
-- that followed ran with NO bound (4 min 41 s of DataFileRead until cancelled by hand). A step that can
-- run long must not follow a caught timeout inside the same statement.
--
-- WHAT: the username step moves to its own function run_sold_pack_opener_names() and its own pg_cron job
-- (rpc-sold-pack-opener-names, '17 * * * *', hourly as before), so it gets its own 120 s cap and its own
-- pipeline_runs row ('sold-pack-opener-names', ok = the step worked). run_sold_pack_open_tx_reads keeps
-- collect + dispatch only. Base prosrc md5 asserted (0f3dae860b6fc694d77ea23084933ad1).
--
-- (Applied as 20261127231156; the in-body comment "20261127231500 header" names this file by its draft stamp.)
-- REVERT: SELECT cron.unschedule('rpc-sold-pack-opener-names'); DROP FUNCTION public.run_sold_pack_opener_names();
--   re-apply run_sold_pack_open_tx_reads from 20261127194434 (line 314) -- the pre-11-27-afternoon body.

DO $mig$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.run_sold_pack_open_tx_reads()'::regprocedure)
     IS DISTINCT FROM '0f3dae860b6fc694d77ea23084933ad1' THEN
    RAISE EXCEPTION 'base drifted: run_sold_pack_open_tx_reads is not the 20261127224121 body';
  END IF;
END
$mig$;

CREATE OR REPLACE FUNCTION public.run_sold_pack_open_tx_reads()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '60s'
AS $fn$
DECLARE
  v_collect jsonb; v_dispatched integer; v_err text;
BEGIN
  BEGIN
    v_collect := public.collect_sold_pack_open_tx_reads();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := 'collect: ' || left(SQLERRM, 280);
  END;

  -- 11-27: after a caught timeout nothing bounds the rest of this statement, so dispatch is skipped then
  IF v_err IS NULL OR v_err NOT LIKE '%statement timeout%' THEN
    BEGIN
      v_dispatched := public.dispatch_sold_pack_open_tx_reads(60);
    EXCEPTION WHEN query_canceled OR OTHERS THEN
      v_err := concat_ws(' | ', v_err, 'dispatch: ' || left(SQLERRM, 280));
    END;
  END IF;

  -- the opener-username step runs in its own job: run_sold_pack_opener_names() (20261127231500 header)
  PERFORM public.log_pipeline_run('sold-pack-open-tx-reads', v_err IS NULL,
    jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.run_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_open_tx_reads() TO service_role;

CREATE OR REPLACE FUNCTION public.run_sold_pack_opener_names()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_wallets text[]; v_names integer := 0; v_names_err text;
BEGIN
  -- openers of sold packs with no username on record: one Atlas profile batch (<= 25) per run,
  -- dispatched into member_wallet_username_requests so resolve_member_wallet_usernames_via_atlas
  -- (pg_cron rpc-member-wallet-usernames-atlas) collects it and writes wallet_usernames -- only when
  -- that lane has nothing in flight, so it never doubles its request rate
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.member_wallet_username_requests WHERE drained_at IS NULL) THEN
      SELECT array_agg(w ORDER BY w) INTO v_wallets
        FROM (
          SELECT o.w
            FROM (
              SELECT r.opener_address AS w
                FROM (SELECT pp.pack_nft_id
                        FROM public.pack_purchases pp
                       WHERE pp.pack_nft_id IS NOT NULL AND pp.custom_id IS DISTINCT FROM 'nba'
                         AND pp.seller_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                      UNION
                      SELECT h.pack_nft_id FROM public.topshot_pack_sales_history h
                       WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)
                      UNION
                      SELECT h.pack_nft_id FROM public.allday_pack_sales_history h
                       WHERE h.purchased AND h.storefront_address IN (SELECT DISTINCT wallet_addr FROM public.saved_wallets)) s
                CROSS JOIN LATERAL (SELECT r0.opener_address FROM public.pack_rips r0
                                     WHERE r0.pack_nft_id = s.pack_nft_id LIMIT 1) r
              UNION
              SELECT opener_address FROM public.sold_container_open_search
            ) o
            LEFT JOIN public.wallet_usernames wu ON wu.wallet_addr = o.w
           WHERE o.w ~ '^0x[0-9a-f]{16}$'
             AND (wu.wallet_addr IS NULL
                  OR (wu.username IS NULL AND (wu.last_attempted_at IS NULL OR wu.last_attempted_at < now() - interval '14 days')))
           ORDER BY o.w
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
        v_names := cardinality(v_wallets);
      END IF;
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_names_err := left(SQLERRM, 300);
    v_names := 0;
  END;

  PERFORM public.log_pipeline_run('sold-pack-opener-names', v_names_err IS NULL,
    jsonb_build_object('opener_names_asked', v_names, 'error', v_names_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('opener_names_asked', v_names, 'error', v_names_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.run_sold_pack_opener_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_opener_names() TO service_role;

SELECT cron.schedule('rpc-sold-pack-opener-names', '17 * * * *', 'SELECT public.run_sold_pack_opener_names()');
