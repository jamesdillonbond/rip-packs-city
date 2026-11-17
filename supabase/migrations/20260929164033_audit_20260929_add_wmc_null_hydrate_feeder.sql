-- Structural fix for the wmc NULL-edition_key leak: the entire moment-hydration pipeline
-- (dispatch_head / dispatch / hydrate_from_wmc / v_moments_needing_hydration) feeds ONLY off
-- moment_acquisitions verified pack_pulls, so a moment merely SEEN in a wallet (a wmc stub) with
-- no verified pull and no free-source resolution never gets a chain read -> never lands in moments
-- -> reconcile_wmc_edition_key_from_moments can never fill its edition_key. This feeder closes that
-- gap by enqueuing the SAME read-only Flow borrowMoment script (no tx, no cost, no auth) for TS wmc
-- rows with NULL edition_key, so the existing drain (topshot_moment_hydrate_drain) resolves them
-- into moments. Mirrors topshot_moment_hydrate_dispatch_head; bounded by p_max and scheduled on a
-- minute offset from the tick (jobid 469) to stay under the Flow node's 100 req/s burst limit.
-- anon-exec: revoked (topshot_moment_hydrate_dispatch_wmc_nulls) — new SECDEF enqueuer, service_role only; verified below.
CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch_wmc_nulls(p_max integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  r record; v_req bigint; v_n int := 0;
  v_coll uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('topshot_moment_hydrate_dispatch_wmc_nulls')::bigint) THEN
    RETURN jsonb_build_object('skipped','concurrent');
  END IF;
  FOR r IN
    SELECT DISTINCT ON (w.moment_id) w.moment_id, w.wallet_address AS wallet
      FROM public.wallet_moments_cache w
     WHERE w.collection_id = v_coll
       AND w.edition_key IS NULL
       AND w.moment_id IS NOT NULL
       AND w.wallet_address ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moments m
                        WHERE m.nft_id = w.moment_id AND m.collection_id = v_coll)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_moment_hydrate_requests q
                        WHERE q.nft_id = w.moment_id
                          AND q.dispatched_at > now() - CASE
                                WHEN q.outcome IN ('no_nft','no_collection') THEN interval '30 days'
                                WHEN q.outcome IS NULL THEN interval '10 minutes'
                                ELSE interval '1 day' END)
     ORDER BY w.moment_id, w.last_seen_at DESC NULLS LAST
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed',
      body := jsonb_build_object(
        'script', v_script,
        'arguments', jsonb_build_array(
          encode(convert_to('{"type":"Address","value":"' || r.wallet || '"}', 'UTF8'), 'base64'),
          encode(convert_to('{"type":"UInt64","value":"' || r.moment_id || '"}', 'UTF8'), 'base64'))),
      headers := '{"Content-Type":"application/json"}'::jsonb,
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_moment_hydrate_requests (request_id, nft_id, wallet)
      VALUES (v_req, r.moment_id, r.wallet);
    v_n := v_n + 1;
  END LOOP;
  PERFORM public.log_pipeline_run('topshot-moment-hydrate-wmc-nulls', v_started, v_n, v_n, 0,
    true, NULL, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('dispatched', v_n, 'via', 'pg_cron',
      'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('dispatched', v_n);
END
$function$;

REVOKE EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch_wmc_nulls(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch_wmc_nulls(integer) TO postgres, service_role;