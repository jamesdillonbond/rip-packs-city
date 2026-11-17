-- DB invariant: public.run_chain_arrival_flip_lane — a sold moment delivered
-- and sold inside the sold seed's 100-block margin is found by reading the
-- events up to the sale. Added 2026-10-03 (Rigged: 88 of 88 such probes were
-- custodial pulls from 0xe1f2... sold 28-100 blocks after delivery).
-- Claims:
--   Q1. Enqueue takes a done, sender-less 'no TopShot.Withdraw' probe whose
--       wallet SOLD the id with the seed's signature (0 <= estimate - hi <= 200)
--       and reads (hi, least(estimate + 80, hi + 250, spork end)] on the node
--       serving hi + 1. Any other candidate is recorded 'skipped' once.
--   C1. The sale is the wallet's own FIRST withdraw in the window; the delivery
--       is the LAST withdraw by anyone else strictly BEFORE it -- a hand-off by
--       the buyer AFTER the sale is never taken. The probe gets the sender, tx,
--       height and time.
--   C2. No sale in the window -> 'sale_not_in_window'; a sale with nothing
--       before it -> 'no_delivery_before_sale'; the probe is untouched either way.
--   C3. A 429 is a free retry; any other error counts an attempt, ok=false.
--   C4. A probe that already has a sender is never overwritten.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261003160000_audit_20261003_chain_arrival_flips_read_past_the_sale_margin.sql).
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;
-- a fixed-rate stand-in: height = seconds since 2025-01-01 + 100,000,000
CREATE FUNCTION public.flow_height_estimate(p_at timestamptz) RETURNS bigint LANGUAGE sql AS $$
  SELECT 100000000 + extract(epoch FROM p_at - timestamptz '2025-01-01 00:00:00+00')::bigint $$;

CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, url text);
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url); RETURN v; END $$;

CREATE TABLE public.chain_arrival_probes (
  wallet text NOT NULL, nft_id bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL,
  status text NOT NULL DEFAULT 'bisect', request_id bigint, attempts int NOT NULL DEFAULT 0,
  arrived_height bigint, arrived_at timestamptz, tx_id text, from_address text, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, PRIMARY KEY (wallet, nft_id));
CREATE TABLE public.sales (nft_id text, collection_id uuid, seller_address text, sold_at timestamptz,
  block_height bigint, transaction_hash text);

CREATE TABLE IF NOT EXISTS public.chain_arrival_flip_reads (
  wallet        text NOT NULL,
  nft_id        bigint NOT NULL,
  lo            bigint,
  hi            bigint,
  sale_est      bigint,
  sale_tx       text,
  node          text,
  request_id    bigint,
  attempts      int NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'skipped')),
  result        text,
  sale_height   bigint,
  sale_tx_read  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  finished_at   timestamptz,
  PRIMARY KEY (wallet, nft_id)
);

-- >>> BEGIN verbatim run_chain_arrival_flip_lane (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_chain_arrival_flip_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_ts       constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_per_node constant int := 20;
  v_max_att  constant int := 6;
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145]::bigint[];
  r record;
  v_sale record; v_arr record;
  v_collected int := 0; v_found int := 0; v_no_sale int := 0; v_no_delivery int := 0;
  v_tx_match int := 0; v_throttled int := 0; v_failed int := 0; v_expired int := 0;
  v_enqueued int := 0; v_skipped int := 0; v_dispatched int := 0; v_n int;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_chain_arrival_flip_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect landed reads.
  FOR r IN
    SELECT f.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error
      FROM public.chain_arrival_flip_reads f
      JOIN net._http_response h ON h.id = f.request_id
     WHERE f.status = 'pending'
  LOOP
    v_collected := v_collected + 1;
    IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
       AND jsonb_typeof(r.h_content::jsonb) = 'array' THEN
      CREATE TEMP TABLE IF NOT EXISTS _flip_w (bh bigint, bt timestamptz, tx text, ei int, mid bigint, sender text) ON COMMIT DROP;
      TRUNCATE _flip_w;
      INSERT INTO _flip_w
      SELECT (b->>'block_height')::bigint, (b->>'block_timestamp')::timestamptz,
             e->>'transaction_id', (e->>'event_index')::int,
             (SELECT (x->'value'->>'value')::bigint FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'id'),
             (SELECT coalesce(x->'value'->'value'->>'value', x->'value'->>'value')
                FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'from')
        FROM jsonb_array_elements(r.h_content::jsonb) b
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
        CROSS JOIN LATERAL (SELECT convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl) p
       WHERE convert_from(decode(e->>'payload', 'base64'), 'UTF8') LIKE '%"' || r.nft_id || '"%';

      -- the sale: the wallet's own FIRST withdraw of the id in the window
      SELECT bh, ei, tx INTO v_sale FROM _flip_w
       WHERE mid = r.nft_id AND sender = r.wallet ORDER BY bh, ei LIMIT 1;
      IF NOT FOUND THEN
        UPDATE public.chain_arrival_flip_reads SET status = 'done', result = 'sale_not_in_window',
               request_id = NULL, finished_at = now()
         WHERE wallet = r.wallet AND nft_id = r.nft_id;
        v_no_sale := v_no_sale + 1;
      ELSE
        -- the delivery: the LAST withdraw by anyone else strictly before the sale
        SELECT bh, bt, tx, sender INTO v_arr FROM _flip_w
         WHERE mid = r.nft_id AND sender IS DISTINCT FROM r.wallet AND (bh, ei) < (v_sale.bh, v_sale.ei)
         ORDER BY bh DESC, ei DESC LIMIT 1;
        v_n := CASE WHEN FOUND THEN 1 ELSE 0 END;
        IF v_sale.tx = r.sale_tx THEN v_tx_match := v_tx_match + 1; END IF;
        IF v_n = 0 THEN
          UPDATE public.chain_arrival_flip_reads SET status = 'done', result = 'no_delivery_before_sale',
                 sale_height = v_sale.bh, sale_tx_read = v_sale.tx, request_id = NULL, finished_at = now()
           WHERE wallet = r.wallet AND nft_id = r.nft_id;
          v_no_delivery := v_no_delivery + 1;
        ELSE
          UPDATE public.chain_arrival_probes p
             SET arrived_height = v_arr.bh, arrived_at = v_arr.bt, tx_id = v_arr.tx,
                 from_address = v_arr.sender, last_error = NULL, finished_at = now()
           WHERE p.wallet = r.wallet AND p.nft_id = r.nft_id
             AND p.status = 'done' AND p.from_address IS NULL;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          UPDATE public.chain_arrival_flip_reads
             SET status = 'done', result = CASE WHEN v_n = 1 THEN 'found' ELSE 'found_probe_changed' END,
                 sale_height = v_sale.bh, sale_tx_read = v_sale.tx, request_id = NULL, finished_at = now()
           WHERE wallet = r.wallet AND nft_id = r.nft_id;
          v_found := v_found + v_n;
        END IF;
      END IF;
    ELSIF r.h_status IN (429, 503) THEN
      UPDATE public.chain_arrival_flip_reads SET request_id = NULL, result = 'http ' || r.h_status
       WHERE wallet = r.wallet AND nft_id = r.nft_id;
      v_throttled := v_throttled + 1;
    ELSE
      v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
      UPDATE public.chain_arrival_flip_reads
         SET request_id = NULL, attempts = attempts + 1, result = v_last_error,
             status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE status END,
             finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
       WHERE wallet = r.wallet AND nft_id = r.nft_id;
      v_failed := v_failed + 1;
    END IF;
  END LOOP;

  -- a read that never landed (pg_net drops responses after its TTL)
  UPDATE public.chain_arrival_flip_reads f
     SET request_id = NULL, attempts = attempts + 1, result = 'no_response',
         status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE status END
   WHERE f.status = 'pending' AND f.request_id IS NOT NULL
     AND f.dispatched_at < now() - interval '30 minutes'
     AND NOT EXISTS (SELECT 1 FROM net._http_response h WHERE h.id = f.request_id);
  GET DIAGNOSTICS v_expired = ROW_COUNT;

  -- (2) Enqueue: every candidate once; the sold-seed signature gets a window,
  -- the rest are recorded 'skipped' so a tick never re-probes sales for them.
  WITH cand AS (
    SELECT p.wallet, p.nft_id, p.hi
      FROM public.chain_arrival_probes p
     WHERE p.status = 'done' AND p.from_address IS NULL
       AND p.last_error LIKE 'no TopShot.Withdraw%'
       AND NOT EXISTS (SELECT 1 FROM public.chain_arrival_flip_reads f
                        WHERE f.wallet = p.wallet AND f.nft_id = p.nft_id)
  ), sold AS (
    SELECT c.wallet, c.nft_id, c.hi, s.tx,
           coalesce(s.block_height, public.flow_height_estimate(s.sold_at)) AS est
      FROM cand c
      LEFT JOIN LATERAL (
        SELECT s.block_height, s.sold_at, s.transaction_hash AS tx
          FROM public.sales s
         WHERE s.nft_id = c.nft_id::text AND s.collection_id = v_ts
           AND s.seller_address = c.wallet AND s.sold_at > timestamptz '2023-11-09'
         ORDER BY s.sold_at LIMIT 1
      ) s ON true
  ), win AS (
    SELECT so.*, (so.est IS NOT NULL AND so.est - so.hi BETWEEN 0 AND 200) AS ok,
           least(so.est + 80, so.hi + 250,
                 coalesce((SELECT min(e) FROM unnest(v_ends) e WHERE e >= so.hi + 1), so.hi + 250)) AS w_hi
      FROM sold so
  ), ins AS (
    INSERT INTO public.chain_arrival_flip_reads (wallet, nft_id, lo, hi, sale_est, sale_tx, node, status, result, finished_at)
    SELECT w.wallet, w.nft_id, w.hi, CASE WHEN w.ok THEN w.w_hi END, w.est, w.tx,
           CASE WHEN NOT w.ok THEN NULL
                WHEN w.hi + 1 <= 85981134  THEN 'http://access-001.mainnet24.nodes.onflow.org:8070'
                WHEN w.hi + 1 <= 88226266  THEN 'http://access-001.mainnet25.nodes.onflow.org:8070'
                WHEN w.hi + 1 <= 130290658 THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                WHEN w.hi + 1 <= 137390145 THEN 'http://access-001.mainnet27.nodes.onflow.org:8070'
                ELSE 'https://rest-mainnet.onflow.org' END,
           CASE WHEN w.ok THEN 'pending' ELSE 'skipped' END,
           CASE WHEN w.ok THEN NULL WHEN w.est IS NULL THEN 'not_sold_by_wallet' ELSE 'not_the_sold_seed_margin' END,
           CASE WHEN w.ok THEN NULL ELSE now() END
      FROM win w
    ON CONFLICT (wallet, nft_id) DO NOTHING
    RETURNING status
  )
  SELECT count(*) FILTER (WHERE status = 'pending'), count(*) FILTER (WHERE status = 'skipped')
    INTO v_enqueued, v_skipped FROM ins;

  -- (3) Dispatch <= v_per_node reads per node.
  FOR r IN
    SELECT f.wallet, f.nft_id, f.lo, f.hi, f.node
      FROM (SELECT f.*, row_number() OVER (PARTITION BY f.node ORDER BY f.attempts, f.created_at, f.wallet, f.nft_id) AS rn
              FROM public.chain_arrival_flip_reads f
             WHERE f.status = 'pending' AND f.request_id IS NULL) f
     WHERE f.rn <= v_per_node
  LOOP
    UPDATE public.chain_arrival_flip_reads
       SET request_id = net.http_get(
             url := r.node || '/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=' || (r.lo + 1) || '&end_height=' || r.hi,
             timeout_milliseconds := 30000),
           dispatched_at = now()
     WHERE wallet = r.wallet AND nft_id = r.nft_id;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'chain-arrival-flips', v_started,
    v_collected, v_found, v_no_sale + v_no_delivery,
    (v_failed = 0), v_last_error,
    'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'found', v_found, 'sale_not_in_window', v_no_sale,
                       'no_delivery_before_sale', v_no_delivery, 'sale_tx_match', v_tx_match,
                       'throttled', v_throttled, 'failed', v_failed, 'expired', v_expired,
                       'enqueued', v_enqueued, 'skipped', v_skipped, 'dispatched', v_dispatched)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'found', v_found,
                            'sale_not_in_window', v_no_sale, 'no_delivery_before_sale', v_no_delivery,
                            'sale_tx_match', v_tx_match, 'throttled', v_throttled, 'failed', v_failed,
                            'expired', v_expired, 'enqueued', v_enqueued, 'skipped', v_skipped,
                            'dispatched', v_dispatched, 'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<

-- fixtures: wallet W; heights are 100,000,000 + seconds into 2025
--   1  sold at +10,000 s (estimate 100,010,000), seeded hi = 100,009,900, no withdraw
--   2  same shape; the window holds the sale but nothing before it
--   3  same shape; the window holds no sale at all
--   4  same shape; 429 first, then found
--   5  sold, but hi is NOT the seed's margin (estimate - hi = 5,000) -> skipped
--   6  never sold by the wallet -> skipped
--   7  already has a sender -> not a candidate
--   8  sold with an exact block_height; the window is hi + 250 capped by the
--      estimate + 80 -> (hi, block_height + 80]
CREATE FUNCTION pg_temp.probe(p_id bigint, p_hi bigint, p_from text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.chain_arrival_probes (wallet, nft_id, lo, hi, status, from_address, last_error)
  VALUES ('0x00000000000000aa', p_id, p_hi - 1, p_hi, 'done', p_from,
          CASE WHEN p_from IS NULL THEN 'no TopShot.Withdraw in (lo, hi]: minted in or unread' END) $$;
CREATE FUNCTION pg_temp.sale(p_id bigint, p_at timestamptz, p_tx text, p_bh bigint DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.sales VALUES (p_id::text, '95f28a17-224a-4025-96ad-adf8a4c63bfd', '0x00000000000000aa', p_at, p_bh, p_tx) $$;
CREATE FUNCTION pg_temp.req_of(p_id bigint) RETURNS bigint LANGUAGE sql AS $$
  SELECT request_id FROM public.chain_arrival_flip_reads WHERE wallet = '0x00000000000000aa' AND nft_id = p_id $$;
CREATE FUNCTION pg_temp.wd(p_id bigint, p_from text, p_tx text, p_idx int) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('type', 'A.0b2a3299cc857e29.TopShot.Withdraw', 'transaction_id', p_tx, 'event_index', p_idx::text,
    'payload', translate(encode(convert_to(jsonb_build_object('type', 'Event', 'value', jsonb_build_object(
      'id', 'A.0b2a3299cc857e29.TopShot.Withdraw', 'fields', jsonb_build_array(
        jsonb_build_object('name', 'id', 'value', jsonb_build_object('type', 'UInt64', 'value', p_id::text)),
        jsonb_build_object('name', 'from', 'value', jsonb_build_object('type', 'Optional',
          'value', jsonb_build_object('type', 'Address', 'value', p_from)))))) ::text, 'UTF8'), 'base64'), E'\n', '')) $$;
CREATE FUNCTION pg_temp.blk(p_h bigint, p_events jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('block_height', p_h::text, 'block_timestamp',
    to_char((timestamptz '2025-01-01 00:00:00+00' + (p_h - 100000000) * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'events', p_events) $$;

SELECT pg_temp.probe(1, 100009900), pg_temp.probe(2, 100009900), pg_temp.probe(3, 100009900), pg_temp.probe(4, 100009900),
       pg_temp.probe(5, 100005000), pg_temp.probe(6, 100009900), pg_temp.probe(7, 100009900, '0x1111111111111111'),
       pg_temp.probe(8, 100019900);
SELECT pg_temp.sale(1, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE1'),
       pg_temp.sale(1, timestamptz '2025-01-01 00:00:00+00' + interval '20000 s', 'LATER1'),
       pg_temp.sale(2, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE2'),
       pg_temp.sale(3, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE3'),
       pg_temp.sale(4, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE4'),
       pg_temp.sale(5, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE5'),
       pg_temp.sale(7, timestamptz '2025-01-01 00:00:00+00' + interval '10000 s', 'SALE7'),
       pg_temp.sale(8, timestamptz '2025-01-01 00:00:00+00' + interval '19000 s', 'SALE8', 100020000);

-- run 1: enqueue + dispatch
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_flip_lane();
  PERFORM _assert_eq(v->>'enqueued', '5', 'Q1: five probes carry the sold seed''s margin');
  PERFORM _assert_eq(v->>'skipped', '2', 'Q1: the off-margin and the never-sold probes are skipped once');
  PERFORM _assert_eq(v->>'dispatched', '5', 'Q1: one read each');
  PERFORM _assert((SELECT status = 'skipped' AND result = 'not_the_sold_seed_margin' FROM public.chain_arrival_flip_reads WHERE nft_id = 5),
                  'Q1: an off-margin probe is skipped, saying why');
  PERFORM _assert((SELECT status = 'skipped' AND result = 'not_sold_by_wallet' FROM public.chain_arrival_flip_reads WHERE nft_id = 6),
                  'Q1: a never-sold probe is skipped, saying why');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.chain_arrival_flip_reads WHERE nft_id = 7), 'C4: a probe with a sender is not a candidate');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(1))
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=100009901&end_height=100010080',
                  'Q1: (hi, first-sale estimate + 80] on the node serving hi + 1');
  PERFORM _assert((SELECT sale_tx = 'SALE1' FROM public.chain_arrival_flip_reads WHERE nft_id = 1), 'Q1: the FIRST sale is the one read');
  PERFORM _assert((SELECT url FROM net.calls WHERE id = pg_temp.req_of(8))
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/events?type=A.0b2a3299cc857e29.TopShot.Withdraw&start_height=100019901&end_height=100020080',
                  'Q1: an exact sale height is used over the estimate');
END $$;

-- responses
--   1: a delivery from 0xe1f2 at +10,040, an earlier hand-off at +9,950, the
--      sale (wallet) at +10,000... ordered: hand-off, delivery, sale, then the
--      BUYER's re-withdraw after the sale (must never be taken)
INSERT INTO net._http_response (id, status_code, content) SELECT pg_temp.req_of(1), 200, jsonb_build_array(
  pg_temp.blk(100009950, jsonb_build_array(pg_temp.wd(1, '0x2222222222222222', 'TXEARLY', 0))),
  pg_temp.blk(100009980, jsonb_build_array(pg_temp.wd(1, '0xe1f2a091f7bb5245', 'TXDELIVER', 0))),
  pg_temp.blk(100010000, jsonb_build_array(pg_temp.wd(99, '0xe1f2a091f7bb5245', 'TXOTHER', 0), pg_temp.wd(1, '0x00000000000000aa', 'SALE1', 3))),
  pg_temp.blk(100010050, jsonb_build_array(pg_temp.wd(1, '0xe1f2a091f7bb5245', 'TXBUYER', 0)))
)::text;
INSERT INTO net._http_response (id, status_code, content) SELECT pg_temp.req_of(2), 200, jsonb_build_array(
  pg_temp.blk(100010000, jsonb_build_array(pg_temp.wd(2, '0x00000000000000aa', 'SALE2', 0))),
  pg_temp.blk(100010010, jsonb_build_array(pg_temp.wd(2, '0xe1f2a091f7bb5245', 'TXAFTER', 0)))
)::text;
INSERT INTO net._http_response (id, status_code, content) SELECT pg_temp.req_of(3), 200, jsonb_build_array(
  pg_temp.blk(100009990, jsonb_build_array(pg_temp.wd(3, '0xe1f2a091f7bb5245', 'TXNOSALE', 0)))
)::text;
INSERT INTO net._http_response (id, status_code, content) VALUES (pg_temp.req_of(4), 429, 'Too Many Requests');
INSERT INTO net._http_response (id, status_code, content) VALUES (pg_temp.req_of(8), 400, '{"message":"bad range"}');

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_flip_lane();
  PERFORM _assert((SELECT from_address = '0xe1f2a091f7bb5245' AND tx_id = 'TXDELIVER' AND arrived_height = 100009980
                          AND arrived_at = timestamptz '2025-01-01 00:00:00+00' + interval '9980 s' AND last_error IS NULL
                     FROM public.chain_arrival_probes WHERE nft_id = 1),
                  'C1: the last other withdraw BEFORE the sale is the delivery -- not the earlier hand-off, not the buyer after');
  PERFORM _assert((SELECT status = 'done' AND result = 'found' AND sale_height = 100010000 AND sale_tx_read = 'SALE1'
                     FROM public.chain_arrival_flip_reads WHERE nft_id = 1), 'C1: found, with the sale read back');
  PERFORM _assert((SELECT result = 'no_delivery_before_sale' FROM public.chain_arrival_flip_reads WHERE nft_id = 2),
                  'C2: a sale with nothing before it');
  PERFORM _assert((SELECT from_address IS NULL AND last_error LIKE 'no TopShot.Withdraw%' FROM public.chain_arrival_probes WHERE nft_id = 2),
                  'C2/C1: a withdraw AFTER the sale is never taken as the delivery');
  PERFORM _assert((SELECT result = 'sale_not_in_window' FROM public.chain_arrival_flip_reads WHERE nft_id = 3),
                  'C2: no sale in the window');
  PERFORM _assert((SELECT from_address IS NULL FROM public.chain_arrival_probes WHERE nft_id = 3),
                  'C2: without the sale in view, no delivery is named');
  PERFORM _assert((SELECT status = 'pending' AND attempts = 0 FROM public.chain_arrival_flip_reads WHERE nft_id = 4),
                  'C3: a 429 is a free retry');
  PERFORM _assert((SELECT status = 'pending' AND attempts = 1 FROM public.chain_arrival_flip_reads WHERE nft_id = 8),
                  'C3: another error counts an attempt');
  PERFORM _assert_eq(v->>'found', '1', 'one found');
  PERFORM _assert_eq(v->>'sale_tx_match', '2', 'two sale withdraws matched the recorded sale tx');
  PERFORM _assert(NOT (v->>'ok')::boolean, 'C3: a failed read makes ok false');
  PERFORM _assert_eq(v->>'dispatched', '2', 'the two retries go out again');
  PERFORM _assert_eq(v->>'enqueued', '0', 'nothing enqueued twice');
END $$;

-- 4 lands; the sale arrives in the same block as the delivery, later index
INSERT INTO net._http_response (id, status_code, content) SELECT pg_temp.req_of(4), 200, jsonb_build_array(
  pg_temp.blk(100009990, jsonb_build_array(pg_temp.wd(4, '0xe1f2a091f7bb5245', 'TXD4', 0), pg_temp.wd(4, '0x00000000000000aa', 'SALE4', 2)))
)::text;
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_chain_arrival_flip_lane();
  PERFORM _assert((SELECT from_address = '0xe1f2a091f7bb5245' AND tx_id = 'TXD4' FROM public.chain_arrival_probes WHERE nft_id = 4),
                  'C1: same block, earlier event index -> the delivery');
  PERFORM _assert((SELECT from_address = '0x1111111111111111' FROM public.chain_arrival_probes WHERE nft_id = 7),
                  'C4: an existing sender is untouched');
END $$;

SELECT '✓ run_chain_arrival_flip_lane: Q1, C1-C4' AS ok;

ROLLBACK;
