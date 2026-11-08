-- DB invariant: public.run_pinnacle_pull_chain_lane — Disney Pinnacle pack pulls named by reading each pin's
-- editionID on chain at the open block (added 2026-09-29: 55,283 unpriced opens held a pull no source named).
-- Claims:
--   E1. Queued: every pull of an UNPRICED open with an opener and an open block at/after the mainnet27 root
--       (130290659; the mainnet24 root until 2026-11-08), with no mint event and no chain read — never a
--       priced open's, an opener-less one's, a pre-floor one's.
--       The spork index is the node the block lives on (1 = mainnet24 .. 5 = current).
--   D1. Stage 1 groups one opener's pins by open_block / 100000 into ONE call at the group's LAST open block,
--       on that spork's node, with the Cadence 1.0 script (the pre-Cadence-1.0 one left with mainnet24).
--   D2. <= 10 calls per node per tick; a saved/seeded wallet's opener goes first.
--   C1. A read lands: returned pins -> pinnacle_pull_chain_reads (edition, opener, height) and 'read'; a pin
--       not returned at a stage-1 block -> stage 2 (its own open block); the read pins' unpriced opens get
--       priced_at = NULL so the pricer retries them.
--       A pin in the answer that the call did not ask about is ignored.
--   C2. Not returned at stage 2 either -> 'missing'.
--   H1. A 429 is a free retry; another error counts an attempt and reports ok=false; the 6th -> 'failed'.
--   R1. (2026-11-08, #181) Nothing below the mainnet27 root is enqueued or dispatched: a pending pin there
--       is closed 'failed' with the #181 reason and no request; an in-flight one is closed once its error
--       lands; no request URL names mainnet24-26 and no call carries the pre-Cadence-1.0 script.
--   (Re-based 2026-11-08 from mainnet24-26 heights onto mainnet27 / mainnet28.)
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261108171820_audit_20261108_run_pinnacle_pull_chain_lane_floor_at_mainnet27.sql).
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
BEGIN INSERT INTO net.calls VALUES (v, url, body); INSERT INTO net.all_calls VALUES (v, url, body); RETURN v; END $$;
CREATE TABLE net.all_calls (id bigint, url text, body jsonb);   -- never cleared: R1 checks every call made
-- a 200 body as the REST API returns it: a JSON string of base64 JSON-Cadence
CREATE FUNCTION pg_temp.ok_body(pairs text) RETURNS text LANGUAGE sql AS $$
  SELECT to_jsonb(translate(encode(convert_to('{"value":[' || pairs || '],"type":"Dictionary"}', 'UTF8'), 'base64'), E'\n', ''))::text $$;
CREATE FUNCTION pg_temp.kv(id text, ed int) RETURNS text LANGUAGE sql AS $$
  SELECT '{"key":{"value":"' || id || '","type":"UInt64"},"value":{"value":"' || ed || '","type":"Int"}}' $$;
CREATE FUNCTION pg_temp.script_of(b jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT convert_from(decode(b->>'script', 'base64'), 'UTF8') $$;
CREATE FUNCTION pg_temp.ids_of(b jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(x->>'value', ',' ORDER BY x->>'value')
    FROM jsonb_array_elements(convert_from(decode(b->'arguments'->>1, 'base64'), 'UTF8')::jsonb->'value') x $$;

CREATE TABLE public.pinnacle_pack_opens (
  pack_nft_id text PRIMARY KEY, opener_address text, open_block bigint, nft_ids text[], moments_pulled int,
  pull_value_usd numeric, priced_at timestamptz);
CREATE TABLE public.pinnacle_mint_events (nft_id text PRIMARY KEY);
CREATE TABLE public.seeded_wallets (wallet_address text, is_active boolean);
CREATE TABLE public.saved_wallets (wallet_addr text);
CREATE TABLE IF NOT EXISTS public.pinnacle_pull_chain_reads (
  nft_id         text PRIMARY KEY,
  edition_id     int NOT NULL,
  owner_address  text NOT NULL,
  block_height   bigint NOT NULL,
  read_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pinnacle_pull_chain_pins (
  nft_id          text PRIMARY KEY,
  opener_address  text NOT NULL,
  open_block      bigint NOT NULL,
  spork           int NOT NULL,   -- node index 1..5 = mainnet24..28 (as pinnacle_opener_windows.spork)
  stage           smallint NOT NULL DEFAULT 1 CHECK (stage IN (1, 2)),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'read', 'missing', 'failed')),
  request_id      bigint,
  req_block       bigint,
  attempts        int NOT NULL DEFAULT 0,
  dispatched_at   timestamptz,
  finished_at     timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- >>> BEGIN verbatim run_pinnacle_pull_chain_lane (body byte-identical to the migration) >>>
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
-- <<< END verbatim run_pinnacle_pull_chain_lane <<<

-- ── fixtures ──────────────────────────────────────────────────────────────────
-- 0xa: two pins in one ~day on mainnet27 (one stage-1 call at the later block); 0xb: one pin on mainnet28.
-- Not queued: a minted pin, an already-read pin, a priced open, an opener-less open, a pre-floor open
-- (mainnet26: no node reads it since #181).
-- R1: p_old, a pending pin on mainnet26 queued before the floor -> closed, never dispatched.
INSERT INTO public.pinnacle_mint_events VALUES ('p_minted');
INSERT INTO public.pinnacle_pull_chain_reads (nft_id, edition_id, owner_address, block_height) VALUES ('p_read', 7, '0xa', 131000000);
INSERT INTO public.pinnacle_pack_opens VALUES
  ('A1', '0xa', 131000010, ARRAY['p1'], 1, NULL, now() - interval '1 hour'),
  ('A2', '0xa', 131000050, ARRAY['p2'], 1, NULL, now() - interval '1 hour'),
  ('B1', '0xb', 140000000, ARRAY['p3'], 1, NULL, NULL),
  ('M1', '0xa', 131000060, ARRAY['p_minted'], 1, NULL, NULL),
  ('R1', '0xa', 131000070, ARRAY['p_read'], 1, NULL, NULL),
  ('P1', '0xa', 131000080, ARRAY['p_priced'], 1, 12.5, now()),
  ('N1', NULL,  131000090, ARRAY['p_noopener'], 1, NULL, NULL),
  ('F1', '0xa', 100000000, ARRAY['p_prefloor'], 1, NULL, NULL),
  ('O1', '0xo', 100000500, ARRAY['p_old'], 1, NULL, NULL);
INSERT INTO public.pinnacle_pull_chain_pins (nft_id, opener_address, open_block, spork) VALUES ('p_old', '0xo', 100000500, 3);

SELECT public.run_pinnacle_pull_chain_lane();

-- ── E1 ────────────────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT string_agg(nft_id, ',' ORDER BY nft_id) FROM pinnacle_pull_chain_pins WHERE nft_id <> 'p_old'), 'p1,p2,p3',
  'E1: only unpriced, opener-known, post-floor, unminted, unread pulls are queued');
SELECT _assert_eq((SELECT string_agg(nft_id || ':' || spork, ',' ORDER BY nft_id) FROM pinnacle_pull_chain_pins WHERE nft_id <> 'p_old'), 'p1:4,p2:4,p3:5',
  'E1: spork index = the node the open block lives on');
-- ── R1 ────────────────────────────────────────────────────────────────────────
SELECT _assert((SELECT status = 'failed' AND request_id IS NULL AND finished_at IS NOT NULL
                       AND last_error LIKE 'open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes%(#181)'
                  FROM pinnacle_pull_chain_pins WHERE nft_id = 'p_old'),
  'R1: a pending pin below the floor is closed failed with the #181 reason');
SELECT _assert((SELECT (extra->>'retired_pre_mainnet27')::int = 1 AND ok FROM pipeline_runs_stub ORDER BY ctid DESC LIMIT 1),
  'R1: retired counted, and not a failure');
-- ── D1 ────────────────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM net.calls), '2', 'D1: one call per (opener, ~day) group');
SELECT _assert_eq((SELECT url FROM net.calls WHERE pg_temp.ids_of(body) = 'p1,p2'),
  'http://access-001.mainnet27.nodes.onflow.org:8070/v1/scripts?block_height=131000050',
  'D1: 0xa''s two pins go in ONE mainnet27 call at the group''s last open block');
SELECT _assert((SELECT pg_temp.script_of(body) LIKE '%access(all) fun main%' FROM net.calls WHERE pg_temp.ids_of(body) = 'p1,p2'),
  'D1: mainnet27 gets the Cadence 1.0 script');
SELECT _assert((SELECT pg_temp.script_of(body) LIKE '%access(all) fun main%' AND url = 'https://rest-mainnet.onflow.org/v1/scripts?block_height=140000000'
                  FROM net.calls WHERE pg_temp.ids_of(body) = 'p3'),
  'D1: mainnet28 (rest-mainnet) gets the Cadence 1.0 script at the pin''s block');
SELECT _assert((SELECT bool_and(status = 'in_flight' AND request_id IS NOT NULL) FROM pinnacle_pull_chain_pins WHERE nft_id <> 'p_old'), 'D1: dispatched pins are in flight');

-- ── C1 / C2 ───────────────────────────────────────────────────────────────────
-- 0xa held p1 at 131000050 but not p2 (sold in between); 0xb held p3.
INSERT INTO net._http_response
SELECT id, 200, pg_temp.ok_body(pg_temp.kv('p1', 11)), NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'p1,p2';
INSERT INTO net._http_response
SELECT id, 200, pg_temp.ok_body(pg_temp.kv('p3', 33) || ',' || pg_temp.kv('p_unasked', 44)), NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'p3';
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert_eq((SELECT string_agg(nft_id || '=' || edition_id || '@' || owner_address || '/' || block_height, ',' ORDER BY nft_id)
                     FROM pinnacle_pull_chain_reads WHERE nft_id <> 'p_read'),
  'p1=11@0xa/131000050,p3=33@0xb/140000000', 'C1: returned pins land as reads with owner and height');
SELECT _assert_eq((SELECT status FROM pinnacle_pull_chain_pins WHERE nft_id = 'p1'), 'read', 'C1: p1 read');
SELECT _assert((SELECT NOT EXISTS (SELECT 1 FROM pinnacle_pull_chain_reads WHERE nft_id = 'p_unasked')), 'C1: a pin the call did not ask about is never stored');
SELECT _assert((SELECT stage = 2 FROM pinnacle_pull_chain_pins WHERE nft_id = 'p2'), 'C1: p2 (not held at the group block) -> stage 2');
SELECT _assert((SELECT priced_at IS NULL FROM pinnacle_pack_opens WHERE pack_nft_id = 'A1'), 'C1: the read pin''s open is re-queued for the pricer');
SELECT _assert((SELECT priced_at IS NOT NULL FROM pinnacle_pack_opens WHERE pack_nft_id = 'A2'), 'C1: an unread pin''s open is left alone');
SELECT _assert_eq((SELECT url FROM net.calls WHERE pg_temp.ids_of(body) = 'p2'),
  'http://access-001.mainnet27.nodes.onflow.org:8070/v1/scripts?block_height=131000050',
  'C1: stage 2 reads p2 at ITS OWN open block');
-- stage 2 does not find it either
INSERT INTO net._http_response SELECT id, 200, pg_temp.ok_body(''), NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'p2';
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert_eq((SELECT status FROM pinnacle_pull_chain_pins WHERE nft_id = 'p2'), 'missing', 'C2: not held at its own open block -> missing');
SELECT _assert((SELECT ok FROM pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'C2: a clean tick reports ok');

-- ── H1 ────────────────────────────────────────────────────────────────────────
INSERT INTO public.pinnacle_pack_opens VALUES ('H1', '0xh', 135000000, ARRAY['h1'], 1, NULL, NULL),
                                             ('H2', '0xi', 135000000, ARRAY['h2'], 1, NULL, NULL);
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
INSERT INTO net._http_response SELECT id, 429, 'slow down', NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'h1';
INSERT INTO net._http_response SELECT id, 500, 'boom', NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'h2';
UPDATE public.pinnacle_pull_chain_pins SET attempts = 4 WHERE nft_id = 'h2';
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert((SELECT attempts = 0 FROM pinnacle_pull_chain_pins WHERE nft_id = 'h1'), 'H1: a 429 costs no attempt');
SELECT _assert((SELECT attempts = 5 AND status = 'in_flight' FROM pinnacle_pull_chain_pins WHERE nft_id = 'h2'), 'H1: an error counts an attempt and is retried');
SELECT _assert((SELECT NOT ok FROM pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'H1: an error tick reports ok=false');
INSERT INTO net._http_response SELECT id, 500, 'boom', NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'h2';
INSERT INTO net._http_response SELECT id, 200, pg_temp.ok_body(pg_temp.kv('h1', 5)), NULL FROM net.calls WHERE pg_temp.ids_of(body) = 'h1';
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert_eq((SELECT status FROM pinnacle_pull_chain_pins WHERE nft_id = 'h2'), 'failed', 'H1: the 6th failure -> failed');
SELECT _assert_eq((SELECT status FROM pinnacle_pull_chain_pins WHERE nft_id = 'h1'), 'read', 'H1: the throttled pin is read on its retry');

-- ── D2 ────────────────────────────────────────────────────────────────────────
-- 12 openers on mainnet27, one of them a seeded wallet: 10 calls, the seeded opener among them.
INSERT INTO public.seeded_wallets VALUES ('0xseed', true);
INSERT INTO public.pinnacle_pack_opens
SELECT 'D' || g, CASE WHEN g = 12 THEN '0xseed' ELSE '0xd' || g END, 136000000 - g * 100000, ARRAY['d' || g], 1, NULL, NULL
  FROM generate_series(1, 12) g;
DELETE FROM net.calls;
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert_eq((SELECT count(*)::text FROM net.calls WHERE url LIKE '%mainnet27%'), '10', 'D2: <= 10 calls per node per tick');
SELECT _assert((SELECT status = 'in_flight' FROM pinnacle_pull_chain_pins WHERE nft_id = 'd12'),
  'D2: the seeded wallet''s opener goes first although its block is the oldest');

-- ── R1 (in flight) ────────────────────────────────────────────────────────────
-- a pin already in flight to a retired node when the floor lands: its DNS failure returns it to pending,
-- it is not re-dispatched, and the next tick closes it with the #181 reason.
INSERT INTO public.pinnacle_pull_chain_pins (nft_id, opener_address, open_block, spork, status, request_id, req_block, dispatched_at)
VALUES ('p_inflight', '0xq', 86000000, 2, 'in_flight', 900, 86000000, now());
INSERT INTO net._http_response VALUES (900, NULL, NULL, 'Couldn''t resolve host name');
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert((SELECT status = 'pending' AND request_id IS NULL FROM pinnacle_pull_chain_pins WHERE nft_id = 'p_inflight'),
  'R1: an in-flight pin below the floor is collected but not re-dispatched');
SELECT public.run_pinnacle_pull_chain_lane();
SELECT _assert((SELECT status = 'failed' AND last_error LIKE 'open block before 130290659%(#181)'
                  FROM pinnacle_pull_chain_pins WHERE nft_id = 'p_inflight'),
  'R1: ... and the next tick closes it with the #181 reason');
SELECT _assert((SELECT (extra->>'retired_pre_mainnet27')::int = 1 FROM pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'R1: counted as retired');
-- over every call this file made
SELECT _assert((SELECT count(*) > 0 FROM net.all_calls), 'R1: the call log is not empty (positive control)');
SELECT _assert((SELECT count(*) = 0 FROM net.all_calls WHERE url ~ 'mainnet2[456]'), 'R1: no request to a retired node');
SELECT _assert((SELECT count(*) = 0 FROM net.all_calls WHERE pg_temp.script_of(body) LIKE '%pub fun main%'), 'R1: no call carries the pre-Cadence-1.0 script');

SELECT '✓ run_pinnacle_pull_chain_lane: all assertions passed' AS result;

ROLLBACK;
