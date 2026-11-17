-- audit_20261108_run_pinnacle_pull_chain_lane_floor_at_mainnet27
--
-- WHY. 2026-11-08 ~9:10 AM PT (Claude Code, Trevor's Windows box). Flow retired the
-- access nodes access-001.mainnet24/25/26.nodes.onflow.org (#181: no DNS record);
-- a block before 130290659 (the mainnet27 root) is readable by no node. Two lanes
-- broke today when old work reached them and were floored at mainnet27
-- (20261108071848 Top Shot pull chain, 20261108164041 pack mint probes). This lane
-- still enqueues any unpriced pull whose open block is at/after the mainnet24 root
-- and posts the script to v_nodes[1..3] (mainnet24 with a pre-Cadence-1.0 variant).
-- No exposure today (0 pending/in-flight pins below the floor; 11 spork-1 pins sit
-- 'failed' with an old http 503 and are left as they are), but a re-ingest of old
-- opens would send every tick's requests to dead hosts and burn 6 attempts per pin.
--
-- WHAT (minimal; the arrays stay so the stored spork index 1..5 keeps its meaning):
--   * v_floor 130290659 (mainnet27 root): enqueue reads open_block >= v_floor (was
--     >= v_roots[1], the mainnet24 root), and dispatch groups only pins with
--     open_block >= v_floor -- so v_nodes[1..3] are unreachable.
--   * new step (0): a pending pin with open_block < v_floor is closed 'failed' with
--     "open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26
--     access nodes, so the block is not readable by any node (#181)", no request.
--     An in-flight one returns to pending when its error lands and closes next tick.
--     Counted as extra.retired_pre_mainnet27 (not a failure: ok unchanged).
--   * the pre-Cadence-1.0 script (v_src_pre; only mainnet24 executed it) is removed
--     with its node; every call carries the Cadence 1.0 script.
--
-- PIN: supabase/tests/run_pinnacle_pull_chain_lane.sql (re-based on mainnet27 /
--   mainnet28; new R1 - below-floor pins are closed / never enqueued, no request
--   URL names mainnet24-26, no call carries the pre-Cadence-1.0 script).
-- anon-exec: unchanged (run_pinnacle_pull_chain_lane) - CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- Revert: re-apply the run_pinnacle_pull_chain_lane body from
--   20260930010000_audit_20260929_pinnacle_pulls_named_by_reading_the_chain_at_the_open_block.sql
--   (pins closed by this step stay failed; re-open with
--    UPDATE pinnacle_pull_chain_pins SET status='pending', attempts=0, finished_at=NULL
--     WHERE last_error LIKE 'open block before 130290659%').

CREATE OR REPLACE FUNCTION public.run_pinnacle_pull_chain_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 10;
  v_max_att  constant int := 6;
  v_max_ids  constant int := 200;
  -- 2026-11-08: the mainnet27 root. Flow retired the mainnet24-26 access nodes
  -- (#181: no DNS record), so an open block before this height has no node that
  -- can read it. Such work is never enqueued or dispatched; a pending row is
  -- closed 'failed' with v_retired_msg. (Was the mainnet24 root, v_roots[1].)
  v_floor    constant bigint := 130290659;
  v_retired_msg constant text := 'open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the block is not readable by any node (#181)';
  -- mainnet24..27 roots/ends; 28 = current spork. The mainnet24-26 entries stay
  -- so the stored spork index (1..5) keeps its meaning; nothing below v_floor
  -- reaches v_nodes[1..3] any more.
  v_roots    constant bigint[] := ARRAY[65264619, 85981135, 88226267, 130290659, 137390146]::bigint[];
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145, 9223372036854775807]::bigint[];
  v_nodes    constant text[] := ARRAY['http://access-001.mainnet24.nodes.onflow.org:8070',
                                      'http://access-001.mainnet25.nodes.onflow.org:8070',
                                      'http://access-001.mainnet26.nodes.onflow.org:8070',
                                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                                      'https://rest-mainnet.onflow.org'];
  -- mainnet25..28 execute only Cadence 1.0 (probed 2026-09-29). The pre-Cadence-1.0 script only
  -- mainnet24 executed is removed with its node (#181).
  v_src_c1   constant text := 'import NonFungibleToken from 0x1d7e57aa55817448
import Pinnacle from 0xedf9df96c92f4595
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: Int} {
  let out: {UInt64: Int} = {}
  let col = getAccount(owner).capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(Pinnacle.CollectionPublicPath)
  if col == nil { return out }
  for id in ids { if let n = col!.borrowNFT(id) { if let p = n as? &Pinnacle.NFT { out[id] = p.editionID } } }
  return out
}';
  r record;
  v_body jsonb; v_req bigint; v_read text[]; v_all_read text[] := '{}'; v_n int;
  v_collected int := 0; v_reads_new int := 0; v_to_stage2 int := 0; v_missing int := 0;
  v_failed int := 0; v_throttled int := 0; v_expired int := 0; v_requeued_opens int := 0;
  v_enqueued int := 0; v_dispatched int := 0; v_retired int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_pull_chain_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) A pending pin whose open block is below the floor has no node to read it: close it as failed,
  -- saying why, never dispatch it. (An in-flight one returns to pending when its DNS failure lands and
  -- is closed on the next tick.)
  WITH ret AS (
    UPDATE public.pinnacle_pull_chain_pins
       SET status = 'failed', request_id = NULL, last_error = v_retired_msg,
           finished_at = coalesce(finished_at, now())
     WHERE status = 'pending' AND open_block < v_floor
    RETURNING 1
  )
  SELECT count(*) INTO v_retired FROM ret;

  -- (1) Collect every landed read (one pg_net request per group of pins).
  FOR r IN
    SELECT q.request_id, min(q.opener_address) AS opener_address, min(q.req_block) AS req_block,
           min(q.stage) AS stage, min(q.dispatched_at) AS dispatched_at, array_agg(q.nft_id) AS ids,
           min(h.status_code) AS h_status, min(h.content) AS h_content, min(h.error_msg) AS h_error,
           bool_or(h.id IS NOT NULL) AS landed
      FROM public.pinnacle_pull_chain_pins q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.status = 'in_flight'
     GROUP BY q.request_id
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_pull_chain_pins
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;

    -- a 200 carries a JSON string: base64 of the JSON-Cadence result
    v_body := NULL;
    IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
      BEGIN
        v_body := convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
      EXCEPTION WHEN others THEN
        v_body := NULL;
      END;
    END IF;

    IF v_body IS NULL OR v_body->>'type' IS DISTINCT FROM 'Dictionary' THEN
      IF r.h_status = 429 THEN
        -- the node's throttle, not a wrong read: retried without counting an attempt
        UPDATE public.pinnacle_pull_chain_pins SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_pull_chain_pins
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE request_id = r.request_id AND status = 'in_flight';
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    WITH kv AS (
      SELECT e->'key'->>'value' AS nft_id, (e->'value'->>'value')::int AS edition_id
        FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) e
    ), ins AS (
      INSERT INTO public.pinnacle_pull_chain_reads (nft_id, edition_id, owner_address, block_height)
      SELECT kv.nft_id, kv.edition_id, r.opener_address, r.req_block
        FROM kv
       WHERE kv.nft_id = ANY (r.ids) AND kv.edition_id IS NOT NULL
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins),
           (SELECT array_agg(kv.nft_id) FROM kv WHERE kv.nft_id = ANY (r.ids) AND kv.edition_id IS NOT NULL)
      INTO v_n, v_read;
    v_reads_new := v_reads_new + v_n;
    v_read := coalesce(v_read, '{}'::text[]);

    UPDATE public.pinnacle_pull_chain_pins
       SET status = 'read', finished_at = now(), request_id = NULL, last_error = NULL
     WHERE request_id = r.request_id AND status = 'in_flight' AND nft_id = ANY (v_read);
    -- not held at the group's block: sold in between -> read it at its own open block
    WITH s2 AS (
      UPDATE public.pinnacle_pull_chain_pins
         SET stage = 2, status = 'pending', request_id = NULL, last_error = NULL
       WHERE request_id = r.request_id AND status = 'in_flight' AND stage = 1
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM s2;
    v_to_stage2 := v_to_stage2 + v_n;
    -- not held even at its own open block: nothing more this lane can read
    WITH ms AS (
      UPDATE public.pinnacle_pull_chain_pins
         SET status = 'missing', finished_at = now(), request_id = NULL
       WHERE request_id = r.request_id AND status = 'in_flight' AND stage = 2
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM ms;
    v_missing := v_missing + v_n;

    v_all_read := v_all_read || v_read;
  END LOOP;

  -- the pricer re-tries the opens holding a pin read this tick on its next run (one scan, not one per read)
  IF cardinality(v_all_read) > 0 THEN
    WITH rq AS (
      UPDATE public.pinnacle_pack_opens o SET priced_at = NULL
       WHERE o.pull_value_usd IS NULL AND o.priced_at IS NOT NULL AND o.nft_ids && v_all_read
      RETURNING 1
    )
    SELECT count(*) INTO v_requeued_opens FROM rq;
  END IF;

  -- (2) Enqueue (every 10 minutes, or when nothing is pending): every pull of an unpriced open that has an
  -- opener and an open block on a reachable spork, with no mint event, no chain read and no queue row.
  IF extract(minute FROM now())::int % 10 = 0
     OR NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins WHERE status = 'pending') THEN
    WITH c AS (
      SELECT DISTINCT ON (u.nft_id) u.nft_id, o.opener_address, o.open_block,
             (SELECT min(i) FROM generate_subscripts(v_ends, 1) i WHERE v_ends[i] >= o.open_block) AS sp
        FROM public.pinnacle_pack_opens o
        CROSS JOIN LATERAL unnest(o.nft_ids) AS u(nft_id)
       WHERE o.pull_value_usd IS NULL AND o.moments_pulled > 0
         AND o.opener_address IS NOT NULL AND o.open_block >= v_floor
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_mint_events m WHERE m.nft_id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_reads cr WHERE cr.nft_id = u.nft_id)
         AND NOT EXISTS (SELECT 1 FROM public.pinnacle_pull_chain_pins q WHERE q.nft_id = u.nft_id)
       ORDER BY u.nft_id, o.open_block
    ), ins AS (
      INSERT INTO public.pinnacle_pull_chain_pins (nft_id, opener_address, open_block, spork)
      SELECT c.nft_id, c.opener_address, c.open_block, c.sp FROM c WHERE c.sp IS NOT NULL
      ON CONFLICT (nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch: pending pins grouped per call — stage 1 by (opener, ~1 day of blocks), stage 2 by
  -- (opener, open block) — read at the group's LAST open block, <= v_max_ids ids a call, <= v_per_node
  -- calls per spork node, saved/seeded wallets' openers first.
  FOR r IN
    SELECT * FROM (
      SELECT g.*, row_number() OVER (PARTITION BY g.spork ORDER BY g.prio DESC, g.blk DESC) AS rn
        FROM (
          SELECT q.spork, q.stage, q.opener_address,
                 CASE WHEN q.stage = 1 THEN q.open_block / 100000 ELSE q.open_block END AS grp,
                 (q.rn - 1) / v_max_ids AS chunk,
                 max(q.open_block) AS blk, array_agg(q.nft_id ORDER BY q.nft_id) AS ids,
                 bool_or(EXISTS (SELECT 1 FROM public.seeded_wallets s
                                  WHERE s.is_active AND lower(s.wallet_address) = q.opener_address)
                      OR EXISTS (SELECT 1 FROM public.saved_wallets w
                                  WHERE lower(w.wallet_addr) = q.opener_address)) AS prio
            FROM (
              SELECT p.*, row_number() OVER (
                       PARTITION BY p.spork, p.stage, p.opener_address,
                                    CASE WHEN p.stage = 1 THEN p.open_block / 100000 ELSE p.open_block END
                       ORDER BY p.nft_id) AS rn
                FROM public.pinnacle_pull_chain_pins p
               WHERE p.status = 'pending' AND p.open_block >= v_floor
            ) q
           GROUP BY 1, 2, 3, 4, 5
        ) g
    ) z WHERE z.rn <= v_per_node
  LOOP
    SELECT net.http_post(
      url := v_nodes[r.spork] || '/v1/scripts?block_height=' || r.blk,
      body := jsonb_build_object(
        'script', translate(encode(convert_to(v_src_c1, 'UTF8'), 'base64'), E'\n', ''),
        'arguments', jsonb_build_array(
          translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', r.opener_address)::text, 'UTF8'), 'base64'), E'\n', ''),
          translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
            (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i)) FROM unnest(r.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
      params := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_pull_chain_pins
       SET status = 'in_flight', request_id = v_req, req_block = r.blk, dispatched_at = now()
     WHERE nft_id = ANY (r.ids) AND status = 'pending';
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-pull-chain', v_started, v_collected, v_reads_new, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('reads_new', v_reads_new, 'to_stage2', v_to_stage2, 'missing', v_missing,
                       'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                       'requeued_opens', v_requeued_opens, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
                       'retired_pre_mainnet27', v_retired));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'reads_new', v_reads_new,
                            'to_stage2', v_to_stage2, 'missing', v_missing, 'failed', v_failed,
                            'throttled', v_throttled, 'expired', v_expired, 'requeued_opens', v_requeued_opens,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'retired_pre_mainnet27', v_retired,
                            'last_error', v_last_error);
END;
$function$;
