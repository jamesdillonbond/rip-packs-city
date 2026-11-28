-- Big-spender watch: a scheduled Candy (Solana) whale username lane (2026-11-27, Trevor: "Yes do that. Keep going
-- … Make sure any scheduled tasks live outside this thread"). The first 30 names were read by hand in Chrome
-- (20261128025030). This moves the same method into the database so it keeps running: pg_net fetches
-- https://candy.io/collectibles/<mint> (server-rendered, 200 from the DB, measured 6:58 PM PT) for cards an
-- unnamed Solana whale bought and never resold, and reads "Owned by @<username>".
--   * A name is written only when at least TWO checked cards show the same owner and no other owner is seen as often.
--   * Up to 12 cards per wallet, at most 3 in flight per wallet and 12 requests per run (every 10 min).
--   * Each response is parsed on the next run and then deleted from net._http_response (pages are ~440 KB).
--   * A request with no response after 30 min, or a non-200, is recorded with its error; errored checks are cleared
--     after a day so the card can be tried again.
-- Also adds the missing cadence watch for the Atlas lane (pg_cron 958, big_spender_usernames).
-- Revert: select cron.unschedule('rpc-big-spender-candy-usernames');
--         DROP FUNCTION public.run_big_spender_candy_usernames(); DROP TABLE public.big_spender_candy_owner_checks;
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline IN ('big_spender_candy_usernames','big_spender_usernames');

CREATE TABLE public.big_spender_candy_owner_checks (
  wallet_key   text NOT NULL,
  mint         text NOT NULL,
  request_id   bigint,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status_code  integer,
  owner        text,
  error        text,
  checked_at   timestamptz,
  PRIMARY KEY (wallet_key, mint)
);
CREATE INDEX big_spender_candy_owner_checks_pending_idx ON public.big_spender_candy_owner_checks (request_id) WHERE checked_at IS NULL;
ALTER TABLE public.big_spender_candy_owner_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.big_spender_candy_owner_checks FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.big_spender_candy_owner_checks IS
  'One candy.io card-page check per (Solana whale wallet, card mint): who candy.io says owns the card. Written by run_big_spender_candy_usernames(). Internal only.';

-- anon-exec: revoked (run_big_spender_candy_usernames) — new SECDEF writer; service_role/postgres only.
CREATE FUNCTION public.run_big_spender_candy_usernames()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_harvested integer := 0; v_expired integer := 0; v_cleared integer := 0;
  v_named integer := 0; v_queued integer := 0;
  v_harvest_err text; v_name_err text; v_queue_err text;
  r record;
BEGIN
  -- 1. Read the responses that arrived, then drop them from pg_net's table.
  BEGIN
    WITH got AS (
      UPDATE public.big_spender_candy_owner_checks c
         SET status_code = h.status_code,
             owner = CASE WHEN h.status_code = 200 THEN
                       (regexp_match(h.content, 'Owned by\s*(?:<[^>]*>|\s|<!--[^>]*-->)*@([A-Za-z0-9_.\-]+)'))[1] END,
             error = CASE WHEN h.status_code = 200 THEN NULL
                          ELSE left(coalesce(h.error_msg, 'http ' || h.status_code), 200) END,
             checked_at = now()
        FROM net._http_response h
       WHERE c.checked_at IS NULL AND c.request_id = h.id
      RETURNING c.request_id
    ), del AS (
      DELETE FROM net._http_response h USING got WHERE h.id = got.request_id RETURNING 1
    )
    SELECT count(*) INTO v_harvested FROM got;

    UPDATE public.big_spender_candy_owner_checks
       SET error = 'no response after 30 min', checked_at = now()
     WHERE checked_at IS NULL AND requested_at < now() - interval '30 minutes';
    GET DIAGNOSTICS v_expired = ROW_COUNT;

    DELETE FROM public.big_spender_candy_owner_checks
     WHERE error IS NOT NULL AND checked_at < now() - interval '1 day';
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_harvest_err := left(SQLERRM, 300);
  END;

  -- 2. Name a wallet once two of its cards agree and no other owner ties.
  BEGIN
    WITH counts AS (
      SELECT wallet_key, owner, count(*) n,
             row_number() OVER (PARTITION BY wallet_key ORDER BY count(*) DESC, owner) rk,
             lead(count(*)) OVER (PARTITION BY wallet_key ORDER BY count(*) DESC, owner) next_n
        FROM public.big_spender_candy_owner_checks
       WHERE owner IS NOT NULL
       GROUP BY wallet_key, owner
    )
    UPDATE public.big_spender_wallets bw
       SET username = c.owner, updated_at = now()
      FROM counts c
     WHERE c.rk = 1 AND c.n >= 2 AND (c.next_n IS NULL OR c.next_n < c.n)
       AND bw.wallet_key = c.wallet_key AND bw.chain = 'solana' AND bw.username IS NULL;
    GET DIAGNOSTICS v_named = ROW_COUNT;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_name_err := left(SQLERRM, 300);
  END;

  -- 3. Ask candy.io about the next cards.
  BEGIN
    FOR r IN
      WITH w AS (
        SELECT bw.wallet_key, bw.top_sale_usd,
               (SELECT count(*) FROM public.big_spender_candy_owner_checks c
                 WHERE c.wallet_key = bw.wallet_key AND c.checked_at IS NULL) pending
          FROM public.big_spender_wallets bw
         WHERE bw.chain = 'solana' AND bw.username IS NULL AND NOT bw.muted
      ), held AS (
        SELECT w.wallet_key, w.top_sale_usd, w.pending, s.nft_id mint,
               row_number() OVER (PARTITION BY w.wallet_key ORDER BY s.sold_at DESC, s.nft_id) rn
          FROM w
          JOIN public.sales_market s
            ON s.buyer_address = w.wallet_key
           AND s.collection_id = (SELECT id FROM public.collections WHERE slug = 'candy_mlb')
         WHERE s.nft_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.sales_market s2
                            WHERE s2.collection_id = s.collection_id AND s2.nft_id = s.nft_id AND s2.sold_at > s.sold_at)
      ), todo AS (
        SELECT h.*, row_number() OVER (PARTITION BY h.wallet_key ORDER BY h.rn) k
          FROM held h
         WHERE h.rn <= 12
           AND NOT EXISTS (SELECT 1 FROM public.big_spender_candy_owner_checks c
                            WHERE c.wallet_key = h.wallet_key AND c.mint = h.mint)
      )
      SELECT wallet_key, mint FROM todo
       WHERE k <= 3 - pending
       ORDER BY top_sale_usd DESC, wallet_key, k
       LIMIT 12
    LOOP
      INSERT INTO public.big_spender_candy_owner_checks (wallet_key, mint, request_id)
      VALUES (r.wallet_key, r.mint,
              net.http_get(
                url := 'https://candy.io/collectibles/' || r.mint,
                headers := '{"User-Agent":"Mozilla/5.0 (compatible; RipPacksCity/1.0; +https://www.rippackscity.com)","Accept":"text/html"}'::jsonb,
                timeout_milliseconds := 20000));
      v_queued := v_queued + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_queue_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('big_spender_candy_usernames',
    v_harvest_err IS NULL AND v_name_err IS NULL AND v_queue_err IS NULL,
    jsonb_build_object('harvested', v_harvested, 'expired', v_expired, 'cleared', v_cleared, 'harvest_error', v_harvest_err,
                       'named', v_named, 'name_error', v_name_err,
                       'queued', v_queued, 'queue_error', v_queue_err, 'via', 'pg_cron'));
  RETURN jsonb_build_object('harvested', v_harvested, 'expired', v_expired, 'named', v_named, 'queued', v_queued,
                            'harvest_error', v_harvest_err, 'name_error', v_name_err, 'queue_error', v_queue_err);
END
$function$;
REVOKE EXECUTE ON FUNCTION public.run_big_spender_candy_usernames() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_big_spender_candy_usernames() TO postgres, service_role;

INSERT INTO public.pipeline_cadence_watchlist (pipeline, max_silent_minutes, max_minutes_without_success, severity, notes)
VALUES
  ('big_spender_candy_usernames', 60, 180, 'info',
   'pg_cron rpc-big-spender-candy-usernames (2-52/10 * * * *). run_big_spender_candy_usernames() — reads candy.io card pages to name Solana whales in big_spender_wallets. Logs every run; ok=false when any step errored. audit_20261127.'),
  ('big_spender_usernames', 60, 180, 'info',
   'pg_cron 958 rpc-big-spender-usernames (4-54/10 * * * *). run_big_spender_usernames() — asks Atlas for unnamed Flow whale usernames. Logs every run. audit_20261127.')
ON CONFLICT (pipeline) DO NOTHING;

SELECT cron.schedule('rpc-big-spender-candy-usernames', '2-52/10 * * * *', 'select public.run_big_spender_candy_usernames()');
