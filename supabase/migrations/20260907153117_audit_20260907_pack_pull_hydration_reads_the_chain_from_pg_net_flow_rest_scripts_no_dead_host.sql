-- audit_20260907: the rest of the pack-pull hydration queue is read ON-CHAIN, from the database — no dead host, no worker.
--
-- WHERE THIS STANDS. `topshot-moments-hydrator` (Cloudflare worker, cron-job.org, INACTIVE since
-- 08-30) named pack-pulled Top Shot moments by asking public-api.nbatopshot.com, which answers 530.
-- Today `hydrate_topshot_moments_from_wmc()` (jobid 468) serves every pull the wallet cache or the
-- Atlas marketplace events have already seen — 34,854 rows in its first 26 ticks. **176,337 pulls
-- remain**, 4,877 wallets, heavily concentrated (top 200 wallets = 61 %), and only 200 of those
-- wallets have ever been walked. Every one of them is answerable by one Cadence script against the
-- puller's wallet, and Supabase's pg_net can POST that script to the public Flow REST API directly:
-- probed 2026-09-07 15:3xZ — `borrowMoment(id)` on 0x640705263fe8f11b / nft 52669535 answered
-- 200 with setID 271 · playID 9038 · serial 146 · subedition 0 (`TopShot.getMomentsSubedition`
-- exists on the deployed contract — the script itself is the proof); a wallet without the
-- collection answered 400 with `panic: no collection` in the message. Both outcomes are legible.
--
-- THE PIPELINE (pipeline `topshot-moments-hydrate-chain`, pg_cron `rpc-topshot-moments-hydrate-chain`
-- at `3-59/4 * * * *` — every 4 min off the banned minutes):
--   dispatch(p_max): the p_max newest queue rows (pack_pull + verified, no `moments` row) that have
--     no request in the retry window → one `net.http_post` each to
--     https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed with the script below, recorded
--     in `topshot_moment_hydrate_requests` (request_id = pg_net id).
--   drain(): every undrained request whose response has landed → 200: decode the JSON-CDC
--     dictionary, resolve the edition by `set:play` or `set:play::sub`, write through the existing
--     `replace_topshot_moments_batch()` (the same writer as the worker and the wmc hydrator);
--     400 `no nft` → the Moment has moved on (outcome `no_nft`, retried after 30 days — it will be
--     named the day a walked wallet or a marketplace event carries it); `no collection` → same
--     class; anything else → `error`, retried after 1 day; a request with no response after 3 min
--     is `timeout` (retried after 1 day). Nothing is ever guessed: an unresolvable edition is
--     outcome `unmapped`, counted, not written.
--   tick(p_max) = drain, then dispatch; one `pipeline_runs` row with the counts.
--
-- Budget: 80 scripts every 4 min = 0.33 req/s against the public access node (the wallet-backfill
-- route runs 8-way concurrent walks against the same node); 28.8K/day → the backlog in ~6 days,
-- then only new pulls. Watch `status_code` 429 in the requests table — the throttle signal.
--
-- REVERT: SELECT cron.unschedule('rpc-topshot-moments-hydrate-chain');
--         DROP FUNCTION public.topshot_moment_hydrate_tick(int), public.topshot_moment_hydrate_dispatch(int),
--                       public.topshot_moment_hydrate_drain();
--         DROP TABLE public.topshot_moment_hydrate_requests;
--         DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'topshot-moments-hydrate-chain';
--         (moments rows written are on-chain facts; nothing to restore.)

CREATE TABLE public.topshot_moment_hydrate_requests (
  request_id    bigint PRIMARY KEY,
  nft_id        text NOT NULL,
  wallet        text NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  drained_at    timestamptz,
  status_code   int,
  outcome       text,      -- written | unmapped | no_nft | no_collection | error | timeout
  error         text
);
ALTER TABLE public.topshot_moment_hydrate_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.topshot_moment_hydrate_requests FROM PUBLIC, anon, authenticated;
CREATE INDEX idx_tmhr_nft_dispatched ON public.topshot_moment_hydrate_requests (nft_id, dispatched_at DESC);
CREATE INDEX idx_tmhr_inflight ON public.topshot_moment_hydrate_requests (dispatched_at) WHERE drained_at IS NULL;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_dispatch(p_max int DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r record; v_req bigint; v_n int := 0;
  v_script text := encode(convert_to($cdc$import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address, id: UInt64): {String: String} {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) ?? panic("no collection")
  let nft = col.borrowMoment(id: id) ?? panic("no nft")
  let sub = TopShot.getMomentsSubedition(nftID: id)
  return {"setID": nft.data.setID.toString(), "playID": nft.data.playID.toString(), "serial": nft.data.serialNumber.toString(), "sub": sub == nil ? "" : sub!.toString()}
}$cdc$, 'UTF8'), 'base64');
BEGIN
  FOR r IN
    SELECT ma.nft_id, ma.wallet
      FROM public.moment_acquisitions ma
     WHERE ma.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
       AND ma.acquisition_method = 'pack_pull'
       AND ma.acquisition_confidence = 'verified'
       AND ma.wallet ~ '^0x[0-9a-f]{16}$'
       AND NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = ma.nft_id AND m.collection_id = ma.collection_id)
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
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_dispatch(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_dispatch(int) TO service_role;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_drain()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_coll uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_payload jsonb; v_written int := 0; v_resolved int := 0; v_unmapped int := 0;
  v_no_nft int := 0; v_no_coll int := 0; v_err int := 0; v_timeout int := 0; v_429 int := 0;
BEGIN
  DROP TABLE IF EXISTS _hyd_resp;
  CREATE TEMP TABLE _hyd_resp ON COMMIT DROP AS
  SELECT q.request_id, q.nft_id, q.wallet, q.dispatched_at, r.status_code,
         CASE WHEN r.status_code = 200 AND r.content ~ '^"[A-Za-z0-9+/=]+"$'
              THEN convert_from(decode(trim(both '"' from r.content), 'base64'), 'UTF8')::jsonb
              ELSE NULL END AS cdc,
         CASE WHEN r.status_code = 200 THEN NULL ELSE left(r.content, 300) END AS body,
         r.error_msg
    FROM public.topshot_moment_hydrate_requests q
    JOIN net._http_response r ON r.id = q.request_id
   WHERE q.drained_at IS NULL;

  -- Decode: a JSON-CDC Dictionary of String → String.
  DROP TABLE IF EXISTS _hyd_dec;
  CREATE TEMP TABLE _hyd_dec ON COMMIT DROP AS
  SELECT x.request_id, x.nft_id, x.wallet, x.status_code, x.body, x.error_msg,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'setID')::int  AS set_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'playID')::int AS play_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'serial')::int AS serial_number,
         NULLIF((SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'sub'), '')::int AS sub_id
    FROM _hyd_resp x;

  -- Resolve editions: the parallel keys `set:play::sub`, a Standard `set:play`.
  DROP TABLE IF EXISTS _hyd_res;
  CREATE TEMP TABLE _hyd_res ON COMMIT DROP AS
  SELECT d.request_id, d.nft_id, d.wallet, d.status_code, d.body, d.error_msg, d.serial_number, d.set_id,
         e.id AS edition_id
    FROM _hyd_dec d
    LEFT JOIN public.editions e
      ON d.status_code = 200 AND e.collection_id = v_coll
     AND e.external_id = CASE WHEN COALESCE(d.sub_id, 0) > 0
                              THEN d.set_id || ':' || d.play_id || '::' || d.sub_id
                              ELSE d.set_id || ':' || d.play_id END;

  SELECT jsonb_agg(jsonb_build_object('nft_id', nft_id, 'edition_id', edition_id,
                                      'serial_number', serial_number, 'owner_address', wallet)),
         count(*)
    INTO v_payload, v_resolved
    FROM _hyd_res WHERE status_code = 200 AND edition_id IS NOT NULL AND serial_number IS NOT NULL;
  IF v_resolved > 0 THEN
    v_written := public.replace_topshot_moments_batch(v_payload);
  END IF;

  UPDATE public.topshot_moment_hydrate_requests q
     SET drained_at = now(), status_code = x.status_code,
         outcome = CASE
           WHEN x.status_code = 200 AND x.edition_id IS NOT NULL AND x.serial_number IS NOT NULL THEN 'written'
           WHEN x.status_code = 200 AND x.set_id IS NOT NULL THEN 'unmapped'
           WHEN x.status_code = 200 THEN 'error'   -- a 200 whose body did not decode
           WHEN x.status_code = 400 AND x.body LIKE '%panic: no nft%' THEN 'no_nft'
           WHEN x.status_code = 400 AND x.body LIKE '%panic: no collection%' THEN 'no_collection'
           ELSE 'error' END,
         error = CASE WHEN x.status_code = 200 THEN NULL ELSE COALESCE(x.error_msg, x.body) END
    FROM _hyd_res x WHERE x.request_id = q.request_id;

  SELECT count(*) FILTER (WHERE outcome = 'unmapped'), count(*) FILTER (WHERE outcome = 'no_nft'),
         count(*) FILTER (WHERE outcome = 'no_collection'), count(*) FILTER (WHERE outcome = 'error'),
         count(*) FILTER (WHERE status_code = 429)
    INTO v_unmapped, v_no_nft, v_no_coll, v_err, v_429
    FROM public.topshot_moment_hydrate_requests WHERE request_id IN (SELECT request_id FROM _hyd_res);

  -- Requests pg_net never answered.
  UPDATE public.topshot_moment_hydrate_requests
     SET drained_at = now(), outcome = 'timeout', error = 'no response within 3 min'
   WHERE drained_at IS NULL AND dispatched_at < now() - interval '3 minutes';
  GET DIAGNOSTICS v_timeout = ROW_COUNT;

  RETURN jsonb_build_object('drained', (SELECT count(*) FROM _hyd_res), 'resolved', v_resolved, 'written', v_written,
                            'unmapped', v_unmapped, 'no_nft', v_no_nft, 'no_collection', v_no_coll,
                            'error', v_err, 'http_429', v_429, 'timeout', v_timeout);
END $$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_drain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_drain() TO service_role;

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_tick(p_max int DEFAULT 80)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '110s'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_drain jsonb; v_disp jsonb; v_err text;
BEGIN
  BEGIN
    v_drain := public.topshot_moment_hydrate_drain();
    v_disp  := public.topshot_moment_hydrate_dispatch(p_max);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('topshot-moments-hydrate-chain', v_started,
    COALESCE((v_drain->>'drained')::int, 0), COALESCE((v_drain->>'written')::int, 0),
    COALESCE((v_drain->>'no_nft')::int, 0) + COALESCE((v_drain->>'no_collection')::int, 0) + COALESCE((v_drain->>'unmapped')::int, 0),
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('drain', v_drain, 'dispatch', v_disp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('drain', v_drain, 'dispatch', v_disp, 'error', v_err);
END $$;
REVOKE ALL ON FUNCTION public.topshot_moment_hydrate_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_moment_hydrate_tick(int) TO service_role;

SELECT cron.schedule('rpc-topshot-moments-hydrate-chain', '3-59/4 * * * *',
  $cron$ SELECT public.topshot_moment_hydrate_tick(80) $cron$);

INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES (
  'topshot-moments-hydrate-chain', 'medium', true, 15, 30,
  'pg_cron rpc-topshot-moments-hydrate-chain, 3-59/4 * * * * since 2026-09-07 (this migration). Reads pack-pulled Top Shot nfts on-chain via the Flow REST API from pg_net (80 scripts per tick) and writes public.moments through replace_topshot_moments_batch. 15 min = 3 missed ticks. rows_written falls to ~0 once the backlog is named; the drain counts (no_nft / unmapped) are outcomes, not failures. Throttle signal: extra.drain.http_429 > 0.'
)
ON CONFLICT (pipeline) DO UPDATE SET severity = EXCLUDED.severity, is_active = true,
  max_silent_minutes = EXCLUDED.max_silent_minutes, max_minutes_without_success = EXCLUDED.max_minutes_without_success,
  notes = EXCLUDED.notes;
