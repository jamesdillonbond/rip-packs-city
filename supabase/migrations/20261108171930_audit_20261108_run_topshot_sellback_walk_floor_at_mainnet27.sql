-- audit_20261108_run_topshot_sellback_walk_floor_at_mainnet27
--
-- WHY. 2026-11-08 (Claude Code, Trevor's Windows box; #181 follow-through). Flow retired the
-- mainnet24/25/26 access nodes (access-001.mainnet2[456].nodes.onflow.org: no DNS record;
-- mainnet27 :8070 and rest-mainnet still answer), so a block below 130,290,659 (the mainnet27
-- root) is unreadable by any node. This walk issued every page starting at or below 130,290,658
-- to mainnet26. It is dormant (job rpc-topshot-sellback-walk unscheduled; state next_height
-- 131,330,001 > end_height 131,330,000; 0 open pages - read 11-08), so nothing is failing today;
-- a manual re-run with a reset state would re-create the same DNS-failure storm the pull-chain
-- (20261108071848) and pack-mint-probe (20261108164041) lanes hit.
--
-- WHAT. Pages are 250 blocks (start_height .. start_height+249).
--   * A queued page lying ENTIRELY at or below c_m26_end (start_height + 249 <= 130,290,658) is
--     closed failed = true with last_error 'block before 130290659 (mainnet27 root): Flow retired
--     the mainnet24-26 access nodes (#181)' just before ISSUE (after ENQUEUE, so a freshly
--     enqueued one is closed in the same tick), never issued; counted in failed_pages and the new
--     extra.below_floor. An in-flight one's DNS failure re-queues it, then it closes here.
--   * A page STRADDLING the root (start_height <= 130,290,658 < start_height + 249) is issued to
--     mainnet27 from the root: start_height=GREATEST(start_height, 130290659). (The old body read
--     it on mainnet26 up to 130,290,658 and never read the rest; live, separate 130,290,659 page
--     rows - done, 200 - cover that gap.) When it lands, the closed page carries the
--     same reason in last_error: its blocks before the root were not read.
--   * The mainnet26 URL arm and the m26 end-height cap are removed. Nothing else changes.
-- A cost + honesty fix, not a recovery.
--
-- PIN: supabase/tests/run_topshot_sellback_walk.sql (heights re-based above the floor; the
--   http_get stub now records URLs; new claim 6: an all-below page and a DNS-failed in-flight
--   page close failed with the reason and no request, a straddling page is read from the root and
--   annotated, and no URL anywhere matches mainnet2[456]).
-- Base verified 2026-11-08: live md5(prosrc) 8ca0a3da2f1e3f58e4af876044987537 = the body of
--   20261009162520 (the newest migration defining this function).
-- anon-exec: unchanged (run_topshot_sellback_walk) - CREATE OR REPLACE of an existing fn, same signature; ACL preserved.
-- Revert: re-apply the CREATE OR REPLACE body of
--   20261009162520_audit_20261009_sellback_walk_retries_a_page_with_idless_events.sql. Pages already
--   closed stay closed; re-open with
--   UPDATE topshot_sellback_walk_pages SET done_at=NULL, failed=false, attempts=0, req_id=NULL WHERE last_error LIKE 'block before 130290659%' AND failed;

CREATE OR REPLACE FUNCTION public.run_topshot_sellback_walk(p_max_inflight integer DEFAULT 16)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_buyback   CONSTANT text := '0xe1f2a091f7bb5245';
  c_ts        CONSTANT uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  -- 2026-11-08 (#181): the last block before the mainnet27 root (130,290,659). Flow retired the
  -- mainnet24-26 access nodes (no DNS record), so no node can read at or below this height:
  -- such work is closed with c_floor_reason, never dispatched.
  c_m26_end   CONSTANT bigint := 130290658;
  c_floor_reason CONSTANT text := 'block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes (#181)';
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
  v_below_floor int := 0;
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
        -- 2026-11-08 (#181): a page straddling the mainnet27 root was read from the root only;
        -- its blocks before the root are unreadable, and the closed page says so.
        UPDATE public.topshot_sellback_walk_pages
           SET done_at = now(), last_status = 200,
               last_error = CASE WHEN start_height <= c_m26_end THEN c_floor_reason ELSE last_error END
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

    -- 2026-11-08 (#181): a queued page lying entirely at or below c_m26_end has no node left to
    -- read it (an in-flight one's DNS failure re-queues it first). It is closed as failed with
    -- c_floor_reason (counted in failed_pages), never issued. A page straddling the root is
    -- issued from the root (below).
    UPDATE public.topshot_sellback_walk_pages
       SET done_at = now(), failed = true, last_error = c_floor_reason
     WHERE done_at IS NULL AND req_id IS NULL AND start_height + 249 <= c_m26_end;
    GET DIAGNOSTICS v_below_floor = ROW_COUNT;
    v_failed := v_failed + v_below_floor;

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
                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                      CASE p.kind WHEN 'purchase' THEN 'A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased'
                                  ELSE 'A.0b2a3299cc857e29.TopShot.Deposit' END,
                      -- 2026-11-08 (#181): a page straddling the mainnet27 root is read from the
                      -- root (each node only knows its own blocks; none is left before the root)
                      GREATEST(p.start_height, c_m26_end + 1),
                      p.start_height + 249),
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
                       'promoted', v_promoted, 'pages_with_idless_events', v_noid_pages, 'below_floor', v_below_floor, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('harvested', v_harvested, 'retried', v_retried, 'issued', v_issued,
                            'failed_pages', v_failed, 'promoted', v_promoted, 'below_floor', v_below_floor, 'error', v_err);
END
$function$;
