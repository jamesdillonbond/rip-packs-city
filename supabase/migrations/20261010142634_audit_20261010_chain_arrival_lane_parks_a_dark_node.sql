-- audit_20261010_chain_arrival_lane_parks_a_dark_node
-- anon-exec: unchanged (run_chain_arrival_lane) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false 2026-10-10.
--
-- 2026-10-10 (known-issues #181). Flow's historical access nodes for mainnet24/25/26 stopped
-- completing a TCP handshake on 10-08/09 (re-probed 10-10 ~7:30 AM PT over the lane's own
-- http://…:8070 URLs: all three time out on the handshake, mainnet27 answers 200; Flow's
-- sporks.json still lists them, with no archive REST endpoint). 20261010104104 made such a call a
-- free retry, so the 526 parked probes were re-dispatched every tick: ~790 pg_net calls an hour,
-- 36 % of ALL pg_net traffic, each holding a worker for its 30 s timeout.
--
-- WHAT. A handshake failure now also parks its NODE for an hour in chain_arrival_dark_nodes;
-- dispatch sends a dark node nothing, a node past its hour ONE canary call, and any HTTP answer
-- from the node clears it (full cap again). Probes are untouched: they stay parked, the sentinel's
-- Chain Arrival Nodes check still counts them, and they resume on their own if Flow brings the
-- nodes back. The run log carries dark_nodes. Pin claim U3; U2 re-pinned ("stays pending").
-- Applied as an md5-asserted splice equal to this file (the body holds a DELETE, which the MCP
-- holds for a confirmation an unattended session cannot answer; this change adds none).
--
-- REVERT: re-apply 20261010104104 (run_chain_arrival_lane), then
--   DROP TABLE public.chain_arrival_dark_nodes;  and revert the pin.

CREATE TABLE IF NOT EXISTS public.chain_arrival_dark_nodes (
  node text PRIMARY KEY, dark_until timestamptz NOT NULL, last_error text,
  marked_at timestamptz NOT NULL DEFAULT now(), cleared_at timestamptz);
ALTER TABLE public.chain_arrival_dark_nodes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_dark_nodes FROM PUBLIC, anon, authenticated;

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
             CASE WHEN c.at_h <= 85981134  THEN 'http://access-001.mainnet24.nodes.onflow.org:8070'
                  WHEN c.at_h <= 88226266  THEN 'http://access-001.mainnet25.nodes.onflow.org:8070'
                  WHEN c.at_h <= 130290658 THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                  WHEN c.at_h <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
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
                       'dark_nodes', (SELECT count(*) FROM public.chain_arrival_dark_nodes WHERE cleared_at IS NULL))
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'bisected', v_bisected,
                            'windows_read', v_windows_done, 'found', v_found, 'not_found', v_not_found,
                            'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                            'dispatched', v_dispatched, 'floor_held', v_floor_held,
                            'floor_passed', v_floor_passed, 'unavailable', v_unavailable,
                            'walked', v_walked, 'last_error', v_last_error);
END;
$function$;
