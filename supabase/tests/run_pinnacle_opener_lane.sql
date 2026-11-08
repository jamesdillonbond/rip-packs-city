-- DB invariant: public.run_pinnacle_opener_lane + the keep-opener trigger —
-- Disney Pinnacle pack OPENERS read from the open tx's Pinnacle.Deposit events.
-- Added 2026-09-29 (90,105 opens, 0 openers: Dapper names the custodian).
-- Claims:
--   T1. A NULL never overwrites a known opener (the ingest re-upserts NULL);
--       a real value still can.
--   E1. Windows are (spork, open_block / 250), clamped to the spork: an open
--       just before a spork end and one just after share a win number but get
--       two windows, each inside one spork.
--   D1. One Pinnacle.Deposit events read per window, on its spork's node.
--   C1. The opener is the recipient of the pack's own pins IN THE OPEN TX --
--       never a later transfer of the same pin in another tx; the most common
--       recipient when they differ.
--   C2. A done window is re-read when an open with no opener is ingested after
--       it finished.
--   H1. A 429 is a free retry; another error counts an attempt, ok=false.
--   R1. (2026-11-08, #181) Nothing below the mainnet27 root (130290659) is
--       enqueued or dispatched: a pending window there is closed 'failed' with
--       the #181 reason and no request; an in-flight one is closed once its
--       error lands; a done one is never re-pended; no request URL names
--       mainnet24-26.
--   (Re-based 2026-11-08 from mainnet24-26 heights onto mainnet27 / mainnet28.)
--
-- The function DDL below is VERBATIM from the committed migrations
-- (keep-opener: supabase/migrations/20260929183000_audit_20260929_pinnacle_pack_openers_read_from_the_open_tx.sql;
--  run_pinnacle_opener_lane: supabase/migrations/20261108171810_audit_20261108_run_pinnacle_opener_lane_floor_at_mainnet27.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;
CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, url text);
CREATE FUNCTION net.http_get(url text, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds int DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, url); RETURN v; END $$;

CREATE TABLE public.pinnacle_pack_opens (
  pack_nft_id text PRIMARY KEY, opener_address text, opened_at timestamptz, open_tx text, open_block bigint,
  nft_ids text[], ingested_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.pinnacle_opener_windows (
  spork int NOT NULL, win bigint NOT NULL, lo bigint NOT NULL, hi bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_flight', 'done', 'failed')),
  request_id bigint, attempts int NOT NULL DEFAULT 0, dispatched_at timestamptz, finished_at timestamptz,
  n_opens int, n_attributed int, last_error text, PRIMARY KEY (spork, win));

-- >>> BEGIN verbatim pinnacle_pack_opens_keep_opener (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.pinnacle_pack_opens_keep_opener()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  -- the ingest re-upserts rows with opener_address NULL (Dapper names the
  -- custodian); an opener read on chain must survive that
  IF NEW.opener_address IS NULL AND OLD.opener_address IS NOT NULL THEN
    NEW.opener_address := OLD.opener_address;
  END IF;
  RETURN NEW;
END;
$function$;
-- <<< END verbatim <<<
CREATE TRIGGER pinnacle_pack_opens_keep_opener
  BEFORE UPDATE ON public.pinnacle_pack_opens
  FOR EACH ROW EXECUTE FUNCTION public.pinnacle_pack_opens_keep_opener();

-- >>> BEGIN verbatim run_pinnacle_opener_lane (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_pinnacle_opener_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started  timestamptz := clock_timestamp();
  v_per_node constant int := 10;
  v_max_att  constant int := 6;
  -- 2026-11-08: the mainnet27 root. Flow retired the mainnet24-26 access nodes
  -- (#181: no DNS record), so an open block before this height has no node that
  -- can read it. Such work is never enqueued or dispatched; a pending row is
  -- closed 'failed' with v_retired_msg. (Was the mainnet24 root, v_roots[1].)
  v_floor    constant bigint := 130290659;
  v_retired_msg constant text := 'open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes, so the block is not readable by any node (#181)';
  -- mainnet24..27 roots/ends; 28 = current spork. The mainnet24-26 entries stay
  -- so the stored spork index (1..5) keeps its meaning; nothing below v_floor
  -- reaches v_nodes[1..3] any more.
  v_roots    constant bigint[] := ARRAY[65264619, 85981135, 88226267, 130290659, 137390146]::bigint[];
  v_ends     constant bigint[] := ARRAY[85981134, 88226266, 130290658, 137390145, 9223372036854775807]::bigint[];
  v_nodes    constant text[] := ARRAY['http://access-001.mainnet24.nodes.onflow.org:8070',
                                      'http://access-001.mainnet25.nodes.onflow.org:8070',
                                      'http://access-001.mainnet26.nodes.onflow.org:8070',
                                      'http://access-001.mainnet27.nodes.onflow.org:8070',
                                      'https://rest-mainnet.onflow.org'];
  r record;
  v_body jsonb; v_n int; v_req bigint;
  v_collected int := 0; v_done int := 0; v_attributed int := 0; v_failed int := 0; v_throttled int := 0;
  v_expired int := 0; v_enqueued int := 0; v_dispatched int := 0; v_retired int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_opener_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (0) A pending window below the floor has no node to read it: close it as
  -- failed, saying why, never dispatch it. (An in-flight one returns to pending
  -- when its DNS failure lands and is closed on the next tick.)
  WITH ret AS (
    UPDATE public.pinnacle_opener_windows
       SET status = 'failed', request_id = NULL, last_error = v_retired_msg,
           finished_at = coalesce(finished_at, now())
     WHERE status = 'pending' AND lo < v_floor
    RETURNING 1
  )
  SELECT count(*) INTO v_retired FROM ret;

  -- (1) Collect.
  FOR r IN
    SELECT w.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
      FROM public.pinnacle_opener_windows w
      LEFT JOIN net._http_response h ON h.id = w.request_id
     WHERE w.status = 'in_flight'
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = 'no_response'
         WHERE spork = r.spork AND win = r.win;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;
    v_collected := v_collected + 1;
    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      IF r.h_status = 429 THEN
        UPDATE public.pinnacle_opener_windows SET status = 'pending', request_id = NULL, last_error = 'http 429'
         WHERE spork = r.spork AND win = r.win;
        v_throttled := v_throttled + 1;
      ELSE
        v_last_error := left(coalesce(r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ': ' || r.h_content), 300);
        UPDATE public.pinnacle_opener_windows
           SET status = CASE WHEN attempts + 1 >= v_max_att THEN 'failed' ELSE 'pending' END,
               attempts = attempts + 1, request_id = NULL, last_error = v_last_error,
               finished_at = CASE WHEN attempts + 1 >= v_max_att THEN now() END
         WHERE spork = r.spork AND win = r.win;
        v_failed := v_failed + 1;
      END IF;
      CONTINUE;
    END IF;

    WITH ev AS MATERIALIZED (
      SELECT e->>'transaction_id' AS tx,
             convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb AS pl
        FROM jsonb_array_elements(v_body) b
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(b->'events', '[]'::jsonb)) e
    ), d AS MATERIALIZED (
      SELECT tx,
             (SELECT x->'value'->>'value' FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'id') AS pin_id,
             (SELECT coalesce(x->'value'->'value'->>'value', x->'value'->>'value')
                FROM jsonb_array_elements(pl->'value'->'fields') x WHERE x->>'name' = 'to') AS to_addr
        FROM ev
    ), m AS (
      -- per open: the most common recipient of its pins in its own tx
      SELECT DISTINCT ON (o.pack_nft_id) o.pack_nft_id, d.to_addr
        FROM public.pinnacle_pack_opens o
        JOIN d ON d.tx = o.open_tx AND d.pin_id = ANY (o.nft_ids)
       WHERE o.opener_address IS NULL AND o.open_block BETWEEN r.lo AND r.hi AND d.to_addr IS NOT NULL
       GROUP BY o.pack_nft_id, d.to_addr
       ORDER BY o.pack_nft_id, count(*) DESC, d.to_addr
    ), upd AS (
      UPDATE public.pinnacle_pack_opens o SET opener_address = m.to_addr
        FROM m WHERE o.pack_nft_id = m.pack_nft_id AND o.opener_address IS NULL
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM upd;
    v_attributed := v_attributed + v_n;

    UPDATE public.pinnacle_opener_windows
       SET status = 'done', finished_at = now(), request_id = NULL, last_error = NULL, n_attributed = v_n,
           n_opens = (SELECT count(*) FROM public.pinnacle_pack_opens o WHERE o.open_block BETWEEN r.lo AND r.hi)
     WHERE spork = r.spork AND win = r.win;
    v_done := v_done + 1;
  END LOOP;

  -- (2) Enqueue (every 10 minutes, or when nothing is pending): windows with
  -- an open that has no opener; a done window is re-read when such an open was
  -- ingested after it finished.
  IF extract(minute FROM now())::int % 10 = 0
     OR NOT EXISTS (SELECT 1 FROM public.pinnacle_opener_windows WHERE status = 'pending') THEN
    WITH o AS (
      SELECT (SELECT min(i) FROM generate_subscripts(v_ends, 1) i WHERE v_ends[i] >= p.open_block) AS sp,
             p.open_block / 250 AS win, max(p.ingested_at) AS last_ingested
        FROM public.pinnacle_pack_opens p
       WHERE p.opener_address IS NULL AND p.open_block >= v_floor
       GROUP BY 1, 2
    ), ins AS (
      INSERT INTO public.pinnacle_opener_windows AS w (spork, win, lo, hi)
      SELECT o.sp, o.win, greatest(o.win * 250, v_roots[o.sp]), least(o.win * 250 + 249, v_ends[o.sp])
        FROM o WHERE o.sp IS NOT NULL
      ON CONFLICT (spork, win) DO UPDATE
        SET status = 'pending', request_id = NULL, attempts = 0
        WHERE w.status = 'done'
          AND w.finished_at < (SELECT max(p2.ingested_at) FROM public.pinnacle_pack_opens p2
                                WHERE p2.opener_address IS NULL AND p2.open_block BETWEEN w.lo AND w.hi)
      RETURNING 1
    )
    SELECT count(*) INTO v_enqueued FROM ins;
  END IF;

  -- (3) Dispatch: <= v_per_node per spork node, newest windows first.
  FOR r IN
    SELECT * FROM (
      SELECT w.*, row_number() OVER (PARTITION BY w.spork ORDER BY w.win DESC) AS rn
        FROM public.pinnacle_opener_windows w WHERE w.status = 'pending' AND w.lo >= v_floor
    ) z WHERE rn <= v_per_node
  LOOP
    SELECT net.http_get(
      url := v_nodes[r.spork] || '/v1/events?type=A.edf9df96c92f4595.Pinnacle.Deposit&start_height=' || r.lo || '&end_height=' || r.hi,
      timeout_milliseconds := 30000
    ) INTO v_req;
    UPDATE public.pinnacle_opener_windows
       SET status = 'in_flight', request_id = v_req, dispatched_at = now()
     WHERE spork = r.spork AND win = r.win;
    v_dispatched := v_dispatched + 1;
  END LOOP;

  PERFORM public.log_pipeline_run(
    'pinnacle-pack-openers', v_started, v_collected, v_attributed, 0, (v_failed = 0), v_last_error,
    'disney_pinnacle', NULL, NULL,
    jsonb_build_object('windows_done', v_done, 'attributed', v_attributed, 'failed', v_failed,
                       'throttled', v_throttled, 'expired', v_expired, 'enqueued', v_enqueued,
                       'dispatched', v_dispatched, 'retired_pre_mainnet27', v_retired));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'windows_done', v_done,
                            'attributed', v_attributed, 'failed', v_failed, 'throttled', v_throttled,
                            'expired', v_expired, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
                            'retired_pre_mainnet27', v_retired,
                            'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<

CREATE FUNCTION pg_temp.dep(p_pin text, p_to text, p_tx text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('type', 'A.edf9df96c92f4595.Pinnacle.Deposit', 'transaction_id', p_tx,
    'payload', translate(encode(convert_to(jsonb_build_object('type', 'Event', 'value', jsonb_build_object(
      'id', 'A.edf9df96c92f4595.Pinnacle.Deposit', 'fields', jsonb_build_array(
        jsonb_build_object('name', 'id', 'value', jsonb_build_object('type', 'UInt64', 'value', p_pin)),
        jsonb_build_object('name', 'to', 'value', jsonb_build_object('type', 'Optional',
          'value', jsonb_build_object('type', 'Address', 'value', p_to))))))::text, 'UTF8'), 'base64'), E'\n', '')) $$;

-- T1
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, opener_address, open_tx, open_block, nft_ids)
VALUES ('T', '0x00000000000000aa', 'TXT', 131000000, ARRAY['1']);
UPDATE public.pinnacle_pack_opens SET opener_address = NULL, open_tx = 'TXT' WHERE pack_nft_id = 'T';
DO $$ BEGIN
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'T') = '0x00000000000000aa',
                  'T1: an ingest re-upsert with NULL keeps the known opener');
END $$;
UPDATE public.pinnacle_pack_opens SET opener_address = '0x00000000000000ab' WHERE pack_nft_id = 'T';
DO $$ BEGIN
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'T') = '0x00000000000000ab',
                  'T1: a real value still updates');
END $$;

-- fixture: A (1 pin) and B (2 pins, recipients CC, CC... and DD) in mainnet27
-- window 524000 (131000000..131000249); E just before mainnet27 ends, F just
-- after (same win number 549560, F on mainnet28).
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, open_tx, open_block, nft_ids) VALUES
  ('A', 'TXA', 131000010, ARRAY['10']),
  ('B', 'TXB', 131000020, ARRAY['20', '21', '22']),
  ('E', 'TXE', 137390100, ARRAY['30']),
  ('F', 'TXF', 137390200, ARRAY['40']);
-- R1 fixture: O, an old (mainnet26) open with no opener, ingested now, inside a
-- window that finished an hour ago (the old code re-pended and re-read it on
-- mainnet26); and a pending mainnet26 window left from before the floor.
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, open_tx, open_block, nft_ids, ingested_at)
VALUES ('O', 'TXO', 100000010, ARRAY['60'], now());
INSERT INTO public.pinnacle_opener_windows (spork, win, lo, hi, status, finished_at) VALUES
  (3, 400000, 100000000, 100000249, 'done', now() - interval '1 hour'),
  (3, 400001, 100000250, 100000499, 'pending', NULL);

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  -- E1
  PERFORM _assert((SELECT lo = 131000000 AND hi = 131000249 FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 524000),
                  'E1: a mainnet27 window');
  PERFORM _assert((SELECT lo = 137390000 AND hi = 137390145 FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 549560),
                  'E1: the mainnet27 side ends at its last height');
  PERFORM _assert((SELECT lo = 137390146 AND hi = 137390249 FROM public.pinnacle_opener_windows WHERE spork = 5 AND win = 549560),
                  'E1: the mainnet28 side starts at its root');
  PERFORM _assert((SELECT count(*) = 0 FROM public.pinnacle_opener_windows WHERE lo <= 131000000 AND hi >= 131000000 AND spork <> 4),
                  'E1: T (opener known) needs no window of its own');
  -- D1
  PERFORM _assert((SELECT url FROM net.calls c JOIN public.pinnacle_opener_windows w ON w.request_id = c.id WHERE w.spork = 4 AND w.win = 524000)
                  = 'http://access-001.mainnet27.nodes.onflow.org:8070/v1/events?type=A.edf9df96c92f4595.Pinnacle.Deposit&start_height=131000000&end_height=131000249',
                  'D1: one events read per window on its node');
  PERFORM _assert((SELECT url FROM net.calls c JOIN public.pinnacle_opener_windows w ON w.request_id = c.id WHERE w.spork = 4 AND w.win = 549560)
                  LIKE 'http://access-001.mainnet27.%end_height=137390145', 'D1: the mainnet27 half reads mainnet27 up to its end');
  PERFORM _assert((SELECT url FROM net.calls c JOIN public.pinnacle_opener_windows w ON w.request_id = c.id WHERE w.spork = 5 AND w.win = 549560)
                  LIKE 'https://rest-mainnet.onflow.org/%start_height=137390146&end_height=137390249', 'D1: the mainnet28 half reads rest-mainnet from its root');
  -- R1
  PERFORM _assert((SELECT status = 'failed' AND request_id IS NULL AND finished_at IS NOT NULL
                          AND last_error LIKE 'open block before 130290659 (mainnet27 root): Flow retired the mainnet24-26 access nodes%(#181)'
                     FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400001),
                  'R1: a pending window below the floor is closed failed with the #181 reason');
  PERFORM _assert((SELECT status = 'done' AND request_id IS NULL FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400000),
                  'R1: a done window below the floor is not re-pended by a late-ingested old open');
  PERFORM _assert((SELECT count(*) = 2 FROM public.pinnacle_opener_windows WHERE lo < 130290659),
                  'R1: an old open with no opener enqueues no window');
  PERFORM _assert((v->>'retired_pre_mainnet27')::int = 1 AND (v->>'ok')::boolean, 'R1: retired counted, and not a failure');
  PERFORM _assert((SELECT count(*) = 0 FROM net.calls WHERE url ~ 'mainnet2[456]'), 'R1: no request to a retired node');
END $$;

-- responses: the mainnet27 window. Pin 10 is deposited to AA in TXA, and
-- again to 0x…01 in a LATER tx (a transfer; it sorts first, so only the tx join can reject it); B's pins go CC, CC, DD in TXB.
INSERT INTO net._http_response (id, status_code, content)
SELECT w.request_id, 200, jsonb_build_array(
  jsonb_build_object('block_height', '131000010', 'events', jsonb_build_array(pg_temp.dep('10', '0x00000000000000aa', 'TXA'))),
  jsonb_build_object('block_height', '131000020', 'events', jsonb_build_array(
    pg_temp.dep('20', '0x00000000000000cc', 'TXB'), pg_temp.dep('21', '0x00000000000000cc', 'TXB'), pg_temp.dep('22', '0x00000000000000dd', 'TXB'))),
  jsonb_build_object('block_height', '131000200', 'events', jsonb_build_array(pg_temp.dep('10', '0x0000000000000001', 'TXLATER')))
)::text FROM public.pinnacle_opener_windows w WHERE w.spork = 4 AND w.win = 524000;
-- H1: mainnet27 half throttled, mainnet28 half errors
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 429, 'Too Many Requests' FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 549560;
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 500, '{"message":"internal server error"}' FROM public.pinnacle_opener_windows WHERE spork = 5 AND win = 549560;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  -- C1
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'A') = '0x00000000000000aa',
                  'C1: the recipient in the open tx, never a later transfer''s');
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'B') = '0x00000000000000cc',
                  'C1: the most common recipient of the pack''s pins');
  PERFORM _assert((SELECT status = 'done' AND n_attributed = 2 FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 524000),
                  'C1: the window is done with its count');
  -- H1
  PERFORM _assert((SELECT attempts = 0 AND last_error = 'http 429' FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 549560),
                  'H1: a 429 costs no attempt');
  PERFORM _assert((SELECT attempts = 1 AND last_error LIKE 'http 500%' FROM public.pinnacle_opener_windows WHERE spork = 5 AND win = 549560),
                  'H1: a 500 counts an attempt');
  PERFORM _assert(NOT (v->>'ok')::boolean AND (v->>'throttled')::int = 1 AND (v->>'failed')::int = 1, 'H1: ok=false, counted');
END $$;

-- C2: a late-ingested open in the done window
UPDATE public.pinnacle_opener_windows SET finished_at = now() - interval '1 hour' WHERE spork = 4 AND win = 524000;
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, open_tx, open_block, nft_ids, ingested_at)
VALUES ('G', 'TXG', 131000100, ARRAY['50'], now());
DELETE FROM public.pinnacle_opener_windows WHERE win = 549560;   -- so nothing else is pending and enqueue runs
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  PERFORM _assert((SELECT status = 'in_flight' FROM public.pinnacle_opener_windows WHERE spork = 4 AND win = 524000),
                  'C2: a done window holding a newly ingested open is read again');
  PERFORM _assert((SELECT status = 'done' FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400000),
                  'R1: ... while a done window below the floor is not');
END $$;

-- R1: a window already in flight to a retired node when the floor lands: its
-- DNS failure returns it to pending, it is not re-dispatched, and the next
-- tick closes it with the #181 reason.
INSERT INTO public.pinnacle_opener_windows (spork, win, lo, hi, status, request_id, dispatched_at)
VALUES (2, 344000, 86000000, 86000249, 'in_flight', 900, now());
INSERT INTO net._http_response (id, status_code, content, error_msg) VALUES (900, NULL, NULL, 'Couldn''t resolve host name');
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  PERFORM _assert((SELECT status = 'pending' AND request_id IS NULL FROM public.pinnacle_opener_windows WHERE spork = 2 AND win = 344000),
                  'R1: an in-flight window below the floor is collected but not re-dispatched');
  v := public.run_pinnacle_opener_lane();
  PERFORM _assert((SELECT status = 'failed' AND last_error LIKE 'open block before 130290659%(#181)'
                     FROM public.pinnacle_opener_windows WHERE spork = 2 AND win = 344000),
                  'R1: ... and the next tick closes it with the #181 reason');
  PERFORM _assert((v->>'retired_pre_mainnet27')::int = 1, 'R1: counted as retired');
  PERFORM _assert((SELECT count(*) = 0 FROM net.calls WHERE url ~ 'mainnet2[456]'), 'R1: no request to a retired node');
END $$;

ROLLBACK;
