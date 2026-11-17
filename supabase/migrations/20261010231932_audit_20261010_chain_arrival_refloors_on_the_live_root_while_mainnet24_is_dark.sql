-- audit_20261010_chain_arrival_refloors_on_the_live_root_while_mainnet24_is_dark
-- anon-exec: run_chain_arrival_refloor() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- 2026-10-10 (PT; known-issues #181). Every chain-arrival probe starts with a FLOOR check: one
-- holdings script at the mainnet24 root ("held at 2023-11-08?"). mainnet24's node has not
-- completed a handshake since 10-08, so every probe the daily 4:13 AM PT seed creates parks in
-- 'floor' -- including moments that plainly arrived much later. Measured 10-10 ~3:50 PM PT: 548
-- parked probes (9 wallets); 509 had hi inside mainnet27 (alive). ONE script per wallet at
-- 130,290,700 (mainnet27's root, 2025-10-22) answered: 538 NOT held there -> their arrival lies
-- in (130,290,700, hi], all on live nodes; 10 held (the positive control). Moved by hand (ledger
-- 10-10 "538 of the 548"), all 538 finished within ~10 min: 113 Dapper deliveries, 37 other
-- senders, 388 sold-seed ends picked up by the flip lane (99 found in its first 10 min).
--
-- WHAT. run_chain_arrival_refloor() (pg_cron 'rpc-chain-arrival-refloor', every 10 min) does
-- the same, durably, and ONLY while mainnet24 is parked in chain_arrival_dark_nodes:
--   collect   a 200 answer: ids not held -> lo = 130,290,700, status 'bisect', attempts 0,
--             last_error NULL (still 'floor', not in flight, hi above the live root); ids held ->
--             chain_arrival_refloor_held, never asked again (they arrived in the dark window
--             and stay parked for the lane). Any other answer, or none after 10 min, closes the
--             request 'failed' (its ids are asked again next run) and counts a failure (ok=false).
--             Requests are kept with status/result/finished_at as the record.
--   dispatch  'floor' probes not in flight, hi > the live root, not already held/pending,
--             grouped per wallet, <= 1,000 ids a call, <= 10 calls a run, on mainnet27's node.
-- It never touches run_chain_arrival_lane: when mainnet24 answers again the lane's canary
-- clears it, dispatch here stops, and the lane floor-checks whatever is left as before.
-- Pins: supabase/tests/run_chain_arrival_refloor.sql (R1-R7).
--
-- REVERT: SELECT cron.unschedule('rpc-chain-arrival-refloor'); then remove the function
--   run_chain_arrival_refloor() and the tables chain_arrival_refloor_requests / _held.
--   (probes it moved finish normally; undo per audit_20261010_chain_arrival_floor_to_mainnet27's
--   pattern only if the live-root answer is ever shown wrong.)

CREATE TABLE IF NOT EXISTS public.chain_arrival_refloor_requests (
  request_id bigint PRIMARY KEY, wallet text NOT NULL, ids bigint[] NOT NULL, height bigint NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  result text, finished_at timestamptz);
CREATE INDEX IF NOT EXISTS chain_arrival_refloor_requests_pending
  ON public.chain_arrival_refloor_requests (wallet) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS public.chain_arrival_refloor_held (
  wallet text NOT NULL, nft_id bigint NOT NULL, height bigint NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (wallet, nft_id));
ALTER TABLE public.chain_arrival_refloor_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chain_arrival_refloor_held ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_refloor_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.chain_arrival_refloor_held FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.run_chain_arrival_refloor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_live     constant bigint := 130290700;   -- mainnet27 root (130,290,659) + margin
  v_node     constant text := 'http://access-001.mainnet27.nodes.onflow.org:8070';
  v_max_ids  constant int := 1000;
  v_max_call constant int := 10;
  v_src      constant text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): [UInt64] {
  let out: [UInt64] = []
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if col!.borrowMoment(id: id) != nil { out.append(id) } }
  return out
}';
  r record; v_resp record; v_held bigint[]; v_req bigint; v_dark boolean;
  v_collected int := 0; v_moved int := 0; v_kept int := 0; v_failed int := 0; v_dispatched int := 0;
  v_last_error text; v_n int;
BEGIN
  -- collect
  FOR r IN SELECT * FROM public.chain_arrival_refloor_requests WHERE status = 'pending' ORDER BY request_id LOOP
    SELECT status_code, content, error_msg INTO v_resp FROM net._http_response WHERE id = r.request_id;
    IF NOT FOUND THEN
      IF r.dispatched_at < now() - interval '10 minutes' THEN
        v_failed := v_failed + 1; v_last_error := 'no answer in 10 min';
        UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
         WHERE request_id = r.request_id;
      END IF;
      CONTINUE;
    END IF;
    IF v_resp.status_code IS DISTINCT FROM 200 THEN
      v_failed := v_failed + 1;
      v_last_error := left(coalesce('http ' || v_resp.status_code || ': ' || v_resp.content, v_resp.error_msg), 200);
      UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;
    BEGIN
      SELECT coalesce(array_agg((e->>'value')::bigint), '{}') INTO v_held
        FROM jsonb_array_elements(
          convert_from(decode(btrim(v_resp.content, E'" \n'), 'base64'), 'UTF8')::jsonb -> 'value') e;
    EXCEPTION WHEN OTHERS THEN
      v_failed := v_failed + 1; v_last_error := 'undecodable answer: ' || left(v_resp.content, 120);
      UPDATE public.chain_arrival_refloor_requests SET status = 'failed', result = v_last_error, finished_at = now()
       WHERE request_id = r.request_id;
      CONTINUE;
    END;
    v_collected := v_collected + 1;
    INSERT INTO public.chain_arrival_refloor_held (wallet, nft_id, height)
    SELECT r.wallet, i, r.height FROM unnest(r.ids) i WHERE i = ANY (v_held)
    ON CONFLICT (wallet, nft_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_kept := v_kept + v_n;
    UPDATE public.chain_arrival_probes p
       SET lo = r.height, status = 'bisect', attempts = 0, last_error = NULL
     WHERE p.wallet = r.wallet AND p.nft_id = ANY (r.ids) AND NOT (p.nft_id = ANY (v_held))
       AND p.status = 'floor' AND p.request_id IS NULL AND p.hi > r.height;
    GET DIAGNOSTICS v_n = ROW_COUNT; v_moved := v_moved + v_n;
    UPDATE public.chain_arrival_refloor_requests
       SET status = 'done', result = cardinality(v_held) || ' of ' || cardinality(r.ids) || ' held', finished_at = now()
     WHERE request_id = r.request_id;
  END LOOP;

  -- dispatch, only while mainnet24 is parked dark
  SELECT EXISTS (SELECT 1 FROM public.chain_arrival_dark_nodes
                  WHERE node LIKE '%mainnet24%' AND cleared_at IS NULL) INTO v_dark;
  IF v_dark THEN
    FOR r IN
      SELECT q.wallet, array_agg(q.nft_id ORDER BY q.nft_id) AS ids
        FROM (SELECT p.wallet, p.nft_id,
                     (row_number() OVER (PARTITION BY p.wallet ORDER BY p.nft_id) - 1) / v_max_ids AS chunk
                FROM public.chain_arrival_probes p
               WHERE p.status = 'floor' AND p.request_id IS NULL AND p.hi > v_live
                 AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_refloor_held h
                                  WHERE h.wallet = p.wallet AND h.nft_id = p.nft_id)
                 AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_refloor_requests q2
                                  WHERE q2.status = 'pending' AND q2.wallet = p.wallet AND p.nft_id = ANY (q2.ids))) q
       GROUP BY q.wallet, q.chunk
       ORDER BY q.wallet, q.chunk
       LIMIT v_max_call
    LOOP
      v_req := net.http_post(
        url := v_node || '/v1/scripts?block_height=' || v_live,
        body := jsonb_build_object(
          'script', encode(convert_to(v_src, 'UTF8'), 'base64'),
          'arguments', jsonb_build_array(
            encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.wallet)::text, 'UTF8'), 'base64'),
            encode(convert_to(jsonb_build_object('type', 'Array', 'value',
              (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(r.ids) i))::text,
              'UTF8'), 'base64'))),
        timeout_milliseconds := 30000);
      INSERT INTO public.chain_arrival_refloor_requests (request_id, wallet, ids, height)
      VALUES (v_req, r.wallet, r.ids, v_live);
      v_dispatched := v_dispatched + 1;
    END LOOP;
  END IF;

  PERFORM public.log_pipeline_run(
    'chain-arrival-refloor', v_started,
    v_collected, v_moved, v_kept,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'moved_to_bisect', v_moved, 'held_at_live_root', v_kept,
                       'failed', v_failed, 'dispatched', v_dispatched, 'mainnet24_dark', v_dark));

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'moved_to_bisect', v_moved,
                            'held_at_live_root', v_kept, 'failed', v_failed, 'dispatched', v_dispatched,
                            'mainnet24_dark', v_dark, 'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.run_chain_arrival_refloor() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_chain_arrival_refloor() TO postgres, service_role;

SELECT cron.schedule('rpc-chain-arrival-refloor', '4-54/10 * * * *', 'SELECT public.run_chain_arrival_refloor();');
