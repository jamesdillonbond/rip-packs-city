-- DB invariant: public.run_chain_arrival_lane / public.enqueue_chain_arrivals —
-- WHEN and FROM WHOM a wallet received a Top Shot moment, read on Flow's
-- historical sporks. Added 2026-09-29 (custodial rips: a custodial pull is a
-- TopShot.Withdraw from 0xb5b717909b9c5ea5 in the tx that deposits it).
-- Claims:
--   B1. A probe bisects [lo, hi] on "which of these ids does the wallet hold at
--       mid": ids sharing an interval share ONE call on the node serving mid;
--       held -> hi = mid, not held -> lo = mid.
--   B2. An interval straddling a spork end splits AT that end, on the ending
--       spork's node (mainnet24 with the pre-Cadence-1.0 script).
--   W1. At <= 250 blocks inside one spork, ONE TopShot.Withdraw events read of
--       (lo, hi] names the delivery: the last withdraw of the id whose sender
--       is not the wallet itself -- sender, tx, block height and time.
--   W2. No withdraw in the window -> done, saying so (a mint), never a sender.
--   H1. A 429 is a free retry; any other error counts an attempt, ok=false.
--   E1. Enqueue refuses an interval below the mainnet24 root or inverted.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929170000_audit_20260929_chain_arrivals_find_when_and_from_whom_a_wallet_got_a_moment.sql).
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
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url, NULL); RETURN v; END $$;

CREATE TABLE public.chain_arrival_requests (
  request_id bigint PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('owned', 'events')), wallet text,
  lo bigint NOT NULL, hi bigint NOT NULL, height bigint, node text NOT NULL, dispatched_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chain_arrival_probes (
  wallet text NOT NULL, nft_id bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL,
  status text NOT NULL DEFAULT 'bisect' CHECK (status IN ('bisect', 'window', 'done', 'failed')),
  request_id bigint, attempts int NOT NULL DEFAULT 0, arrived_height bigint, arrived_at timestamptz, tx_id text,
  from_address text, last_error text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  PRIMARY KEY (wallet, nft_id));

-- >>> BEGIN verbatim enqueue_chain_arrivals (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.enqueue_chain_arrivals(p_wallet text, p_ids bigint[], p_lo bigint, p_hi bigint)
RETURNS int
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH ins AS (
    INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi)
    SELECT lower(p_wallet), i, p_lo, p_hi FROM unnest(p_ids) i
     WHERE p_lo < p_hi AND p_lo >= 65264619
    ON CONFLICT (wallet, nft_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int FROM ins
$function$;
-- <<< END verbatim <<<

-- >>> BEGIN verbatim run_chain_arrival_lane (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_chain_arrival_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 12;
  v_max_att  constant int := 6;
  -- last height of mainnet24..27; a window never straddles one
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145]::bigint[];
  v_src_pre  constant text := 'import TopShot from 0x0b2a3299cc857e29
pub fun main(owner: Address, ids: [UInt64]): [UInt64] {
  let out: [UInt64] = []
  let col = getAccount(owner).getCapability(/public/MomentCollection).borrow<&{TopShot.MomentCollectionPublic}>()
  if col == nil { return out }
  for id in ids { if col!.borrowMoment(id: id) != nil { out.append(id) } }
  return out
}';
  v_src_c1   constant text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): [UInt64] {
  let out: [UInt64] = []
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if col!.borrowMoment(id: id) != nil { out.append(id) } }
  return out
}';
  r record;
  v_body jsonb; v_owned bigint[]; v_req bigint; v_mid bigint; v_node text; v_n int;
  v_collected int := 0; v_bisected int := 0; v_windows_done int := 0; v_found int := 0; v_not_found int := 0;
  v_failed int := 0; v_throttled int := 0; v_expired int := 0; v_dispatched int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_chain_arrival_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect landed calls.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error
      FROM public.chain_arrival_requests q
      JOIN net._http_response h ON h.id = q.request_id
     ORDER BY q.dispatched_at
  LOOP
    v_collected := v_collected + 1;
    v_body := NULL;
    IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
      BEGIN
        v_body := CASE r.kind
          WHEN 'owned' THEN convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb
          ELSE r.h_content::jsonb END;
      EXCEPTION WHEN others THEN v_body := NULL;
      END;
    END IF;

    IF v_body IS NULL
       OR (r.kind = 'owned' AND v_body->>'type' IS DISTINCT FROM 'Array')
       OR (r.kind = 'events' AND jsonb_typeof(v_body) IS DISTINCT FROM 'array') THEN
      IF r.h_status = 429 THEN
        UPDATE public.chain_arrival_probes SET request_id = NULL, last_error = 'http 429'
         WHERE request_id = r.request_id;
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.chain_arrival_probes
           SET request_id = NULL, attempts = attempts + 1, last_error = v_last_error,
               status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE status END,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id;
        v_failed := v_failed + 1;
      END IF;
      DELETE FROM public.chain_arrival_requests WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    IF r.kind = 'owned' THEN
      SELECT coalesce(array_agg((x->>'value')::bigint), '{}') INTO v_owned
        FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) x;
      -- held at the midpoint -> it arrived at or before it; else after it
      UPDATE public.chain_arrival_probes p
         SET lo = CASE WHEN p.nft_id = ANY (v_owned) THEN p.lo ELSE r.height END,
             hi = CASE WHEN p.nft_id = ANY (v_owned) THEN r.height ELSE p.hi END,
             request_id = NULL, last_error = NULL
       WHERE p.request_id = r.request_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_bisected := v_bisected + v_n;
    ELSE
      -- events: the LAST TopShot.Withdraw of each probed id in (lo, hi] whose
      -- sender is not the wallet itself is the delivery
      WITH ev AS (
        SELECT (b->>'block_height')::bigint AS bh, (b->>'block_timestamp')::timestamptz AS bt,
               e->>'transaction_id' AS tx, (e->>'event_index')::int AS ei,
               convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl
          FROM jsonb_array_elements(v_body) b
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
      ), w AS (
        SELECT bh, bt, tx, ei,
               (SELECT (x->'value'->>'value')::bigint FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'id') AS mid,
               (SELECT coalesce(x->'value'->'value'->>'value', x->'value'->>'value')
                  FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'from') AS sender
          FROM ev
      ), hit AS (
        SELECT DISTINCT ON (p.wallet, p.nft_id) p.wallet, p.nft_id, w.bh, w.bt, w.tx, w.sender
          FROM public.chain_arrival_probes p
          JOIN w ON w.mid = p.nft_id AND w.sender IS DISTINCT FROM p.wallet
         WHERE p.request_id = r.request_id
         ORDER BY p.wallet, p.nft_id, w.bh DESC, w.ei DESC
      ), upd AS (
        UPDATE public.chain_arrival_probes p
           SET status = 'done', request_id = NULL, finished_at = now(), last_error = NULL,
               arrived_height = hit.bh, arrived_at = hit.bt, tx_id = hit.tx, from_address = hit.sender
          FROM hit
         WHERE p.wallet = hit.wallet AND p.nft_id = hit.nft_id
        RETURNING 1
      )
      SELECT count(*) INTO v_n FROM upd;
      v_found := v_found + v_n;
      -- no Withdraw in the window: it was deposited without one (a mint)
      UPDATE public.chain_arrival_probes p
         SET status = 'done', request_id = NULL, finished_at = now(),
             last_error = 'no TopShot.Withdraw in (lo, hi]: minted in or unread'
       WHERE p.request_id = r.request_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_not_found := v_not_found + v_n;
      v_windows_done := v_windows_done + 1;
    END IF;
    DELETE FROM public.chain_arrival_requests WHERE request_id = r.request_id;
  END LOOP;

  -- a call that never landed (pg_net drops responses after its TTL)
  WITH x AS (
    DELETE FROM public.chain_arrival_requests q
     WHERE q.dispatched_at < now() - interval '30 minutes'
       AND NOT EXISTS (SELECT 1 FROM net._http_response h WHERE h.id = q.request_id)
    RETURNING q.request_id
  ), u AS (
    UPDATE public.chain_arrival_probes p
       SET request_id = NULL, attempts = attempts + 1, last_error = 'no_response',
           status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE status END
      FROM x WHERE p.request_id = x.request_id
    RETURNING 1
  )
  SELECT count(*) INTO v_expired FROM u;

  -- narrow enough, and inside one spork: read the window's events next
  UPDATE public.chain_arrival_probes p
     SET status = 'window'
   WHERE p.status = 'bisect' AND p.request_id IS NULL AND p.hi - p.lo <= 250
     AND NOT EXISTS (SELECT 1 FROM unnest(v_ends) e WHERE e >= p.lo + 1 AND e < p.hi);

  -- (2) Dispatch. Pending probes group by (kind, wallet, lo, hi): one call per
  -- group of <= 1,000 ids (an events window is wallet-agnostic but is read per
  -- wallet to keep the bookkeeping simple). <= v_per_node calls per node.
  FOR r IN
    WITH pend AS (
      SELECT p.status, p.wallet, p.lo, p.hi, p.nft_id,
             -- the midpoint; an interval straddling a spork end splits AT it
             coalesce((SELECT min(e) FROM unnest(v_ends) e WHERE e > p.lo AND e < p.hi AND p.status = 'bisect'),
                      (p.lo + p.hi) / 2) AS mid
        FROM public.chain_arrival_probes p
       WHERE p.request_id IS NULL AND p.status IN ('bisect', 'window')
    ), grp AS (
      SELECT status, wallet, lo, hi, mid,
             (row_number() OVER (PARTITION BY status, wallet, lo, hi ORDER BY nft_id) - 1) / 1000 AS chunk,
             nft_id
        FROM pend
    ), calls AS (
      SELECT status, wallet, lo, hi, mid, chunk, array_agg(nft_id ORDER BY nft_id) AS ids,
             CASE WHEN status = 'bisect' THEN mid ELSE lo + 1 END AS at_h
        FROM grp
       GROUP BY status, wallet, lo, hi, mid, chunk
    ), routed AS (
      SELECT c.*,
             CASE WHEN c.at_h <= 85981134  THEN 'http://access-001.mainnet24.nodes.onflow.org:8070'
                  WHEN c.at_h <= 88226266  THEN 'http://access-001.mainnet25.nodes.onflow.org:8070'
                  WHEN c.at_h <= 130290658 THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                  WHEN c.at_h <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                  ELSE 'https://rest-mainnet.onflow.org' END AS node
        FROM calls c
    ), ranked AS (
      SELECT rt.*, row_number() OVER (PARTITION BY rt.node ORDER BY rt.hi - rt.lo, rt.lo) AS rn
        FROM routed rt
    )
    SELECT * FROM ranked WHERE rn <= v_per_node
  LOOP
    IF r.status = 'bisect' THEN
      SELECT net.http_post(
        url := r.node || '/v1/scripts?block_height=' || r.mid,
        body := jsonb_build_object(
          'script', translate(encode(convert_to(CASE WHEN r.mid <= 85981134 THEN v_src_pre ELSE v_src_c1 END, 'UTF8'), 'base64'), E'\n', ''),
          'arguments', jsonb_build_array(
            translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.wallet)::text, 'UTF8'), 'base64'), E'\n', ''),
            translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
              (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(r.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
        headers := '{"Content-Type": "application/json"}'::jsonb,
        timeout_milliseconds := 30000
      ) INTO v_req;
      INSERT INTO public.chain_arrival_requests (request_id, kind, wallet, lo, hi, height, node)
      VALUES (v_req, 'owned', r.wallet, r.lo, r.hi, r.mid, r.node);
    ELSE
      SELECT net.http_get(
        url := r.node || '/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=' || (r.lo + 1) || '&end_height=' || r.hi,
        timeout_milliseconds := 30000
      ) INTO v_req;
      INSERT INTO public.chain_arrival_requests (request_id, kind, wallet, lo, hi, height, node)
      VALUES (v_req, 'events', r.wallet, r.lo, r.hi, NULL, r.node);
    END IF;
    UPDATE public.chain_arrival_probes p SET request_id = v_req
     WHERE p.wallet = r.wallet AND p.nft_id = ANY (r.ids);
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'chain-arrivals', v_started,
    v_collected, v_found, v_not_found,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('bisected', v_bisected, 'windows_read', v_windows_done, 'found', v_found,
                       'not_found', v_not_found, 'failed', v_failed, 'throttled', v_throttled,
                       'expired', v_expired, 'dispatched', v_dispatched)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'bisected', v_bisected,
                            'windows_read', v_windows_done, 'found', v_found, 'not_found', v_not_found,
                            'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                            'dispatched', v_dispatched, 'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<


-- helpers
CREATE FUNCTION pg_temp.call_ids(p_id bigint) RETURNS bigint[] LANGUAGE sql AS $$
  SELECT array_agg((x->>'value')::bigint ORDER BY (x->>'value')::bigint)
    FROM net.calls c, jsonb_array_elements(convert_from(decode(c.body->'arguments'->>1, 'base64'), 'UTF8')::jsonb->'value') x
   WHERE c.id = p_id $$;
CREATE FUNCTION pg_temp.req_of(p_id bigint) RETURNS bigint LANGUAGE sql AS $$
  SELECT request_id FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000aa' AND nft_id = p_id $$;
CREATE FUNCTION pg_temp.plant_owned(p_req bigint, p_ids bigint[]) RETURNS void LANGUAGE sql AS $$
  INSERT INTO net._http_response (id, status_code, content)
  VALUES (p_req, 200, to_jsonb(translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
    coalesce((SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(p_ids) i), '[]'::jsonb))::text,
    'UTF8'), 'base64'), E'\n', ''))::text) $$;
CREATE FUNCTION pg_temp.wd(p_id bigint, p_from text, p_tx text, p_idx int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('type', 'A.0b2a3299cc857e29.TopShot.Withdraw', 'transaction_id', p_tx, 'event_index', p_idx::text,
    'payload', translate(encode(convert_to(jsonb_build_object('type', 'Event', 'value', jsonb_build_object(
      'id', 'A.0b2a3299cc857e29.TopShot.Withdraw', 'fields', jsonb_build_array(
        jsonb_build_object('name', 'id', 'value', jsonb_build_object('type', 'UInt64', 'value', p_id::text)),
        jsonb_build_object('name', 'from', 'value', jsonb_build_object('type', 'Optional',
          'value', jsonb_build_object('type', 'Address', 'value', p_from)))))) ::text, 'UTF8'), 'base64'), E'\n', '')) $$;

-- E1
DO $$
BEGIN
  PERFORM _assert_eq(public.enqueue_chain_arrivals('0x00000000000000AA', ARRAY[1, 2]::bigint[], 100000000, 100001000)::text, '2', 'two probes seeded, wallet folded');
  PERFORM _assert_eq(public.enqueue_chain_arrivals('0x00000000000000aa', ARRAY[3]::bigint[], 85981000, 85990000)::text, '1', 'a straddling probe');
  PERFORM _assert_eq(public.enqueue_chain_arrivals('0x00000000000000aa', ARRAY[4, 5, 6]::bigint[], 100000000, 100000200)::text, '3', 'a window probe');
  PERFORM _assert_eq(public.enqueue_chain_arrivals('0x00000000000000aa', ARRAY[7]::bigint[], 60000000, 100000000)::text, '0', 'E1: below the mainnet24 root refused');
  PERFORM _assert_eq(public.enqueue_chain_arrivals('0x00000000000000aa', ARRAY[8]::bigint[], 100000500, 100000000)::text, '0', 'E1: inverted interval refused');
END $$;

-- run 1: dispatch
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_lane();
  PERFORM _assert_eq(v->>'dispatched', '3', 'three calls: [1,2] share one, [3] one, the window one');
  -- B1
  PERFORM _assert(pg_temp.req_of(1) = pg_temp.req_of(2), 'B1: ids sharing an interval share one call');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(1))
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=100000500', 'B1: the midpoint on the mainnet26 node');
  PERFORM _assert(pg_temp.call_ids(pg_temp.req_of(1)) = ARRAY[1, 2]::bigint[], 'B1: the call asks for both ids');
  PERFORM _assert(convert_from(decode((SELECT body->>'script' FROM net.calls WHERE id = pg_temp.req_of(1)), 'base64'), 'UTF8') LIKE '%access(all) fun main%',
                  'B1: Cadence 1.0 on mainnet26');
  -- B2
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(3))
                  = 'http://access-001.mainnet24.nodes.onflow.org:8070/v1/scripts?block_height=85981134', 'B2: split at mainnet24''s last height, on its node');
  PERFORM _assert(convert_from(decode((SELECT body->>'script' FROM net.calls WHERE id = pg_temp.req_of(3)), 'base64'), 'UTF8') LIKE '%pub fun main%',
                  'B2: the pre-Cadence-1.0 script on mainnet24');
  -- W1 dispatch
  PERFORM _assert((SELECT status FROM public.chain_arrival_probes WHERE nft_id = 4) = 'window', 'W1: 200 blocks inside one spork is a window');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(4))
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=100000001&end_height=100000200',
                  'W1: one events read of (lo, hi]');
END $$;

-- responses: the wallet held 1 (not 2) at the midpoint; 3 not held at the
-- spork end; the window: 4 withdrawn from the custodial account then (later)
-- by the wallet itself; 5 withdrawn from a seller; 6 never withdrawn.
SELECT pg_temp.plant_owned(pg_temp.req_of(1), ARRAY[1]::bigint[]);
SELECT pg_temp.plant_owned(pg_temp.req_of(3), ARRAY[]::bigint[]);
INSERT INTO net._http_response (id, status_code, content)
SELECT pg_temp.req_of(4), 200, jsonb_build_array(
  -- 5 changed hands between two others first: the LAST withdraw delivers it
  jsonb_build_object('block_height', '100000020', 'block_timestamp', '2025-01-01T00:00:30Z',
    'events', jsonb_build_array(pg_temp.wd(5, '0x2222222222222222', 'TXEARLY', 0))),
  jsonb_build_object('block_height', '100000050', 'block_timestamp', '2025-01-01T00:01:00Z',
    'events', jsonb_build_array(pg_temp.wd(4, '0xb5b717909b9c5ea5', 'TXC', 0), pg_temp.wd(5, '0x1111111111111111', 'TXS', 1))),
  jsonb_build_object('block_height', '100000150', 'block_timestamp', '2025-01-01T00:02:30Z',
    'events', jsonb_build_array(pg_temp.wd(4, '0x00000000000000aa', 'TXOUT', 0)))
)::text;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT lo = 100000000 AND hi = 100000500 FROM public.chain_arrival_probes WHERE nft_id = 1), 'B1: held at mid -> hi = mid');
  PERFORM _assert((SELECT lo = 100000500 AND hi = 100001000 FROM public.chain_arrival_probes WHERE nft_id = 2), 'B1: not held -> lo = mid');
  PERFORM _assert((SELECT lo = 85981134 AND hi = 85990000 FROM public.chain_arrival_probes WHERE nft_id = 3), 'B2: after the split the interval lies in mainnet25');
  PERFORM _assert((SELECT status = 'done' AND from_address = '0xb5b717909b9c5ea5' AND tx_id = 'TXC' AND arrived_height = 100000050
                          AND arrived_at = '2025-01-01 00:01:00+00'
                     FROM public.chain_arrival_probes WHERE nft_id = 4),
                  'W1: the delivery is the custodial withdraw, never the wallet''s own later withdraw');
  PERFORM _assert((SELECT status = 'done' AND from_address = '0x1111111111111111' AND tx_id = 'TXS' FROM public.chain_arrival_probes WHERE nft_id = 5),
                  'W1: the last seller''s withdraw names the delivery, not an earlier hand-off');
  PERFORM _assert((SELECT status = 'done' AND from_address IS NULL AND last_error LIKE 'no TopShot.Withdraw%' FROM public.chain_arrival_probes WHERE nft_id = 6),
                  'W2: no withdraw -> done, no sender invented');
  PERFORM _assert_eq(v->>'found', '2', 'two deliveries found');
  PERFORM _assert_eq(v->>'not_found', '1', 'one without a withdraw');
  PERFORM _assert((v->>'ok')::boolean, 'a clean run is ok');
  PERFORM _assert((SELECT count(*) = 0 FROM public.chain_arrival_requests WHERE request_id IN (SELECT id FROM net._http_response)),
                  'collected calls are cleared');
END $$;

-- H1: a 429 and a 400
INSERT INTO net._http_response (id, status_code, content) VALUES (pg_temp.req_of(1), 429, 'Too Many Requests');
INSERT INTO net._http_response (id, status_code, content) VALUES (pg_temp.req_of(3), 400, '{"message":"failed to execute script"}');
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT attempts = 0 FROM public.chain_arrival_probes WHERE nft_id = 1), 'H1: a 429 costs no attempt');
  PERFORM _assert((SELECT attempts = 1 AND last_error LIKE 'http 400%' FROM public.chain_arrival_probes WHERE nft_id = 3), 'H1: a 400 counts an attempt');
  PERFORM _assert(NOT (v->>'ok')::boolean AND (v->>'throttled')::int = 1 AND (v->>'failed')::int = 1, 'H1: ok=false, one throttled, one failed');
  PERFORM _assert((SELECT request_id IS NOT NULL FROM public.chain_arrival_probes WHERE nft_id = 1), 'H1: the throttled probe is re-dispatched');
END $$;

ROLLBACK;
