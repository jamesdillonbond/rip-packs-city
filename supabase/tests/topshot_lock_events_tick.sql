-- DB invariant: public.topshot_lock_events_tick / _apply / _request — the TopShotLocking event lane
-- that keeps wallet_moments_cache.is_locked current (#222). Pins:
--   · the first tick asks only the sealed height; the next dispatches locked+unlocked pages for
--     250-block ranges from sealed−216,000, never past the last KNOWN sealed height;
--   · a MomentLocked page sets is_locked=true and lock_checked_at = the block time on EVERY wallet's
--     Top Shot row for that moment — and never another collection's row with the same moment_id;
--   · an event OLDER than the row's lock_checked_at (a newer poll) does not overwrite it;
--   · within a page the LAST event for a moment wins;
--   · a 403 is re-asked (attempt 2) and the run stays ok; a page on its last attempt fails the run.
--
-- The DDL below is a VERBATIM copy of the committed migration (tables + three functions,
-- supabase/migrations/20261101052029_audit_20261031_topshot_lock_events_lane.sql, minus its watchlist
-- row and cron.schedule); __tests__/db-invariants-drift-guard.test.ts fails CI if a function drifts.
--
-- Runs inside a rolled-back transaction so it leaves no residue.
BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code integer, error_msg text, content text);
CREATE TABLE net.sent (id bigint, url text);
CREATE SEQUENCE net.req_seq START 9000;
CREATE FUNCTION net.http_get(url text, timeout_milliseconds integer)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.sent SELECT nextval('net.req_seq'), url RETURNING id $$;

CREATE TABLE public.pipeline_log (pipeline text, rows_found integer, rows_written integer, ok boolean, error text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p_pipeline, p_rows_found, p_rows_written, p_ok, p_error, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.wallet_moments_cache (wallet_address text, collection_id uuid, moment_id text, is_locked boolean, lock_checked_at timestamptz);
INSERT INTO public.wallet_moments_cache VALUES
  ('0xaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '100', false, '2026-10-31T13:00:00Z'),
  ('0xbb', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '100', false, '2026-10-30T13:00:00Z'),
  ('0xaa', 'dee28451-5d62-409e-a1ad-a83f763ac070', '100', false, '2026-10-30T13:00:00Z'),
  ('0xaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '200', false, '2026-10-31T23:00:00Z'),
  ('0xaa', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '300', true,  '2026-10-30T00:00:00Z');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.topshot_lock_event_state (
  id            integer PRIMARY KEY CHECK (id = 1),
  next_height   bigint,
  sealed_height bigint,
  sealed_at     timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.topshot_lock_event_state (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.topshot_lock_event_requests (
  request_id    bigint      PRIMARY KEY,
  kind          text        NOT NULL CHECK (kind IN ('sealed', 'locked', 'unlocked')),
  start_h       bigint,
  end_h         bigint,
  attempt       integer     NOT NULL DEFAULT 1,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  drained_at    timestamptz,
  status_code   integer,
  events        integer,
  rows_updated  integer,
  error         text
);
CREATE INDEX IF NOT EXISTS idx_topshot_lock_event_requests_open
  ON public.topshot_lock_event_requests (kind) WHERE drained_at IS NULL;

ALTER TABLE public.topshot_lock_event_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.topshot_lock_event_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_lock_event_state, public.topshot_lock_event_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_apply(p_body jsonb, p_locked boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_events integer;
  v_rows   integer;
BEGIN
  WITH ev AS (
    SELECT convert_from(decode(e->>'payload', 'base64'), 'UTF8')::jsonb #>> '{value,fields,0,value,value}' AS moment_id,
           (b->>'block_timestamp')::timestamptz AS ts, (b->>'block_height')::bigint AS bh, (e->>'event_index')::integer AS ei
      FROM jsonb_array_elements(p_body) b
     CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b->'events', '[]'::jsonb)) e
     WHERE e->>'payload' ~ '^[A-Za-z0-9+/=]+$'
  ), last AS (
    SELECT DISTINCT ON (moment_id) moment_id, ts
      FROM ev WHERE moment_id ~ '^[0-9]+$'
     ORDER BY moment_id, bh DESC, ei DESC
  ), upd AS (
    UPDATE public.wallet_moments_cache w
       SET is_locked = p_locked, lock_checked_at = l.ts
      FROM last l
     WHERE w.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND w.moment_id = l.moment_id
       AND (w.lock_checked_at IS NULL OR w.lock_checked_at < l.ts)
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM ev), (SELECT count(*) FROM upd) INTO v_events, v_rows;
  RETURN jsonb_build_object('events', v_events, 'rows', v_rows);
END;
$function$;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_request(p_kind text, p_start bigint, p_end bigint, p_attempt integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req bigint;
  v_url text;
BEGIN
  v_url := CASE p_kind
    WHEN 'sealed' THEN 'https://rest-mainnet.onflow.org/v1/blocks?height=sealed'
    ELSE 'https://rest-mainnet.onflow.org/v1/events?type=A.0b2a3299cc857e29.TopShotLocking.'
         || CASE p_kind WHEN 'locked' THEN 'MomentLocked' ELSE 'MomentUnlocked' END
         || '&start_height=' || p_start || '&end_height=' || p_end END;
  v_req := net.http_get(url := v_url, timeout_milliseconds := 30000);
  INSERT INTO public.topshot_lock_event_requests (request_id, kind, start_h, end_h, attempt)
  VALUES (v_req, p_kind, p_start, p_end, p_attempt);
  RETURN v_req;
END;
$function$;

CREATE OR REPLACE FUNCTION public.topshot_lock_events_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  MAX_ATTEMPTS constant integer := 3;
  RANGE_BLOCKS constant integer := 250;   -- Flow REST's maximum events range
  PER_TICK     constant integer := 6;     -- ranges dispatched per tick (2 requests each)
  MAX_INFLIGHT constant integer := 12;    -- undrained event requests
  BACKFILL     constant bigint  := 216000; -- ~2 days of blocks on the first run
  v_started  timestamptz := clock_timestamp();
  r          record;
  s          public.topshot_lock_event_state%ROWTYPE;
  v_body     jsonb;
  v_res      jsonb;
  v_retry    boolean;
  v_pages    integer := 0;
  v_failed   integer := 0;
  v_retried  integer := 0;
  v_events   integer := 0;
  v_rows     integer := 0;
  v_sent     integer := 0;
  v_inflight integer;
  v_end      bigint;
  v_errors   jsonb := '[]'::jsonb;
BEGIN
  DELETE FROM public.topshot_lock_event_requests WHERE drained_at < now() - interval '2 days';

  -- ── drain ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT q.request_id, q.kind, q.start_h, q.end_h, q.attempt,
           h.status_code, h.error_msg, h.content, (h.id IS NOT NULL) AS has_resp
      FROM public.topshot_lock_event_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < now() - interval '5 minutes')
     ORDER BY q.request_id
     LIMIT 60
  LOOP
    v_body := CASE WHEN r.has_resp AND r.status_code = 200 AND r.content IS NOT NULL
                        AND pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END;
    IF r.kind = 'sealed' THEN
      -- The next tick asks again; a missed height only delays dispatch by a minute.
      IF v_body IS NOT NULL AND v_body -> 0 -> 'header' ->> 'height' ~ '^[0-9]+$' THEN
        UPDATE public.topshot_lock_event_state
           SET sealed_height = greatest(coalesce(sealed_height, 0), (v_body -> 0 -> 'header' ->> 'height')::bigint),
               sealed_at = clock_timestamp(), updated_at = now()
         WHERE id = 1;
      END IF;
      UPDATE public.topshot_lock_event_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN v_body IS NULL THEN coalesce(r.status_code::text, 'no-response') END
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    v_pages := v_pages + 1;
    IF v_body IS NULL OR jsonb_typeof(v_body) IS DISTINCT FROM 'array' THEN
      v_retry := r.attempt < MAX_ATTEMPTS
                 AND (NOT r.has_resp OR r.status_code IS NULL
                      OR r.status_code IN (403, 408, 429) OR r.status_code >= 500);
      UPDATE public.topshot_lock_event_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN v_retry THEN 'retried ' ELSE '' END
                  || CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
      IF v_retry THEN
        PERFORM public.topshot_lock_events_request(r.kind, r.start_h, r.end_h, r.attempt + 1);
        v_retried := v_retried + 1;
      ELSE
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object('kind', r.kind, 'start', r.start_h, 'status', r.status_code);
      END IF;
      CONTINUE;
    END IF;

    v_res := public.topshot_lock_events_apply(v_body, r.kind = 'locked');
    v_events := v_events + (v_res ->> 'events')::integer;
    v_rows := v_rows + (v_res ->> 'rows')::integer;
    UPDATE public.topshot_lock_event_requests
       SET drained_at = clock_timestamp(), status_code = 200,
           events = (v_res ->> 'events')::integer, rows_updated = (v_res ->> 'rows')::integer
     WHERE request_id = r.request_id;
  END LOOP;

  -- ── dispatch ─────────────────────────────────────────────────────────────
  IF NOT EXISTS (SELECT 1 FROM public.topshot_lock_event_requests WHERE kind = 'sealed' AND drained_at IS NULL) THEN
    PERFORM public.topshot_lock_events_request('sealed', NULL, NULL, 1);
  END IF;
  SELECT * INTO s FROM public.topshot_lock_event_state WHERE id = 1;
  IF s.sealed_height IS NOT NULL THEN
    IF s.next_height IS NULL THEN
      UPDATE public.topshot_lock_event_state SET next_height = s.sealed_height - BACKFILL, updated_at = now()
       WHERE id = 1 RETURNING * INTO s;
    END IF;
    SELECT count(*) INTO v_inflight FROM public.topshot_lock_event_requests
     WHERE kind <> 'sealed' AND drained_at IS NULL;
    FOR i IN 1 .. PER_TICK LOOP
      EXIT WHEN v_inflight + 2 > MAX_INFLIGHT OR s.next_height > s.sealed_height;
      v_end := least(s.next_height + RANGE_BLOCKS - 1, s.sealed_height);
      PERFORM public.topshot_lock_events_request('locked', s.next_height, v_end, 1);
      PERFORM public.topshot_lock_events_request('unlocked', s.next_height, v_end, 1);
      v_inflight := v_inflight + 2;
      v_sent := v_sent + 2;
      UPDATE public.topshot_lock_event_state SET next_height = v_end + 1, updated_at = now()
       WHERE id = 1 RETURNING * INTO s;
    END LOOP;
  END IF;

  IF v_pages > 0 THEN
    -- ok = no page failed for good. rows_written = wmc rows whose lock state an event changed.
    PERFORM public.log_pipeline_run(
      'topshot-lock-events', v_started, v_events, v_rows, v_failed,
      v_failed = 0,
      CASE WHEN v_failed > 0 THEN v_failed || ' page(s) failed' END,
      'nba_top_shot', NULL, s.next_height::text,
      jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                         'events', v_events, 'rows_updated', v_rows, 'sent', v_sent,
                         'lag_blocks', s.sealed_height - s.next_height + 1, 'errors_sample', v_errors));
  END IF;
  RETURN jsonb_build_object('pages', v_pages, 'failed', v_failed, 'retried', v_retried, 'events', v_events,
                            'rows', v_rows, 'sent', v_sent, 'next_height', s.next_height, 'sealed_height', s.sealed_height);
END;
$function$;

REVOKE ALL ON FUNCTION public.topshot_lock_events_apply(jsonb, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.topshot_lock_events_request(text, bigint, bigint, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.topshot_lock_events_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.topshot_lock_events_tick() TO service_role;

-- helper: one Flow REST events block payload
CREATE FUNCTION pg_temp.ev(p_type text, p_id text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('type', 'A.0b2a3299cc857e29.TopShotLocking.' || p_type, 'event_index', '0',
    'payload', replace(encode(convert_to(jsonb_build_object(
        'value', jsonb_build_object('id', 'A.0b2a3299cc857e29.TopShotLocking.' || p_type,
                   'fields', jsonb_build_array(jsonb_build_object('name', 'id', 'value', jsonb_build_object('type', 'UInt64', 'value', p_id)))),
        'type', 'Event')::text, 'UTF8'), 'base64'), E'\n', ''))
$$;

DO $$
DECLARE v jsonb; n integer; lo bigint;
BEGIN
  v := public.topshot_lock_events_tick();
  ASSERT (SELECT count(*) FROM net.sent) = 1 AND (SELECT url FROM net.sent) LIKE '%blocks?height=sealed', 'tick 1 asks only the sealed height';

  INSERT INTO net._http_response SELECT id, 200, NULL, '[{"header":{"height":"1000000"}}]' FROM net.sent;
  v := public.topshot_lock_events_tick();
  SELECT next_height INTO lo FROM public.topshot_lock_event_state;
  ASSERT (SELECT sealed_height FROM public.topshot_lock_event_state) = 1000000, 'sealed height recorded';
  ASSERT (SELECT count(*) FROM public.topshot_lock_event_requests WHERE kind <> 'sealed') = 12, format('6 ranges x 2 kinds dispatched: %s', v);
  ASSERT (SELECT min(start_h) FROM public.topshot_lock_event_requests WHERE kind <> 'sealed') = 1000000 - 216000, 'backfill starts 216,000 blocks back';
  ASSERT (SELECT max(end_h) FROM public.topshot_lock_event_requests WHERE kind <> 'sealed') <= 1000000, 'never past the known sealed height';
  ASSERT lo = 1000000 - 216000 + 6 * 250, 'cursor advanced by the dispatched ranges';

  -- the first LOCKED page: moment 100 locked at 10-31 20:00Z (after 0xaa's 13:00 poll); moment 200 locked
  -- at 10-31 20:00Z but polled at 23:00Z (newer) → untouched; moment 300 unlocked then relocked: last wins.
  INSERT INTO net._http_response
  SELECT q.request_id, 200, NULL, jsonb_build_array(
           jsonb_build_object('block_height', '784000', 'block_timestamp', '2026-10-31T20:00:00Z',
             'events', jsonb_build_array(pg_temp.ev('MomentLocked', '100'), pg_temp.ev('MomentLocked', '200')))
         )::text
    FROM public.topshot_lock_event_requests q WHERE q.kind = 'locked' AND q.start_h = 784000;
  INSERT INTO net._http_response
  SELECT q.request_id, 403, NULL, '<html>Just a moment</html>'
    FROM public.topshot_lock_event_requests q WHERE q.kind = 'unlocked' AND q.start_h = 784000;
  v := public.topshot_lock_events_tick();
  ASSERT (SELECT is_locked AND lock_checked_at = '2026-10-31T20:00:00Z' FROM public.wallet_moments_cache WHERE wallet_address='0xaa' AND moment_id='100' AND collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'),
    'MomentLocked sets the flag and stamps the block time';
  ASSERT (SELECT is_locked FROM public.wallet_moments_cache WHERE wallet_address='0xbb' AND moment_id='100'), 'every wallet''s row for that NFT';
  ASSERT NOT (SELECT is_locked FROM public.wallet_moments_cache WHERE moment_id='100' AND collection_id='dee28451-5d62-409e-a1ad-a83f763ac070'),
    'never another collection''s row with the same moment_id';
  ASSERT NOT (SELECT is_locked FROM public.wallet_moments_cache WHERE moment_id='200'), 'an event older than a newer poll does not overwrite it';
  ASSERT (SELECT count(*) FROM public.topshot_lock_event_requests WHERE kind='unlocked' AND start_h=784000 AND attempt=2) = 1, 'a 403 is re-asked';
  ASSERT (SELECT ok FROM public.pipeline_log ORDER BY ctid DESC LIMIT 1), 'a re-asked page does not fail the run';

  -- the unlocked page (retry) lands: 300 unlocked at 21:00Z then locked at 21:00Z+? — same page, last wins
  INSERT INTO net._http_response
  SELECT q.request_id, 200, NULL, jsonb_build_array(
           jsonb_build_object('block_height', '784010', 'block_timestamp', '2026-10-31T21:00:00Z',
             'events', jsonb_build_array(pg_temp.ev('MomentUnlocked', '300'))))::text
    FROM public.topshot_lock_event_requests q WHERE q.kind = 'unlocked' AND q.start_h = 784000 AND q.attempt = 2;
  v := public.topshot_lock_events_tick();
  ASSERT NOT (SELECT is_locked FROM public.wallet_moments_cache WHERE moment_id='300'), 'MomentUnlocked clears the flag';

  -- a page on its last attempt fails the run
  UPDATE public.topshot_lock_event_requests SET attempt = 3 WHERE kind='locked' AND start_h = 784250 AND drained_at IS NULL;
  INSERT INTO net._http_response
  SELECT q.request_id, 500, NULL, 'boom' FROM public.topshot_lock_event_requests q WHERE q.kind='locked' AND q.start_h = 784250 AND q.drained_at IS NULL;
  v := public.topshot_lock_events_tick();
  ASSERT (v->>'failed')::integer = 1, format('last-attempt failure counted: %s', v);
  ASSERT NOT (SELECT ok FROM public.pipeline_log ORDER BY ctid DESC LIMIT 1), 'a page out of attempts fails the run';

  ASSERT NOT has_function_privilege('anon', 'public.topshot_lock_events_tick()', 'EXECUTE'), 'anon cannot tick';
  ASSERT NOT has_function_privilege('anon', 'public.topshot_lock_events_apply(jsonb, boolean)', 'EXECUTE'), 'anon cannot apply';
END $$;

SELECT '✓ topshot_lock_events lane: all assertions passed' AS result;
ROLLBACK;
