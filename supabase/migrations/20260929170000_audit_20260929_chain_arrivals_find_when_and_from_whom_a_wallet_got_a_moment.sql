-- 2026-09-29 (PT) — chain arrivals: WHEN and FROM WHOM a wallet received a
-- Top Shot moment, found on Flow's historical spork nodes.
--
-- WHY (Trevor: "proceed with all" -- custodial rips). A custodial Top Shot
-- rip (a pack opened at Dapper, no PackNFT) leaves no row we hold: deliveries
-- are seeded only from flowty_ingest (2026-04 on) and from one owner's CSV.
-- Rigged (0xf77bf547fccf6656) holds 38,508 Top Shot moments; 19,480 arrived
-- between 2023-11-08 and 2025-12-28 (held at the end, not at the start --
-- two historical scripts per 1,000 ids), and 10,787 of those are neither an
-- NFT pack pull nor a purchase we hold.
--
-- Measured on chain 2026-09-29: a custodial pull is ONE transaction
-- TopShot.Withdraw(from: 0xb5b717909b9c5ea5) -> TopShot.Deposit(to: wallet)
-- (0xbd94...'s burst 45259996, 2025-04-14); an NFT pack open withdraws from
-- 0xe1f2a091f7bb5245 instead. 0xb5b7... holds a moment only in transit (0 of
-- 1,000 of Rigged's at either end of the window), so a snapshot of IT cannot
-- find them; the wallet's own holdings can.
--
-- WHAT.
--   chain_arrival_probes    one row per (wallet, moment): [lo, hi] = a height
--                           the wallet did NOT hold it and one it DID. Bisected
--                           by "which of these ids does the wallet hold at h"
--                           scripts (<= 1,000 ids a call; ids sharing an
--                           interval share the call, so a pack's pulls travel
--                           together); an interval never straddles a spork end.
--                           At <= 250 blocks, one TopShot.Withdraw events read
--                           of (lo, hi] names the sender, tx and block time.
--   chain_arrival_requests  the in-flight calls.
--   enqueue_chain_arrivals(wallet, ids, lo, hi)  seeds probes.
--   run_chain_arrival_lane()  collect + dispatch (<= 12 calls per node per
--                           tick; a 429 is a free retry). pg_cron every minute.
-- The lane DISCOVERS only; nothing reads its rows yet. Classification:
-- from 0xb5b7... = custodial pull, 0xe1f2... = NFT pack pull, else a transfer
-- or purchase (from = the sender).
-- anon-exec: enqueue_chain_arrivals(text, bigint[], bigint, bigint) — new; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: run_chain_arrival_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-chain-arrival-lane');
--   DROP FUNCTION public.run_chain_arrival_lane(), public.enqueue_chain_arrivals(text, bigint[], bigint, bigint);
--   DROP TABLE public.chain_arrival_probes, public.chain_arrival_requests;

CREATE TABLE IF NOT EXISTS public.chain_arrival_requests (
  request_id     bigint PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('owned', 'events')),
  wallet         text,
  lo             bigint NOT NULL,
  hi             bigint NOT NULL,
  height         bigint,
  node           text NOT NULL,
  dispatched_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chain_arrival_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_requests FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.chain_arrival_probes (
  wallet          text NOT NULL,
  nft_id          bigint NOT NULL,
  lo              bigint NOT NULL,
  hi              bigint NOT NULL,
  status          text NOT NULL DEFAULT 'bisect' CHECK (status IN ('bisect', 'window', 'done', 'failed')),
  request_id      bigint,
  attempts        int NOT NULL DEFAULT 0,
  arrived_height  bigint,
  arrived_at      timestamptz,
  tx_id           text,
  from_address    text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  PRIMARY KEY (wallet, nft_id)
);
COMMENT ON TABLE public.chain_arrival_probes IS
  'Top Shot moment arrivals read on Flow''s historical sporks: [lo, hi] bisected on the wallet''s own holdings, then the TopShot.Withdraw that delivered it (sender, tx, block time). from_address 0xb5b717909b9c5ea5 = custodial pack pull, 0xe1f2a091f7bb5245 = NFT pack pull. Written by run_chain_arrival_lane().';
CREATE INDEX IF NOT EXISTS idx_chain_arrival_probes_pending
  ON public.chain_arrival_probes (status, lo, hi) WHERE request_id IS NULL AND status IN ('bisect', 'window');
CREATE INDEX IF NOT EXISTS idx_chain_arrival_probes_request
  ON public.chain_arrival_probes (request_id) WHERE request_id IS NOT NULL;
ALTER TABLE public.chain_arrival_probes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_probes FROM anon, authenticated;


-- ── enqueue_chain_arrivals ──────────────────────────────────────────────────
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


-- ── run_chain_arrival_lane ──────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.enqueue_chain_arrivals(text, bigint[], bigint, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_chain_arrival_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_chain_arrivals(text, bigint[], bigint, bigint) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.run_chain_arrival_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-chain-arrival-lane', '* * * * *', 'SELECT public.run_chain_arrival_lane();');
