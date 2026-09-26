-- DB invariant: public.run_allday_drop_windows_lane — every All Day drop's sale
-- window (startTime / endTime) and price from Dapper's searchDistributions, so a
-- pack with no buy row can be judged against its drop. Added 2026-09-26 (1,632
-- All Day distributions carried no start time at all). Claims:
--
--   1. A walk starts when none is in flight: page 1 of searchDistributions
--      (byProductID AllDay, 100 per page).
--   2. A landed page upserts every node (start / end / price / title; an
--      unparseable time is NULL, never a guess) and dispatches the next page
--      with its cursor -- a page with a next page is NOT a finished walk.
--   3. The last page finishes the walk with no error; no new walk starts
--      within 24 h.
--   4. A failed page ends the walk WITH its error and the run says ok=false;
--      rows already written stay.
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20260926210050_audit_20260926_allday_drop_windows_page_cap_200.sql; tables from 20260926210000).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found int, p_rows_written int,
  p_rows_skipped int, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

-- pg_net stand-in: http_post records the body and returns an id.
CREATE SCHEMA net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE SEQUENCE net.req_seq START 1000;
CREATE TABLE net.calls (id bigint, body jsonb, timeout_ms int);
CREATE FUNCTION net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds int)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint := nextval('net.req_seq');
BEGIN INSERT INTO net.calls VALUES (v, body, timeout_milliseconds); RETURN v; END $$;

-- the lane's own tables, as the migration creates them
CREATE TABLE public.allday_drop_windows (dist_id text PRIMARY KEY, start_time timestamptz, end_time timestamptz,
  price_usd numeric(14,2), title text, fetched_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.allday_drop_window_pages (request_id bigint PRIMARY KEY, page int NOT NULL, after_cursor text,
  dispatched_at timestamptz NOT NULL DEFAULT now(), collected_at timestamptz, status_code int, outcome text, n_returned int);
CREATE TABLE public.allday_drop_window_state (id int PRIMARY KEY DEFAULT 1 CHECK (id = 1), started_at timestamptz,
  completed_at timestamptz, pages int NOT NULL DEFAULT 0, rows_upserted int NOT NULL DEFAULT 0, last_error text);
INSERT INTO public.allday_drop_window_state (id) VALUES (1);

-- >>> BEGIN verbatim run_allday_drop_windows_lane (body byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.run_allday_drop_windows_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_state public.allday_drop_window_state%ROWTYPE;
  r record;
  v_body jsonb; v_edges jsonb; v_cursor text; v_more boolean;
  v_n int; v_req bigint;
  v_pages int := 0; v_rows int := 0; v_failed int := 0; v_expired int := 0;
  v_started_walk boolean := false; v_finished_walk boolean := false;
  v_last_error text := NULL;
  c_query constant text := 'query($input: SearchDistributionsInput!){ searchDistributions(input:$input){ pageInfo{ endCursor hasNextPage } edges{ node{ id title startTime endTime price{ value } } } } }';
  c_headers constant jsonb := '{"Content-Type":"application/json","Origin":"https://nflallday.com","Referer":"https://nflallday.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_allday_drop_windows_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect every landed page.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
    FROM public.allday_drop_window_pages q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        UPDATE public.allday_drop_window_pages SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        UPDATE public.allday_drop_window_state
           SET completed_at = now(), last_error = 'no_response on page ' || r.page WHERE id = 1;
        v_expired := v_expired + 1;
        v_last_error := 'no_response on page ' || r.page;
      END IF;
      CONTINUE;
    END IF;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    v_edges := v_body->'data'->'searchDistributions'->'edges';
    IF v_body IS NULL OR jsonb_typeof(v_edges) IS DISTINCT FROM 'array' THEN
      v_failed := v_failed + 1;
      v_last_error := 'page ' || r.page || ': ' || left(coalesce(v_body->'errors'->0->>'message', r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ' ' || r.h_content), 200);
      UPDATE public.allday_drop_window_pages
         SET collected_at = now(), status_code = r.h_status,
             outcome = CASE WHEN r.h_status IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.h_status::text, 'null') ELSE 'graphql_error' END
       WHERE request_id = r.request_id;
      -- the walk ends WITH its error; rows already written stay (each is a fact)
      UPDATE public.allday_drop_window_state SET completed_at = now(), last_error = v_last_error WHERE id = 1;
      CONTINUE;
    END IF;

    WITH n AS (
      SELECT e->'node' AS node FROM jsonb_array_elements(v_edges) e
    ), ins AS (
      INSERT INTO public.allday_drop_windows (dist_id, start_time, end_time, price_usd, title, fetched_at)
      SELECT node->>'id',
             CASE WHEN pg_input_is_valid(node->>'startTime', 'timestamptz') THEN (node->>'startTime')::timestamptz END,
             CASE WHEN pg_input_is_valid(node->>'endTime', 'timestamptz') THEN (node->>'endTime')::timestamptz END,
             CASE WHEN pg_input_is_valid(node->'price'->>'value', 'numeric') THEN round((node->'price'->>'value')::numeric, 2) END,
             node->>'title', now()
      FROM n WHERE node->>'id' IS NOT NULL
      ON CONFLICT (dist_id) DO UPDATE
        SET start_time = EXCLUDED.start_time, end_time = EXCLUDED.end_time,
            price_usd = EXCLUDED.price_usd, title = EXCLUDED.title, fetched_at = EXCLUDED.fetched_at
      RETURNING 1
    )
    SELECT count(*) INTO v_n FROM ins;
    v_rows := v_rows + v_n;
    v_pages := v_pages + 1;

    UPDATE public.allday_drop_window_pages
       SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
     WHERE request_id = r.request_id;
    UPDATE public.allday_drop_window_state
       SET pages = pages + 1, rows_upserted = rows_upserted + v_n WHERE id = 1;

    v_cursor := v_body->'data'->'searchDistributions'->'pageInfo'->>'endCursor';
    v_more := coalesce((v_body->'data'->'searchDistributions'->'pageInfo'->>'hasNextPage')::boolean, false);
    -- Three outcomes; only the first two END the walk.
    IF NOT v_more OR v_cursor IS NULL THEN
      UPDATE public.allday_drop_window_state SET completed_at = now(), last_error = NULL WHERE id = 1;
      v_finished_walk := true;
    ELSIF r.page >= 200 THEN
      UPDATE public.allday_drop_window_state
         SET completed_at = now(), last_error = 'page cap 200 reached; distributions beyond 8,000 not walked' WHERE id = 1;
      v_last_error := 'page cap 200 reached';
    ELSE
      SELECT net.http_post(
        url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
        body := jsonb_build_object('query', c_query, 'variables', jsonb_build_object('input',
                  jsonb_build_object('first', 100, 'after', v_cursor, 'filters', jsonb_build_object('byProductID', 'AllDay')))),
        headers := c_headers, timeout_milliseconds := 20000
      ) INTO v_req;
      INSERT INTO public.allday_drop_window_pages (request_id, page, after_cursor) VALUES (v_req, r.page + 1, v_cursor);
    END IF;
  END LOOP;

  -- (2) Start a walk when none is in flight and the last one finished > 24 h ago.
  SELECT * INTO v_state FROM public.allday_drop_window_state WHERE id = 1;
  IF NOT EXISTS (SELECT 1 FROM public.allday_drop_window_pages WHERE collected_at IS NULL)
     AND (v_state.completed_at IS NULL AND v_state.started_at IS NULL
          OR v_state.completed_at < now() - interval '24 hours'
          OR (v_state.completed_at IS NULL AND v_state.started_at < now() - interval '2 hours')) THEN
    SELECT net.http_post(
      url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
      body := jsonb_build_object('query', c_query, 'variables', jsonb_build_object('input',
                jsonb_build_object('first', 100, 'filters', jsonb_build_object('byProductID', 'AllDay')))),
      headers := c_headers, timeout_milliseconds := 20000
    ) INTO v_req;
    INSERT INTO public.allday_drop_window_pages (request_id, page) VALUES (v_req, 1);
    UPDATE public.allday_drop_window_state
       SET started_at = now(), completed_at = NULL, pages = 0, rows_upserted = 0, last_error = NULL WHERE id = 1;
    v_started_walk := true;
  END IF;

  PERFORM public.log_pipeline_run(
    'allday-drop-windows', v_started,
    v_pages, v_rows, 0,
    (v_failed = 0 AND v_expired = 0), v_last_error,
    'nfl_all_day', NULL, NULL,
    jsonb_build_object('pages', v_pages, 'rows_upserted', v_rows, 'pages_failed', v_failed,
                       'pages_expired', v_expired, 'walk_started', v_started_walk, 'walk_finished', v_finished_walk)
  );

  RETURN jsonb_build_object('ok', v_failed = 0 AND v_expired = 0, 'pages', v_pages, 'rows_upserted', v_rows,
                            'pages_failed', v_failed, 'pages_expired', v_expired,
                            'walk_started', v_started_walk, 'walk_finished', v_finished_walk,
                            'last_error', v_last_error);
END;
$function$;
-- <<< END verbatim <<<

-- claim 1
DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_allday_drop_windows_lane();
  PERFORM _assert((v->>'walk_started')::boolean, 'no walk in flight -> a walk starts');
  PERFORM _assert((SELECT count(*) = 1 FROM public.allday_drop_window_pages WHERE page = 1 AND collected_at IS NULL), 'page 1 in flight');
  PERFORM _assert((SELECT body->'variables'->'input'->'filters'->>'byProductID' = 'AllDay'
                      AND (body->'variables'->'input'->>'first')::int = 100
                      AND body->'variables'->'input'->>'after' IS NULL
                      AND body->>'query' LIKE '%startTime endTime%'
                      AND timeout_ms = 20000
                     FROM net.calls ORDER BY id LIMIT 1), 'page 1 asks All Day''s distributions, 100 a page, with their windows');
END $$;

-- claim 2: page 1 lands with two nodes and a next page
INSERT INTO net._http_response
SELECT request_id, 200, '{"data":{"searchDistributions":{"pageInfo":{"endCursor":"cur-1","hasNextPage":true},"edges":[
  {"node":{"id":4078,"title":"Regal Rookies Quick Rips (2024 Season)","startTime":"2024-10-31T20:00:00Z","endTime":"2024-11-04T22:00:00Z","price":{"value":"5.00000000"}}},
  {"node":{"id":9999,"title":"Undated","startTime":"soon","endTime":null,"price":{"value":"0E-8"}}}
]}}}', NULL
FROM public.allday_drop_window_pages WHERE page = 1;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_allday_drop_windows_lane();
  PERFORM _assert((v->>'ok')::boolean AND (v->>'rows_upserted')::int = 2, 'both nodes upserted');
  PERFORM _assert((SELECT start_time = '2024-10-31 20:00:00+00' AND end_time = '2024-11-04 22:00:00+00' AND price_usd = 5.00
                     FROM public.allday_drop_windows WHERE dist_id = '4078'), 'a drop carries its window and price');
  PERFORM _assert((SELECT start_time IS NULL AND price_usd = 0 FROM public.allday_drop_windows WHERE dist_id = '9999'),
                  'an unparseable time is NULL, never a guess');
  PERFORM _assert((SELECT count(*) = 1 FROM public.allday_drop_window_pages WHERE page = 2 AND after_cursor = 'cur-1' AND collected_at IS NULL),
                  'page 2 dispatched with the cursor');
  PERFORM _assert((SELECT completed_at IS NULL FROM public.allday_drop_window_state), 'a page with a next page is NOT a finished walk');
  PERFORM _assert(NOT (v->>'walk_started')::boolean, 'no second walk while one is in flight');
END $$;

-- claim 3: page 2 is the last
INSERT INTO net._http_response
SELECT request_id, 200, '{"data":{"searchDistributions":{"pageInfo":{"endCursor":"cur-2","hasNextPage":false},"edges":[{"node":{"id":1768,"title":"Rookie Debut Premium - Wave 2","startTime":"2024-09-06T00:00:00Z","endTime":"2024-09-10T03:30:00Z","price":{"value":"99.00000000"}}}]}}}', NULL
FROM public.allday_drop_window_pages WHERE page = 2;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_allday_drop_windows_lane();
  PERFORM _assert((v->>'walk_finished')::boolean, 'the last page finishes the walk');
  PERFORM _assert((SELECT completed_at IS NOT NULL AND last_error IS NULL AND pages = 2 AND rows_upserted = 3 FROM public.allday_drop_window_state),
                  'state: finished, 2 pages, 3 rows, no error');
  PERFORM _assert(NOT (v->>'walk_started')::boolean, 'no new walk within 24 h');
  PERFORM _assert((SELECT count(*) = 0 FROM public.allday_drop_window_pages WHERE collected_at IS NULL), 'nothing left in flight');
END $$;

-- claim 4: a day later a walk starts and its page fails
UPDATE public.allday_drop_window_state SET completed_at = now() - interval '25 hours';
DO $$ BEGIN PERFORM public.run_allday_drop_windows_lane(); END $$;
INSERT INTO net._http_response
SELECT request_id, 503, 'upstream unavailable', NULL FROM public.allday_drop_window_pages WHERE collected_at IS NULL;

DO $$
DECLARE v jsonb;
BEGIN
  v := public.run_allday_drop_windows_lane();
  PERFORM _assert(NOT (v->>'ok')::boolean, 'a failed page -> ok=false');
  PERFORM _assert((SELECT ok = false FROM public.pipeline_runs_stub ORDER BY ctid DESC LIMIT 1), 'the pipeline row says ok=false');
  PERFORM _assert((SELECT completed_at IS NOT NULL AND last_error LIKE 'page 1:%' FROM public.allday_drop_window_state),
                  'a failed page ends the walk WITH its error');
  PERFORM _assert((SELECT count(*) = 3 FROM public.allday_drop_windows), 'rows already written stay');
END $$;

ROLLBACK;
