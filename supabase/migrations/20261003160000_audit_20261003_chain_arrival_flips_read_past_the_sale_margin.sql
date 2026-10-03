-- 2026-10-03 (PT) — chain arrivals: a moment SOLD within ~100 blocks of its
-- delivery is found by reading up to the sale, not stopping 100 blocks short.
--
-- WHY (Trevor: "keep going ... anything still unresolved", Rigged pack count).
-- The sold-moment seed (hand seed 2026-09-29, then seed_saved_wallet_chain_arrivals
-- since 20260930190000) sets hi = the wallet's first sale height - 100, a margin
-- because flow_height_estimate() can be off by ~20 blocks and the events read
-- takes the LAST non-wallet withdraw in (lo, hi] -- past the sale that would be
-- the BUYER's next hand-off. But a moment delivered AND sold inside those 100
-- blocks was never held in [lo, hi]: the bisection walks lo up to hi and the
-- window read ends 'no TopShot.Withdraw in (lo, hi]: minted in or unread'.
-- Measured 2026-10-03: 1,845 sold-seed probes ended that way (Rigged 88 of 781,
-- the estate sold seed 1,757 of 11,013) against ~2 % of held seeds. Rigged's 88
-- read by hand over (hi, estimate + 80]: 88 of 88 delivered by 0xe1f2a091f7bb5245
-- 28-100 blocks (median 47) before the sale, the sale withdraw's tx equal to
-- sales.transaction_hash 88 of 88, 88 distinct delivery txs none already counted.
-- These are custodial packs sold back at once: one 3-moment reveal
-- (d489a695..., 2025-07-19) went to Dapper in ONE sale tx 29 s later, and
-- sales holds only one of the three -- so one seeded member is what finds the pack.
--
-- WHAT.
--   chain_arrival_flip_reads   one row per such probe: the window (lo, hi] it
--                              reads, the request in flight, the outcome.
--   run_chain_arrival_flip_lane()  enqueue -> dispatch -> collect:
--     enqueue  a done probe with no sender and 'no TopShot.Withdraw ...' whose
--              wallet SOLD the id (first sale after 2023-11-09) with the seed's
--              signature 0 <= estimate - hi <= 200; window (hi, least(estimate
--              + 80, hi + 250, the spork's last height)]. Every other candidate
--              is recorded 'skipped' once, so a tick never re-probes sales.
--     collect  the SALE is the wallet's own FIRST withdraw of the id in the
--              window; the delivery is the LAST withdraw of the id by anyone
--              else strictly BEFORE it (block, event index) -- never a hand-off
--              after the sale. Found -> the probe gets arrived_height / at /
--              tx_id / from_address (only while it still has none); no sale in
--              the window or no delivery before it -> recorded, probe untouched.
--              429 / 503 are free retries; else an attempt, 6 -> failed.
--   pg_cron rpc-chain-arrival-flips every 2 minutes (odd minutes), <= 20
--   reads per node per tick. apply_chain_arrival_pack_pulls (hourly :41)
--   then turns Dapper deliveries into pack-pull acquisitions as for any probe.
-- anon-exec: run_chain_arrival_flip_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-chain-arrival-flips');
--   UPDATE public.chain_arrival_probes p SET arrived_height = NULL, arrived_at = NULL, tx_id = NULL,
--          from_address = NULL, last_error = 'no TopShot.Withdraw in (lo, hi]: minted in or unread'
--     FROM public.chain_arrival_flip_reads f
--    WHERE f.result = 'found' AND p.wallet = f.wallet AND p.nft_id = f.nft_id;
--   DELETE FROM public.moment_acquisitions m USING public.chain_arrival_flip_reads f
--    WHERE f.result = 'found' AND m.wallet = f.wallet AND m.nft_id = f.nft_id::text
--      AND m.source = 'chain_history' AND m.acquisition_method = 'pack_pull';
--   (then SELECT public.rebuild_wallet_reconstructed_rips(w) for each affected wallet)
--   DROP FUNCTION public.run_chain_arrival_flip_lane();
--   DROP TABLE public.chain_arrival_flip_reads;

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
CREATE INDEX IF NOT EXISTS idx_chain_arrival_flip_reads_request
  ON public.chain_arrival_flip_reads (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chain_arrival_flip_reads_pending
  ON public.chain_arrival_flip_reads (node) WHERE status = 'pending' AND request_id IS NULL;
ALTER TABLE public.chain_arrival_flip_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chain_arrival_flip_reads FROM anon, authenticated;

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

REVOKE ALL ON FUNCTION public.run_chain_arrival_flip_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_chain_arrival_flip_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-chain-arrival-flips', '1-59/2 * * * *', 'SELECT public.run_chain_arrival_flip_lane();');
