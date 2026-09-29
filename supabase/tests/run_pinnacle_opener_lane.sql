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
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260929183000_audit_20260929_pinnacle_pack_openers_read_from_the_open_tx.sql).
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
  -- mainnet24..27 roots/ends; 28 = current spork
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
  v_expired int := 0; v_enqueued int := 0; v_dispatched int := 0;
  v_last_error text := NULL;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pinnacle_opener_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

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
       WHERE p.opener_address IS NULL AND p.open_block >= v_roots[1]
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
        FROM public.pinnacle_opener_windows w WHERE w.status = 'pending'
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
                       'dispatched', v_dispatched));
  RETURN jsonb_build_object('ok', v_failed = 0, 'collected', v_collected, 'windows_done', v_done,
                            'attributed', v_attributed, 'failed', v_failed, 'throttled', v_throttled,
                            'expired', v_expired, 'enqueued', v_enqueued, 'dispatched', v_dispatched,
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
VALUES ('T', '0x00000000000000aa', 'TXT', 100000000, ARRAY['1']);
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

-- fixture: A (1 pin) and B (2 pins, recipients CC, CC... and DD) in mainnet26
-- window 400000 (100000000..100000249); E just before mainnet24 ends, F just
-- after (same win number 343924).
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, open_tx, open_block, nft_ids) VALUES
  ('A', 'TXA', 100000010, ARRAY['10']),
  ('B', 'TXB', 100000020, ARRAY['20', '21', '22']),
  ('E', 'TXE', 85981100, ARRAY['30']),
  ('F', 'TXF', 85981200, ARRAY['40']);

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  -- E1
  PERFORM _assert((SELECT lo = 100000000 AND hi = 100000249 FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400000),
                  'E1: a mainnet26 window');
  PERFORM _assert((SELECT lo = 85981000 AND hi = 85981134 FROM public.pinnacle_opener_windows WHERE spork = 1 AND win = 343924),
                  'E1: the mainnet24 side ends at its last height');
  PERFORM _assert((SELECT lo = 85981135 AND hi = 85981249 FROM public.pinnacle_opener_windows WHERE spork = 2 AND win = 343924),
                  'E1: the mainnet25 side starts at its root');
  PERFORM _assert((SELECT count(*) = 0 FROM public.pinnacle_opener_windows WHERE lo <= 100000000 AND hi >= 100000000 AND spork <> 3),
                  'E1: T (opener known) needs no window of its own');
  -- D1
  PERFORM _assert((SELECT url FROM net.calls c JOIN public.pinnacle_opener_windows w ON w.request_id = c.id WHERE w.spork = 3 AND w.win = 400000)
                  = 'http://access-001.mainnet26.nodes.onflow.org:8070/v1/events?type=A.edf9df96c92f4595.Pinnacle.Deposit&start_height=100000000&end_height=100000249',
                  'D1: one events read per window on its node');
  PERFORM _assert((SELECT url FROM net.calls c JOIN public.pinnacle_opener_windows w ON w.request_id = c.id WHERE w.spork = 1)
                  LIKE 'http://access-001.mainnet24.%end_height=85981134', 'D1: the mainnet24 half reads mainnet24 up to its end');
END $$;

-- responses: the mainnet26 window. Pin 10 is deposited to AA in TXA, and
-- again to 0x…01 in a LATER tx (a transfer; it sorts first, so only the tx join can reject it); B's pins go CC, CC, DD in TXB.
INSERT INTO net._http_response (id, status_code, content)
SELECT w.request_id, 200, jsonb_build_array(
  jsonb_build_object('block_height', '100000010', 'events', jsonb_build_array(pg_temp.dep('10', '0x00000000000000aa', 'TXA'))),
  jsonb_build_object('block_height', '100000020', 'events', jsonb_build_array(
    pg_temp.dep('20', '0x00000000000000cc', 'TXB'), pg_temp.dep('21', '0x00000000000000cc', 'TXB'), pg_temp.dep('22', '0x00000000000000dd', 'TXB'))),
  jsonb_build_object('block_height', '100000200', 'events', jsonb_build_array(pg_temp.dep('10', '0x0000000000000001', 'TXLATER')))
)::text FROM public.pinnacle_opener_windows w WHERE w.spork = 3 AND w.win = 400000;
-- H1: mainnet24 half throttled, mainnet25 half errors
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 429, 'Too Many Requests' FROM public.pinnacle_opener_windows WHERE spork = 1;
INSERT INTO net._http_response (id, status_code, content)
SELECT request_id, 500, '{"message":"internal server error"}' FROM public.pinnacle_opener_windows WHERE spork = 2;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  -- C1
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'A') = '0x00000000000000aa',
                  'C1: the recipient in the open tx, never a later transfer''s');
  PERFORM _assert((SELECT opener_address FROM public.pinnacle_pack_opens WHERE pack_nft_id = 'B') = '0x00000000000000cc',
                  'C1: the most common recipient of the pack''s pins');
  PERFORM _assert((SELECT status = 'done' AND n_attributed = 2 FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400000),
                  'C1: the window is done with its count');
  -- H1
  PERFORM _assert((SELECT attempts = 0 AND last_error = 'http 429' FROM public.pinnacle_opener_windows WHERE spork = 1),
                  'H1: a 429 costs no attempt');
  PERFORM _assert((SELECT attempts = 1 AND last_error LIKE 'http 500%' FROM public.pinnacle_opener_windows WHERE spork = 2),
                  'H1: a 500 counts an attempt');
  PERFORM _assert(NOT (v->>'ok')::boolean AND (v->>'throttled')::int = 1 AND (v->>'failed')::int = 1, 'H1: ok=false, counted');
END $$;

-- C2: a late-ingested open in the done window
UPDATE public.pinnacle_opener_windows SET finished_at = now() - interval '1 hour' WHERE spork = 3 AND win = 400000;
INSERT INTO public.pinnacle_pack_opens (pack_nft_id, open_tx, open_block, nft_ids, ingested_at)
VALUES ('G', 'TXG', 100000100, ARRAY['50'], now());
DELETE FROM public.pinnacle_opener_windows WHERE spork IN (1, 2);   -- so nothing else is pending and enqueue runs
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_pinnacle_opener_lane();
  PERFORM _assert((SELECT status = 'in_flight' FROM public.pinnacle_opener_windows WHERE spork = 3 AND win = 400000),
                  'C2: a done window holding a newly ingested open is read again');
END $$;

ROLLBACK;
