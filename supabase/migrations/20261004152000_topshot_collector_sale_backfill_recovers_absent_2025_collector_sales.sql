-- topshot_collector_sale_backfill_recovers_absent_2025_collector_sales
-- anon-exec: revoked (run_topshot_collector_sale_backfill) — NEW SECDEF fn; REVOKE FROM PUBLIC, anon, authenticated in one statement below; pg_cron runs it as postgres.
--
-- 2026-10-04 (known-issues #167, the "second 2025 gap"; decided under Trevor's "make decisions
-- yourself … best for RPC long term and our users"). The sell-back walk (20261003204900) stages
-- EVERY TopShotMarketV3.MomentPurchased of Jul–Oct 2025 but keeps deposits only for the buy-back
-- wallet, so the ordinary COLLECTOR purchases it stages (promote_outcome NULL) are never promoted.
-- Measured 2026-10-04 ~7:55 AM PT on 1,500 random staged collector purchases below the walk's
-- head: 86.7 % / 90.6 % / 97.6 % (weeks of 06-30 / 07-07 / 07-14) are in `sales`; of the absent
-- rows, 11 % have an edition in moments / another sale and 87 % have none anywhere in the DB.
-- (A first read said 11.8 % for the 07-14 week — that was the walk's HEAD: 23,011 of the day's
-- rows were in flight and unclassified. Classify only below the frontier.)
--
-- Design (option (a) of the register, narrowed): a SEPARATE, additive lane — the live walk is not
-- touched and nothing is re-walked. For each absent collector purchase it reads
--   1. the transaction result (`/v1/transaction_results/{tx}` on the spork's historical node):
--      the TopShot.Deposit of THAT moment names the BUYER (a tx can deposit several moments);
--   2. only when no DB source names the edition, the BUYER's collection at the PURCHASE block
--      (the edition lane's script, 20261003211651): setID / playID / serial / subedition.
-- Verified live before writing: tx 4d19aae3… (block 119,108,545) → Deposit to 0x3473…; the
-- script at that block against 0x3473… returns 48:1703 serial 192 (= `Ray Allen — Archive Set`,
-- an edition we carry); one block earlier the buyer does not hold it, so the read height is
-- exactly the purchase block.
--
-- Volume: ~500–1,000 collector purchases per walked chain-day, ~10 % absent → ~10k tx reads +
-- ~9k scripts over the whole range, 6 in flight per minute. The lane classifies at most p_claim
-- rows per tick and only rows the walk has fully passed (block < open-page frontier − 250), so a
-- staged sell-back (which has a deposit row by then) can never be mistaken for a collector sale.
-- Outcomes are written on the walk's own purchases rows: collector_in_sales · collector_absent
-- (in progress) · inserted_collector · edition_missing · chain_not_held · buyer_unknown ·
-- buyer_fetch_failed · edition_read_failed. Nothing is ever written with a guessed edition.
-- Self-unschedules when the walk's job is gone and nothing is left.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-topshot-collector-sale-backfill');
--   DELETE FROM public.sales WHERE source = 'onchain_collector_backfill_2025';   -- the only rows it writes
--   UPDATE public.topshot_sellback_walk_purchases SET promote_outcome = NULL, promoted_at = NULL, buyer = NULL
--    WHERE promote_outcome IN ('collector_in_sales', 'collector_absent', 'inserted_collector', 'buyer_unknown',
--                              'buyer_fetch_failed', 'edition_read_failed')
--       OR (promote_outcome IN ('edition_missing', 'chain_not_held') AND buyer IS NOT NULL);
--   DELETE FROM public.topshot_chain_moment_reads c USING public.topshot_collector_sale_requests q
--    WHERE q.kind = 'script' AND c.nft_id = q.nft_id::bigint AND c.owner_address = q.owner;
--   DROP FUNCTION public.run_topshot_collector_sale_backfill(integer, integer);
--   DROP TABLE public.topshot_collector_sale_requests;
--   DROP INDEX public.topshot_sellback_walk_purchases_unclassified_idx, public.topshot_sellback_walk_purchases_collector_open_idx;
--   ALTER TABLE public.topshot_sellback_walk_purchases DROP COLUMN buyer;

ALTER TABLE public.topshot_sellback_walk_purchases ADD COLUMN IF NOT EXISTS buyer text;
-- per-tick scans proportional to the WORK: the unclassified rows (claim) and the open collector rows (promote)
CREATE INDEX IF NOT EXISTS topshot_sellback_walk_purchases_unclassified_idx
  ON public.topshot_sellback_walk_purchases (block_height) WHERE promote_outcome IS NULL;
CREATE INDEX IF NOT EXISTS topshot_sellback_walk_purchases_collector_open_idx
  ON public.topshot_sellback_walk_purchases (tx, nft_id) WHERE promote_outcome = 'collector_absent';

CREATE TABLE IF NOT EXISTS public.topshot_collector_sale_requests (
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
CREATE INDEX IF NOT EXISTS topshot_collector_sale_requests_open_idx
  ON public.topshot_collector_sale_requests (status, id) WHERE status IN ('pending', 'in_flight');
ALTER TABLE public.topshot_collector_sale_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_collector_sale_requests FROM PUBLIC, anon, authenticated;

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
         AND p.block_height < v_frontier - 250
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

REVOKE EXECUTE ON FUNCTION public.run_topshot_collector_sale_backfill(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_topshot_collector_sale_backfill(integer, integer) TO postgres, service_role;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.run_topshot_collector_sale_backfill(integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'run_topshot_collector_sale_backfill must not be executable by anon';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-topshot-collector-sale-backfill') THEN
    PERFORM cron.schedule('rpc-topshot-collector-sale-backfill', '* * * * *',
                          'SELECT public.run_topshot_collector_sale_backfill(6, 200) FROM pg_sleep(40);');
  END IF;
END
$$;
