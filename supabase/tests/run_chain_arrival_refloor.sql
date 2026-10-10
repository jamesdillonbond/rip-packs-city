-- DB invariant: public.run_chain_arrival_refloor -- while mainnet24's node is parked dark,
-- a chain-arrival FLOOR probe is re-floored on mainnet27's live root (130,290,700) instead of
-- waiting for mainnet24. Added 2026-10-10 (known-issues #181).
-- Claims:
--   R1. mainnet24 not parked dark -> nothing is dispatched (the lane floor-checks as before).
--   R2. mainnet24 dark -> ONE holdings script per wallet at 130,290,700 on mainnet27, asking
--       only 'floor' probes not in flight whose hi is above that height.
--   R3. A 200 answer: an id NOT held -> lo = 130,290,700, status 'bisect', attempts 0,
--       last_error NULL; an id held -> chain_arrival_refloor_held, stays 'floor', never asked again.
--   R4. A non-200 answer closes the request 'failed', counts a failure (ok=false), and its ids
--       are asked again.
--   R5. No answer: kept pending (not re-dispatched) for 10 min, then closed 'failed'.
--   R7. Requests are kept as the record (status, result, finished_at).
--   R6. A call carries <= 1,000 ids and a run sends <= 10 calls.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010231932_audit_20261010_chain_arrival_refloors_on_the_live_root_while_mainnet24_is_dark.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, url text, body jsonb);
CREATE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url, body); RETURN v; END $$;

CREATE TABLE public.chain_arrival_probes (
  wallet text NOT NULL, nft_id bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL,
  status text NOT NULL DEFAULT 'bisect' CHECK (status IN ('floor', 'bisect', 'window', 'walk', 'done', 'failed')),
  request_id bigint, attempts int NOT NULL DEFAULT 0, arrived_height bigint, arrived_at timestamptz, tx_id text,
  from_address text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY (wallet, nft_id));
CREATE TABLE public.chain_arrival_dark_nodes (
  node text PRIMARY KEY, dark_until timestamptz NOT NULL, last_error text,
  marked_at timestamptz NOT NULL DEFAULT now(), cleared_at timestamptz);
CREATE TABLE public.chain_arrival_refloor_requests (
  request_id bigint PRIMARY KEY, wallet text NOT NULL, ids bigint[] NOT NULL, height bigint NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  result text, finished_at timestamptz);
CREATE TABLE public.chain_arrival_refloor_held (
  wallet text NOT NULL, nft_id bigint NOT NULL, height bigint NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (wallet, nft_id));

-- >>> BEGIN verbatim run_chain_arrival_refloor (body byte-identical to the migration) >>>
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
-- <<< END verbatim <<<

-- the node's answer: base64 of a JSON-CDC [UInt64] array, as a JSON string
CREATE FUNCTION pg_temp.answer(ids bigint[]) RETURNS text LANGUAGE sql AS $$
  SELECT '"' || encode(convert_to(jsonb_build_object('type', 'Array', 'value',
    coalesce((SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(ids) i), '[]'::jsonb))::text || E'\n',
    'UTF8'), 'base64') || '"' $$;
CREATE FUNCTION pg_temp.call_ids(p_req bigint) RETURNS bigint[] LANGUAGE sql AS $$
  SELECT array_agg((e->>'value')::bigint ORDER BY (e->>'value')::bigint)
    FROM net.calls c, jsonb_array_elements(convert_from(decode(c.body->'arguments'->>1, 'base64'), 'UTF8')::jsonb -> 'value') e
   WHERE c.id = p_req $$;
CREATE FUNCTION pg_temp.req_of(p_wallet text) RETURNS bigint LANGUAGE sql AS $$
  SELECT max(request_id) FROM public.chain_arrival_refloor_requests WHERE wallet = p_wallet AND status = 'pending' $$;

DO $$
DECLARE v jsonb; v_req bigint; v_req2 bigint;
BEGIN
  INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status, request_id) VALUES
    ('0xaa', 1, 65300000, 135000000, 'floor', NULL),
    ('0xaa', 2, 65300000, 135000000, 'floor', NULL),
    ('0xaa', 3, 65300000, 120000000, 'floor', NULL),     -- hi inside the dark window
    ('0xaa', 4, 65300000, 135000000, 'floor', 77),       -- in flight (the lane's canary)
    ('0xaa', 5, 65300000, 135000000, 'bisect', NULL),    -- not a floor probe
    ('0xbb', 9, 65300000, 160000000, 'floor', NULL);

  -- R1: mainnet24 not parked -> nothing sent
  v := public.run_chain_arrival_refloor();
  PERFORM _assert_eq((SELECT count(*) FROM net.calls)::text, '0', 'R1: no dispatch while mainnet24 is not dark');
  PERFORM _assert_eq(v->>'mainnet24_dark', 'false', 'R1: reports mainnet24 not dark');

  -- R2: dark -> one call per wallet, only eligible ids, at the live root on mainnet27
  INSERT INTO public.chain_arrival_dark_nodes (node, dark_until) VALUES
    ('http://access-001.mainnet24.nodes.onflow.org:8070', now() + interval '1 hour');
  v := public.run_chain_arrival_refloor();
  PERFORM _assert_eq(v->>'dispatched', '2', 'R2: one call per wallet');
  v_req := pg_temp.req_of('0xaa');
  PERFORM _assert(pg_temp.call_ids(v_req) = ARRAY[1, 2]::bigint[],
                  'R2: asks only floor probes not in flight with hi above the live root');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = v_req)
                  = 'http://access-001.mainnet27.nodes.onflow.org:8070/v1/scripts?block_height=130290700',
                  'R2: the script runs at 130,290,700 on mainnet27');
  PERFORM _assert(convert_from(decode((SELECT body->>'script' FROM net.calls WHERE id = v_req), 'base64'), 'UTF8')
                  LIKE '%access(all) fun main%', 'R2: Cadence 1.0 syntax on mainnet27');
  PERFORM _assert(pg_temp.call_ids(pg_temp.req_of('0xbb')) = ARRAY[9]::bigint[], 'R2: the other wallet asked too');

  -- R5: no answer yet -> kept pending, not re-dispatched
  v := public.run_chain_arrival_refloor();
  PERFORM _assert_eq(v->>'dispatched', '0', 'R5: a pending request is not re-dispatched');
  PERFORM _assert_eq(v->>'failed', '0', 'R5: under 10 minutes a missing answer is not a failure');

  -- R3: 0xaa holds 2, not 1
  INSERT INTO net._http_response VALUES (v_req, 200, pg_temp.answer(ARRAY[2]::bigint[]), NULL);
  -- R4: 0xbb gets a 500
  INSERT INTO net._http_response VALUES (pg_temp.req_of('0xbb'), 500, 'boom', NULL);
  v := public.run_chain_arrival_refloor();
  PERFORM _assert((SELECT lo = 130290700 AND status = 'bisect' AND attempts = 0 AND last_error IS NULL
                     FROM public.chain_arrival_probes WHERE nft_id = 1),
                  'R3: not held at the live root -> bisect from 130,290,700');
  PERFORM _assert((SELECT status = 'floor' AND lo = 65300000 FROM public.chain_arrival_probes WHERE nft_id = 2),
                  'R3: held at the live root -> stays floor');
  PERFORM _assert(EXISTS (SELECT 1 FROM public.chain_arrival_refloor_held WHERE wallet = '0xaa' AND nft_id = 2),
                  'R3: held id recorded');
  PERFORM _assert((SELECT status = 'floor' AND lo = 65300000 FROM public.chain_arrival_probes WHERE nft_id = 3),
                  'R3: a probe with hi in the dark window is untouched');
  PERFORM _assert_eq(v->>'moved_to_bisect', '1', 'R3: the count is rows moved');
  PERFORM _assert_eq(v->>'ok', 'false', 'R4: a non-200 answer fails the run');
  PERFORM _assert_eq(v->>'failed', '1', 'R4: one failure');
  PERFORM _assert((SELECT ok = false FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'R4: logged ok=false');
  v_req2 := pg_temp.req_of('0xbb');
  PERFORM _assert(v_req2 IS NOT NULL AND v_req2 <> (SELECT max(id) FROM net._http_response WHERE status_code = 500),
                  'R4: the failed wallet is re-asked in the same run');
  PERFORM _assert(pg_temp.req_of('0xaa') IS NULL, 'R3: the held id is never asked again');

  -- R5: no answer for 10 minutes -> freed as a failure
  PERFORM _assert((SELECT status = 'done' AND result = '1 of 2 held' AND finished_at IS NOT NULL
                     FROM public.chain_arrival_refloor_requests WHERE request_id = v_req), 'R7: a collected request is kept, done, with its result');
  PERFORM _assert((SELECT status = 'failed' AND result LIKE 'http 500%' FROM public.chain_arrival_refloor_requests
                    WHERE request_id = (SELECT max(id) FROM net._http_response WHERE status_code = 500)), 'R7: a failed request is kept, failed, with the error');
  UPDATE public.chain_arrival_refloor_requests SET dispatched_at = now() - interval '11 minutes' WHERE status = 'pending';
  v := public.run_chain_arrival_refloor();
  PERFORM _assert_eq(v->>'failed', '1', 'R5: a request unanswered for 10 min is a failure');
  PERFORM _assert(EXISTS (SELECT 1 FROM public.chain_arrival_refloor_requests WHERE status = 'failed' AND result = 'no answer in 10 min'),
                  'R5: closed failed, not dropped');

  -- R6: <= 1,000 ids a call, <= 10 calls a run
  UPDATE public.chain_arrival_refloor_requests SET status = 'done' WHERE status = 'pending';
  INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
  SELECT '0xcc', 1000 + g, 65300000, 135000000, 'floor' FROM generate_series(1, 12500) g;
  v := public.run_chain_arrival_refloor();
  PERFORM _assert_eq(v->>'dispatched', '10', 'R6: at most 10 calls a run');
  PERFORM _assert((SELECT max(cardinality(ids)) FROM public.chain_arrival_refloor_requests WHERE status = 'pending') = 1000,
                  'R6: at most 1,000 ids a call');
END $$;

ROLLBACK;
