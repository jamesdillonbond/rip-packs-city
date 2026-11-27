-- audit_20261127_sold_pack_open_tx_reads_steps_isolated
--
-- 2026-11-27 (PT, ~3:00 PM; Claude Code cloud, autonomous pass).
--
-- WHY (read from the lane's first 6 hours):
-- 1. run_sold_pack_open_tx_reads (pg_cron 945, every 10 min) ran collect + dispatch + the opener-username
--    step in ONE exception block. When the username step hit the 120 s pg_cron cap (11-27 1:06 PM and
--    2:26 PM PT), the block rolled back the collect and the dispatch with it -- yet the run record still
--    said `collect: {collected: 60, rows_written: 244}`: a failed write published as rows written.
-- 2. The username step re-derives the opener set of ~50k sold packs every tick (a per-pack probe of
--    pack_rips, 3.8M rows; 3-4 s per source leg cold, ~30-110 s whole), 6x an hour, to ask Atlas for
--    at most 25 names. The opener set changes slowly; once an hour is enough.
--
-- WHAT: collect, dispatch and the username step each get their own exception block, so a failure in
-- one cannot undo another. The run's ok reflects collect + dispatch (this lane's own work); the username
-- step reports `names_error` separately (a failure of ONE source must not gate a field fed by another).
-- The username step runs only on the :06 tick (minute < 10). Body otherwise byte-identical in effect.
-- Base prosrc md5 asserted (a184e99fb213df02bbeb4d7e61d0eb4e, from 20261127194434), so a concurrent
-- redefinition makes this refuse rather than revert it.
--
-- REVERT: re-apply run_sold_pack_open_tx_reads from
--   20261127194434_audit_20261127_sold_pack_outcomes_v4_marketplace_sales.sql (line 314).

DO $mig$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.run_sold_pack_open_tx_reads()'::regprocedure)
     IS DISTINCT FROM 'a184e99fb213df02bbeb4d7e61d0eb4e' THEN
    RAISE EXCEPTION 'base drifted: run_sold_pack_open_tx_reads is not the body this migration was written against';
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
  v_collect jsonb; v_dispatched integer; v_err text; v_names_err text;
  v_wallets text[]; v_names integer := 0;
  v_names_due boolean := extract(minute FROM now()) < 10;   -- 11-27: the :06 tick only
BEGIN
  BEGIN
    v_collect := public.collect_sold_pack_open_tx_reads();
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := 'collect: ' || left(SQLERRM, 280);
  END;

  BEGIN
    v_dispatched := public.dispatch_sold_pack_open_tx_reads(60);
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := concat_ws(' | ', v_err, 'dispatch: ' || left(SQLERRM, 280));
  END;

  -- openers of sold packs with no username on record: one Atlas profile batch (<= 25) per run,
  -- dispatched into member_wallet_username_requests so resolve_member_wallet_usernames_via_atlas
  -- (pg_cron rpc-member-wallet-usernames-atlas) collects it and writes wallet_usernames -- only when
  -- that lane has nothing in flight, so it never doubles its request rate
  IF v_names_due THEN
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
  END IF;

  PERFORM public.log_pipeline_run('sold-pack-open-tx-reads', v_err IS NULL,
    jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched,
                       'opener_names_asked', v_names, 'names_due', v_names_due, 'names_error', v_names_err,
                       'error', v_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('collect', v_collect, 'dispatched', v_dispatched, 'opener_names_asked', v_names,
                            'names_error', v_names_err, 'error', v_err);
END
$fn$;

REVOKE ALL ON FUNCTION public.run_sold_pack_open_tx_reads() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_sold_pack_open_tx_reads() TO service_role;
