-- 2026-11-08 (PT) — Disney Pinnacle pack OPENS read from Flow itself, not from Dapper's index.
--
-- WHY. pinnacle_pack_opens is fed by ingest-pinnacle-pack-opens (Dapper searchPackNft). That index
-- stopped seeing new opens after 2026-10-23 8:19 AM PT: 300+ runs since, ok=true, head_new 0 (#218's
-- freeze reaching Pinnacle). The chain kept recording them. Measured 2026-11-08 on
-- rest-mainnet.onflow.org: an open is one tx carrying PackNFT.Opened(id = pack) and, per pulled
-- pin, Pinnacle.Withdraw(from the contract) -> Pinnacle.Deposit(id, to: the opener). The pack's
-- dist is not on the pack: it is in PackNFT.Minted(id, hash, distId), emitted when Dapper mints
-- the pack into the buyer's wallet (pack 280375467870110: minted 10-22 9:02 AM PT as dist 8906,
-- opened 1:24 PM PT the same day).
--
-- NOT COVERED (by design): Open Edition pins are minted STRAIGHT into the buyer's wallet by an
-- admin mint tx (no PackNFT, no pack id, no dist id on chain). Those were never pack opens in this
-- table and still are not; they stay in pinnacle_mint_events.
--
-- WHAT.
--   pinnacle_chain_open_reads   one row per (250-block window, event type): 'Opened' and 'Minted'
--                               for every window; 'Deposit' only for a window whose Opened read
--                               found an open.
--   pinnacle_chain_opened       every PackNFT.Opened seen (pack, tx, block, time) — the audit of
--                               what the chain said, and the join for the Deposit read.
--   pinnacle_chain_opens_state  the walk cursor (next_lo) and the sealed head.
--   pack_nft_mints              gains Pinnacle rows (collection-scoped table; every reader filters
--                               collection_id) from PackNFT.Minted.
--   run_pinnacle_chain_opens_lane()  collect -> enqueue -> dispatch via pg_net, every minute.
--     Writes pinnacle_pack_opens by FILLING ONLY what is missing: an existing row's dist, opener,
--     time, tx, block and pins are never replaced (the Dapper ingest is the second writer of this
--     table; where both wrote a row they agree on the tx). A pack whose mint the walk has not seen
--     is written with dist_id NULL — unattributed, never guessed from its pins (half of Pinnacle
--     editions sit in more than one dist) — and gets its dist when the Minted read lands.
--   A failed read retries (6 attempts; 429 = free retry); pipeline_runs 'pinnacle-chain-opens'
--   reports ok = no failed read and no failed window this tick, rows_written = opens written.
--
-- anon-exec: run_pinnacle_chain_opens_lane() — new; REVOKE FROM PUBLIC, anon, authenticated below.
--
-- Revert:
--   SELECT cron.unschedule('rpc-pinnacle-chain-opens-lane');
--   DELETE FROM public.pinnacle_pack_opens o USING public.pinnacle_chain_opened c
--     WHERE c.pack_nft_id = o.pack_nft_id AND c.created_row;
--   DELETE FROM public.pack_nft_mints WHERE collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714';
--   DROP FUNCTION public.run_pinnacle_chain_opens_lane();
--   DROP TABLE public.pinnacle_chain_open_reads, public.pinnacle_chain_opened, public.pinnacle_chain_opens_state;

CREATE TABLE IF NOT EXISTS public.pinnacle_chain_open_reads (
  lo             bigint NOT NULL,
  ev             text   NOT NULL CHECK (ev IN ('Opened', 'Minted', 'Deposit')),
  hi             bigint NOT NULL,
  status         text   NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id     bigint,
  attempts       int    NOT NULL DEFAULT 0,
  dispatched_at  timestamptz,
  finished_at    timestamptz,
  n_events       int,
  last_error     text,
  PRIMARY KEY (lo, ev)
);
COMMENT ON TABLE public.pinnacle_chain_open_reads IS
  'One Flow events read per (250-block window, event type) for Disney Pinnacle pack opens: PackNFT.Opened and PackNFT.Minted for every window, Pinnacle.Deposit for a window with an open. run_pinnacle_chain_opens_lane().';
CREATE INDEX IF NOT EXISTS idx_pinnacle_chain_open_reads_status ON public.pinnacle_chain_open_reads (status, lo);
ALTER TABLE public.pinnacle_chain_open_reads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_chain_open_reads FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pinnacle_chain_opened (
  pack_nft_id  text PRIMARY KEY,
  open_tx      text NOT NULL,
  open_block   bigint NOT NULL,
  opened_at    timestamptz NOT NULL,
  window_lo    bigint NOT NULL,
  n_pins       int,
  written_at   timestamptz,
  created_row  boolean,
  seen_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pinnacle_chain_opened IS
  'Every Disney Pinnacle PackNFT.Opened read from Flow (pack, tx, block, time). written_at = when its pinnacle_pack_opens row was written or filled; created_row = the lane created that row (revert key).';
CREATE INDEX IF NOT EXISTS idx_pinnacle_chain_opened_window ON public.pinnacle_chain_opened (window_lo);
ALTER TABLE public.pinnacle_chain_opened ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_chain_opened FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS public.pinnacle_chain_opens_state (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  next_lo          bigint NOT NULL,
  head             bigint,
  head_at          timestamptz,
  head_request_id  bigint,
  head_dispatched_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pinnacle_chain_opens_state IS
  'Walk cursor for run_pinnacle_chain_opens_lane(): next_lo = first block not yet enqueued; head = latest sealed height read from rest-mainnet.';
ALTER TABLE public.pinnacle_chain_opens_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_chain_opens_state FROM anon, authenticated;

-- Start of the walk: block 168,700,000 (2026-10-23 ~4:20 AM PT), before Dapper's last indexed open
-- (10-23 8:19 AM PT, block 168,731,104); the overlap is fill-only. ~7,200 windows to the head =
-- ~14,400 reads, ~4 h at 60 per tick, then ~1 read a minute. Control, walked the same way from a
-- session on 2026-11-08 over blocks 166,300,000-170,490,000: after 10-23 the chain holds 1,304
-- opens (10-29 → 11-07) — dists 8912 514, 8909 450, 8910 240, 8913 100 (by their PackNFT.Minted) —
-- and Dapper's index holds 0 of them.
INSERT INTO public.pinnacle_chain_opens_state (id, next_lo) VALUES (1, 168700000)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.run_pinnacle_chain_opens_lane()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_started    timestamptz := clock_timestamp();
  v_node       constant text := 'https://rest-mainnet.onflow.org';
  v_a          constant text := 'A.edf9df96c92f4595.';
  v_coll       constant uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_per_tick   constant int := 60;
  v_max_att    constant int := 6;
  v_margin     constant int := 20;      -- stay this far behind the sealed head
  v_max_enq    constant int := 400;     -- windows enqueued per tick (x2 reads)
  r record;
  st record;
  v_body jsonb; v_n int; v_req bigint; v_h bigint;
  v_collected int := 0; v_done int := 0; v_failed int := 0; v_throttled int := 0; v_expired int := 0;
  v_opened int := 0; v_minted int := 0; v_written int := 0; v_created int := 0; v_dist_filled int := 0;
  v_enqueued int := 0; v_dispatched int := 0; v_no_pins int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_chain_opens_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  SELECT * INTO st FROM public.pinnacle_chain_opens_state WHERE id = 1 FOR UPDATE;

  -- (0) Sealed head: collect the last request, dispatch a new one at most once a minute.
  IF st.head_request_id IS NOT NULL THEN
    SELECT CASE WHEN h.status_code = 200 AND pg_input_is_valid(h.content, 'jsonb')
                THEN (h.content::jsonb -> 0 -> 'header' ->> 'height')::bigint END
      INTO v_h FROM net._http_response h WHERE h.id = st.head_request_id;
    IF FOUND THEN
      UPDATE public.pinnacle_chain_opens_state
         SET head = coalesce(v_h, head), head_at = CASE WHEN v_h IS NOT NULL THEN now() ELSE head_at END,
             head_request_id = NULL, updated_at = now()
       WHERE id = 1;
    ELSIF st.head_dispatched_at < now() - interval '10 minutes' THEN
      UPDATE public.pinnacle_chain_opens_state SET head_request_id = NULL WHERE id = 1;
    END IF;
  END IF;
  SELECT * INTO st FROM public.pinnacle_chain_opens_state WHERE id = 1;
  IF st.head_request_id IS NULL THEN
    SELECT net.http_get(url := v_node || '/v1/blocks?height=sealed', timeout_milliseconds := 20000) INTO v_req;
    UPDATE public.pinnacle_chain_opens_state SET head_request_id = v_req, head_dispatched_at = now() WHERE id = 1;
  END IF;

  -- (1) Collect.
  FOR r IN
    SELECT w.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
      FROM public.pinnacle_chain_open_reads w
      LEFT JOIN net._http_response h ON h.id = w.request_id
     WHERE w.status = 'in_flight'
     ORDER BY w.lo, w.ev
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_chain_open_reads
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE lo = r.lo AND ev = r.ev;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;
    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      IF r.h_status = 429 THEN
        UPDATE public.pinnacle_chain_open_reads SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE lo = r.lo AND ev = r.ev;
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(r.ev || ' ' || r.lo || ': ' || coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_chain_open_reads
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE lo = r.lo AND ev = r.ev;
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    -- one row per event: block, time, tx, fields (Cadence-JSON: Optional<Address> nests one level deeper)
    CREATE TEMP TABLE IF NOT EXISTS _pco_ev (bh bigint, bt timestamptz, tx text, f jsonb) ON COMMIT DROP;
    TRUNCATE _pco_ev;
    INSERT INTO _pco_ev
    SELECT (b->>'block_height')::bigint, (b->>'block_timestamp')::timestamptz, e->>'transaction_id',
           (SELECT jsonb_object_agg(x->>'name', coalesce(x->'value'->'value'->>'value', x->'value'->>'value'))
              FROM jsonb_array_elements(convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb -> 'value' -> 'fields') x)
      FROM jsonb_array_elements(v_body) b
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e;
    SELECT count(*) INTO v_n FROM _pco_ev;

    IF r.ev = 'Minted' THEN
      INSERT INTO public.pack_nft_mints (collection_id, pack_nft_id, dist_id, minted_at, block_height, tx_id)
      SELECT v_coll, f->>'id', f->>'distId', bt, bh, tx FROM _pco_ev WHERE f->>'id' ~ '^[0-9]+$'
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
      v_minted := v_minted + v_n;
      -- an open written before its mint was seen gets its dist now
      WITH u AS (
        UPDATE public.pinnacle_pack_opens o SET dist_id = m.f->>'distId'
          FROM _pco_ev m
         WHERE o.pack_nft_id = m.f->>'id' AND o.dist_id IS NULL AND m.f->>'distId' ~ '^[0-9]+$'
        RETURNING 1
      ) SELECT v_dist_filled + count(*) INTO v_dist_filled FROM u;

    ELSIF r.ev = 'Opened' THEN
      INSERT INTO public.pinnacle_chain_opened (pack_nft_id, open_tx, open_block, opened_at, window_lo)
      SELECT f->>'id', tx, bh, bt, r.lo FROM _pco_ev WHERE f->>'id' ~ '^[0-9]+$'
      ON CONFLICT (pack_nft_id) DO NOTHING;
      v_opened := v_opened + v_n;
      IF v_n > 0 THEN
        INSERT INTO public.pinnacle_chain_open_reads (lo, ev, hi) VALUES (r.lo, 'Deposit', r.hi)
        ON CONFLICT (lo, ev) DO UPDATE SET status = 'pending', request_id = NULL, attempts = 0
          WHERE public.pinnacle_chain_open_reads.status IN ('done', 'failed');
      END IF;

    ELSE  -- Deposit: the pins of each open in this window, and who received them
      WITH dep AS (
        SELECT tx, f->>'id' AS pin, f->>'to' AS to_addr FROM _pco_ev WHERE f->>'id' IS NOT NULL
      ), per AS (
        SELECT c.pack_nft_id, c.open_tx, c.open_block, c.opened_at,
               array_agg(DISTINCT d.pin ORDER BY d.pin) FILTER (WHERE d.pin IS NOT NULL) AS pins,
               mode() WITHIN GROUP (ORDER BY d.to_addr) AS opener
          FROM public.pinnacle_chain_opened c
          LEFT JOIN dep d ON d.tx = c.open_tx
         WHERE c.window_lo = r.lo
         GROUP BY 1, 2, 3, 4
      ), pre AS (
        SELECT p.*, (SELECT m.dist_id FROM public.pack_nft_mints m
                      WHERE m.collection_id = v_coll AND m.pack_nft_id = p.pack_nft_id) AS dist_id,
               EXISTS (SELECT 1 FROM public.pinnacle_pack_opens o WHERE o.pack_nft_id = p.pack_nft_id) AS existed
          FROM per p WHERE p.pins IS NOT NULL
      ), up AS (
        INSERT INTO public.pinnacle_pack_opens AS o
               (pack_nft_id, dist_id, opener_address, opened_at, open_tx, open_block, nft_ids, moments_pulled, ingested_at)
        SELECT pack_nft_id, dist_id, opener, opened_at, open_tx, open_block, pins, cardinality(pins), now() FROM pre
        ON CONFLICT (pack_nft_id) DO UPDATE SET
          dist_id        = coalesce(o.dist_id, excluded.dist_id),
          opener_address = coalesce(o.opener_address, excluded.opener_address),
          opened_at      = coalesce(o.opened_at, excluded.opened_at),
          open_tx        = coalesce(o.open_tx, excluded.open_tx),
          open_block     = coalesce(o.open_block, excluded.open_block),
          nft_ids        = CASE WHEN cardinality(o.nft_ids) = 0 THEN excluded.nft_ids ELSE o.nft_ids END,
          moments_pulled = CASE WHEN cardinality(o.nft_ids) = 0 THEN excluded.moments_pulled ELSE o.moments_pulled END
        RETURNING o.pack_nft_id
      ), mark AS (
        UPDATE public.pinnacle_chain_opened c
           SET written_at = now(), n_pins = cardinality(pre.pins), created_row = coalesce(c.created_row, NOT pre.existed)
          FROM pre WHERE c.pack_nft_id = pre.pack_nft_id AND pre.pack_nft_id IN (SELECT pack_nft_id FROM up)
        RETURNING NOT pre.existed AS created
      )
      SELECT v_written + count(*), v_created + count(*) FILTER (WHERE created) INTO v_written, v_created FROM mark;
      -- an Opened with no Pinnacle.Deposit in its own tx is left unwritten (counted, never a 0-pin open)
      SELECT v_no_pins + count(*) INTO v_no_pins
        FROM public.pinnacle_chain_opened c
       WHERE c.window_lo = r.lo AND c.written_at IS NULL;
    END IF;

    UPDATE public.pinnacle_chain_open_reads
       SET status = 'done', finished_at = now(), request_id = NULL, last_error = NULL, n_events = v_n
     WHERE lo = r.lo AND ev = r.ev;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue windows up to the sealed head (minus a margin).
  SELECT * INTO st FROM public.pinnacle_chain_opens_state WHERE id = 1;
  IF st.head IS NOT NULL AND st.next_lo + 249 <= st.head - v_margin THEN
    WITH w AS (
      SELECT g AS lo, g + 249 AS hi
        FROM generate_series(st.next_lo, least(st.head - v_margin - 249, st.next_lo + (v_max_enq - 1) * 250), 250) g
    ), ins AS (
      INSERT INTO public.pinnacle_chain_open_reads (lo, ev, hi)
      SELECT w.lo, e.ev, w.hi FROM w CROSS JOIN (VALUES ('Opened'), ('Minted')) e(ev)
      ON CONFLICT (lo, ev) DO NOTHING
      RETURNING lo
    )
    SELECT count(DISTINCT lo) INTO v_enqueued FROM ins;
    UPDATE public.pinnacle_chain_opens_state
       SET next_lo = (SELECT max(lo) + 250 FROM public.pinnacle_chain_open_reads WHERE ev = 'Opened'),
           updated_at = now()
     WHERE id = 1;
  END IF;

  -- (3) Dispatch: Deposit reads first (they finish an open), then the oldest windows.
  FOR r IN
    SELECT * FROM public.pinnacle_chain_open_reads WHERE status = 'pending'
     ORDER BY (ev = 'Deposit') DESC, lo, ev LIMIT v_per_tick
  LOOP
    SELECT net.http_get(
      url := v_node || '/v1/events?type=' || v_a || CASE r.ev WHEN 'Deposit' THEN 'Pinnacle.Deposit' ELSE 'PackNFT.' || r.ev END
             || '&start_height=' || r.lo || '&end_height=' || r.hi,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_chain_open_reads
       SET status = 'in_flight', request_id = v_req, dispatched_at = now()
     WHERE lo = r.lo AND ev = r.ev;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-chain-opens', v_started, v_collected, v_written, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('reads_done', v_done, 'failed', v_failed, 'throttled', v_throttled, 'expired', v_expired,
                       'opened_seen', v_opened, 'minted_seen', v_minted, 'opens_written', v_written,
                       'opens_created', v_created, 'dist_filled', v_dist_filled, 'opened_without_pins', v_no_pins,
                       'enqueued_windows', v_enqueued, 'dispatched', v_dispatched,
                       'next_lo', (SELECT next_lo FROM public.pinnacle_chain_opens_state WHERE id = 1),
                       'head', (SELECT head FROM public.pinnacle_chain_opens_state WHERE id = 1),
                       'pending', (SELECT count(*) FROM public.pinnacle_chain_open_reads WHERE status = 'pending'),
                       'failed_total', (SELECT count(*) FROM public.pinnacle_chain_open_reads WHERE status = 'failed')));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'reads_done', v_done, 'failed', v_failed,
                            'opened_seen', v_opened, 'minted_seen', v_minted, 'opens_written', v_written,
                            'opens_created', v_created, 'dist_filled', v_dist_filled, 'enqueued_windows', v_enqueued,
                            'dispatched', v_dispatched, 'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.run_pinnacle_chain_opens_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pinnacle_chain_opens_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-pinnacle-chain-opens-lane', '* * * * *', 'SELECT public.run_pinnacle_chain_opens_lane();');
