-- DB invariant: public.run_pack_mint_probe_lane / public.flow_height_estimate —
-- which packs Dapper MINTED straight into a wallet, read from Flow's
-- PackNFT.Minted events at the instant Dapper's index says the wallet acquired
-- each pack. Added 2026-09-26 (215 of Trevor's packs arrived in one PDS mint
-- transaction on 2026-04-24, long after their drops' sale windows). Claims:
--
--   1. Arrival instants come from pack_nft_identity.acquired_at for Top Shot and
--      All Day only, on/after the spork floor; saved wallets' instants first.
--   2. A probe reads the 250-block window around the instant's estimated height
--      (interpolated between marketplace sales) for that collection's
--      PackNFT.Minted events; an instant below the spork floor is FAILED with
--      its reason, never dispatched.
--   3. A window containing the instant records every mint it read (block time,
--      height, tx) and says how many were minted AT the instant.
--   4. A window that misses the instant is RE-AIMED from the block times it did
--      read -- never recorded as "no mints" -- and gives up after 4 attempts.
--   5. An HTTP failure retries and the run says ok=false.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926200000_audit_20260926_pack_nft_mints_name_packs_dapper_minted_straight_into_a_wallet.sql;
-- run_pack_mint_probe_lane from 20260926200050_audit_20260926_pack_mint_probe_lane_waits_20s_per_request.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text UNIQUE);
INSERT INTO public.collections VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'nfl_all_day'),
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'laliga_golazos');
CREATE TABLE public.saved_wallets (wallet_addr text);
CREATE TABLE public.pack_nft_identity (collection_id uuid, pack_nft_id text, owner_address text, acquired_at timestamptz);
CREATE TABLE public.topshot_pack_sales_history (block_height bigint, block_time timestamptz);
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

-- pg_net stand-in: http_get records the URL and returns an id; responses are
-- planted into net._http_response by the test.
CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, url text, timeout_ms int);
CREATE FUNCTION net.http_get(url text, timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url, timeout_milliseconds); RETURN v; END $$;

-- the lane's own tables, as the migration creates them
CREATE TABLE public.pack_nft_mints (
  collection_id uuid NOT NULL, pack_nft_id text NOT NULL, dist_id text, minted_at timestamptz NOT NULL,
  block_height bigint NOT NULL, tx_id text NOT NULL, first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id));
CREATE TABLE public.pack_mint_probes (
  collection_id uuid NOT NULL, probe_at timestamptz NOT NULL, priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  start_height bigint, request_id bigint, attempts int NOT NULL DEFAULT 0, dispatched_at timestamptz,
  finished_at timestamptz, n_minted int, n_at_instant int, last_error text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, probe_at));

-- >>> BEGIN verbatim flow_height_estimate (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.flow_height_estimate(p_at timestamptz)
RETURNS bigint
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  -- Interpolate between the nearest marketplace sales on either side of p_at
  -- (each carries its block height and time); extrapolate at ~1.19 blocks/s
  -- from one side when only one exists. NULL when there is no anchor at all.
  WITH a AS (
    SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
     WHERE block_time <= p_at AND block_height IS NOT NULL
     ORDER BY block_time DESC LIMIT 1
  ), b AS (
    SELECT block_height AS h, block_time AS t FROM public.topshot_pack_sales_history
     WHERE block_time >= p_at AND block_height IS NOT NULL
     ORDER BY block_time LIMIT 1
  )
  SELECT CASE
           WHEN a.h IS NOT NULL AND b.h IS NOT NULL AND b.t > a.t
             THEN a.h + round((b.h - a.h) * extract(epoch FROM p_at - a.t) / extract(epoch FROM b.t - a.t))::bigint
           WHEN a.h IS NOT NULL THEN a.h + round(extract(epoch FROM p_at - a.t) * 1.19)::bigint
           WHEN b.h IS NOT NULL THEN b.h - round(extract(epoch FROM b.t - p_at) * 1.19)::bigint
         END
  FROM (SELECT 1) one LEFT JOIN a ON true LEFT JOIN b ON true
$function$;
-- <<< END verbatim <<<

-- >>> BEGIN verbatim run_pack_mint_probe_lane (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_pack_mint_probe_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_floor     constant bigint := 137390146;            -- Flow spork root: nothing older is served
  v_floor_at  constant timestamptz := '2025-12-29 00:00:00+00';
  v_ts uuid; v_ad uuid;
  r record;
  v_body jsonb;
  v_t0 timestamptz; v_t1 timestamptz; v_h0 bigint; v_h1 bigint;
  v_n int; v_at int; v_inst int;
  v_start bigint; v_req bigint;
  v_collected int := 0; v_done int := 0; v_reaimed int := 0; v_failed int := 0; v_expired int := 0;
  v_mints_new int := 0; v_enqueued int := 0; v_dispatched int := 0; v_below_floor int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pack_mint_probe_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  -- (1) Collect every landed probe.
  FOR r IN
    SELECT p.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
    FROM public.pack_mint_probes p
    LEFT JOIN net._http_response h ON h.id = p.request_id
    WHERE p.status = 'in_flight'
    ORDER BY p.dispatched_at
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pack_mint_probes
           SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, last_error = 'no_response',
               finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
         WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
                   THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' OR jsonb_array_length(v_body) = 0 THEN
      v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 200);
      UPDATE public.pack_mint_probes
         SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1, last_error = v_last_error,
             finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_failed := v_failed + 1;
      CONTINUE;
    END IF;

    SELECT min((b->>'block_timestamp')::timestamptz), max((b->>'block_timestamp')::timestamptz),
           min((b->>'block_height')::bigint), max((b->>'block_height')::bigint)
      INTO v_t0, v_t1, v_h0, v_h1
      FROM jsonb_array_elements(v_body) b;

    -- The window read blocks that do not contain the instant: re-aim from the
    -- block times it DID read (1.25 blocks/s, a margin past the gap) and retry.
    IF r.probe_at < v_t0 - interval '1 second' OR r.probe_at > v_t1 + interval '1 second' THEN
      v_start := CASE WHEN r.probe_at < v_t0
                      THEN v_h0 - ceil(extract(epoch FROM v_t0 - r.probe_at) * 1.25)::bigint - 125
                      ELSE v_h1 + ceil(extract(epoch FROM r.probe_at - v_t1) * 1.25)::bigint - 125 END;
      UPDATE public.pack_mint_probes
         SET status = CASE WHEN attempts + 1 >= 4 THEN 'failed' ELSE 'pending' END,
             attempts = attempts + 1, start_height = v_start,
             last_error = 'window ' || v_t0 || ' .. ' || v_t1 || ' missed the instant',
             finished_at = CASE WHEN attempts + 1 >= 4 THEN now() END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_reaimed := v_reaimed + 1;
      CONTINUE;
    END IF;

    WITH ev AS (
      SELECT (b->>'block_height')::bigint AS bh, (b->>'block_timestamp')::timestamptz AS bt,
             e->>'transaction_id' AS tx,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS p
      FROM jsonb_array_elements(v_body) b
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
    ), f AS (
      SELECT bh, bt, tx,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(p->'value'->'fields') x WHERE x->>'name' = 'id') AS pack_id,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(p->'value'->'fields') x WHERE x->>'name' = 'distId') AS dist_id
      FROM ev
    ), ins AS (
      INSERT INTO public.pack_nft_mints (collection_id, pack_nft_id, dist_id, minted_at, block_height, tx_id)
      SELECT r.collection_id, pack_id, dist_id, bt, bh, tx FROM f WHERE pack_id IS NOT NULL
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins),
           (SELECT count(*) FROM f WHERE pack_id IS NOT NULL),
           (SELECT count(*) FROM f WHERE pack_id IS NOT NULL AND abs(extract(epoch FROM bt - r.probe_at)) <= 2)
      INTO v_n, v_at, v_inst;
    v_mints_new := v_mints_new + v_n;

    UPDATE public.pack_mint_probes
       SET status = 'done', finished_at = now(), n_minted = v_at, n_at_instant = v_inst, last_error = NULL
     WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue new arrival instants (hourly: a full read of the index).
  -- Saved wallets' instants first.
  IF extract(minute FROM now()) < 5 OR NOT EXISTS (SELECT 1 FROM public.pack_mint_probes) THEN
    WITH ins AS (
      INSERT INTO public.pack_mint_probes (collection_id, probe_at, priority)
      SELECT i.collection_id, i.acquired_at,
             max(CASE WHEN EXISTS (SELECT 1 FROM public.saved_wallets s WHERE lower(s.wallet_addr) = i.owner_address) THEN 1 ELSE 0 END)
      FROM public.pack_nft_identity i
      WHERE i.acquired_at >= v_floor_at
        AND i.collection_id IN (v_ts, v_ad)
      GROUP BY i.collection_id, i.acquired_at
      ON CONFLICT (collection_id, probe_at) DO UPDATE
        SET priority = EXCLUDED.priority
        WHERE public.pack_mint_probes.priority < EXCLUDED.priority
      RETURNING (xmax = 0) AS inserted
    )
    SELECT count(*) FILTER (WHERE inserted) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch up to 40 pending probes.
  FOR r IN
    SELECT * FROM public.pack_mint_probes
    WHERE status = 'pending'
    ORDER BY priority DESC, probe_at DESC
    LIMIT 40
  LOOP
    v_start := coalesce(r.start_height, public.flow_height_estimate(r.probe_at) - 125);
    IF v_start IS NULL OR v_start < v_floor THEN
      UPDATE public.pack_mint_probes
         SET status = 'failed', finished_at = now(),
             last_error = CASE WHEN v_start IS NULL THEN 'no height anchor' ELSE 'below the Flow spork floor' END
       WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
      v_below_floor := v_below_floor + 1;
      CONTINUE;
    END IF;
    SELECT net.http_get(
      url := 'https://rest-mainnet.onflow.org/v1/events?type='
        || CASE r.collection_id WHEN v_ts THEN 'A.0b2a3299cc857e29' ELSE 'A.e4cf4bdc1751c65d' END
        || '.PackNFT.Minted&start_height=' || v_start || '&end_height=' || (v_start + 249),
      timeout_milliseconds := 20000
    ) INTO v_req;
    UPDATE public.pack_mint_probes
       SET status = 'in_flight', request_id = v_req, start_height = v_start, dispatched_at = now()
     WHERE collection_id = r.collection_id AND probe_at = r.probe_at;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pack-mint-probes', v_started,
    v_collected, v_mints_new, 0,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('probes_done', v_done, 'probes_reaimed', v_reaimed, 'probes_failed', v_failed,
                       'probes_expired', v_expired, 'mints_new', v_mints_new, 'enqueued', v_enqueued,
                       'dispatched', v_dispatched, 'below_floor', v_below_floor)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'done', v_done,
                            'reaimed', v_reaimed, 'failed', v_failed, 'expired', v_expired,
                            'mints_new', v_mints_new, 'enqueued', v_enqueued,
                            'dispatched', v_dispatched, 'below_floor', v_below_floor,
                            'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<

-- Anchors: 1,190 blocks over 1,000 s from 2026-04-24 11:00 UTC.
INSERT INTO public.topshot_pack_sales_history VALUES
  (140000000, '2026-04-24 11:00:00+00'), (140001190, '2026-04-24 11:16:40+00');
INSERT INTO public.saved_wallets VALUES ('0xBD94CADE097E50AC');
INSERT INTO public.pack_nft_identity VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P1', '0xbd94cade097e50ac', '2026-04-24 11:08:20.118+00'),  -- saved wallet, T+500 s
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P9', '0xbd94cade097e50ac', '2026-04-24 11:08:20.118+00'),  -- same instant: one probe
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P3', '0x1111111111111111', '2026-04-24 11:15:00+00'),      -- T+900 s
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'A4', '0x1111111111111111', '2026-04-24 11:08:20.118+00'),  -- All Day, same instant
  ('06248cc4-b85f-47cd-af67-1855d14acd75', 'G1', '0x1111111111111111', '2026-04-24 11:08:20.118+00'),  -- Golazos: not probed
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P5', '0x1111111111111111', '2025-06-01 00:00:00+00'),      -- before the floor date
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'P6', '0x1111111111111111', '2025-12-29 06:00:00+00');      -- estimate below the floor height

-- claims 1 + 2
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pack_mint_probe_lane();
  PERFORM _assert_eq(v->>'enqueued', '4', 'TS x3 instants + AD x1; Golazos and pre-floor-date rows are not probes');
  PERFORM _assert_eq(v->>'dispatched', '3', 'three probes dispatched');
  PERFORM _assert_eq(v->>'below_floor', '1', 'the 2025-12-29 06:00 instant estimates below the spork floor');
  PERFORM _assert((SELECT priority = 1 FROM public.pack_mint_probes
                    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND probe_at = '2026-04-24 11:08:20.118+00'),
                  'a saved wallet''s instant is priority 1 (case-folded address)');
  PERFORM _assert((SELECT status = 'failed' AND last_error = 'below the Flow spork floor' AND request_id IS NULL
                     FROM public.pack_mint_probes WHERE probe_at = '2025-12-29 06:00:00+00'),
                  'below the floor: failed with its reason, never dispatched');
  PERFORM _assert((SELECT url FROM net.calls ORDER BY id LIMIT 1)
                   = 'https://rest-mainnet.onflow.org/v1/events?type=A.0b2a3299cc857e29.PackNFT.Minted&start_height=140000470&end_height=140000719',
                  'first dispatch: the saved wallet''s Top Shot instant, 250 blocks around the interpolated height');
  PERFORM _assert((SELECT bool_and(timeout_ms = 20000) FROM net.calls), 'every probe waits 20 s (a 5 s default died on DNS in production)');
  PERFORM _assert((SELECT count(*) = 1 FROM net.calls WHERE url LIKE '%A.e4cf4bdc1751c65d.PackNFT.Minted%'),
                  'the All Day instant reads All Day''s PackNFT contract');
END $$;

-- Responses. TS T+500: a window T+400..T+600 with P1 minted AT the instant and
-- P2 minted 60 s later. TS T+900: a window T+100..T+300 (missed, instant later).
-- AD: HTTP 503.
CREATE FUNCTION pg_temp.ev(p_id text, p_dist text) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('type', 'A.0b2a3299cc857e29.PackNFT.Minted', 'transaction_id', 'tx-' || p_id,
    'payload', replace(encode(convert_to(jsonb_build_object('type', 'Event', 'value', jsonb_build_object(
      'id', 'A.0b2a3299cc857e29.PackNFT.Minted', 'fields', jsonb_build_array(
        jsonb_build_object('name', 'id', 'value', jsonb_build_object('type', 'UInt64', 'value', p_id)),
        jsonb_build_object('name', 'distId', 'value', jsonb_build_object('type', 'UInt64', 'value', p_dist)))))::text, 'UTF8'), 'base64'), E'\n', ''))
$f$;
INSERT INTO net._http_response
SELECT p.request_id, 200, jsonb_build_array(
  jsonb_build_object('block_height', '140000476', 'block_timestamp', '2026-04-24T11:06:40.000Z', 'events', '[]'::jsonb),
  jsonb_build_object('block_height', '140000595', 'block_timestamp', '2026-04-24T11:08:20.118Z', 'events', jsonb_build_array(pg_temp.ev('P1', '7185'))),
  jsonb_build_object('block_height', '140000666', 'block_timestamp', '2026-04-24T11:09:20.000Z', 'events', jsonb_build_array(pg_temp.ev('P2', '1427'))),
  jsonb_build_object('block_height', '140000714', 'block_timestamp', '2026-04-24T11:10:00.000Z', 'events', '[]'::jsonb)
)::text, NULL
FROM public.pack_mint_probes p WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND p.probe_at = '2026-04-24 11:08:20.118+00';
INSERT INTO net._http_response
SELECT p.request_id, 200, jsonb_build_array(
  jsonb_build_object('block_height', '140000100', 'block_timestamp', '2026-04-24T11:01:40.000Z', 'events', '[]'::jsonb),
  jsonb_build_object('block_height', '140000349', 'block_timestamp', '2026-04-24T11:05:00.000Z', 'events', '[]'::jsonb)
)::text, NULL
FROM public.pack_mint_probes p WHERE p.probe_at = '2026-04-24 11:15:00+00';
INSERT INTO net._http_response
SELECT p.request_id, 503, 'upstream unavailable', NULL
FROM public.pack_mint_probes p WHERE p.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070';

-- claims 3, 4, 5
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pack_mint_probe_lane();
  PERFORM _assert(NOT (v->>'ok')::boolean, 'an HTTP failure -> ok=false');
  PERFORM _assert((SELECT ok = false FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the pipeline row says ok=false');
  PERFORM _assert_eq(v->>'done', '1', 'the in-window probe is done');
  PERFORM _assert_eq(v->>'mints_new', '2', 'both mints in the window are recorded');
  PERFORM _assert((SELECT minted_at = '2026-04-24 11:08:20.118+00' AND block_height = 140000595 AND tx_id = 'tx-P1' AND dist_id = '7185'
                     FROM public.pack_nft_mints WHERE pack_nft_id = 'P1'),
                  'a mint carries its block time, height, tx and distribution');
  PERFORM _assert((SELECT status = 'done' AND n_minted = 2 AND n_at_instant = 1 FROM public.pack_mint_probes
                    WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND probe_at = '2026-04-24 11:08:20.118+00'),
                  'the probe says 2 mints read, 1 AT the instant');
  -- the miss: re-aimed later from the last block it read (140000349 + ceil(600 s x 1.25) - 125), not "no mints"
  PERFORM _assert((SELECT status = 'in_flight' AND attempts = 1 AND start_height = 140000349 + 750 - 125 AND n_minted IS NULL
                     FROM public.pack_mint_probes WHERE probe_at = '2026-04-24 11:15:00+00'),
                  'a window that missed its instant is re-aimed and re-dispatched, never recorded as empty');
  PERFORM _assert((SELECT status = 'in_flight' AND attempts = 1 AND last_error LIKE 'http 503%'
                     FROM public.pack_mint_probes WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'),
                  'an HTTP failure retries with its error');
END $$;

-- claim 4, the cap: a fourth miss gives up with the reason.
UPDATE public.pack_mint_probes SET attempts = 3 WHERE probe_at = '2026-04-24 11:15:00+00';
INSERT INTO net._http_response
SELECT p.request_id, 200, jsonb_build_array(
  jsonb_build_object('block_height', '140000974', 'block_timestamp', '2026-04-24T11:13:00.000Z', 'events', '[]'::jsonb)
)::text, NULL
FROM public.pack_mint_probes p WHERE p.probe_at = '2026-04-24 11:15:00+00';
DO $$
BEGIN
  PERFORM public.run_pack_mint_probe_lane();
  PERFORM _assert((SELECT status = 'failed' AND attempts = 4 AND last_error LIKE 'window % missed the instant' AND finished_at IS NOT NULL
                     FROM public.pack_mint_probes WHERE probe_at = '2026-04-24 11:15:00+00'),
                  'after 4 attempts a missing window is failed with its reason');
  PERFORM _assert((SELECT count(*) = 0 FROM public.pack_nft_mints WHERE pack_nft_id = 'P3'), 'a failed probe claims nothing');
END $$;

ROLLBACK;
