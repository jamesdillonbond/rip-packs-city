-- 2026-09-29: a key-less Top Shot wallet_moments_cache row is named from a CHAIN READ OF ITS OWN WALLET.
--
-- WHY. /api/wallet-search inserts a held moment key-less when both of its enrichment legs fail (Top Shot
-- GraphQL has answered 530 since 09-13, so a transient Flow failure is enough). Nothing ever named such a
-- row again: the route only enriches the page being viewed, and the chain-read hydrator (job 469) feeds
-- only on recent pack pulls. Two rows on 0xbd94cade097e50ac had sat key-less since April; all three live
-- ones resolve on chain today (48:1652#507, 218:8370#3728, 26:677#28324). This was the "missing re-check
-- path" of the 09-22 handoff.
--
-- WHY NOT reconcile_wmc_edition_key_from_moments (job 587). It fills only where a SALE or the subedition
-- map corroborates `moments`, because `moments` can come from sources that mis-keyed Top Shot before. A
-- never-sold moment has neither, so it is refused forever. The corroboration this adds is stronger than
-- either: a chain read of THIS wallet (topshot_moment_hydrate_requests.outcome = 'written', same wallet)
-- whose `moments` row it wrote (owner_address = the same wallet). It confirms the holding AND the edition.
--
-- HOW. heal_topshot_wmc_null_keys(p_max):
--   1. FILL rows whose moment has a completed chain read of the stored wallet. Serial fits the set:play
--      circulation (base + parallels, the reconcile's own denominator). Logged per row.
--   2. DISPATCH chain reads for the rest into the EXISTING request table, same script and same backoff as
--      the head dispatcher (no_nft / no_collection → 30 days). Job 469 drains them; the next tick fills.
-- Hourly at :27, 20 reads max: the quietest minute measured, far under the access node's burst limit.
--
-- Revert:
--   SELECT cron.unschedule('rpc-topshot-wmc-null-key-heal');
--   UPDATE public.wallet_moments_cache w SET edition_key = NULL, serial_number = f.prior_serial
--     FROM public.topshot_wmc_null_key_chain_fills f WHERE w.id = f.wmc_id;
--   DROP FUNCTION IF EXISTS public.heal_topshot_wmc_null_keys(integer);
--   DROP TABLE IF EXISTS public.topshot_wmc_null_key_chain_fills;

CREATE TABLE IF NOT EXISTS public.topshot_wmc_null_key_chain_fills (
  wmc_id         uuid PRIMARY KEY,
  wallet_address text NOT NULL,
  moment_id      text NOT NULL,
  filled_key     text NOT NULL,
  filled_serial  integer,
  prior_serial   integer,
  request_id     bigint,
  filled_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.topshot_wmc_null_key_chain_fills ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_wmc_null_key_chain_fills FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.heal_topshot_wmc_null_keys(p_max integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_started  timestamptz := clock_timestamp();
  v_waiting  int := 0;
  v_filled   int := 0;
  v_refused  int := 0;
  v_sent     int := 0;
  v_req      bigint;
  r          record;
  v_err      text;
  v_script   text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  BEGIN
    SELECT count(*) INTO v_waiting
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_ts AND w.edition_key IS NULL;

    -- 1. FILL from a completed chain read of the SAME wallet.
    DROP TABLE IF EXISTS _hk_cand;
    CREATE TEMP TABLE _hk_cand ON COMMIT DROP AS
      SELECT DISTINCT ON (w.id)
             w.id AS wmc_id, w.wallet_address, w.moment_id, w.serial_number AS prior_serial,
             e.external_id AS proposed_key, m.serial_number AS chain_serial, q.request_id,
             (SELECT sum(t.circulation_count) FROM public.editions t
               WHERE t.collection_id = v_ts
                 AND (t.external_id = split_part(e.external_id, '::', 1)
                   OR t.external_id LIKE split_part(e.external_id, '::', 1) || '::%')) AS edition_total
        FROM public.wallet_moments_cache w
        JOIN public.topshot_moment_hydrate_requests q
          ON q.nft_id = w.moment_id AND q.wallet = w.wallet_address AND q.outcome = 'written'
        JOIN public.moments m
          ON m.nft_id = w.moment_id AND m.collection_id = v_ts AND m.owner_address = w.wallet_address
        JOIN public.editions e ON e.id = m.edition_id AND e.collection_id = v_ts
       WHERE w.collection_id = v_ts AND w.edition_key IS NULL
       ORDER BY w.id, q.drained_at DESC NULLS LAST;

    SELECT count(*) INTO v_refused FROM _hk_cand c
     WHERE c.chain_serial IS NOT NULL AND c.edition_total IS NOT NULL AND c.chain_serial > c.edition_total;

    WITH ok AS (
      SELECT c.* FROM _hk_cand c
       WHERE NOT (c.chain_serial IS NOT NULL AND c.edition_total IS NOT NULL AND c.chain_serial > c.edition_total)
    ),
    logged AS (
      INSERT INTO public.topshot_wmc_null_key_chain_fills
             (wmc_id, wallet_address, moment_id, filled_key, filled_serial, prior_serial, request_id)
      SELECT ok.wmc_id, ok.wallet_address, ok.moment_id, ok.proposed_key, ok.chain_serial, ok.prior_serial, ok.request_id
        FROM ok
      ON CONFLICT (wmc_id) DO NOTHING
      RETURNING wmc_id
    ),
    upd AS (
      UPDATE public.wallet_moments_cache w
         SET edition_key   = ok.proposed_key,
             serial_number = coalesce(ok.chain_serial, w.serial_number)
        FROM ok
       WHERE w.id = ok.wmc_id AND w.edition_key IS NULL
         AND w.id IN (SELECT wmc_id FROM logged)
      RETURNING 1
    )
    SELECT count(*)::int INTO v_filled FROM upd;

    -- 2. DISPATCH reads for what is still key-less, with the head dispatcher's backoff.
    FOR r IN
      SELECT w.moment_id AS nft_id, w.wallet_address AS wallet
        FROM public.wallet_moments_cache w
       WHERE w.collection_id = v_ts
         AND w.edition_key IS NULL
         AND w.wallet_address ~ '^0x[0-9a-f]{16}$'
         AND w.moment_id ~ '^[0-9]+$'
         AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                          WHERE q.nft_id = w.moment_id AND q.wallet = w.wallet_address
                            AND q.dispatched_at > now() - CASE
                                  WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                                  WHEN q.outcome IS NULL THEN interval '10 minutes'
                                  ELSE interval '1 day' END)
       ORDER BY w.last_seen_at DESC NULLS LAST, w.id
       LIMIT GREATEST(p_max, 0)
    LOOP
      v_req := net.http_post(
        url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
        body := jsonb_build_object(
          'script', v_script,
          'arguments', jsonb_build_array(
            encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
            encode(convert_to('{"type":"UInt64","value":"' || r.nft_id || '"}', 'UTF8'), 'base64'))),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        timeout_milliseconds := 20000);
      INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet) VALUES (v_req, r.nft_id, r.wallet);
      v_sent := v_sent + 1;
    END LOOP;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run(
    'topshot-wmc-null-key-heal', v_started, v_waiting, v_filled, v_refused,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('waiting', v_waiting, 'filled', v_filled, 'refused_impossible_serial', v_refused,
                       'reads_dispatched', v_sent, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));

  RETURN jsonb_build_object('waiting', v_waiting, 'filled', v_filled, 'refused_impossible_serial', v_refused,
                            'reads_dispatched', v_sent, 'error', v_err);
END
$fn$;

COMMENT ON FUNCTION public.heal_topshot_wmc_null_keys(integer) IS
  'Names key-less Top Shot wallet_moments_cache rows from a chain read of their OWN wallet: fills where a '
  'topshot_moment_hydrate_requests read of (moment, wallet) was written and moments.owner_address is that '
  'wallet; queues reads (job 469 drains them) for the rest. Hourly at :27. Fills logged in '
  'topshot_wmc_null_key_chain_fills.';

REVOKE ALL ON FUNCTION public.heal_topshot_wmc_null_keys(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.heal_topshot_wmc_null_keys(integer) TO postgres, service_role;

SELECT cron.schedule('rpc-topshot-wmc-null-key-heal', '27 * * * *', 'SELECT public.heal_topshot_wmc_null_keys(20)');
