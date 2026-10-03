-- DB invariant: public.run_topshot_sellback_edition_reads — names staged 2025 Top Shot sell-backs
-- (known-issues #167) by reading the buy-back wallet's collection on chain at a historical height,
-- then promotes them into `sales`. Claims:
--   1. staged 'unresolved_edition' sell-backs are enqueued as ONE read per 2,000-block window that
--      never straddles the mainnet26/27 boundary, at the window's highest sale block, routed to the
--      spork's node; never more than p_max_inflight reads are outstanding;
--   2. a landed read is stored in topshot_chain_moment_reads; a sell-back whose read maps to an
--      edition we carry enters `sales` with that edition and the CHAIN's serial
--      ('inserted_chain_read'); a read naming an edition we do not carry (e.g. a parallel) is
--      'edition_missing' and writes nothing; a sale already in `sales` is not duplicated;
--   3. an id a WINDOW read did not return is retried alone at its own sale block; an id a BLOCK
--      read did not return is 'chain_not_held';
--   4. a 429 is retried without spending an attempt; any other failure spends one, and the 6th
--      closes the request as failed.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261003211651_topshot_sellback_edition_reads_name_staged_sellbacks_from_the_chain.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, timed_out boolean, error_msg text);
CREATE TABLE net._sent (id bigint, url text, body jsonb);
CREATE SEQUENCE net._req_seq START 1000;
CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), url, body) RETURNING id $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobname text);
CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.sales (id uuid DEFAULT gen_random_uuid(), edition_id uuid, collection_id uuid, collection text, serial_number int,
  price_usd numeric, currency text, seller_address text, buyer_address text, marketplace text, transaction_hash text,
  block_height bigint, sold_at timestamptz, nft_id varchar, source text);
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE TABLE public.topshot_chain_moment_reads (nft_id bigint PRIMARY KEY, set_id int NOT NULL, play_id int NOT NULL,
  serial_number int NOT NULL, subedition_id int NOT NULL, owner_address text NOT NULL, block_height bigint NOT NULL, read_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_sellback_walk_purchases (tx text NOT NULL, nft_id text NOT NULL, price_usd numeric, seller text, block_height bigint,
  sold_at timestamptz, promoted_at timestamptz, promote_outcome text, edition_read_requested_at timestamptz, PRIMARY KEY (tx, nft_id));
CREATE TABLE public.topshot_sellback_edition_requests (id bigserial PRIMARY KEY, kind text NOT NULL, read_height bigint NOT NULL, ids bigint[] NOT NULL,
  status text NOT NULL DEFAULT 'pending', request_id bigint, attempts int NOT NULL DEFAULT 0, last_error text,
  dispatched_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

-- A 200 the way Flow's REST API returns a script result: a JSON string of base64 JSON-Cadence.
CREATE FUNCTION pg_temp.dict(entries text) RETURNS text LANGUAGE sql AS $$
  SELECT to_jsonb(translate(encode(convert_to('{"type":"Dictionary","value":[' || entries || ']}', 'UTF8'), 'base64'), E'\n', ''))::text $$;
CREATE FUNCTION pg_temp.ent(id bigint, s int, p int, serial int, sub int) RETURNS text LANGUAGE sql AS $$
  SELECT format('{"key":{"type":"UInt64","value":"%s"},"value":{"type":"Array","value":[{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"}]}}',
                id, s, p, serial, sub) $$;

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.run_topshot_sellback_edition_reads(p_max_inflight integer DEFAULT 4)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_buyback  CONSTANT text := '0xe1f2a091f7bb5245';
  c_ts       CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_m26_end  CONSTANT bigint := 130290658;
  c_base     CONSTANT bigint := 118100000;
  c_window   CONSTANT int := 2000;
  c_chunk    CONSTANT int := 500;
  c_max_att  CONSTANT int := 6;
  c_src      CONSTANT text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}';
  v_started    timestamptz := clock_timestamp();
  r            record;
  v_body       jsonb;
  v_got        bigint[];
  v_collected  int := 0;
  v_reads_new  int := 0;
  v_throttled  int := 0;
  v_failed     int := 0;
  v_fallback   int := 0;
  v_not_held   int := 0;
  v_enqueued   int := 0;
  v_dispatched int := 0;
  v_inflight   int := 0;
  v_promoted   int := 0;
  v_missing    int := 0;
  v_n          int;
  v_err        text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_topshot_sellback_edition_reads')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  BEGIN
    -- 1. COLLECT every landed read. A 200 is a Dictionary of the ids still held at read_height.
    FOR r IN
      SELECT q.id, q.kind, q.read_height, q.ids, q.attempts, q.dispatched_at,
             h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
        FROM public.topshot_sellback_edition_requests q
        LEFT JOIN net._http_response h ON h.id = q.request_id
       WHERE q.status = 'in_flight'
       ORDER BY q.id
    LOOP
      IF NOT r.landed THEN
        IF r.dispatched_at < now() - interval '30 minutes' THEN
          UPDATE public.topshot_sellback_edition_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
        END IF;
        CONTINUE;
      END IF;
      v_collected := v_collected + 1;

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
          -- the node's throttle, not a wrong read: retried without spending an attempt
          UPDATE public.topshot_sellback_edition_requests
             SET status = 'pending', request_id = NULL, last_error = 'http 429'
           WHERE id = r.id;
          v_throttled := v_throttled + 1;
        ELSE
          UPDATE public.topshot_sellback_edition_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL,
                 last_error = left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300),
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
          v_failed := v_failed + 1;
        END IF;
        CONTINUE;
      END IF;

      WITH kv AS (
        SELECT (e->'key'->>'value')::bigint AS nft_id,
               (e->'value'->'value'->0->>'value')::int AS set_id,
               (e->'value'->'value'->1->>'value')::int AS play_id,
               (e->'value'->'value'->2->>'value')::int AS serial_number,
               coalesce((e->'value'->'value'->3->>'value')::int, 0) AS subedition_id
          FROM jsonb_array_elements(coalesce(v_body->'value', '[]'::jsonb)) e
      ), ins AS (
        INSERT INTO public.topshot_chain_moment_reads
               (nft_id, set_id, play_id, serial_number, subedition_id, owner_address, block_height)
        SELECT nft_id, set_id, play_id, serial_number, subedition_id, c_buyback, r.read_height
          FROM kv
         WHERE set_id IS NOT NULL AND play_id IS NOT NULL AND serial_number IS NOT NULL
        ON CONFLICT (nft_id) DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM ins), (SELECT array_agg(nft_id) FROM kv) INTO v_n, v_got;
      v_reads_new := v_reads_new + v_n;

      -- Ids the read did not return. A WINDOW miss is retried alone at its own sale block (it may
      -- have left the wallet before the window's read height); a BLOCK miss is final.
      IF r.kind = 'window' THEN
        INSERT INTO public.topshot_sellback_edition_requests (kind, read_height, ids)
        SELECT 'block', p.block_height, array_agg(DISTINCT p.nft_id::bigint)
          FROM public.topshot_sellback_walk_purchases p
         WHERE p.nft_id::bigint = ANY (r.ids)
           AND NOT (p.nft_id::bigint = ANY (coalesce(v_got, '{}'::bigint[])))
           AND p.promote_outcome = 'unresolved_edition'
         GROUP BY p.block_height;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_fallback := v_fallback + v_n;
      ELSE
        UPDATE public.topshot_sellback_walk_purchases p
           SET promote_outcome = 'chain_not_held'
         WHERE p.nft_id::bigint = ANY (r.ids)
           AND NOT (p.nft_id::bigint = ANY (coalesce(v_got, '{}'::bigint[])))
           AND p.promote_outcome = 'unresolved_edition'
           AND NOT EXISTS (SELECT 1 FROM public.topshot_chain_moment_reads c WHERE c.nft_id = p.nft_id::bigint);
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_not_held := v_not_held + v_n;
      END IF;

      UPDATE public.topshot_sellback_edition_requests
         SET status = 'done', finished_at = now(), last_error = NULL
       WHERE id = r.id;
    END LOOP;

    -- 2. ENQUEUE staged, unresolved sell-backs not yet asked for: one request per 2,000-block
    --    window (never straddling the mainnet26/27 boundary), ≤ 500 ids each, read at the
    --    window's highest sale block. Bounded per tick.
    WITH todo AS (
      SELECT p.tx, p.nft_id, p.block_height,
             (p.block_height <= c_m26_end) AS m26,
             (p.block_height - c_base) / c_window AS w
        FROM public.topshot_sellback_walk_purchases p
       WHERE p.promote_outcome = 'unresolved_edition'
         AND p.edition_read_requested_at IS NULL
         AND p.block_height IS NOT NULL
         AND p.nft_id ~ '^[0-9]{1,18}$'
       ORDER BY p.block_height
       LIMIT 4000
    ), chunked AS (
      SELECT t.*, (row_number() OVER (PARTITION BY m26, w ORDER BY block_height, nft_id) - 1) / c_chunk AS c
        FROM todo t
    ), groups AS (
      SELECT max(block_height) AS h, array_agg(DISTINCT nft_id::bigint) AS ids
        FROM chunked GROUP BY m26, w, c
    ), ins AS (
      INSERT INTO public.topshot_sellback_edition_requests (kind, read_height, ids)
      SELECT 'window', h, ids FROM groups
      RETURNING 1
    ), mark AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET edition_read_requested_at = now()
        FROM todo t
       WHERE p.tx = t.tx AND p.nft_id = t.nft_id
      RETURNING 1
    )
    -- (`mark` runs regardless: a data-modifying CTE executes whether or not it is read)
    SELECT count(*) INTO v_enqueued FROM ins;

    -- 3. DISPATCH: never more than p_max_inflight reads outstanding, oldest first.
    SELECT count(*) INTO v_inflight FROM public.topshot_sellback_edition_requests WHERE status = 'in_flight';
    WITH nxt AS (
      SELECT id FROM public.topshot_sellback_edition_requests
       WHERE status = 'pending'
       ORDER BY id
       LIMIT GREATEST(p_max_inflight - v_inflight, 0)
    ), sent AS (
      UPDATE public.topshot_sellback_edition_requests q
         SET request_id = net.http_post(
               url := CASE WHEN q.read_height <= c_m26_end THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                           ELSE 'http://access-001.mainnet27.nodes.onflow.org:8070' END
                      || '/v1/scripts?block_height=' || q.read_height,
               body := jsonb_build_object(
                 'script', translate(encode(convert_to(c_src, 'UTF8'), 'base64'), E'\n', ''),
                 'arguments', jsonb_build_array(
                   translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', c_buyback)::text, 'UTF8'), 'base64'), E'\n', ''),
                   translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
                     (SELECT jsonb_agg(jsonb_build_object('type', 'UInt64', 'value', i::text)) FROM unnest(q.ids) i))::text, 'UTF8'), 'base64'), E'\n', ''))),
               headers := '{"Content-Type":"application/json"}'::jsonb,
               timeout_milliseconds := 60000),
             status = 'in_flight', dispatched_at = now()
        FROM nxt
       WHERE q.id = nxt.id
      RETURNING 1
    )
    SELECT count(*) INTO v_dispatched FROM sent;

    -- 4. PROMOTE staged sell-backs the chain has now named. The edition must be one we carry
    --    (exact external_id, parallels included); otherwise 'edition_missing', never a guess.
    WITH cand AS (
      SELECT p.tx, p.nft_id, p.price_usd, p.seller, p.block_height, p.sold_at,
             c.serial_number, ed.id AS edition_id
        FROM public.topshot_sellback_walk_purchases p
        JOIN public.topshot_chain_moment_reads c ON c.nft_id = p.nft_id::bigint
        LEFT JOIN public.editions ed
          ON ed.collection_id = c_ts
         AND ed.external_id = CASE WHEN c.subedition_id = 0 THEN c.set_id || ':' || c.play_id
                                   ELSE c.set_id || ':' || c.play_id || '::' || c.subedition_id END
       WHERE p.promote_outcome = 'unresolved_edition'
         AND p.edition_read_requested_at IS NOT NULL
         AND p.price_usd IS NOT NULL
         AND p.nft_id ~ '^[0-9]{1,18}$'
       LIMIT 2000
    ), ins AS (
      INSERT INTO public.sales (edition_id, collection_id, collection, serial_number, price_usd, currency,
                                seller_address, buyer_address, marketplace, transaction_hash, block_height,
                                sold_at, nft_id, source)
      SELECT c.edition_id, c_ts, 'nba_top_shot', c.serial_number, c.price_usd, 'USD',
             c.seller, c_buyback, 'top_shot', c.tx, c.block_height, c.sold_at, c.nft_id,
             'onchain_sellback_backfill_2025'
        FROM cand c
       WHERE c.edition_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.sales s
                          WHERE s.collection_id = c_ts AND s.nft_id = c.nft_id
                            AND s.sold_at BETWEEN c.sold_at - interval '1 hour' AND c.sold_at + interval '1 hour'
                            AND (s.transaction_hash = c.tx OR s.transaction_hash IS NULL))
      ON CONFLICT DO NOTHING
      RETURNING nft_id, transaction_hash
    ), marked AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET promote_outcome = CASE WHEN EXISTS (SELECT 1 FROM ins WHERE ins.nft_id = p.nft_id AND ins.transaction_hash = p.tx)
                                    THEN 'inserted_chain_read'
                                    WHEN c.edition_id IS NULL THEN 'edition_missing'
                                    ELSE 'already_in_sales' END,
             promoted_at = now()
        FROM cand c
       WHERE p.tx = c.tx AND p.nft_id = c.nft_id
      RETURNING p.promote_outcome
    )
    SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM marked WHERE promote_outcome = 'edition_missing')
      INTO v_promoted, v_missing;

    -- 5. DONE: the walk is finished (its job gone), nothing unresolved is waiting for a read,
    --    and no read is open -> this lane unschedules itself.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_purchases
                        WHERE promote_outcome = 'unresolved_edition' AND edition_read_requested_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_edition_requests WHERE status IN ('pending', 'in_flight'))
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-edition-reads') THEN
      PERFORM cron.unschedule('rpc-topshot-sellback-edition-reads');
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-sellback-edition-reads', v_started, v_collected, v_promoted, v_failed,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'reads_new', v_reads_new, 'throttled', v_throttled,
                       'failed', v_failed, 'fallback_enqueued', v_fallback, 'chain_not_held', v_not_held,
                       'enqueued', v_enqueued, 'dispatched', v_dispatched, 'inflight_before', v_inflight,
                       'promoted', v_promoted, 'edition_missing', v_missing, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('collected', v_collected, 'reads_new', v_reads_new, 'throttled', v_throttled,
                            'failed', v_failed, 'fallback_enqueued', v_fallback, 'chain_not_held', v_not_held,
                            'enqueued', v_enqueued, 'dispatched', v_dispatched, 'promoted', v_promoted,
                            'edition_missing', v_missing, 'error', v_err);
END
$function$;
-- <<< END verbatim <<<

INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2'),
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '3:4'),     -- base only: 3:4::2 is NOT carried
  ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '5:6');
INSERT INTO cron.job VALUES ('rpc-topshot-sellback-walk'), ('rpc-topshot-sellback-edition-reads');

INSERT INTO public.topshot_sellback_walk_purchases (tx, nft_id, price_usd, seller, block_height, sold_at, promoted_at, promote_outcome) VALUES
  ('t101', '101', 1, '0xs1', 118100010, '2025-06-30 11:00:00+00', now(), 'unresolved_edition'),
  ('t102', '102', 1, '0xs1', 118100020, '2025-06-30 11:00:10+00', now(), 'unresolved_edition'),
  ('t103', '103', 1, '0xs2', 118100030, '2025-06-30 11:00:20+00', now(), 'unresolved_edition'),
  ('t104', '104', 2, '0xs3', 130290700, '2025-10-22 12:00:00+00', now(), 'unresolved_edition'),   -- mainnet27
  ('t105', '105', 9, '0xs4', 118100040, '2025-06-30 11:00:30+00', now(), 'inserted'),             -- not staged: untouched
  ('t107', '107', 1, '0xs5', 118102500, '2025-06-30 11:50:00+00', now(), 'unresolved_edition');   -- next window

DO $do$
DECLARE r jsonb; q1 bigint; q2 bigint; q3 bigint; rid bigint;
BEGIN
  -- ── claim 1: one read per window, routed by spork, read at the window's max sale block
  r := public.run_topshot_sellback_edition_reads(3);
  PERFORM _assert_eq(r->>'error', NULL, 'tick 1 ran clean');
  PERFORM _assert_eq(r->>'enqueued', '3', 'three windows: m26 w0, m26 w1, m27');
  PERFORM _assert_eq((SELECT string_agg(read_height || ':' || array_to_string(ids, '|'), ',' ORDER BY read_height)
                        FROM public.topshot_sellback_edition_requests),
    '118100030:101|102|103,118102500:107,130290700:104', 'window grouping and read heights (claim 1)');
  PERFORM _assert_eq(r->>'dispatched', '3', 'all three dispatched under p_max_inflight = 3');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_sellback_walk_purchases WHERE edition_read_requested_at IS NOT NULL), '5',
    'every staged row marked requested; the already-inserted row is not');
  INSERT INTO public.topshot_sellback_edition_requests (kind, read_height, ids) VALUES ('block', 118100001, '{999}');
  r := public.run_topshot_sellback_edition_reads(3);
  PERFORM _assert_eq(r->>'dispatched', '0', 'nothing more while p_max_inflight are in flight (claim 1)');
  DELETE FROM public.topshot_sellback_edition_requests WHERE read_height = 118100001;
  PERFORM _assert_eq((SELECT url FROM net._sent s JOIN public.topshot_sellback_edition_requests q ON q.request_id = s.id WHERE q.read_height = 118100030),
    'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=118100030', 'mainnet26 window routed to mainnet26 at its max block');
  SELECT request_id INTO q1 FROM public.topshot_sellback_edition_requests WHERE read_height = 118100030;
  SELECT request_id INTO q2 FROM public.topshot_sellback_edition_requests WHERE read_height = 118102500;
  PERFORM _assert((SELECT body->'arguments'->>1 FROM net._sent WHERE id = q1) IS NOT NULL, 'ids argument sent');
  PERFORM _assert_eq((SELECT convert_from(decode(body->'arguments'->>0, 'base64'), 'UTF8')::jsonb->>'value' FROM net._sent WHERE id = q1),
    '0xe1f2a091f7bb5245', 'reads the buy-back wallet');

  -- ── claims 2-4: window 0 answers 101 (carried) + 102 (parallel, not carried), omits 103; window 1 is throttled
  INSERT INTO net._http_response (id, status_code, content) VALUES
    (q1, 200, pg_temp.dict(pg_temp.ent(101, 1, 2, 7, 0) || ',' || pg_temp.ent(102, 3, 4, 9, 2))),
    (q2, 429, 'too many requests');
  r := public.run_topshot_sellback_edition_reads(1);
  PERFORM _assert_eq(r->>'error', NULL, 'tick 3 ran clean');
  PERFORM _assert_eq(r->>'reads_new', '2', 'two chain reads stored (claim 2)');
  PERFORM _assert_eq((SELECT owner_address || ':' || block_height FROM public.topshot_chain_moment_reads WHERE nft_id = 101),
    '0xe1f2a091f7bb5245:118100030', 'read provenance = buy-back wallet at the read height');
  PERFORM _assert_eq((SELECT edition_id::text || ':' || serial_number || ':' || buyer_address || ':' || source || ':' || price_usd FROM public.sales WHERE nft_id = '101'),
    '00000000-0000-0000-0000-0000000000e1:7:0xe1f2a091f7bb5245:onchain_sellback_backfill_2025:1', 'carried edition promoted with the chain serial (claim 2)');
  PERFORM _assert_eq((SELECT string_agg(nft_id || ':' || promote_outcome, ',' ORDER BY nft_id) FROM public.topshot_sellback_walk_purchases),
    '101:inserted_chain_read,102:edition_missing,103:unresolved_edition,104:unresolved_edition,105:inserted,107:unresolved_edition',
    'parallel never folded into its base; unanswered rows still staged (claim 2)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id IN ('102', '105')), '0', 'nothing guessed, nothing re-written (claim 2)');
  PERFORM _assert_eq((SELECT kind || ':' || read_height || ':' || array_to_string(ids, '|') FROM public.topshot_sellback_edition_requests WHERE kind = 'block'),
    'block:118100030:103', 'a window miss is retried alone at its own sale block (claim 3)');
  PERFORM _assert_eq((SELECT attempts || ':' || last_error FROM public.topshot_sellback_edition_requests WHERE read_height = 118102500),
    '0:http 429', 'a 429 spends no attempt (claim 4)');
  PERFORM _assert_eq(r->>'throttled', '1', 'throttle counted');

  -- ── claim 3: the block read does not hold 103 either -> chain_not_held
  SELECT request_id INTO q3 FROM public.topshot_sellback_edition_requests WHERE kind = 'block' AND status = 'in_flight';
  IF q3 IS NULL THEN
    UPDATE public.topshot_sellback_edition_requests SET status = 'in_flight', request_id = 9001, dispatched_at = now() WHERE kind = 'block';
    q3 := 9001;
  END IF;
  INSERT INTO net._http_response (id, status_code, content) VALUES (q3, 200, pg_temp.dict(''));
  r := public.run_topshot_sellback_edition_reads(1);
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '103'), 'chain_not_held',
    'a block-read miss is final (claim 3)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_sellback_edition_requests WHERE kind = 'block'), '1', 'no second fallback for a block miss');

  -- ── claim 2: a sale already present is not duplicated
  INSERT INTO public.topshot_chain_moment_reads VALUES (104, 5, 6, 3, 0, '0xe1f2a091f7bb5245', 130290700, now());
  INSERT INTO public.sales (edition_id, collection_id, collection, price_usd, transaction_hash, sold_at, nft_id, source)
  VALUES ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 2, 't104', '2025-10-22 12:00:00+00', '104', 'onchain');
  r := public.run_topshot_sellback_edition_reads(1);
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '104'), 'already_in_sales', 'existing sale recognised');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id = '104'), '1', 'no duplicate (claim 2)');

  -- ── claim 4: any other failure spends an attempt; the 6th closes the request as failed
  SELECT id INTO rid FROM public.topshot_sellback_edition_requests WHERE read_height = 118102500;
  UPDATE public.topshot_sellback_edition_requests SET attempts = 5, status = 'in_flight', request_id = 9002, dispatched_at = now() WHERE id = rid;
  INSERT INTO net._http_response (id, status_code, content) VALUES (9002, 500, 'boom');
  r := public.run_topshot_sellback_edition_reads(1);
  PERFORM _assert_eq((SELECT status || ':' || attempts FROM public.topshot_sellback_edition_requests WHERE id = rid), 'failed:6',
    'the 6th failure closes the request (claim 4)');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '107'), 'unresolved_edition',
    'a failed read leaves the row staged, never resolved');
END
$do$;

ROLLBACK;
