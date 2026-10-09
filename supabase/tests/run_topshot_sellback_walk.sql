-- DB invariant: public.run_topshot_sellback_walk — the throttled walk that backfills Top Shot
-- sell-backs to Dapper's buy-back wallet (Jul–Oct 2025, known-issues #167). Claims:
--   1. a TopShotMarketV3 purchase whose moment is deposited into 0xe1f2a091f7bb5245 in the same tx
--      is a sell-back; a purchase deposited anywhere else is not;
--   2. a sell-back enters `sales` ONLY with an edition resolved from `moments` / another sale,
--      buyer = the buy-back wallet, source 'onchain_sellback_backfill_2025'; an unresolvable one is
--      staged as 'unresolved_edition', never written; one already in `sales` is not duplicated;
--   3. a non-200 page is re-queued with attempts+1; after 8 failures it is closed as failed;
--   4. never more than p_max_inflight requests are outstanding;
--   5. (2026-10-09) a 200 page carrying an event with no id is NOT read as complete: nothing from it
--      is kept, it is re-queued with attempts+1 and the reason, the run does not abort, and a clean
--      re-fetch then lands the page.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261009162520_audit_20261009_sellback_walk_retries_a_page_with_idless_events.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, timed_out boolean, error_msg text);
CREATE SEQUENCE net._req_seq START 1000;
CREATE FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds int) RETURNS bigint
  LANGUAGE sql AS $$ SELECT nextval('net._req_seq') $$;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobname text);
CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;

CREATE TABLE public.moments (nft_id varchar, collection_id uuid, edition_id uuid, serial_number int);
CREATE TABLE public.sales (id uuid DEFAULT gen_random_uuid(), edition_id uuid, collection_id uuid, collection text, serial_number int,
  price_usd numeric, currency text, seller_address text, buyer_address text, marketplace text, transaction_hash text,
  block_height bigint, sold_at timestamptz, nft_id varchar, source text);
CREATE FUNCTION public.log_pipeline_run(text, timestamptz, integer, integer, integer, boolean, text, text, text, text, jsonb)
  RETURNS void LANGUAGE sql AS $$ SELECT NULL::void $$;

CREATE TABLE public.topshot_sellback_walk_state (id int PRIMARY KEY, next_height bigint NOT NULL, end_height bigint NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.topshot_sellback_walk_pages (kind text NOT NULL, start_height bigint NOT NULL, req_id bigint, issued_at timestamptz,
  attempts int NOT NULL DEFAULT 0, last_status int, last_error text, failed boolean NOT NULL DEFAULT false, done_at timestamptz, PRIMARY KEY (kind, start_height));
CREATE TABLE public.topshot_sellback_walk_purchases (tx text NOT NULL, nft_id text NOT NULL, price_usd numeric, seller text, block_height bigint,
  sold_at timestamptz, promoted_at timestamptz, promote_outcome text, PRIMARY KEY (tx, nft_id));
CREATE TABLE public.topshot_sellback_walk_deposits (tx text NOT NULL, nft_id text NOT NULL, block_height bigint, deposited_at timestamptz, PRIMARY KEY (tx, nft_id));

-- >>> BEGIN verbatim >>>
CREATE OR REPLACE FUNCTION public.run_topshot_sellback_walk(p_max_inflight integer DEFAULT 16)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_buyback   CONSTANT text := '0xe1f2a091f7bb5245';
  c_ts        CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_m26_end   CONSTANT bigint := 130290658;
  v_started   timestamptz := clock_timestamp();
  v_state     public.topshot_sellback_walk_state%ROWTYPE;
  v_harvested int := 0;
  v_retried   int := 0;
  v_failed    int := 0;
  v_issued    int := 0;
  v_inflight  int := 0;
  v_room      int := 0;
  v_purch     int := 0;
  v_dep       int := 0;
  v_promoted  int := 0;
  v_page      record;
  v_err       text;
  v_noid      int := 0;
  v_noid_pages int := 0;
BEGIN
  BEGIN
    SELECT * INTO v_state FROM public.topshot_sellback_walk_state WHERE id = 1 FOR UPDATE;

    -- 1. HARVEST every in-flight page whose response has arrived. A 200 is parsed and closed;
    --    anything else (429, 5xx, a pg_net timeout row with NULL status) is re-queued, and a
    --    page that has failed 8 times is closed as FAILED so it is visible, never silently lost.
    FOR v_page IN
      SELECT p.kind, p.start_height, p.req_id, r.status_code, r.content, r.timed_out, r.error_msg
        FROM public.topshot_sellback_walk_pages p
        JOIN net._http_response r ON r.id = p.req_id
       WHERE p.done_at IS NULL AND p.req_id IS NOT NULL
    LOOP
      -- 2026-10-09: a 200 page carrying an event with no `id` field cannot be keyed (nft_id is
      -- NOT NULL). It used to abort the whole run on every tick until pg_net expired the response
      -- row (~6 h: 10-06 and 10-08, ~360 failed ticks each). Such a page is NOT read as complete:
      -- it takes the retry path below (re-fetched, closed as failed after 8 attempts).
      v_noid := 0;
      IF v_page.status_code = 200 THEN
        SELECT count(*) INTO v_noid
          FROM jsonb_array_elements(v_page.content::jsonb) b,
               jsonb_array_elements(b->'events') e,
               LATERAL (SELECT convert_from(decode(e->>'payload', 'base64'), 'utf8')::jsonb AS pl) x
         WHERE (SELECT fl->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'id') IS NULL;
      END IF;
      IF v_page.status_code = 200 AND v_noid = 0 THEN
        IF v_page.kind = 'purchase' THEN
          INSERT INTO public.topshot_sellback_walk_purchases (tx, nft_id, price_usd, seller, block_height, sold_at)
          SELECT e->>'transaction_id',
                 (SELECT fl->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'id'),
                 (SELECT (fl->'value'->>'value')::numeric FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'price'),
                 (SELECT coalesce(fl->'value'->'value'->>'value', fl->'value'->>'value') FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'seller'),
                 (b->>'block_height')::bigint,
                 (b->>'block_timestamp')::timestamptz
            FROM jsonb_array_elements(v_page.content::jsonb) b,
                 jsonb_array_elements(b->'events') e,
                 LATERAL (SELECT convert_from(decode(e->>'payload', 'base64'), 'utf8')::jsonb AS pl) x
          ON CONFLICT (tx, nft_id) DO NOTHING;
        ELSE
          -- Deposits are kept ONLY when they land in the buy-back wallet: that is the population.
          INSERT INTO public.topshot_sellback_walk_deposits (tx, nft_id, block_height, deposited_at)
          SELECT d.tx, d.nft_id, d.h, d.ts
            FROM (
              SELECT e->>'transaction_id' AS tx,
                     (SELECT fl->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'id') AS nft_id,
                     (SELECT coalesce(fl->'value'->'value'->>'value', fl->'value'->>'value') FROM jsonb_array_elements(pl->'value'->'fields') fl WHERE fl->>'name' = 'to') AS to_addr,
                     (b->>'block_height')::bigint AS h,
                     (b->>'block_timestamp')::timestamptz AS ts
                FROM jsonb_array_elements(v_page.content::jsonb) b,
                     jsonb_array_elements(b->'events') e,
                     LATERAL (SELECT convert_from(decode(e->>'payload', 'base64'), 'utf8')::jsonb AS pl) x
            ) d
           WHERE d.to_addr = c_buyback
          ON CONFLICT (tx, nft_id) DO NOTHING;
        END IF;
        UPDATE public.topshot_sellback_walk_pages
           SET done_at = now(), last_status = 200
         WHERE kind = v_page.kind AND start_height = v_page.start_height;
        v_harvested := v_harvested + 1;
      ELSE
        UPDATE public.topshot_sellback_walk_pages
           SET req_id = NULL,
               attempts = attempts + 1,
               last_status = v_page.status_code,
               last_error = left(CASE WHEN v_noid > 0 THEN v_noid || ' event(s) without an id in a 200 page'
                                      ELSE coalesce(v_page.error_msg, CASE WHEN v_page.timed_out THEN 'timed out' END, 'HTTP ' || v_page.status_code) END, 200),
               done_at = CASE WHEN attempts + 1 >= 8 THEN now() END,
               failed = (attempts + 1 >= 8)
         WHERE kind = v_page.kind AND start_height = v_page.start_height;
        v_retried := v_retried + 1;
        IF v_noid > 0 THEN v_noid_pages := v_noid_pages + 1; END IF;
      END IF;
    END LOOP;

    -- A request whose response row never appeared (pg_net drops rows after its TTL) is re-queued
    -- after 15 minutes rather than waiting forever.
    UPDATE public.topshot_sellback_walk_pages
       SET req_id = NULL, attempts = attempts + 1, last_error = 'no response row after 15 min'
     WHERE done_at IS NULL AND req_id IS NOT NULL AND issued_at < now() - interval '15 minutes'
       AND NOT EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = req_id);

    SELECT count(*) FILTER (WHERE failed) INTO v_failed FROM public.topshot_sellback_walk_pages;

    -- 2. ENQUEUE new ranges (both event kinds per 250-block page) until the queue is ahead of the
    --    issue rate, then ISSUE: retries first, then the oldest new pages, never more than
    --    p_max_inflight requests outstanding (the historical node 429s above ~20 concurrent).
    IF v_state.next_height <= v_state.end_height
       AND (SELECT count(*) FROM public.topshot_sellback_walk_pages WHERE done_at IS NULL AND req_id IS NULL) < p_max_inflight THEN
      INSERT INTO public.topshot_sellback_walk_pages (kind, start_height)
      SELECT k, s
        FROM generate_series(v_state.next_height, LEAST(v_state.next_height + 250 * 8 - 1, v_state.end_height), 250) s,
             unnest(ARRAY['purchase', 'deposit']) k
      ON CONFLICT DO NOTHING;
      UPDATE public.topshot_sellback_walk_state
         SET next_height = LEAST(v_state.next_height + 250 * 8, v_state.end_height + 1), updated_at = now()
       WHERE id = 1;
    END IF;

    SELECT count(*) INTO v_inflight FROM public.topshot_sellback_walk_pages WHERE done_at IS NULL AND req_id IS NOT NULL;
    v_room := GREATEST(p_max_inflight - v_inflight, 0);

    WITH next_pages AS (
      SELECT kind, start_height
        FROM public.topshot_sellback_walk_pages
       WHERE done_at IS NULL AND req_id IS NULL
       ORDER BY attempts DESC, start_height
       LIMIT v_room
    ), issued AS (
      UPDATE public.topshot_sellback_walk_pages p
         SET req_id = net.http_get(
               format('%s/v1/events?type=%s&start_height=%s&end_height=%s',
                      CASE WHEN p.start_height <= c_m26_end THEN 'http://access-001.mainnet26.nodes.onflow.org:8070'
                           ELSE 'http://access-001.mainnet27.nodes.onflow.org:8070' END,
                      CASE p.kind WHEN 'purchase' THEN 'A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased'
                                  ELSE 'A.0b2a3299cc857e29.TopShot.Deposit' END,
                      p.start_height,
                      -- a page never straddles the spork boundary: each node only knows its own blocks
                      CASE WHEN p.start_height <= c_m26_end THEN LEAST(p.start_height + 249, c_m26_end)
                           ELSE p.start_height + 249 END),
               '{}'::jsonb, '{}'::jsonb, 20000),
             issued_at = now()
        FROM next_pages n
       WHERE p.kind = n.kind AND p.start_height = n.start_height
      RETURNING 1
    )
    SELECT count(*) INTO v_issued FROM issued;

    -- 3. PROMOTE: a V3 purchase whose moment was deposited into the buy-back wallet in the same
    --    tx is a sell-back. It goes into `sales` only when its edition resolves from a source the
    --    live indexer already resolved (moments, then another sale of the same moment), and only
    --    if `sales` does not already hold that (tx, moment). Unresolved rows stay staged and are
    --    counted; they are never written with a guessed edition.
    WITH cand AS (
      SELECT p.tx, p.nft_id, p.price_usd, p.seller, p.block_height, p.sold_at,
             coalesce(
               (SELECT m.edition_id FROM public.moments m
                 WHERE m.nft_id = p.nft_id AND m.collection_id = c_ts LIMIT 1),
               (SELECT s.edition_id FROM public.sales s
                 WHERE s.nft_id = p.nft_id AND s.collection_id = c_ts ORDER BY s.sold_at DESC LIMIT 1)
             ) AS edition_id,
             coalesce(
               (SELECT m.serial_number FROM public.moments m
                 WHERE m.nft_id = p.nft_id AND m.collection_id = c_ts LIMIT 1),
               (SELECT s.serial_number FROM public.sales s
                 WHERE s.nft_id = p.nft_id AND s.collection_id = c_ts AND s.serial_number IS NOT NULL ORDER BY s.sold_at DESC LIMIT 1)
             ) AS serial_number
        FROM public.topshot_sellback_walk_purchases p
        JOIN public.topshot_sellback_walk_deposits d ON d.tx = p.tx AND d.nft_id = p.nft_id
       WHERE p.promoted_at IS NULL
         AND p.price_usd IS NOT NULL
       LIMIT 500
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
      -- defensive: a unique-index collision (idx_sales_tx_nft_sold) must skip the row, not abort every tick
      ON CONFLICT DO NOTHING
      RETURNING nft_id, transaction_hash
    ), marked AS (
      UPDATE public.topshot_sellback_walk_purchases p
         SET promoted_at = now(),
             promote_outcome = CASE WHEN EXISTS (SELECT 1 FROM ins WHERE ins.nft_id = p.nft_id AND ins.transaction_hash = p.tx)
                                    THEN 'inserted'
                                    WHEN c.edition_id IS NULL THEN 'unresolved_edition'
                                    ELSE 'already_in_sales' END
        FROM cand c
       WHERE p.tx = c.tx AND p.nft_id = c.nft_id
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins) INTO v_promoted;

    -- 4. DONE: every range enqueued and every page closed -> the lane unschedules itself.
    IF (SELECT next_height > end_height FROM public.topshot_sellback_walk_state WHERE id = 1)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_pages WHERE done_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.topshot_sellback_walk_purchases p
                         JOIN public.topshot_sellback_walk_deposits d ON d.tx = p.tx AND d.nft_id = p.nft_id
                        WHERE p.promoted_at IS NULL)
       AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-sellback-walk') THEN
      PERFORM cron.unschedule('rpc-topshot-sellback-walk');
    END IF;

    SELECT count(*) INTO v_purch FROM public.topshot_sellback_walk_purchases;
    SELECT count(*) INTO v_dep FROM public.topshot_sellback_walk_deposits;
  EXCEPTION WHEN query_canceled OR OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;

  PERFORM public.log_pipeline_run('topshot-sellback-walk', v_started, v_harvested, v_promoted, v_retried,
    v_err IS NULL, v_err, 'nba_top_shot', NULL,
    (SELECT next_height::text FROM public.topshot_sellback_walk_state WHERE id = 1),
    jsonb_build_object('harvested', v_harvested, 'retried', v_retried, 'issued', v_issued, 'inflight_before', v_inflight,
                       'failed_pages', v_failed, 'purchases', v_purch, 'buyback_deposits', v_dep,
                       'promoted', v_promoted, 'pages_with_idless_events', v_noid_pages, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('harvested', v_harvested, 'retried', v_retried, 'issued', v_issued,
                            'failed_pages', v_failed, 'promoted', v_promoted, 'error', v_err);
END
$function$;

-- <<< END verbatim <<<

INSERT INTO public.topshot_sellback_walk_state VALUES (1, 118100000, 118100499);
INSERT INTO cron.job VALUES ('rpc-topshot-sellback-walk');
INSERT INTO public.moments VALUES ('111', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '00000000-0000-0000-0000-00000000e111', 77);
INSERT INTO public.sales (edition_id, collection_id, nft_id, transaction_hash, sold_at, price_usd, source)
VALUES ('00000000-0000-0000-0000-00000000e444', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '444', 'tx4', '2025-07-01T00:00:00Z', 2, 'ts_history_backfill_v1');

DO $do$
DECLARE r jsonb;
BEGIN
  -- tick 1: enqueue the 2 pages x 2 kinds and issue at most 3 (the cap)
  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert_eq(r->>'issued', '3', 'issue respects p_max_inflight (claim 4)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_sellback_walk_pages), '4', 'two 250-block pages x two event kinds enqueued');
  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert_eq(r->>'issued', '0', 'nothing more issued while 3 are in flight (claim 4)');

  -- responses: page 118100000 purchase + deposit OK; page 118100250's in-flight one 429s
  INSERT INTO net._http_response (id, status_code, content)
  SELECT req_id, CASE WHEN start_height = 118100000 THEN 200 ELSE 429 END,
         CASE WHEN start_height <> 118100000 THEN 'rate limited'
              WHEN kind = 'purchase' THEN '[{"block_height": "118100010", "block_timestamp": "2025-07-01T00:00:00Z", "events": [{"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx1", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICIxMTEifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiMS4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czEifX19XX19"}, {"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx2", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICIyMjIifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiOS4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czIifX19XX19"}, {"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx3", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICIzMzMifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiNS4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czMifX19XX19"}, {"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx4", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICI0NDQifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiMi4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czQifX19XX19"}]}]' ELSE '[{"block_height": "118100010", "block_timestamp": "2025-07-01T00:00:00Z", "events": [{"type": "A.0b2a3299cc857e29.TopShot.Deposit", "transaction_id": "tx1", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLjBiMmEzMjk5Y2M4NTdlMjkuVG9wU2hvdC5EZXBvc2l0IiwgImZpZWxkcyI6IFt7Im5hbWUiOiAiaWQiLCAidmFsdWUiOiB7InR5cGUiOiAiVUludDY0IiwgInZhbHVlIjogIjExMSJ9fSwgeyJuYW1lIjogInRvIiwgInZhbHVlIjogeyJ0eXBlIjogIk9wdGlvbmFsIiwgInZhbHVlIjogeyJ0eXBlIjogIkFkZHJlc3MiLCAidmFsdWUiOiAiMHhlMWYyYTA5MWY3YmI1MjQ1In19fV19fQ=="}, {"type": "A.0b2a3299cc857e29.TopShot.Deposit", "transaction_id": "tx2", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLjBiMmEzMjk5Y2M4NTdlMjkuVG9wU2hvdC5EZXBvc2l0IiwgImZpZWxkcyI6IFt7Im5hbWUiOiAiaWQiLCAidmFsdWUiOiB7InR5cGUiOiAiVUludDY0IiwgInZhbHVlIjogIjIyMiJ9fSwgeyJuYW1lIjogInRvIiwgInZhbHVlIjogeyJ0eXBlIjogIk9wdGlvbmFsIiwgInZhbHVlIjogeyJ0eXBlIjogIkFkZHJlc3MiLCAidmFsdWUiOiAiMHhlMWYyYTA5MWY3YmI1MjQ1In19fV19fQ=="}, {"type": "A.0b2a3299cc857e29.TopShot.Deposit", "transaction_id": "tx3", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLjBiMmEzMjk5Y2M4NTdlMjkuVG9wU2hvdC5EZXBvc2l0IiwgImZpZWxkcyI6IFt7Im5hbWUiOiAiaWQiLCAidmFsdWUiOiB7InR5cGUiOiAiVUludDY0IiwgInZhbHVlIjogIjMzMyJ9fSwgeyJuYW1lIjogInRvIiwgInZhbHVlIjogeyJ0eXBlIjogIk9wdGlvbmFsIiwgInZhbHVlIjogeyJ0eXBlIjogIkFkZHJlc3MiLCAidmFsdWUiOiAiMHhjb2xsZWN0b3IifX19XX19"}, {"type": "A.0b2a3299cc857e29.TopShot.Deposit", "transaction_id": "tx4", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLjBiMmEzMjk5Y2M4NTdlMjkuVG9wU2hvdC5EZXBvc2l0IiwgImZpZWxkcyI6IFt7Im5hbWUiOiAiaWQiLCAidmFsdWUiOiB7InR5cGUiOiAiVUludDY0IiwgInZhbHVlIjogIjQ0NCJ9fSwgeyJuYW1lIjogInRvIiwgInZhbHVlIjogeyJ0eXBlIjogIk9wdGlvbmFsIiwgInZhbHVlIjogeyJ0eXBlIjogIkFkZHJlc3MiLCAidmFsdWUiOiAiMHhlMWYyYTA5MWY3YmI1MjQ1In19fV19fQ=="}]}]' END
    FROM public.topshot_sellback_walk_pages WHERE req_id IS NOT NULL;

  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert_eq((SELECT string_agg(nft_id, ',' ORDER BY nft_id) FROM public.topshot_sellback_walk_deposits), '111,222,444',
    'only deposits INTO the buy-back wallet are kept (claim 1)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_sellback_walk_purchases), '4', 'every V3 purchase is parsed');
  PERFORM _assert_eq((SELECT string_agg(nft_id || ':' || price_usd::text || ':' || buyer_address || ':' || source || ':' || serial_number::text, ',')
                        FROM public.sales WHERE source = 'onchain_sellback_backfill_2025'),
    '111:1.00000000:0xe1f2a091f7bb5245:onchain_sellback_backfill_2025:77', 'the resolvable sell-back is inserted with its edition, buyer and serial (claim 2)');
  PERFORM _assert_eq((SELECT edition_id::text FROM public.sales WHERE nft_id = '111'), '00000000-0000-0000-0000-00000000e111', 'edition from moments (claim 2)');
  PERFORM _assert_eq((SELECT string_agg(nft_id || ':' || promote_outcome, ',' ORDER BY nft_id) FROM public.topshot_sellback_walk_purchases WHERE promoted_at IS NOT NULL),
    '111:inserted,222:unresolved_edition,444:already_in_sales', 'unresolvable staged, existing not duplicated, collector purchase untouched (claims 1-2)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id = '444'), '1', 'no duplicate of a sale already present (claim 2)');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.sales WHERE nft_id IN ('222', '333')), '0', 'no guessed edition, no collector purchase written (claims 1-2)');
  PERFORM _assert_eq((SELECT attempts::text || ':' || coalesce(last_status::text, '') FROM public.topshot_sellback_walk_pages
                       WHERE start_height = 118100250 AND attempts > 0 LIMIT 1), '1:429', 'a 429 page is re-queued with attempts+1 (claim 3)');

  -- a page that keeps failing is closed as failed at the 8th attempt
  UPDATE public.topshot_sellback_walk_pages SET attempts = 7 WHERE start_height = 118100250 AND attempts = 1;
  INSERT INTO net._http_response (id, status_code, content)
  SELECT req_id, 503, 'x' FROM public.topshot_sellback_walk_pages p
   WHERE req_id IS NOT NULL AND done_at IS NULL AND NOT EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = p.req_id);
  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert((SELECT bool_or(failed) FROM public.topshot_sellback_walk_pages WHERE start_height = 118100250), 'an 8th failure closes the page as failed (claim 3)');

  -- claim 5: a 200 purchase page with one good event (555) and one with no id
  INSERT INTO public.topshot_sellback_walk_pages (kind, start_height, req_id, issued_at) VALUES ('purchase', 118200000, 5000, now());
  INSERT INTO net._http_response (id, status_code, content) VALUES (5000, 200, '[{"block_height": "118200010", "block_timestamp": "2025-07-02T00:00:00Z", "events": [{"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx5", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICI1NTUifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiMy4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czUifX19XX19"}, {"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx6", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogInByaWNlIiwgInZhbHVlIjogeyJ0eXBlIjogIlVGaXg2NCIsICJ2YWx1ZSI6ICI0LjAwMDAwMDAwIn19LCB7Im5hbWUiOiAic2VsbGVyIiwgInZhbHVlIjogeyJ0eXBlIjogIk9wdGlvbmFsIiwgInZhbHVlIjogeyJ0eXBlIjogIkFkZHJlc3MiLCAidmFsdWUiOiAiMHhzNiJ9fX1dfX0="}]}]');
  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert(r->>'error' IS NULL, 'claim 5: an id-less event does not abort the run');
  PERFORM _assert_eq((SELECT (done_at IS NULL)::text || ':' || attempts || ':' || last_status || ':' || last_error
                        FROM public.topshot_sellback_walk_pages WHERE start_height = 118200000),
    'true:1:200:1 event(s) without an id in a 200 page', 'claim 5: the page is re-queued with the reason, not closed');
  PERFORM _assert_eq((SELECT count(*)::text FROM public.topshot_sellback_walk_purchases WHERE tx IN ('tx5', 'tx6')), '0',
    'claim 5: nothing from a page that cannot be read whole is kept');
  -- the re-fetch is clean: the page lands
  UPDATE public.topshot_sellback_walk_pages SET req_id = 5001, issued_at = now() WHERE start_height = 118200000;
  INSERT INTO net._http_response (id, status_code, content) VALUES (5001, 200, '[{"block_height": "118200010", "block_timestamp": "2025-07-02T00:00:00Z", "events": [{"type": "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased", "transaction_id": "tx5", "payload": "eyJ0eXBlIjogIkV2ZW50IiwgInZhbHVlIjogeyJpZCI6ICJBLmMxZTRmNGY0YzQyNTc1MTAuVG9wU2hvdE1hcmtldFYzLk1vbWVudFB1cmNoYXNlZCIsICJmaWVsZHMiOiBbeyJuYW1lIjogImlkIiwgInZhbHVlIjogeyJ0eXBlIjogIlVJbnQ2NCIsICJ2YWx1ZSI6ICI1NTUifX0sIHsibmFtZSI6ICJwcmljZSIsICJ2YWx1ZSI6IHsidHlwZSI6ICJVRml4NjQiLCAidmFsdWUiOiAiMy4wMDAwMDAwMCJ9fSwgeyJuYW1lIjogInNlbGxlciIsICJ2YWx1ZSI6IHsidHlwZSI6ICJPcHRpb25hbCIsICJ2YWx1ZSI6IHsidHlwZSI6ICJBZGRyZXNzIiwgInZhbHVlIjogIjB4czUifX19XX19"}]}]');
  r := public.run_topshot_sellback_walk(3);
  PERFORM _assert_eq((SELECT (done_at IS NOT NULL)::text FROM public.topshot_sellback_walk_pages WHERE start_height = 118200000), 'true',
    'claim 5: a clean re-fetch closes the page');
  PERFORM _assert_eq((SELECT string_agg(nft_id, ',') FROM public.topshot_sellback_walk_purchases WHERE tx = 'tx5'), '555',
    'claim 5: and its purchase lands');
END
$do$;

ROLLBACK;
