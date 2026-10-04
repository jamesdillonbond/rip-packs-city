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
--   F1. A 'floor' probe is ONE script at lo: held there -> done ("arrived
--       before 2023-11-08"), never bisected; not held -> bisect.
--   F2. Floor checks dispatch before bisections within a node's cap.
--   R1. A failed call retries in half-size batches (1,000 >> attempts).
--   F3. Dispatch is round-robin across wallets: one wallet's many narrow
--       intervals cannot take every slot from another wallet's wide one.
--   U1. A 503 (the node's upstream down) is a free retry, like a 429.
--   G1. An interval straddling 86,031,700 (the first height mainnet25 runs a
--       script at) splits AT it, never reading a script below it.
--   G2. An interval wholly inside that gap, wider than 250 blocks, is WALKED:
--       events of its top 250 blocks; no withdraw -> hi drops to the window's
--       bottom; a withdraw -> done with that delivery; the bottom -> done.
--   A1. A bisect's mid is the ALIGNED point of (lo, hi) (most trailing zero
--       bits), and holdings calls group by (wallet, mid): one wallet's probes
--       with different intervals share a call; each moves by its own interval.
--   S2. It also takes each unexplained Top Shot moment the wallet SOLD after
--       2023-11-09, hi = just before its FIRST sale; a held row wins.
--   S1. The saved-wallet seed takes only unexplained held Top Shot moments
--       (not an NFT pack pull, no pack-pull record, not a recorded purchase)
--       at the floor, never another collection's id, never twice.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929170000_audit_20260929_chain_arrivals_find_when_and_from_whom_a_wallet_got_a_moment.sql;
-- seed_saved_wallet_chain_arrivals from
-- 20260930190000_audit_20260930_chain_arrivals_seed_sold_moments.sql;
-- run_chain_arrival_lane from 20260930183000_audit_20260930_chain_arrival_aligned_bisection_shares_calls.sql).
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
  request_id bigint PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('owned', 'events', 'floor', 'walk')), wallet text,
  lo bigint NOT NULL, hi bigint NOT NULL, height bigint, node text NOT NULL, dispatched_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.chain_arrival_probes (
  wallet text NOT NULL, nft_id bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL,
  status text NOT NULL DEFAULT 'bisect' CHECK (status IN ('floor', 'bisect', 'window', 'walk', 'done', 'failed')),
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
    SELECT * FROM ranked WHERE rn <= v_per_node
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
                       'unavailable', v_unavailable, 'walked', v_walked)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'bisected', v_bisected,
                            'windows_read', v_windows_done, 'found', v_found, 'not_found', v_not_found,
                            'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                            'dispatched', v_dispatched, 'floor_held', v_floor_held,
                            'floor_passed', v_floor_passed, 'unavailable', v_unavailable,
                            'walked', v_walked, 'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<


-- seed stubs
CREATE TABLE public.saved_wallets (wallet_addr text);
CREATE TABLE public.wallet_moments_cache (wallet_address text, moment_id text, collection_id uuid);
CREATE TABLE public.pack_open_pulls (collection_id uuid, pack_nft_id text, nft_id text);
CREATE TABLE public.moment_acquisitions (wallet text, collection_id uuid, nft_id text, acquisition_method text);
CREATE TABLE public.sales (collection_id uuid, nft_id text, buyer_address text, seller_address text, sold_at timestamptz, block_height bigint);
CREATE FUNCTION public.flow_height_estimate(p_at timestamptz) RETURNS bigint LANGUAGE sql AS $$ SELECT 166000000::bigint $$;

-- >>> BEGIN verbatim seed_saved_wallet_chain_arrivals (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.seed_saved_wallet_chain_arrivals()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts      constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_floor   constant bigint := 65300000;       -- just past the mainnet24 root
  v_hi      bigint := public.flow_height_estimate(now() - interval '15 minutes');
  v_seeded  int := 0; v_wallets int := 0; v_sold int := 0;
BEGIN
  IF v_hi IS NULL OR v_hi <= v_floor THEN
    PERFORM public.log_pipeline_run('chain-arrivals-seed', v_started, 0, 0, 0, false, 'no height estimate for now()',
      'nba_top_shot', NULL, NULL, '{}'::jsonb);
    RETURN jsonb_build_object('ok', false, 'reason', 'no height estimate for now()');
  END IF;

  -- every held Top Shot moment of a saved wallet we cannot already explain:
  -- not a known NFT pack pull, no pack-pull record, not a recorded purchase.
  -- It starts at the FLOOR check (held at the mainnet24 root -> done).
  --
  -- 2026-10-04: two cost changes, same rows inserted. (1) A moment that already
  -- has a probe row is dropped FIRST: the insert is ON CONFLICT DO NOTHING, so it
  -- could never insert (114,140 of 176,313 held moments). (2) "not a recorded
  -- purchase" reads the saved wallets' purchases ONCE by buyer (`bought`) and
  -- hash-anti-joins, instead of probing all eight sales partitions per moment
  -- (2.58 M buffers -> ~62 k). The 10-04 4:13 AM PT run hit its 300 s timeout.
  WITH w AS (
    SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
     WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$'
  ), bought AS MATERIALIZED (
    SELECT DISTINCT s.buyer_address::text AS wallet, s.nft_id::text AS nft_id
      FROM w
      JOIN public.sales s ON s.buyer_address = w.wallet
     WHERE s.collection_id = v_ts
  ), held AS (
    SELECT w.wallet, m.moment_id::bigint AS nft_id, v_hi AS hi
      FROM w
      JOIN public.wallet_moments_cache m
        ON m.wallet_address = w.wallet AND m.collection_id = v_ts AND m.moment_id ~ '^[0-9]{1,15}$'
     WHERE NOT EXISTS (SELECT 1 FROM public.chain_arrival_probes p
                        WHERE p.wallet = w.wallet AND p.nft_id = m.moment_id::bigint)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = m.moment_id)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = w.wallet AND a.collection_id = v_ts AND a.nft_id = m.moment_id
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM bought b WHERE b.wallet = w.wallet AND b.nft_id = m.moment_id)
  ), sold AS (
    -- 2026-09-30: a moment the wallet SOLD after the floor is traceable too:
    -- it was held just before its first sale, so hi = that height - 100 (the
    -- estimate is within 22 blocks of the real height; 300 of 300 rips,
    -- 2023-26). Only held moments were seeded before, so a pull flipped
    -- between two seeds was never traced. Same exclusions as held.
    SELECT s.seller_address AS wallet, s.nft_id::bigint AS nft_id,
           coalesce(min(s.block_height), public.flow_height_estimate(min(s.sold_at))) - 100 AS hi
      FROM w
      JOIN public.sales s ON s.seller_address = w.wallet
     WHERE s.collection_id = v_ts AND s.nft_id ~ '^[0-9]{1,15}$' AND s.sold_at > timestamptz '2023-11-09'
     GROUP BY 1, 2
  ), sold_ok AS (
    SELECT so.wallet, so.nft_id, so.hi
      FROM sold so
     WHERE so.hi > v_floor
       AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_probes p
                        WHERE p.wallet = so.wallet AND p.nft_id = so.nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.pack_open_pulls o WHERE o.collection_id = v_ts AND o.nft_id = so.nft_id::text)
       AND NOT EXISTS (SELECT 1 FROM public.moment_acquisitions a
                        WHERE a.wallet = so.wallet AND a.collection_id = v_ts AND a.nft_id = so.nft_id::text
                          AND a.acquisition_method = 'pack_pull')
       AND NOT EXISTS (SELECT 1 FROM bought b WHERE b.wallet = so.wallet AND b.nft_id = so.nft_id::text)
  ), ids AS (
    SELECT wallet, nft_id, hi, false AS is_sold FROM held
    UNION ALL
    SELECT wallet, nft_id, hi, true FROM sold_ok
  ), ins AS (
    INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
    SELECT DISTINCT ON (wallet, nft_id) wallet, nft_id, v_floor, hi, 'floor' FROM ids
     ORDER BY wallet, nft_id, is_sold
    ON CONFLICT (wallet, nft_id) DO NOTHING
    RETURNING wallet, hi
  )
  SELECT count(*), count(DISTINCT wallet), count(*) FILTER (WHERE hi <> v_hi) INTO v_seeded, v_wallets, v_sold FROM ins;

  PERFORM public.log_pipeline_run('chain-arrivals-seed', v_started, v_seeded, v_seeded, 0, true, NULL,
    'nba_top_shot', NULL, NULL, jsonb_build_object('seeded', v_seeded, 'sold', v_sold, 'wallets', v_wallets, 'hi', v_hi));
  RETURN jsonb_build_object('ok', true, 'seeded', v_seeded, 'sold', v_sold, 'wallets', v_wallets, 'hi', v_hi);
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
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=100000768', 'B1: the ALIGNED point of (100000000, 100001000) on the mainnet26 node');
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
  PERFORM _assert((SELECT lo = 100000000 AND hi = 100000768 FROM public.chain_arrival_probes WHERE nft_id = 1), 'B1: held at mid -> hi = mid');
  PERFORM _assert((SELECT lo = 100000768 AND hi = 100001000 FROM public.chain_arrival_probes WHERE nft_id = 2), 'B1: not held -> lo = mid');
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

-- F1 / F2: a floor probe on mainnet26's node beside a pending bisection there
DELETE FROM net.calls;
UPDATE public.chain_arrival_probes SET request_id = NULL WHERE request_id IS NOT NULL;
DELETE FROM public.chain_arrival_requests;
DELETE FROM public.chain_arrival_probes WHERE status IN ('bisect', 'window');
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status) VALUES
  ('0x00000000000000bb', 20, 100000000, 166000000, 'floor'),
  ('0x00000000000000bb', 21, 100000000, 166000000, 'floor');
-- 24 narrower bisections on the same node: without floor priority they fill
-- mainnet26's cap of 24 and the floor check waits
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
SELECT '0x00000000000000bb', 900 + g, 100000000 + g * 10000, 100000000 + g * 10000 + 5000, 'bisect' FROM generate_series(1, 24) g;
DO $$
DECLARE v jsonb; v_req bigint;
BEGIN
  v := public.run_chain_arrival_lane();
  SELECT request_id INTO v_req FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000bb' AND nft_id = 20;
  PERFORM _assert(v_req IS NOT NULL AND v_req = (SELECT request_id FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000bb' AND nft_id = 21),
                  'F1: the floor probes share one call');
  PERFORM _assert((SELECT kind = 'floor' AND height = 100000000 FROM public.chain_arrival_requests WHERE request_id = v_req),
                  'F1: a floor call reads AT lo');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = v_req) = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=100000000',
                  'F1: on the node serving lo');
  PERFORM _assert((SELECT count(*) = 24 FROM net.calls WHERE url LIKE 'http://access-001.mainnet26.%'), 'F2: the node''s cap of 24 binds');
  PERFORM _assert(v_req IS NOT NULL, 'F2: the floor check is inside the cap, ahead of narrower bisections');
  INSERT INTO net._http_response (id, status_code, content)
  VALUES (v_req, 200, to_jsonb(translate(encode(convert_to('{"type":"Array","value":[{"type":"UInt64","value":"20"}]}', 'UTF8'), 'base64'), E'\n', ''))::text);
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT status = 'done' AND last_error LIKE 'held at the floor%' AND from_address IS NULL
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000bb' AND nft_id = 20),
                  'F1: held at the floor -> done, saying so');
  PERFORM _assert((SELECT status = 'bisect' AND lo = 100000000 AND hi = 166000000
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000bb' AND nft_id = 21),
                  'F1: not held at the floor -> bisected over the same interval');
  PERFORM _assert_eq(v->>'floor_held', '1', 'F1: counted');
END $$;

-- R1: 1,200 floor probes: fresh -> 2 calls (1,000 + 200); after one failed
-- attempt -> 3 calls (500 + 500 + 200)
DELETE FROM net.calls;
DELETE FROM public.chain_arrival_probes;
DELETE FROM public.chain_arrival_requests;
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
SELECT '0x00000000000000ee', g, 100000000, 166000000, 'floor' FROM generate_series(1, 1200) g;
DO $$
BEGIN
  PERFORM public.run_chain_arrival_lane();
  PERFORM _assert((SELECT count(*) = 2 FROM net.calls), 'R1: fresh probes go 1,000 a call');
  DELETE FROM net.calls; DELETE FROM public.chain_arrival_requests;
  UPDATE public.chain_arrival_probes SET request_id = NULL, attempts = 1 WHERE wallet = '0x00000000000000ee';
  PERFORM public.run_chain_arrival_lane();
  PERFORM _assert((SELECT count(*) = 3 FROM net.calls), 'R1: after a failure, 500 a call');
  PERFORM _assert((SELECT max(cardinality(pg_temp.call_ids(id))) = 500 FROM net.calls), 'R1: no call carries more than 500 ids');
END $$;

-- F3: wallet A holds 30 narrow mainnet26 intervals, wallet B one wide one
DELETE FROM net.calls;
DELETE FROM public.chain_arrival_probes;
DELETE FROM public.chain_arrival_requests;
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
SELECT '0x000000000000000a', g, 100000000 + g * 10000, 100000000 + g * 10000 + 5000, 'bisect' FROM generate_series(1, 30) g;
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status)
VALUES ('0x000000000000000b', 99, 100000000, 129000000, 'bisect');
DO $$
BEGIN
  PERFORM public.run_chain_arrival_lane();
  PERFORM _assert((SELECT count(*) = 24 FROM net.calls WHERE url LIKE 'http://access-001.mainnet26.%'), 'F3: the cap binds');
  PERFORM _assert((SELECT request_id IS NOT NULL FROM public.chain_arrival_probes WHERE wallet = '0x000000000000000b'),
                  'F3: the wide interval of the other wallet is dispatched despite 30 narrower ones');
END $$;

-- A1: ALIGNED bisection. Three probes of one wallet with DIFFERENT intervals
-- (sold moments: each hi is just before its own sale) meet at one aligned
-- height and share ONE call; each then moves by its OWN interval. The same
-- interval in another wallet is its own call. (lo + hi) / 2 would have made
-- three calls here: 100,350,000 / 100,450,000 / 100,450,000 on differing (lo, hi).
DELETE FROM net.calls;
DELETE FROM net._http_response;
DELETE FROM public.chain_arrival_probes;
DELETE FROM public.chain_arrival_requests;
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status) VALUES
  ('0x00000000000000aa', 201, 100000000, 100700000, 'bisect'),
  ('0x00000000000000aa', 202, 100000000, 100900000, 'bisect'),
  ('0x00000000000000aa', 203, 100100000, 100800000, 'bisect'),
  ('0x00000000000000cc', 204, 100000000, 100700000, 'bisect');
DO $$
BEGIN
  PERFORM public.run_chain_arrival_lane();
  PERFORM _assert(pg_temp.req_of(201) = pg_temp.req_of(202) AND pg_temp.req_of(202) = pg_temp.req_of(203),
                  'A1: three different intervals of one wallet share one call');
  PERFORM _assert(pg_temp.call_ids(pg_temp.req_of(201)) = ARRAY[201, 202, 203]::bigint[], 'A1: the call asks for all three ids');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(201))
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=100663296',
                  'A1: at the aligned height 100,663,296 (= 2^26 * 1.5), inside every interval');
  PERFORM _assert((SELECT request_id FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000cc') IS DISTINCT FROM pg_temp.req_of(201),
                  'A1: another wallet never rides the call');
  PERFORM _assert((SELECT count(*) = 2 FROM net.calls), 'A1: two calls in all, not four');
END $$;
SELECT pg_temp.plant_owned(pg_temp.req_of(201), ARRAY[201]::bigint[]);
DO $$
BEGIN
  PERFORM public.run_chain_arrival_lane();
  PERFORM _assert((SELECT lo = 100000000 AND hi = 100663296 FROM public.chain_arrival_probes WHERE nft_id = 201), 'A1: held -> hi = the aligned height');
  PERFORM _assert((SELECT lo = 100663296 AND hi = 100900000 FROM public.chain_arrival_probes WHERE nft_id = 202), 'A1: not held -> lo = it, own hi kept');
  PERFORM _assert((SELECT lo = 100663296 AND hi = 100800000 FROM public.chain_arrival_probes WHERE nft_id = 203), 'A1: not held -> lo = it, own hi kept (different lo before)');
END $$;

-- U1 / G1 / G2: mainnet25's script gap (85,981,135..86,031,699)
DELETE FROM net.calls;
DELETE FROM public.chain_arrival_probes;
DELETE FROM public.chain_arrival_requests;
CREATE FUNCTION pg_temp.req_dd(p_id bigint) RETURNS bigint LANGUAGE sql AS $$
  SELECT request_id FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = p_id $$;
CREATE FUNCTION pg_temp.plant_events(p_req bigint, p_blocks jsonb) RETURNS void LANGUAGE sql AS $$
  INSERT INTO net._http_response (id, status_code, content) VALUES (p_req, 200, p_blocks::text) $$;
INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status) VALUES
  ('0x00000000000000dd', 1, 85981134, 86051294, 'bisect'),   -- the 0x28be… interval
  ('0x00000000000000dd', 2, 85981134, 85982000, 'bisect'),   -- inside the gap, 866 wide
  ('0x00000000000000dd', 3, 85981134, 85981500, 'bisect');   -- inside the gap, 366 wide
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_dd(1))
                  = 'http://access-001.mainnet25.nodes.onflow.org:8070/v1/scripts?block_height=86031700',
                  'G1: an interval straddling the gap''s end splits AT 86,031,700, never at its midpoint 86,016,214');
  PERFORM _assert((SELECT status = 'walk' FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 2),
                  'G2: wholly inside the gap and wider than 250 -> walk');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_dd(2))
                  = 'http://access-001.mainnet25.nodes.onflow.org:8070/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=85981751&end_height=85982000',
                  'G2: a walk reads the TOP 250 blocks by events, on mainnet25');
  PERFORM _assert((SELECT kind = 'walk' AND lo = 85981750 AND hi = 85982000 FROM public.chain_arrival_requests WHERE request_id = pg_temp.req_dd(2)),
                  'G2: the call records the window it read');
  PERFORM _assert((SELECT count(*) = 0 FROM net.calls WHERE url LIKE '%scripts?block_height=8598%' OR url ~ 'scripts\?block_height=8601'
                                                         OR url ~ 'scripts\?block_height=86031[0-6]'),
                  'G1: no script is sent into the gap');
END $$;

-- 1 held at 86,031,700 -> (85981134, 86031700], all gap; 2 and 3: no withdraw on top
SELECT pg_temp.plant_owned(pg_temp.req_dd(1), ARRAY[1]::bigint[]);
SELECT pg_temp.plant_events(pg_temp.req_dd(2), '[]'::jsonb);
SELECT pg_temp.plant_events(pg_temp.req_dd(3), jsonb_build_array(jsonb_build_object('block_height', '85981400',
  'block_timestamp', '2024-09-01T00:00:00Z', 'events', jsonb_build_array(pg_temp.wd(3, '0x00000000000000dd', 'TXSELF', 0)))));
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT status = 'walk' AND lo = 85981134 AND hi = 86031700 FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 1),
                  'G1: held at the split -> the gap remains, and is walked');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_dd(1))
                  = 'http://access-001.mainnet25.nodes.onflow.org:8070/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=86031451&end_height=86031700',
                  'G1: the walk starts at the split');
  PERFORM _assert((SELECT status = 'walk' AND hi = 85981750 AND finished_at IS NULL AND from_address IS NULL
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 2),
                  'G2: no withdraw on top -> hi drops to the window''s bottom, not done');
  PERFORM _assert((SELECT status = 'walk' AND hi = 85981250 AND from_address IS NULL
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 3),
                  'G2: the wallet''s OWN withdraw is not a delivery');
  PERFORM _assert_eq(v->>'walked', '2', 'G2: two walk reads collected');
  PERFORM _assert_eq(v->>'not_found', '0', 'G2: a walk step concludes nothing');
END $$;

-- 2: a seller's withdraw one step down; 3: nothing at the bottom; 1: a 503
SELECT pg_temp.plant_events(pg_temp.req_dd(2), jsonb_build_array(jsonb_build_object('block_height', '85981700',
  'block_timestamp', '2024-09-01T01:00:00Z', 'events', jsonb_build_array(pg_temp.wd(2, '0x3333333333333333', 'TXW', 2)))));
SELECT pg_temp.plant_events(pg_temp.req_dd(3), '[]'::jsonb);
INSERT INTO net._http_response (id, status_code, content)
VALUES (pg_temp.req_dd(1), 503, 'upstream connect error or disconnect/reset before headers. reset reason: connection failure');
DO $$
DECLARE v jsonb;
BEGIN
  PERFORM _assert((SELECT lo = 85981134 AND hi = 85981250 FROM public.chain_arrival_requests WHERE request_id = pg_temp.req_dd(3)),
                  'G2: the last step is clamped at lo');
  v := public.run_chain_arrival_lane();
  PERFORM _assert((SELECT status = 'done' AND from_address = '0x3333333333333333' AND tx_id = 'TXW' AND arrived_height = 85981700
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 2),
                  'G2: a withdraw found walking down is the delivery');
  PERFORM _assert((SELECT status = 'done' AND from_address IS NULL AND last_error LIKE 'no TopShot.Withdraw%'
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 3),
                  'G2: the bottom reached with nothing -> done, no sender invented');
  PERFORM _assert((SELECT attempts = 0 AND last_error = 'http 503' AND status = 'walk' AND request_id IS NOT NULL
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000dd' AND nft_id = 1),
                  'U1: a 503 costs no attempt and is re-dispatched');
  PERFORM _assert((v->>'ok')::boolean AND (v->>'unavailable')::int = 1 AND (v->>'failed')::int = 0,
                  'U1: an outage is not a failed read');
END $$;
DELETE FROM public.chain_arrival_probes;

-- S1
INSERT INTO public.saved_wallets VALUES ('0x00000000000000CC '), ('not-an-address');
INSERT INTO public.wallet_moments_cache VALUES
  ('0x00000000000000cc', '501', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),   -- unexplained -> seeded
  ('0x00000000000000cc', '502', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),   -- an NFT pack pull
  ('0x00000000000000cc', '503', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),   -- a CSV pack pull
  ('0x00000000000000cc', '504', '95f28a17-224a-4025-96ad-adf8a4c63bfd'),   -- a recorded purchase
  ('0x00000000000000cc', '505', 'dee28451-5d62-409e-a1ad-a83f763ac070');   -- All Day
INSERT INTO public.pack_open_pulls VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK', '502');
INSERT INTO public.moment_acquisitions VALUES ('0x00000000000000cc', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '503', 'pack_pull');
INSERT INTO public.sales VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '504', '0x00000000000000cc');
DO $$
DECLARE v jsonb;
BEGIN
  v := public.seed_saved_wallet_chain_arrivals();
  PERFORM _assert_eq(v->>'seeded', '1', 'S1: only the unexplained Top Shot moment');
  PERFORM _assert((SELECT status = 'floor' AND lo = 65300000 AND hi = 166000000
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000cc' AND nft_id = 501),
                  'S1: seeded at the floor, up to now');
  PERFORM _assert_eq((public.seed_saved_wallet_chain_arrivals())->>'seeded', '0', 'S1: never twice');
END $$;

-- S2 (2026-09-30): a moment the wallet SOLD after the floor is seeded too, at
-- the floor with hi = just before its first sale; same exclusions; held wins.
INSERT INTO public.sales (collection_id, nft_id, buyer_address, seller_address, sold_at, block_height) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '601', '0x00000000000000dd', '0x00000000000000cc', '2025-06-01', 120000000), -- seeded, hi = 119,999,900
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '601', '0x00000000000000ee', '0x00000000000000cc', '2025-07-01', 125000000), -- a later re-sale: the FIRST sale bounds it
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '602', '0x00000000000000dd', '0x00000000000000cc', '2025-06-01', 120000000), -- an NFT pack pull
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '603', '0x00000000000000cc', '0x00000000000000dd', '2024-06-01', 100000000), -- bought by the wallet ...
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '603', '0x00000000000000ee', '0x00000000000000cc', '2025-06-01', 120000000), -- ... then sold: not a pull
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '604', '0x00000000000000dd', '0x00000000000000cc', '2023-06-01', 60000000),  -- sold before the floor
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '605', '0x00000000000000dd', '0x00000000000000cc', '2026-01-01', NULL),       -- no height: estimate - 100
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '501', '0x00000000000000dd', '0x00000000000000cc', '2025-06-01', 120000000), -- also held: already seeded
  ('dee28451-5d62-409e-a1ad-a83f763ac070', '606', '0x00000000000000dd', '0x00000000000000cc', '2025-06-01', 120000000); -- All Day
INSERT INTO public.pack_open_pulls VALUES ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'PK2', '602');
DO $$
DECLARE v jsonb;
BEGIN
  v := public.seed_saved_wallet_chain_arrivals();
  PERFORM _assert_eq(v->>'seeded', '2', 'S2: two sold moments seeded (601, 605)');
  PERFORM _assert_eq(v->>'sold', '2', 'S2: and counted as sold');
  PERFORM _assert((SELECT status = 'floor' AND lo = 65300000 AND hi = 119999900
                     FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000cc' AND nft_id = 601),
                  'S2: hi = the FIRST sale''s height - 100');
  PERFORM _assert((SELECT hi = 165999900 FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000cc' AND nft_id = 605),
                  'S2: no recorded height -> flow_height_estimate(sold_at) - 100');
  PERFORM _assert((SELECT count(*) = 0 FROM public.chain_arrival_probes WHERE nft_id IN (602, 603, 604, 606)),
                  'S2: never a pack pull, a bought moment, a pre-floor sale or another collection');
  PERFORM _assert((SELECT hi = 166000000 FROM public.chain_arrival_probes WHERE wallet = '0x00000000000000cc' AND nft_id = 501),
                  'S2: an existing (held) probe is untouched');
  PERFORM _assert_eq((public.seed_saved_wallet_chain_arrivals())->>'seeded', '0', 'S2: never twice');
END $$;

ROLLBACK;
