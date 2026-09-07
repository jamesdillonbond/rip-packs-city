-- audit_20260907: the chain hydrator's dispatch walk is cursored -- a tick's cost is bounded by construction.
--
-- Measured 21:2xZ, six hours after the lane went live: the newest-first candidate scan re-examined the
-- 11,135 newest queue rows every tick (8,656 of them already named -- by this lane, the wmc hydrator or
-- the sales source -- and 1,839 of the rest already asked and filed no_nft), 69K buffers per dispatch
-- (4.6K at ship), tick duration 1.5 s -> 4-6 s. The same compounding shape as the Atlas edition
-- dispatcher this morning (20260907055104): a scan that starts from the top of a queue whose top is
-- what the scan itself resolves.
--
-- Now: a page of at most p_page (3,000) queue rows behind a <acquired_date>|<nft_id> cursor in
-- backfill_state ('topshot-moments-hydrate-chain'), the same walk the wmc hydrator makes; the four
-- exclusions and the request-window check apply to the page; the cursor advances to the last candidate
-- emitted when the page held more than p_max, otherwise past the page; a short page wraps to a new pass
-- from the newest pull. A full pass over the ~640K pack-pull rows is ~215 ticks (~14 h) once the backlog
-- is named, so a new pull waits at most that long for this lane (the wmc hydrator usually names it first).
-- Per tick: ~3,000 index rows + their moments probes (~12K buffers) instead of a growing re-scan.
-- Signature gains p_page (default 3000); the cron command `topshot_moment_hydrate_tick(80)` is unchanged.
--
-- REVERT: re-apply topshot_moment_hydrate_dispatch from 20260907155014 (newest-first, no cursor);
--         DROP FUNCTION public.topshot_moment_hydrate_dispatch(int, int);
--         DELETE FROM public.backfill_state WHERE id = 'topshot-moments-hydrate-chain';

DROP FUNCTION IF EXISTS public.topshot_moment_hydrate_dispatch(int);

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch(p_max int DEFAULT 80, p_page int DEFAULT 3000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record; v_req bigint; v_n int := 0;
  v_state_id text := 'topshot-moments-hydrate-chain';
  v_cursor text; v_cur_date timestamptz; v_cur_nft text;
  v_page_n int := 0; v_page_date timestamptz; v_page_nft text;
  v_last_date timestamptz; v_last_nft text; v_wrapped boolean := false;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  -- The walk is cursored (backfill_state 'topshot-moments-hydrate-chain'): every tick examines at most
  -- p_page queue rows behind <acquired_date>|<nft_id>, so the cost of a tick is bounded by construction
  -- and does not grow with the rows already named (the newest-first re-scan was 69K buffers after 6 h).
  INSERT INTO public.backfill_state (id, cursor, total_ingested, status, notes)
  VALUES (v_state_id, NULL, 0, 'running',
          'Chain hydrator dispatch cursor = <acquired_date>|<nft_id> of the last queue row examined; NULL = start a new pass from the newest pull')
  ON CONFLICT (id) DO NOTHING;
  SELECT cursor INTO v_cursor FROM public.backfill_state WHERE id = v_state_id;
  IF v_cursor IS NOT NULL AND v_cursor <> '' THEN
    v_cur_date := split_part(v_cursor, '|', 1)::timestamptz;
    v_cur_nft  := split_part(v_cursor, '|', 2);
  END IF;

  DROP TABLE IF EXISTS _chain_page;
  CREATE TEMP TABLE _chain_page ON COMMIT DROP AS
  SELECT ma.nft_id, ma.wallet, ma.acquired_date
    FROM public.moment_acquisitions ma
   WHERE ma.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND ma.acquisition_method = 'pack_pull'
     AND ma.acquisition_confidence = 'verified'
     AND (v_cur_date IS NULL OR (ma.acquired_date, ma.nft_id) < (v_cur_date, v_cur_nft))
   ORDER BY ma.acquired_date DESC, ma.nft_id DESC
   LIMIT GREATEST(p_page, p_max);
  SELECT count(*), min(acquired_date) INTO v_page_n, v_page_date FROM _chain_page;
  SELECT nft_id INTO v_page_nft FROM _chain_page ORDER BY acquired_date ASC, nft_id ASC LIMIT 1;

  FOR r IN
    SELECT ma.nft_id, ma.wallet, ma.acquired_date
      FROM _chain_page ma
     WHERE ma.wallet ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = ma.nft_id AND m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd')
       -- a row one of the free sources will name on its next pass is not worth a script
       AND NOT EXISTS (SELECT 1 FROM public.wallet_moments_cache w
                        JOIN public.editions e ON e.collection_id = w.collection_id AND e.external_id = w.edition_key
                       WHERE w.moment_id = ma.nft_id AND w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND w.serial_number IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_events ev
                        JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id AND m.rpc_edition_id IS NOT NULL
                       WHERE ev.product = 'nba' AND ev.nft_id = ma.nft_id AND ev.serial_number IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.sales sl
                       WHERE sl.nft_id = ma.nft_id AND sl.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
                         AND sl.edition_id IS NOT NULL AND sl.serial_number > 0
                         AND sl.sold_at >= ma.acquired_date - interval '1 day')
       AND NOT EXISTS (
         SELECT 1 FROM public.topshot_moment_hydrate_requests q
          WHERE q.nft_id = ma.nft_id
            AND q.dispatched_at > now() - CASE
                  WHEN q.outcome IN ('no_nft', 'no_collection') THEN interval '30 days'
                  WHEN q.outcome IS NULL THEN interval '10 minutes'   -- in flight
                  ELSE interval '1 day' END)
     ORDER BY ma.acquired_date DESC, ma.nft_id DESC
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
    v_n := v_n + 1; v_last_date := r.acquired_date; v_last_nft := r.nft_id;
  END LOOP;

  -- Advance: to the last candidate emitted when the page had more than p_max, otherwise past the whole
  -- page; a short page is the end of the queue -> wrap, and the next tick starts a new pass from the top.
  IF v_n >= p_max AND v_last_date IS NOT NULL THEN
    UPDATE public.backfill_state SET cursor = v_last_date::text || '|' || v_last_nft, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  ELSIF v_page_n >= GREATEST(p_page, p_max) THEN
    UPDATE public.backfill_state SET cursor = v_page_date::text || '|' || v_page_nft, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  ELSE
    v_wrapped := true;
    UPDATE public.backfill_state SET cursor = NULL, last_run_at = now(),
           total_ingested = COALESCE(total_ingested, 0) + v_n, status = 'running' WHERE id = v_state_id;
  END IF;
  RETURN jsonb_build_object('dispatched', v_n, 'examined', v_page_n, 'wrapped', v_wrapped);
END $$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_dispatch(int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch(int, int) TO service_role;
