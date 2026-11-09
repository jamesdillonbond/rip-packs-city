-- audit_20261109_chain_arrival_lane_4xx_is_attributed_by_the_alert_arm
--
-- WHY. 2026-11-09 ~5:30 AM PT (Claude Code cloud; Trevor: "work on these sentinel issues").
-- The sentinel paged `pg_net_http_429 · 2666 pg_net-dispatched call(s) returned HTTP 429 in the
-- last 02:00:00 ... WHICH ENDPOINT IS UNKNOWN` (high). Measured: it is the chain-arrivals lane.
-- The daily seed (pg_cron 638, 3:13 AM PT) took 43,942 probes / 11 wallets today (7,121 on
-- 11-08), so run_chain_arrival_lane (5 pg_cron entries a minute, <= 24 calls per node each) went
-- from ~0 to ~14,000 Flow REST calls an hour, and rest-mainnet.onflow.org throttles a share.
-- pipeline_runs 'chain-arrivals' extra.throttled per hour (UTC) 11:00 686, 12:00 1,702 against
-- net._http_response 429s 700 / 1,703 -- the same population. The lane already treats a 429 as a
-- FREE retry (no attempt spent, re-dispatched next tick; 41,700+58,463 bisections and 4,350
-- arrivals found in those two hours), so nothing was lost. But the lane DELETES its
-- chain_arrival_requests row on collect, so check_edge_fn_http_failures() had nothing to join
-- and filed every throttle as an unattributed pg_net_http_429 -- and would file a 403 as CRITICAL.
--
-- WHAT.
--   1. public.chain_arrival_http_4xx (request_id PK, status_code, kind, node, recorded_at):
--      run_chain_arrival_lane records every collected 4xx there before deleting the request row,
--      and prunes records older than 1 day at the top of each run (the arm reads <= 12 h).
--      Nothing else in the lane changes (collect, retry/attempt rules, dispatch, caps).
--   2. check_edge_fn_http_failures() joins chain_arrival_http_4xx (collected) AND
--      chain_arrival_requests (landed, not yet collected -- the ~15 s between a response and the
--      next tick) and reports lane 'chain-arrivals' as its own row,
--      `flow-rest-chain-arrivals-<code>`: info for a 408/429 while the lane is still making
--      progress, high otherwise -- high for any other 4xx (a script/argument the node refused,
--      which the lane counts as an attempt), and high for a throttle when probes are open and no
--      run in 30 min bisected, found or closed anything (the retry is not keeping up).
--
-- PIN: supabase/tests/run_chain_arrival_lane.sql (A4 added; verbatim body updated; planted defect
-- -- the INSERT removed -- fails A4, verified locally 2026-11-09). Drift guard re-pointed here.
-- Base: run_chain_arrival_lane live prosrc md5 6f420a0087521054aa8e713a81cde224 (= body of
-- 20261108171928); check_edge_fn_http_failures live prosrc md5 2ca68331d416dc8f9d9cda54ac8e2eb1
-- (= the splice of 20261101163057), both read immediately before this migration.
-- anon-exec: unchanged (run_chain_arrival_lane, check_edge_fn_http_failures) - same signatures;
--   the arm's ACL is restated below. New table: RLS on, no policy, anon/authenticated revoked.
-- Revert: re-apply the run_chain_arrival_lane block of 20261108171928; re-apply the arm prosrc
--   with md5 2ca68331d416dc8f9d9cda54ac8e2eb1 (the 20261101163057 result) via the EXECUTE shape
--   below; DROP TABLE public.chain_arrival_http_4xx.

CREATE TABLE IF NOT EXISTS public.chain_arrival_http_4xx (
  request_id  bigint PRIMARY KEY,
  status_code int NOT NULL,
  kind        text NOT NULL,
  node        text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chain_arrival_http_4xx_recorded_at_idx ON public.chain_arrival_http_4xx (recorded_at);
ALTER TABLE public.chain_arrival_http_4xx ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_http_4xx FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.chain_arrival_http_4xx TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.run_chain_arrival_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 24;
  v_max_att  constant int := 6;
  -- last height of mainnet24..27; a window never straddles one
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145]::bigint[];
  -- 2026-09-30: mainnet25's node runs no script below this height ("node
  -- version is incompatible with data for block" on 85,981,135..86,031,699);
  -- its events there read fine. An interval splits here too, and one wholly
  -- inside that gap is WALKED by events from the top down, 250 blocks a call.
  v_dark_end constant bigint := 86031700;
  -- 2026-11-08 (#181): the mainnet27 root. Flow retired the mainnet24/25/26
  -- access nodes (no DNS record): no node reads a height below this, so the
  -- lane never sends work there -- it closes it, or hands it to the floor check.
  v_floor    constant bigint := 130290659;
  -- the reason run_chain_arrival_refloor already gives a retired probe
  v_retired_why constant text := 'arrived before 2025-10-22 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the arrival is not traceable (#181)';
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
  v_floor_held int := 0; v_floor_passed int := 0; v_unavailable int := 0; v_walked int := 0;
  v_below_floor int := 0; v_refloored int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_chain_arrival_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- 2026-11-09: the 4xx record outlives the alert arm's 12 h window, then goes
  DELETE FROM public.chain_arrival_http_4xx WHERE recorded_at < now() - interval '1 day';

  -- (1) Collect landed calls.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error
      FROM public.chain_arrival_requests q
      JOIN net._http_response h ON h.id = q.request_id
     ORDER BY q.dispatched_at
  LOOP
    v_collected := v_collected + 1;
    v_body := NULL;
    -- 2026-10-10: any HTTP answer means the node is reachable (U3)
    IF r.h_status IS NOT NULL THEN
      UPDATE public.chain_arrival_dark_nodes SET cleared_at = now()
       WHERE node = r.node AND cleared_at IS NULL;
    END IF;
    IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
      BEGIN
        v_body := CASE WHEN r.kind IN ('owned', 'floor')
          THEN convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb
          ELSE r.h_content::jsonb END;
      EXCEPTION WHEN others THEN v_body := NULL;
      END;
    END IF;

    IF v_body IS NULL
       OR (r.kind IN ('owned', 'floor') AND v_body->>'type' IS DISTINCT FROM 'Array')
       OR (r.kind IN ('events', 'walk') AND jsonb_typeof(v_body) IS DISTINCT FROM 'array') THEN
      IF r.h_status = 429 THEN
        UPDATE public.chain_arrival_probes SET request_id = NULL, last_error = 'http 429'
         WHERE request_id = r.request_id;
        v_throttled := v_throttled + 1;
      ELSIF r.h_status = 503 THEN
        -- 2026-09-30: the node's proxy lost its upstream ("upstream connect
        -- error ... connection failure", 05:04-05:08 AM PT): an outage, not a
        -- wrong read -- 159 probes spent all 6 attempts in 4 minutes on it
        UPDATE public.chain_arrival_probes SET request_id = NULL, last_error = 'http 503'
         WHERE request_id = r.request_id;
        v_unavailable := v_unavailable + 1;
      ELSIF r.h_status IS NULL AND r.h_error IS NOT NULL
            AND (r.h_error ~ 'HTTP Request/Response time: 0\.0+ ms'
                 OR r.h_error ~* 'couldn''t (resolve host|connect to server)') THEN
        -- 2026-10-10: no HTTP answer at all -- the connection never completed
        -- (a 30 s TCP/SSL handshake timeout with zero request time, or DNS /
        -- connect refused). An outage, like a 503: 526 probes spent all 6
        -- attempts in 6 minutes on one (4:13-4:19 AM PT 10-09) and, the seed
        -- skipping any probed id, were never tried again. A call that DID
        -- connect and then timed out still counts (its batch must halve).
        UPDATE public.chain_arrival_probes SET request_id = NULL, last_error = left(r.h_error, 300)
         WHERE request_id = r.request_id;
        v_unavailable := v_unavailable + 1;
        -- 2026-10-10 (known-issues #181): and park the NODE for an hour. The
        -- mainnet24/25/26 nodes stopped completing a handshake on 10-08/09;
        -- re-dispatching every tick spent ~790 pg_net calls an hour (36 % of
        -- all) on 30 s timeouts. After the hour one canary call re-tests it.
        INSERT INTO public.chain_arrival_dark_nodes (node, dark_until, last_error)
        VALUES (r.node, now() + interval '1 hour', left(r.h_error, 300))
        ON CONFLICT (node) DO UPDATE
          SET dark_until = EXCLUDED.dark_until, last_error = EXCLUDED.last_error,
              marked_at = now(), cleared_at = NULL;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.chain_arrival_probes
           SET request_id = NULL, attempts = attempts + 1, last_error = v_last_error,
               status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE status END,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id;
        v_failed := v_failed + 1;
      END IF;
      -- 2026-11-09: a 4xx keeps its request id after the request row goes, so
      -- check_edge_fn_http_failures() can attribute it to this lane by a join
      -- (2,666 throttles on 11-09 filed as an unattributed pg_net_http_429)
      IF r.h_status BETWEEN 400 AND 499 THEN
        INSERT INTO public.chain_arrival_http_4xx (request_id, status_code, kind, node)
        VALUES (r.request_id, r.h_status, r.kind, r.node)
        ON CONFLICT (request_id) DO NOTHING;
      END IF;
      DELETE FROM public.chain_arrival_requests WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    IF r.kind = 'floor' THEN
      -- 2026-09-29: held at the floor -> it arrived before the oldest spork we
      -- can read: done, saying so, never bisected; else bisect it
      SELECT coalesce(array_agg((x->>'value')::bigint), '{}') INTO v_owned
        FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) x;
      UPDATE public.chain_arrival_probes p
         SET status = CASE WHEN p.nft_id = ANY (v_owned) THEN 'done' ELSE 'bisect' END,
             last_error = CASE WHEN p.nft_id = ANY (v_owned)
                               THEN 'held at the floor: arrived before 2023-11-08 (mainnet24 root)' END,
             finished_at = CASE WHEN p.nft_id = ANY (v_owned) THEN now() END,
             request_id = NULL
       WHERE p.request_id = r.request_id;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_floor_held := v_floor_held + cardinality(v_owned);
      v_floor_passed := v_floor_passed + v_n - cardinality(v_owned);
    ELSIF r.kind = 'owned' THEN
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
      -- sender is not the wallet itself is the delivery. MATERIALIZED: inlined,
      -- the payload decode re-ran per probe and an 11.9 MB window (21,794
      -- withdraws) hit the statement timeout every tick (2026-09-29).
      WITH ev AS MATERIALIZED (
        SELECT (b->>'block_height')::bigint AS bh, (b->>'block_timestamp')::timestamptz AS bt,
               e->>'transaction_id' AS tx, (e->>'event_index')::int AS ei,
               convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl
          FROM jsonb_array_elements(v_body) b
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
      ), w AS MATERIALIZED (
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
      IF r.kind = 'walk' THEN
        -- a walk read (r.lo, r.hi] at the top of its interval: no withdraw
        -- there -> the interval shrinks to (lo, r.lo]; done only at its bottom
        UPDATE public.chain_arrival_probes p
           SET hi = r.lo, request_id = NULL,
               status = CASE WHEN r.lo <= p.lo THEN 'done' ELSE 'walk' END,
               finished_at = CASE WHEN r.lo <= p.lo THEN now() END,
               last_error = CASE WHEN r.lo <= p.lo THEN 'no TopShot.Withdraw in (lo, hi]: minted in or unread' END
         WHERE p.request_id = r.request_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_walked := v_walked + 1;
      ELSE
        -- no Withdraw in the window: it was deposited without one (a mint)
        UPDATE public.chain_arrival_probes p
           SET status = 'done', request_id = NULL, finished_at = now(),
               last_error = 'no TopShot.Withdraw in (lo, hi]: minted in or unread'
         WHERE p.request_id = r.request_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_not_found := v_not_found + v_n;
        v_windows_done := v_windows_done + 1;
      END IF;
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

  -- wider, but wholly inside mainnet25's script gap: walk it
  UPDATE public.chain_arrival_probes p
     SET status = 'walk'
   WHERE p.status = 'bisect' AND p.request_id IS NULL AND p.hi - p.lo > 250
     AND p.lo >= 85981134 AND p.hi <= v_dark_end;

  -- 2026-11-08 (#181): below the mainnet27 root nothing is sent. An interval
  -- wholly below it (the arrival lies in (lo, hi], hi < the root) is closed
  -- 'failed' with the retire reason; one straddling it goes back to 'floor',
  -- where run_chain_arrival_refloor reads it at the live root (not held ->
  -- bisect above it; held -> retired). A call in flight lands first: its DNS
  -- failure is a free retry, and the next run closes it here.
  UPDATE public.chain_arrival_probes p
     SET status = 'failed', last_error = v_retired_why, finished_at = now()
   WHERE p.status IN ('bisect', 'window', 'walk') AND p.request_id IS NULL AND p.hi < v_floor;
  GET DIAGNOSTICS v_below_floor = ROW_COUNT;
  UPDATE public.chain_arrival_probes p
     SET status = 'floor'
   WHERE p.status IN ('bisect', 'window', 'walk') AND p.request_id IS NULL AND p.lo < v_floor - 1;
  GET DIAGNOSTICS v_refloored = ROW_COUNT;

  -- (2) Dispatch. Pending probes group by (kind, wallet, lo, hi): one call per
  -- group of <= 1,000 ids (an events window is wallet-agnostic but is read per
  -- wallet to keep the bookkeeping simple). <= v_per_node calls per node.
  FOR r IN
    WITH pend AS (
      SELECT p.status, p.wallet, p.lo, p.hi, p.nft_id,
             -- 2026-09-29: a failed call retries in HALF-size batches (a node
             -- answers 500 to 1,000 ids a wallet mostly holds; 300 pass)
             (1000 >> least(p.attempts, 4)) AS batch,
             -- the midpoint; an interval straddling a spork end splits AT it
             -- (a floor check reads AT lo)
             -- 2026-09-30: otherwise the ALIGNED point of (lo, hi): the height in
             -- it with the most trailing zero bits (clear every bit of hi - 1
             -- below the highest bit where lo and hi - 1 differ). Probes with
             -- different intervals then meet at the same heights, so a sold
             -- moment (hi = just before ITS sale) shares calls with its
             -- wallet's others instead of bisecting alone.
             CASE WHEN p.status = 'floor' THEN p.lo ELSE
             coalesce((SELECT min(e) FROM unnest(v_ends || v_dark_end) e WHERE e > p.lo AND e < p.hi AND p.status = 'bisect'),
                      CASE WHEN p.status = 'bisect' AND p.hi - p.lo >= 2
                           THEN ((p.hi - 1) >> (64 - position('1' IN (p.lo # (p.hi - 1))::bit(64)::text)))
                                            << (64 - position('1' IN (p.lo # (p.hi - 1))::bit(64)::text))
                           ELSE (p.lo + p.hi) / 2 END) END AS mid
        FROM public.chain_arrival_probes p
       WHERE p.request_id IS NULL AND p.status IN ('floor', 'bisect', 'window', 'walk')
         -- 2026-11-08 (#181): a floor check reads AT lo; below the mainnet27
         -- root it is left to run_chain_arrival_refloor, never sent
         AND (p.status <> 'floor' OR p.lo >= v_floor)
    ), keyed AS (
      -- 2026-09-30: a holdings script asks "held at mid?", which does not
      -- depend on the interval, so bisect and floor calls group by (wallet,
      -- mid); an events read (window, walk) still needs one (lo, hi)
      SELECT pend.*,
             CASE WHEN status IN ('window', 'walk') THEN lo ELSE mid END AS gk_lo,
             CASE WHEN status IN ('window', 'walk') THEN hi ELSE mid END AS gk_hi
        FROM pend
    ), grp AS (
      SELECT status, wallet, lo, hi, gk_lo, gk_hi, mid, batch,
             (row_number() OVER (PARTITION BY status, wallet, gk_lo, gk_hi, mid, batch ORDER BY nft_id) - 1) / batch AS chunk,
             nft_id
        FROM keyed
    ), calls AS (
      SELECT status, wallet, min(lo) AS lo, max(hi) AS hi, min(hi - lo) AS width, mid, batch, chunk,
             array_agg(nft_id ORDER BY nft_id) AS ids,
             CASE WHEN status IN ('bisect', 'floor') THEN mid WHEN status = 'walk' THEN max(hi) ELSE min(lo) + 1 END AS at_h
        FROM grp
       GROUP BY status, wallet, gk_lo, gk_hi, mid, batch, chunk
    ), routed AS (
      SELECT c.*,
             -- 2026-11-08 (#181): the mainnet24-26 arms are gone with their nodes
             CASE WHEN c.at_h <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                  ELSE 'https://rest-mainnet.onflow.org' END AS node
        FROM calls c
    ), per_wallet AS (
      -- 2026-09-29: each wallet's own queue, narrowest first
      SELECT rt.*, row_number() OVER (PARTITION BY rt.node, rt.wallet ORDER BY (rt.status <> 'floor'), rt.width, rt.lo) AS wrn
        FROM routed rt
    ), ranked AS (
      -- floor checks first (one call settles 1,000 ids arrived before the
      -- floor), then ROUND-ROBIN across wallets: narrowest-first alone let one
      -- wallet's hundreds of narrowing intervals take every slot while 26
      -- wallets' wide intervals never started (2026-09-29)
      SELECT pw.*, row_number() OVER (PARTITION BY pw.node ORDER BY (pw.status <> 'floor'), pw.wrn, pw.width, pw.lo) AS rn
        FROM per_wallet pw
    )
    -- 2026-10-10: a dark node gets nothing; one past its hour gets one
    -- canary call; a cleared or never-dark node gets its full cap (U3)
    SELECT rk.* FROM ranked rk
      LEFT JOIN public.chain_arrival_dark_nodes dn ON dn.node = rk.node
     WHERE rk.rn <= CASE WHEN dn.node IS NULL OR dn.cleared_at IS NOT NULL THEN v_per_node
                         WHEN dn.dark_until > now() THEN 0
                         ELSE 1 END
  LOOP
    IF r.status IN ('bisect', 'floor') THEN
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
      VALUES (v_req, CASE WHEN r.status = 'floor' THEN 'floor' ELSE 'owned' END, r.wallet, r.lo, r.hi, r.mid, r.node);
    ELSIF r.status = 'walk' THEN
      -- the top 250 blocks of the interval: the first delivery found walking
      -- down is the last one
      SELECT net.http_get(
        url := r.node || '/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=' || (greatest(r.lo, r.hi - 250) + 1) || '&end_height=' || r.hi,
        timeout_milliseconds := 30000
      ) INTO v_req;
      INSERT INTO public.chain_arrival_requests (request_id, kind, wallet, lo, hi, height, node)
      VALUES (v_req, 'walk', r.wallet, greatest(r.lo, r.hi - 250), r.hi, NULL, r.node);
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
                       'expired', v_expired, 'dispatched', v_dispatched,
                       'floor_held', v_floor_held, 'floor_passed', v_floor_passed,
                       'unavailable', v_unavailable, 'walked', v_walked,
                       'below_floor', v_below_floor, 'refloored', v_refloored,
                       'dark_nodes', (SELECT count(*) FROM public.chain_arrival_dark_nodes WHERE cleared_at IS NULL))
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'bisected', v_bisected,
                            'windows_read', v_windows_done, 'found', v_found, 'not_found', v_not_found,
                            'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                            'dispatched', v_dispatched, 'floor_held', v_floor_held,
                            'floor_passed', v_floor_passed, 'unavailable', v_unavailable,
                            'walked', v_walked, 'below_floor', v_below_floor, 'refloored', v_refloored,
                            'last_error', v_last_error);
END;
$function$;

DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text;
  c_join_anchor constant text := '      LEFT JOIN public.topshot_lock_event_requests lev ON lev.request_id = r.id';
  c_join_new    constant text := E'      LEFT JOIN public.topshot_lock_event_requests lev ON lev.request_id = r.id\n      LEFT JOIN public.chain_arrival_http_4xx cax ON cax.request_id = r.id\n      LEFT JOIN public.chain_arrival_requests caq ON caq.request_id = r.id';
  c_lane_anchor constant text := '             ELSE ''unknown''';
  c_lane_new    constant text := E'             WHEN (SELECT can_attribute FROM bounds) AND (cax.request_id IS NOT NULL OR caq.request_id IS NOT NULL) THEN ''chain-arrivals''\n             ELSE ''unknown''';
  c_ord_anchor  constant text := 'WHEN ''lock-events'' THEN 15 ELSE 0 END AS ord,';
  c_ord_new     constant text := 'WHEN ''lock-events'' THEN 15 WHEN ''chain-arrivals'' THEN 16 ELSE 0 END AS ord,';
  c_else_anchor constant text := E'      ELSE\n        jsonb_build_object(\n          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';
  c_branch constant text := $b$      WHEN 'chain-arrivals' THEN
        jsonb_build_object(
          'severity', CASE WHEN g.status_code IN (408, 429)
                            AND NOT (EXISTS (SELECT 1 FROM public.chain_arrival_probes WHERE status NOT IN ('done', 'failed'))
                                     AND NOT EXISTS (SELECT 1 FROM public.pipeline_runs pr
                                                      WHERE pr.pipeline = 'chain-arrivals'
                                                        AND pr.started_at > now() - interval '30 minutes'
                                                        AND COALESCE((pr.extra->>'bisected')::int, 0) + COALESCE((pr.extra->>'found')::int, 0)
                                                            + COALESCE((pr.extra->>'not_found')::int, 0) + COALESCE((pr.extra->>'walked')::int, 0)
                                                            + COALESCE((pr.extra->>'floor_held')::int, 0) + COALESCE((pr.extra->>'floor_passed')::int, 0) > 0))
                           THEN 'info' ELSE 'high' END,
          'type',     'edge_fn_http_error',
          'pipeline', 'flow-rest-chain-arrivals-' || g.status_code::text,
          'detail',   g.n || ' chain-arrivals Flow REST call(s) (holdings scripts / Withdraw event reads) returned HTTP '
                      || g.status_code || ' in the last ' || p_window::text
                      || '. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to chain_arrival_http_4xx (recorded by '
                      || 'run_chain_arrival_lane() when it collects a 4xx) or chain_arrival_requests (landed, not yet collected). '
                      || 'The Flow access node has no Cloudflare in front of it: a 408/429 is the public node THROTTLING the '
                      || 'lane''s burst after the daily 3:13 AM PT seed -- a FREE retry (no attempt spent, re-dispatched next tick), '
                      || 'so info while the lane keeps bisecting/finding. THIS ROW ESCALATES TO high when probes are open and no '
                      || 'chain-arrivals run in 30 min made progress, or for any other 4xx (a script or argument the node refused; '
                      || 'the lane spends an attempt -- read chain_arrival_probes.last_error). Open probes: '
                      || (SELECT count(*) FROM public.chain_arrival_probes WHERE status NOT IN ('done', 'failed'))
                      || '. Body: ' || COALESCE(g.sample, '(empty)')
        )
$b$;
BEGIN
  SELECT p.prosrc, pg_get_function_arguments(p.oid) INTO v_src, v_args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF md5(v_src) <> '2ca68331d416dc8f9d9cda54ac8e2eb1' THEN
    RAISE EXCEPTION 'base drifted: prosrc md5 % is not the body this splice was written against', md5(v_src);
  END IF;
  IF position('''chain-arrivals''' in v_src) > 0 THEN
    RAISE EXCEPTION 'already patched -- refusing to double-patch';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1
     OR (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'an anchor is not unique';
  END IF;
  v_new := replace(v_src, c_join_anchor, c_join_new);
  v_new := replace(v_new, c_lane_anchor, c_lane_new);
  v_new := replace(v_new, c_ord_anchor, c_ord_new);
  v_new := replace(v_new, c_else_anchor, c_branch || c_else_anchor);
  IF position('JOIN public.chain_arrival_http_4xx cax ON cax.request_id = r.id' in v_new) = 0
     OR position('JOIN public.chain_arrival_requests caq ON caq.request_id = r.id' in v_new) = 0
     OR position('THEN ''chain-arrivals''' in v_new) = 0
     OR position('WHEN ''chain-arrivals'' THEN 16' in v_new) = 0
     OR position('flow-rest-chain-arrivals-' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform did not land';
  END IF;
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

DO $mig$
BEGIN
  IF has_function_privilege('anon', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.check_edge_fn_http_failures(interval)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon/authenticated EXECUTE leaked on check_edge_fn_http_failures';
  END IF;
END
$mig$;
