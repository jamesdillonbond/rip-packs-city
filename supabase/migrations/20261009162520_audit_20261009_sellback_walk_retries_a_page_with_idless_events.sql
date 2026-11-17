-- audit_20261009_sellback_walk_retries_a_page_with_idless_events
--
-- 2026-10-09 ~9:35 AM PT (Claude Code, cloud). QUEUED P2 since 10-07 (recurred 10-08).
--
-- MEASURED (pipeline_runs): topshot-sellback-walk failed EVERY tick 10-06 ~5:00-8:46 AM PT and
-- 10-08 ~4:30-10:30 AM PT, all on
--   null value in column "nft_id" of relation "topshot_sellback_walk_purchases" violates not-null.
-- run_topshot_sellback_walk reads nft_id from each event's `id` field; a 200 page with an event
-- lacking it raises, the run's handler logs the failure, the page is never closed, and every tick
-- re-harvests the same stored response -- until pg_net drops that response row (its TTL, ~6 h:
-- both windows are ~6 h), the page is re-issued, and the fresh fetch is clean. So each recurrence
-- stalls the whole walk for ~6 h and "self-resolves" by expiry, not by repair.
--
-- WHAT THIS DOES. A 200 page with any id-less event is not read as complete -- skipping the event
-- would persist a partial page as the fact. It takes the existing non-200 path: re-queued with
-- attempts+1 and last_error "N event(s) without an id in a 200 page", closed as failed (visible in
-- failed_pages) after 8. The run no longer aborts, so every other page keeps landing. extra gains
-- pages_with_idless_events. Nothing else changes.
--
-- anon-exec: unchanged (run_topshot_sellback_walk) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved, verified has_function_privilege anon=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) af8d0ddf69e2f81472fac47a322e2ddc = the body
-- in 20261003204900, the newest migration defining this function.
--
-- REVERT: re-apply the run_topshot_sellback_walk block of
--   20261003204900_topshot_sellback_walk_backfills_2025_buybacks.sql verbatim.

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
