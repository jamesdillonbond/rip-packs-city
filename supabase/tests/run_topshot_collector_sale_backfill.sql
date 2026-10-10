-- DB invariant: public.run_topshot_collector_sale_backfill — recovers the 2025 Top Shot COLLECTOR
-- sales the sell-back walk staged but `sales` never held (known-issues #167, the "second 2025 gap";
-- ~10 % of collector purchases Jun–Jul 2025, ~87 % of them with no edition anywhere in the DB).
-- Claims:
--   1. an unclassified purchase the walk has fully passed (block below the open-page frontier −
--      250) with NO deposit row is classified: in `sales` (same tx, or the moment within ±1 h) →
--      'collector_in_sales'; otherwise 'collector_absent' with ONE transaction-result read routed
--      to the spork's node; a sell-back (deposit row) and a purchase at/above the frontier are
--      untouched; never more than p_max_inflight reads are outstanding;
--   2. a landed tx result names the buyer from the TopShot.Deposit of THAT moment (never another
--      moment's deposit in the same tx); no such deposit → 'buyer_unknown'; a script against the
--      BUYER's collection at the PURCHASE block is enqueued only when no DB source names the
--      edition (moments / another sale / an existing chain read);
--   3. a known buyer + edition enters `sales` with the buyer, the chain serial and source
--      'onchain_collector_backfill_2025' ('inserted_collector'); a read naming an edition we do
--      not carry (a parallel) is 'edition_missing' and writes nothing; an empty read at the
--      purchase block is 'chain_not_held'; an existing sale is never duplicated;
--   4. a 429 is retried without spending an attempt; any other failure spends one, and the 6th
--      closes the request and the row ('buyer_fetch_failed' / 'edition_read_failed');
--   5. with the walk's job gone and nothing left to classify, read or promote, the lane
--      unschedules itself.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261010161620_audit_20261010_collector_sale_backfill_drops_the_walk_margin_once_the_walk_is_gone.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, timed_out boolean, error_msg text);
CREATE TABLE net._sent (id bigint, url text, body jsonb);
CREATE SEQUENCE net._req_seq START 1000;
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), url, NULL) RETURNING id $$;
CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), url, body) RETURNING id $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobname text);
CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text);
CREATE TABLE public.moments (nft_id varchar, collection_id uuid, edition_id uuid, serial_number int);
CREATE TABLE public.sales (id uuid DEFAULT gen_random_uuid(), edition_id uuid, collection_id uuid, collection text, serial_number int,
  price_usd numeric, currency text, seller_address text, buyer_address text, marketplace text, transaction_hash text,
  block_height bigint, sold_at timestamptz, nft_id varchar, source text);
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;
CREATE TABLE public.topshot_chain_moment_reads (nft_id bigint PRIMARY KEY, set_id int NOT NULL, play_id int NOT NULL,
  serial_number int NOT NULL, subedition_id int NOT NULL, owner_address text NOT NULL, block_height bigint NOT NULL, read_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_sellback_walk_state (id int PRIMARY KEY, next_height bigint NOT NULL, end_height bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_sellback_walk_pages (kind text NOT NULL, start_height bigint NOT NULL, req_id bigint, issued_at timestamptz,
  attempts int NOT NULL DEFAULT 0, last_status int, last_error text, failed boolean NOT NULL DEFAULT false, done_at timestamptz, PRIMARY KEY (kind, start_height));
CREATE TABLE public.topshot_sellback_walk_purchases (tx text NOT NULL, nft_id text NOT NULL, price_usd numeric, seller text, block_height bigint,
  sold_at timestamptz, promoted_at timestamptz, promote_outcome text, edition_read_requested_at timestamptz, buyer text, PRIMARY KEY (tx, nft_id));
CREATE TABLE public.topshot_sellback_walk_deposits (tx text NOT NULL, nft_id text NOT NULL, block_height bigint, deposited_at timestamptz, PRIMARY KEY (tx, nft_id));
CREATE TABLE public.topshot_collector_sale_requests (
  id            bigserial PRIMARY KEY,
  kind          text   NOT NULL CHECK (kind IN ('tx', 'script')),
  tx            text   NOT NULL,
  nft_id        text   NOT NULL,
  block_height  bigint NOT NULL,
  owner         text,
  status        text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id    bigint,
  attempts      int    NOT NULL DEFAULT 0,
  last_error    text,
  dispatched_at timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, tx, nft_id)
);

-- A transaction result the way Flow's REST API returns it: events with base64 JSON-Cadence payloads.
CREATE FUNCTION pg_temp.dep(id text, to_addr text) RETURNS text LANGUAGE sql AS $$
  SELECT format('{"type":"A.0b2a3299cc857e29.TopShot.Deposit","transaction_id":"x","event_index":1,"payload":"%s"}',
    translate(encode(convert_to(format('{"value":{"id":"A.0b2a3299cc857e29.TopShot.Deposit","fields":[{"value":{"value":"%s","type":"UInt64"},"name":"id"},{"value":{"value":{"value":"%s","type":"Address"},"type":"Optional"},"name":"to"}]},"type":"Event"}', id, to_addr), 'UTF8'), 'base64'), E'\n', '')) $$;
CREATE FUNCTION pg_temp.txres(events text) RETURNS text LANGUAGE sql AS $$
  SELECT '{"block_id":"abc","status":"Sealed","status_code":0,"events":[' || events || ']}' $$;
-- A script result: a JSON string of base64 JSON-Cadence.
CREATE FUNCTION pg_temp.dict(entries text) RETURNS text LANGUAGE sql AS $$
  SELECT to_jsonb(translate(encode(convert_to('{"type":"Dictionary","value":[' || entries || ']}', 'UTF8'), 'base64'), E'\n', ''))::text $$;
CREATE FUNCTION pg_temp.ent(id bigint, s int, p int, serial int, sub int) RETURNS text LANGUAGE sql AS $$
  SELECT format('{"key":{"type":"UInt64","value":"%s"},"value":{"type":"Array","value":[{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"},{"type":"UInt32","value":"%s"}]}}',
                id, s, p, serial, sub) $$;

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.run_topshot_collector_sale_backfill(p_max_inflight integer DEFAULT 6, p_claim integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_ts       CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_m26_end  CONSTANT bigint := 130290658;
  c_dep_type CONSTANT text := 'A.0b2a3299cc857e29.TopShot.Deposit';
  c_max_att  CONSTANT int := 6;
  c_src      CONSTANT text := 'import TopShot from 0x0b2a3299cc857e29
access(all) fun main(owner: Address, ids: [UInt64]): {UInt64: [UInt32]} {
  let out: {UInt64: [UInt32]} = {}
  let col = getAccount(owner).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return out }
  for id in ids { if let m = col!.borrowMoment(id: id) { out[id] = [m.data.setID, m.data.playID, m.data.serialNumber, TopShot.getMomentsSubedition(nftID: id) ?? 0] } }
  return out
}';
  v_started     timestamptz := clock_timestamp();
  r             record;
  v_body        jsonb;
  v_buyer       text;
  v_frontier    bigint;
  v_collected   int := 0;
  v_buyers      int := 0;
  v_buyer_unknown int := 0;
  v_reads_new   int := 0;
  v_not_held    int := 0;
  v_throttled   int := 0;
  v_failed      int := 0;
  v_claimed     int := 0;
  v_present     int := 0;
  v_absent      int := 0;
  v_scripts     int := 0;
  v_dispatched  int := 0;
  v_inflight    int := 0;
  v_promoted    int := 0;
  v_missing     int := 0;
  v_n           int;
  v_err         text;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_topshot_collector_sale_backfill')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  BEGIN
    -- 1. COLLECT every landed request. A 'tx' read is the transaction result: the TopShot.Deposit
    --    event for THIS moment names the buyer. A 'script' read is the buyer's collection at the
    --    purchase block: setID / playID / serial / subedition for the moment.
    FOR r IN
      SELECT q.id, q.kind, q.tx, q.nft_id, q.block_height, q.owner, q.attempts, q.dispatched_at,
             h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
        FROM public.topshot_collector_sale_requests q
        LEFT JOIN net._http_response h ON h.id = q.request_id
       WHERE q.status = 'in_flight'
       ORDER BY q.id
    LOOP
      IF NOT r.landed THEN
        IF r.dispatched_at < now() - interval '30 minutes' THEN
          UPDATE public.topshot_collector_sale_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
          IF r.attempts + 1 >= c_max_att THEN
            UPDATE public.topshot_sellback_walk_purchases
               SET promote_outcome = CASE WHEN r.kind = 'tx' THEN 'buyer_fetch_failed' ELSE 'edition_read_failed' END, promoted_at = now()
             WHERE tx = r.tx AND nft_id = r.nft_id AND promote_outcome = 'collector_absent';
            v_failed := v_failed + 1;
          END IF;
        END IF;
        CONTINUE;
      END IF;
      v_collected := v_collected + 1;

      v_body := NULL;
      IF r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN
        IF r.kind = 'tx' THEN
          v_body := r.h_content::jsonb;
          IF jsonb_typeof(v_body->'events') IS DISTINCT FROM 'array' THEN v_body := NULL; END IF;
        ELSE
          BEGIN
            v_body := convert_from(decode(r.h_content::jsonb #>> '{}', 'base64'), 'UTF8')::jsonb;
          EXCEPTION WHEN others THEN
            v_body := NULL;
          END;
          IF v_body->>'type' IS DISTINCT FROM 'Dictionary' THEN v_body := NULL; END IF;
        END IF;
      END IF;

      IF v_body IS NULL THEN
        IF r.h_status = 429 THEN
          -- the node's throttle, not a wrong read: retried without spending an attempt
          UPDATE public.topshot_collector_sale_requests
             SET status = 'pending', request_id = NULL, last_error = 'http 429'
           WHERE id = r.id;
          v_throttled := v_throttled + 1;
        ELSE
          UPDATE public.topshot_collector_sale_requests
             SET status = CASE WHEN attempts + 1 >= c_max_att THEN 'failed' ELSE 'pending' END,
                 attempts = attempts + 1, request_id = NULL,
                 last_error = left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || left(r.h_content, 200)), 300),
                 finished_at = CASE WHEN attempts + 1 >= c_max_att THEN now() END
           WHERE id = r.id;
          IF r.attempts + 1 >= c_max_att THEN
            UPDATE public.topshot_sellback_walk_purchases
               SET promote_outcome = CASE WHEN r.kind = 'tx' THEN 'buyer_fetch_failed' ELSE 'edition_read_failed' END, promoted_at = now()
             WHERE tx = r.tx AND nft_id = r.nft_id AND promote_outcome = 'collector_absent';
          END IF;
          v_failed := v_failed + 1;
        END IF;
        CONTINUE;
      END IF;

      IF r.kind = 'tx' THEN
        -- the Deposit of THIS moment (a tx can deposit several); the `to` address is the buyer
        SELECT (SELECT coalesce(fl->'value'->'value'->>'value', fl->'value'->>'value')
                  FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'to')
          INTO v_buyer
          FROM jsonb_array_elements(v_body->'events') e,
               LATERAL (SELECT convert_from(decode(e->>'payload', 'base64'), 'utf8')::jsonb AS pl) x
         WHERE e->>'type' = c_dep_type
           AND (SELECT fl->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'id') = r.nft_id
         LIMIT 1;

        IF v_buyer IS NULL OR v_buyer !~ '^0x[0-9a-f]{16}$' THEN
          UPDATE public.topshot_sellback_walk_purchases
             SET promote_outcome = 'buyer_unknown', promoted_at = now()
           WHERE tx = r.tx AND nft_id = r.nft_id AND promote_outcome = 'collector_absent';
          v_buyer_unknown := v_buyer_unknown + 1;
        ELSE
          UPDATE public.topshot_sellback_walk_purchases SET buyer = v_buyer
           WHERE tx = r.tx AND nft_id = r.nft_id;
          v_buyers := v_buyers + 1;
          -- the edition comes from a source the live indexer resolved when it has one; the chain
          -- (the buyer's collection at the purchase block) only otherwise
          IF NOT EXISTS (SELECT 1 FROM public.moments m WHERE m.nft_id = r.nft_id AND m.collection_id = c_ts AND m.edition_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.nft_id = r.nft_id AND s.collection_id = c_ts AND s.edition_id IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM public.topshot_chain_moment_reads c WHERE c.nft_id = r.nft_id::bigint)
             AND r.nft_id ~ '^[0-9]{1,18}$' THEN
            INSERT INTO public.topshot_collector_sale_requests (kind, tx, nft_id, block_height, owner)
            VALUES ('script', r.tx, r.nft_id, r.block_height, v_buyer)
            ON CONFLICT (kind, tx, nft_id) DO NOTHING;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            v_scripts := v_scripts + v_n;
          END IF;
        END IF;
      ELSE
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
          SELECT nft_id, set_id, play_id, serial_number, subedition_id, r.owner, r.block_height
            FROM kv
           WHERE nft_id = r.nft_id::bigint
             AND set_id IS NOT NULL AND play_id IS NOT NULL AND serial_number IS NOT NULL
          ON CONFLICT (nft_id) DO NOTHING
          RETURNING 1
        )
        SELECT count(*) INTO v_n FROM ins;
        v_reads_new := v_reads_new + v_n;
        -- the buyer's collection at the purchase block does not hold it: final, never guessed
        IF v_n = 0 AND NOT EXISTS (SELECT 1 FROM public.topshot_chain_moment_reads c WHERE c.nft_id = r.nft_id::bigint) THEN
          UPDATE public.topshot_sellback_walk_purchases
             SET promote_outcome = 'chain_not_held', promoted_at = now()
           WHERE tx = r.tx AND nft_id = r.nft_id AND promote_outcome = 'collector_absent';
          v_not_held := v_not_held + 1;
        END IF;
      END IF;

      UPDATE public.topshot_collector_sale_requests
         SET status = 'done', finished_at = now(), last_error = NULL
       WHERE id = r.id;
    END LOOP;

    -- 2. CLAIM unclassified purchases the walk has fully passed (every page below the frontier is
    --    closed, so a sell-back there already has its deposit row and is NOT a candidate here).
    --    A collector purchase already in `sales` (same tx, or the same moment within ±1 h) is
    --    'collector_in_sales'; the rest are 'collector_absent' and get one tx read each.
    SELECT coalesce((SELECT min(start_height) FROM public.topshot_sellback_walk_pages WHERE done_at IS NULL),
                    (SELECT next_height FROM public.topshot_sellback_walk_state WHERE id = 1))
      INTO v_frontier;

    WITH todo AS (
      SELECT p.tx, p.nft_id, p.block_height, p.sold_at
        FROM public.topshot_sellback_walk_purchases p
       WHERE p.promote_outcome IS NULL
         AND p.block_height IS NOT NULL AND p.sold_at IS NOT NULL
         -- 2026-10-10 (#167): the 250-block margin guards pages still being WALKED;
         -- once the walk is unscheduled nothing below the frontier can change, and
         -- the margin stranded the last two purchases (1,440 empty ticks a day).
         AND p.block_height < v_frontier - CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk') THEN 250 ELSE 0 END
         AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_deposits d WHERE d.tx = p.tx AND d.nft_id = p.nft_id)
       ORDER BY p.block_height
       LIMIT p_claim
    ), cls AS (
      SELECT t.*,
             EXISTS (SELECT 1 FROM public.sales s
                      WHERE s.collection_id = c_ts AND s.nft_id = t.nft_id
                        AND s.sold_at BETWEEN t.sold_at - interval '2 days' AND t.sold_at + interval '2 days'
                        AND (s.transaction_hash = t.tx
                             OR s.sold_at BETWEEN t.sold_at - interval '1 hour' AND t.sold_at + interval '1 hour')) AS present
        FROM todo t
    ), upd AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET promote_outcome = CASE WHEN c.present THEN 'collector_in_sales' ELSE 'collector_absent' END,
             promoted_at = CASE WHEN c.present THEN now() END
        FROM cls c
       WHERE p.tx = c.tx AND p.nft_id = c.nft_id
      RETURNING c.present
    ), enq AS (
      INSERT INTO public.topshot_collector_sale_requests (kind, tx, nft_id, block_height)
      SELECT 'tx', c.tx, c.nft_id, c.block_height FROM cls c WHERE NOT c.present
      ON CONFLICT (kind, tx, nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*), count(*) FILTER (WHERE present), count(*) FILTER (WHERE NOT present)
      INTO v_claimed, v_present, v_absent
      FROM upd;

    -- 3. DISPATCH: never more than p_max_inflight reads outstanding, oldest first, routed to the
    --    spork that holds the block.
    SELECT count(*) INTO v_inflight FROM public.topshot_collector_sale_requests WHERE status = 'in_flight';
    WITH nxt AS (
      SELECT id FROM public.topshot_collector_sale_requests
       WHERE status = 'pending'
       ORDER BY id
       LIMIT GREATEST(p_max_inflight - v_inflight, 0)
    ), sent AS (
      UPDATE public.topshot_collector_sale_requests q
         SET request_id = CASE WHEN q.kind = 'tx' THEN
               net.http_get(
                 url := CASE WHEN q.block_height <= c_m26_end THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                             ELSE 'http://access-001.mainnet27.nodes.onflow.org:8070' END
                        || '/v1/transaction_results/' || q.tx,
                 params := '{}'::jsonb, headers := '{}'::jsonb, timeout_milliseconds := 20000)
             ELSE
               net.http_post(
                 url := CASE WHEN q.block_height <= c_m26_end THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                             ELSE 'http://access-001.mainnet27.nodes.onflow.org:8070' END
                        || '/v1/scripts?block_height=' || q.block_height,
                 body := jsonb_build_object(
                   'script', translate(encode(convert_to(c_src, 'UTF8'), 'base64'), E'\n', ''),
                   'arguments', jsonb_build_array(
                     translate(encode(convert_to(jsonb_build_object('type', 'Address', 'value', q.owner)::text, 'UTF8'), 'base64'), E'\n', ''),
                     translate(encode(convert_to(jsonb_build_object('type', 'Array', 'value',
                       jsonb_build_array(jsonb_build_object('type', 'UInt64', 'value', q.nft_id)))::text, 'UTF8'), 'base64'), E'\n', ''))),
                 headers := '{"Content-Type":"application/json"}'::jsonb,
                 timeout_milliseconds := 60000)
             END,
             status = 'in_flight', dispatched_at = now()
        FROM nxt
       WHERE q.id = nxt.id
      RETURNING 1
    )
    SELECT count(*) INTO v_dispatched FROM sent;

    -- 4. PROMOTE absent collector purchases whose buyer is known and whose edition is: a source the
    --    live indexer resolved (moments, another sale of the moment), else the chain read mapped to
    --    an edition we carry (a parallel is never folded into its base -> 'edition_missing').
    WITH cand AS (
      SELECT p.tx, p.nft_id, p.price_usd, p.seller, p.buyer, p.block_height, p.sold_at,
             coalesce(
               (SELECT m.edition_id FROM public.moments m WHERE m.nft_id = p.nft_id AND m.collection_id = c_ts AND m.edition_id IS NOT NULL LIMIT 1),
               (SELECT s.edition_id FROM public.sales s WHERE s.nft_id = p.nft_id AND s.collection_id = c_ts AND s.edition_id IS NOT NULL ORDER BY s.sold_at DESC LIMIT 1),
               ed.id) AS edition_id,
             coalesce(
               (SELECT m.serial_number FROM public.moments m WHERE m.nft_id = p.nft_id AND m.collection_id = c_ts AND m.edition_id IS NOT NULL LIMIT 1),
               (SELECT s.serial_number FROM public.sales s WHERE s.nft_id = p.nft_id AND s.collection_id = c_ts AND s.serial_number IS NOT NULL ORDER BY s.sold_at DESC LIMIT 1),
               c.serial_number) AS serial_number,
             (c.nft_id IS NOT NULL) AS chain_read
        FROM public.topshot_sellback_walk_purchases p
        LEFT JOIN public.topshot_chain_moment_reads c ON p.nft_id ~ '^[0-9]{1,18}$' AND c.nft_id = p.nft_id::bigint
        LEFT JOIN public.editions ed
          ON ed.collection_id = c_ts
         AND ed.external_id = CASE WHEN c.subedition_id = 0 THEN c.set_id || ':' || c.play_id
                                   ELSE c.set_id || ':' || c.play_id || '::' || c.subedition_id END
       WHERE p.promote_outcome = 'collector_absent'
         AND p.buyer IS NOT NULL
         AND p.price_usd IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.topshot_collector_sale_requests q
                          WHERE q.kind = 'script' AND q.tx = p.tx AND q.nft_id = p.nft_id AND q.status IN ('pending', 'in_flight'))
       LIMIT 1000
    ), ready AS (
      SELECT * FROM cand WHERE edition_id IS NOT NULL OR chain_read
    ), ins AS (
      INSERT INTO public.sales (edition_id, collection_id, collection, serial_number, price_usd, currency,
                                seller_address, buyer_address, marketplace, transaction_hash, block_height,
                                sold_at, nft_id, source)
      SELECT c.edition_id, c_ts, 'nba_top_shot', c.serial_number, c.price_usd, 'USD',
             c.seller, c.buyer, 'top_shot', c.tx, c.block_height, c.sold_at, c.nft_id,
             'onchain_collector_backfill_2025'
        FROM ready c
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
                                    THEN 'inserted_collector'
                                    WHEN c.edition_id IS NULL THEN 'edition_missing'
                                    ELSE 'already_in_sales' END,
             promoted_at = now()
        FROM ready c
       WHERE p.tx = c.tx AND p.nft_id = c.nft_id
      RETURNING p.promote_outcome
    )
    SELECT (SELECT count(*) FROM ins), (SELECT count(*) FROM marked WHERE promote_outcome = 'edition_missing')
      INTO v_promoted, v_missing;

    -- 5. DONE: the walk is finished (its job gone), nothing is left to classify or read, and no
    --    request is open -> this lane unschedules itself.
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_purchases WHERE promote_outcome IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_purchases WHERE promote_outcome = 'collector_absent')
       AND NOT EXISTS (SELECT 1 FROM public.topshot_collector_sale_requests WHERE status IN ('pending', 'in_flight'))
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-collector-sale-backfill') THEN
      PERFORM cron.unschedule('rpc-topshot-collector-sale-backfill');
    END IF;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-collector-sale-backfill', v_started, v_collected, v_promoted, v_failed,
    v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'buyers', v_buyers, 'buyer_unknown', v_buyer_unknown,
                       'reads_new', v_reads_new, 'chain_not_held', v_not_held, 'throttled', v_throttled,
                       'failed', v_failed, 'claimed', v_claimed, 'present', v_present, 'absent', v_absent,
                       'scripts_enqueued', v_scripts, 'dispatched', v_dispatched, 'inflight_before', v_inflight,
                       'frontier', v_frontier, 'promoted', v_promoted, 'edition_missing', v_missing, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('collected', v_collected, 'buyers', v_buyers, 'buyer_unknown', v_buyer_unknown,
                            'reads_new', v_reads_new, 'chain_not_held', v_not_held, 'throttled', v_throttled,
                            'failed', v_failed, 'claimed', v_claimed, 'present', v_present, 'absent', v_absent,
                            'scripts_enqueued', v_scripts, 'dispatched', v_dispatched, 'promoted', v_promoted,
                            'edition_missing', v_missing, 'error', v_err);
END
$function$;
-- <<< END verbatim <<<

INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '1:2'),
  ('00000000-0000-0000-0000-0000000000e3', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '3:4'),     -- base only: 3:4::2 is NOT carried
  ('00000000-0000-0000-0000-0000000000e5', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '5:6');
INSERT INTO cron.job VALUES ('rpc-topshot-sellback-walk'), ('rpc-topshot-collector-sale-backfill');
INSERT INTO public.topshot_sellback_walk_state VALUES (1, 130302000, 131330000);
-- the walk still has an open page at 130,300,000 (mainnet27): everything below 130,299,750 is fully passed
INSERT INTO public.topshot_sellback_walk_pages (kind, start_height, done_at) VALUES
  ('purchase', 118100000, now()), ('deposit', 118100000, now()), ('purchase', 130300000, NULL), ('deposit', 130300000, now());
INSERT INTO public.moments VALUES ('204', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-0000000000e5', 3);

INSERT INTO public.topshot_sellback_walk_purchases (tx, nft_id, price_usd, seller, block_height, sold_at) VALUES
  ('c201', '201', 2,  '0xs1', 118100100, '2025-06-30 11:00:00+00'),   -- absent; buyer from the tx; edition from the chain
  ('c202', '202', 5,  '0xs2', 118100200, '2025-06-30 11:01:00+00'),   -- already in `sales` (same tx)
  ('c203', '203', 1,  '0xs3', 118100300, '2025-06-30 11:02:00+00'),   -- absent; the tx deposits no 203
  ('c204', '204', 9,  '0xs4', 130290700, '2025-10-22 12:00:00+00'),   -- mainnet27; edition already in `moments`
  ('c205', '205', 1,  '0xs5', 118100400, '2025-06-30 11:04:00+00'),   -- a sell-back (deposit row): not this lane's
  ('c206', '206', 1,  '0xs6', 130299900, '2025-10-22 13:00:00+00'),   -- at the frontier: not yet passed
  ('c207', '207', 3,  '0xs7', 118100500, '2025-06-30 11:05:00+00'),   -- absent; chain names a parallel we do not carry
  ('c208', '208', 4,  '0xs8', 118100600, '2025-06-30 11:06:00+00'),   -- absent; the buyer does not hold it at the block
  ('c209', '209', 6,  '0xs9', 118100700, '2025-06-30 11:07:00+00');   -- absent; the node throttles, then fails
INSERT INTO public.topshot_sellback_walk_deposits VALUES ('c205', '205', 118100400, '2025-06-30 11:04:00+00');
INSERT INTO public.sales (edition_id, collection_id, collection, price_usd, transaction_hash, sold_at, nft_id, source)
VALUES ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 5, 'c202', '2025-06-30 11:01:00+00', '202', 'onchain');

DO $do$
DECLARE r jsonb; q bigint; q2 bigint; q3 bigint; rid bigint;
BEGIN
  -- ── claim 1: classification below the frontier, one tx read each, spork routing, inflight cap
  r := public.run_topshot_collector_sale_backfill(6, 200);
  PERFORM _assert_eq(r->>'error', NULL, 'tick 1 ran clean');
  PERFORM _assert_eq(r->>'claimed' || ':' || (r->>'present') || ':' || (r->>'absent'), '7:1:6', 'seven classified: one present, six absent (claim 1)');
  PERFORM _assert_eq((SELECT string_agg(nft_id || ':' || coalesce(promote_outcome, '-'), ',' ORDER BY nft_id) FROM public.topshot_sellback_walk_purchases),
    '201:collector_absent,202:collector_in_sales,203:collector_absent,204:collector_absent,205:-,206:-,207:collector_absent,208:collector_absent,209:collector_absent',
    'a sell-back and a frontier row are untouched; the present row needs no read (claim 1)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_collector_sale_requests WHERE kind = 'tx'), '6', 'one tx read per absent row');
  PERFORM _assert_eq(r->>'dispatched', '6', 'all six tx reads out under p_max_inflight = 6');
  PERFORM _assert_eq((SELECT s.url FROM net._sent s JOIN public.topshot_collector_sale_requests q ON q.request_id = s.id WHERE q.nft_id = '201'),
    'http://access-001.mainnet26.nodes.onflow.org:8070/v1/transaction_results/c201', 'mainnet26 tx routed to mainnet26');
  PERFORM _assert_eq((SELECT s.url FROM net._sent s JOIN public.topshot_collector_sale_requests q ON q.request_id = s.id WHERE q.nft_id = '204'),
    'http://access-001.mainnet27.nodes.onflow.org:8070/v1/transaction_results/c204', 'mainnet27 tx routed to mainnet27');
  r := public.run_topshot_collector_sale_backfill(3, 200);
  PERFORM _assert_eq(r->>'dispatched', '0', 'nothing more while ≥ p_max_inflight are in flight (claim 1)');
  PERFORM _assert_eq(r->>'claimed', '0', 'nothing re-classified');

  -- ── claim 2: the buyer is THIS moment's deposit; no deposit → buyer_unknown; the script is skipped when the DB knows the edition
  SELECT request_id INTO q  FROM public.topshot_collector_sale_requests WHERE nft_id = '201';
  SELECT request_id INTO q2 FROM public.topshot_collector_sale_requests WHERE nft_id = '203';
  SELECT request_id INTO q3 FROM public.topshot_collector_sale_requests WHERE nft_id = '204';
  INSERT INTO net._http_response (id, status_code, content) VALUES
    (q,  200, pg_temp.txres(pg_temp.dep('999', '0x00000000000000zz') || ',' || pg_temp.dep('201', '0x00000000000000b1'))),
    (q2, 200, pg_temp.txres(pg_temp.dep('999', '0x00000000000000zz'))),
    (q3, 200, pg_temp.txres(pg_temp.dep('204', '0x00000000000000b4')));
  r := public.run_topshot_collector_sale_backfill(6, 200);
  PERFORM _assert_eq(r->>'error', NULL, 'tick 3 ran clean');
  PERFORM _assert_eq((r->>'collected') || ':' || (r->>'buyers') || ':' || (r->>'buyer_unknown'), '3:2:1', 'two buyers named, one unknown (claim 2)');
  PERFORM _assert_eq((SELECT buyer FROM public.topshot_sellback_walk_purchases WHERE nft_id = '201'), '0x00000000000000b1', 'buyer = the deposit of THIS moment, not the other id in the tx (claim 2)');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '203'), 'buyer_unknown', 'no deposit for the moment → buyer_unknown (claim 2)');
  PERFORM _assert_eq(r->>'scripts_enqueued', '1', 'one script: 201 only — 204 is named by moments (claim 2)');
  PERFORM _assert_eq((SELECT owner || '@' || block_height FROM public.topshot_collector_sale_requests WHERE kind = 'script' AND nft_id = '201'),
    '0x00000000000000b1@118100100', 'the script reads the BUYER at the PURCHASE block (claim 2)');
  -- 204 promoted straight from the DB edition, with the buyer
  PERFORM _assert_eq((SELECT edition_id::text || ':' || serial_number || ':' || buyer_address || ':' || seller_address || ':' || source || ':' || price_usd FROM public.sales WHERE nft_id = '204'),
    '00000000-0000-0000-0000-0000000000e5:3:0x00000000000000b4:0xs4:onchain_collector_backfill_2025:9', 'DB-named edition promoted with the buyer (claim 3)');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '204'), 'inserted_collector', '204 inserted');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '201'), 'collector_absent', '201 waits for its script');
  PERFORM _assert_eq(r->>'dispatched', '1', 'only the new script goes out; 207/208/209 are still in flight');

  -- ── claim 4 (429) + the remaining buyers
  SELECT request_id INTO q  FROM public.topshot_collector_sale_requests WHERE nft_id = '207' AND kind = 'tx';
  SELECT request_id INTO q2 FROM public.topshot_collector_sale_requests WHERE nft_id = '208' AND kind = 'tx';
  SELECT request_id INTO q3 FROM public.topshot_collector_sale_requests WHERE nft_id = '209' AND kind = 'tx';
  INSERT INTO net._http_response (id, status_code, content) VALUES
    (q,  200, pg_temp.txres(pg_temp.dep('207', '0x00000000000000b7'))),
    (q2, 200, pg_temp.txres(pg_temp.dep('208', '0x00000000000000b8'))),
    (q3, 429, 'too many requests');
  r := public.run_topshot_collector_sale_backfill(6, 200);
  PERFORM _assert_eq(r->>'throttled', '1', 'throttle counted (claim 4)');
  PERFORM _assert_eq((SELECT attempts || ':' || last_error FROM public.topshot_collector_sale_requests WHERE nft_id = '209' AND kind = 'tx'),
    '0:http 429', 'a 429 spends no attempt (claim 4)');
  PERFORM _assert_eq(r->>'scripts_enqueued', '2', 'scripts for 207 and 208');
  PERFORM _assert_eq(r->>'dispatched', '3', 'oldest pending first: 209 again, then the 207 and 208 scripts');
  PERFORM _assert_eq((SELECT s.url FROM net._sent s JOIN public.topshot_collector_sale_requests q ON q.request_id = s.id WHERE q.kind = 'script' AND q.nft_id = '201'),
    'http://access-001.mainnet26.nodes.onflow.org:8070/v1/scripts?block_height=118100100', 'script routed by spork at the purchase block');
  PERFORM _assert_eq((SELECT convert_from(decode(s.body->'arguments'->>0, 'base64'), 'UTF8')::jsonb->>'value'
                        FROM net._sent s JOIN public.topshot_collector_sale_requests q ON q.request_id = s.id WHERE q.kind = 'script' AND q.nft_id = '201'),
    '0x00000000000000b1', 'the script argument is the buyer');

  -- ── claim 3: chain-named edition promoted with the chain serial; a parallel is edition_missing
  SELECT request_id INTO q  FROM public.topshot_collector_sale_requests WHERE nft_id = '201' AND kind = 'script';
  SELECT request_id INTO q2 FROM public.topshot_collector_sale_requests WHERE nft_id = '207' AND kind = 'script';
  SELECT request_id INTO q3 FROM public.topshot_collector_sale_requests WHERE nft_id = '209' AND kind = 'tx';
  INSERT INTO net._http_response (id, status_code, content) VALUES
    (q,  200, pg_temp.dict(pg_temp.ent(201, 1, 2, 7, 0))),
    (q2, 200, pg_temp.dict(pg_temp.ent(207, 3, 4, 9, 2))),
    (q3, 500, 'boom');
  r := public.run_topshot_collector_sale_backfill(6, 200);
  PERFORM _assert_eq(r->>'error', NULL, 'tick 5 ran clean');
  PERFORM _assert_eq(r->>'reads_new', '2', 'two chain reads stored (claim 3)');
  PERFORM _assert_eq((SELECT owner_address || ':' || block_height FROM public.topshot_chain_moment_reads WHERE nft_id = 201),
    '0x00000000000000b1:118100100', 'read provenance = the buyer at the purchase block');
  PERFORM _assert_eq((SELECT edition_id::text || ':' || serial_number || ':' || buyer_address || ':' || source || ':' || price_usd FROM public.sales WHERE nft_id = '201'),
    '00000000-0000-0000-0000-0000000000e1:7:0x00000000000000b1:onchain_collector_backfill_2025:2', 'carried edition promoted with the chain serial and the buyer (claim 3)');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '201'), 'inserted_collector', '201 inserted');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '207'), 'edition_missing', 'a parallel is never folded into its base (claim 3)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id = '207'), '0', 'nothing guessed for the parallel');
  PERFORM _assert_eq((SELECT attempts::text FROM public.topshot_collector_sale_requests WHERE nft_id = '209' AND kind = 'tx'), '1', 'a 500 spends an attempt (claim 4)');

  -- ── claim 3: an empty read at the purchase block is final
  SELECT request_id INTO q FROM public.topshot_collector_sale_requests WHERE nft_id = '208' AND kind = 'script';
  IF q IS NULL THEN
    UPDATE public.topshot_collector_sale_requests SET status = 'in_flight', request_id = 9001, dispatched_at = now() WHERE nft_id = '208' AND kind = 'script';
    q := 9001;
  END IF;
  INSERT INTO net._http_response (id, status_code, content) VALUES (q, 200, pg_temp.dict(''));
  r := public.run_topshot_collector_sale_backfill(3, 200);
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '208'), 'chain_not_held', 'buyer does not hold it at the block → chain_not_held (claim 3)');
  PERFORM _assert_eq(r->>'chain_not_held', '1', 'counted');

  -- ── claim 3: nothing is duplicated on a re-run
  r := public.run_topshot_collector_sale_backfill(3, 200);
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id IN ('201', '204')), '2', 'no duplicate on re-run (claim 3)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id = '202'), '1', 'the present row was never re-written');

  -- ── claim 4: the 6th failure closes the request and the row
  SELECT id INTO rid FROM public.topshot_collector_sale_requests WHERE nft_id = '209' AND kind = 'tx';
  UPDATE public.topshot_collector_sale_requests SET attempts = 5, status = 'in_flight', request_id = 9002, dispatched_at = now() WHERE id = rid;
  INSERT INTO net._http_response (id, status_code, content) VALUES (9002, 500, 'boom');
  r := public.run_topshot_collector_sale_backfill(3, 200);
  PERFORM _assert_eq((SELECT status || ':' || attempts FROM public.topshot_collector_sale_requests WHERE id = rid), 'failed:6', 'the 6th failure closes the request (claim 4)');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '209'), 'buyer_fetch_failed', 'the row is closed, visibly, never guessed (claim 4)');

  -- ── claim 5: not done while rows are unclassified; done once the walk is gone and nothing is open
  PERFORM _assert_eq((SELECT count(*)::text FROM cron.job WHERE jobname = 'rpc-topshot-collector-sale-backfill'), '1', 'still scheduled while 205/206 are unclassified');
  DELETE FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk';
  UPDATE public.topshot_sellback_walk_pages SET done_at = now() WHERE done_at IS NULL;
  UPDATE public.topshot_sellback_walk_purchases SET promote_outcome = 'inserted', promoted_at = now() WHERE nft_id = '205';
  -- 2026-10-10 (#167): a purchase INSIDE the old 250-block margin of the final frontier
  -- (130,302,000), with the walk gone, must still be classified, or the lane never ends.
  INSERT INTO public.topshot_sellback_walk_purchases (tx, nft_id, price_usd, seller, block_height, sold_at)
  VALUES ('c210', '210', 2, '0xs10', 130301900, '2025-10-22 14:00:00+00');
  INSERT INTO public.sales (edition_id, collection_id, collection, price_usd, transaction_hash, sold_at, nft_id, source)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 2, 'c210', '2025-10-22 14:00:00+00', '210', 'onchain');
  INSERT INTO public.sales (edition_id, collection_id, collection, price_usd, transaction_hash, sold_at, nft_id, source)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', 1, 'c206', '2025-10-22 13:00:00+00', '206', 'onchain');
  r := public.run_topshot_collector_sale_backfill(3, 200);
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '206'), 'collector_in_sales', 'the frontier row is classified once the walk has passed it');
  PERFORM _assert_eq((SELECT promote_outcome FROM public.topshot_sellback_walk_purchases WHERE nft_id = '210'), 'collector_in_sales', 'with the walk gone, a row inside the old 250-block margin is classified too (#167)');
  PERFORM _assert_eq((SELECT count(*)::text FROM cron.job WHERE jobname = 'rpc-topshot-collector-sale-backfill'), '0', 'lane unschedules itself when nothing is left (claim 5)');
END
$do$;

ROLLBACK;
