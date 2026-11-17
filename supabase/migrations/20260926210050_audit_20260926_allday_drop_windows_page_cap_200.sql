-- 2026-09-26 (PT) — run_allday_drop_windows_lane: page cap 80 -> 200.
--
-- searchDistributions answers 40 nodes a page whatever `first` asks (first
-- production page, 11:30 AM PT: 40 rows for first: 100), so ~3,200 All Day
-- distributions take ~81 pages -- past the cap of 80, which would have ended
-- every walk with an error before its last pages. 200 pages x 40 = 8,000.
-- Nothing else changes.
-- anon-exec: unchanged (run_allday_drop_windows_lane) — CREATE OR REPLACE of an existing fn; ACL preserved (REVOKE FROM PUBLIC, anon, authenticated in 20260926210000).
--
-- Revert: re-apply the body from
--   supabase/migrations/20260926210000_audit_20260926_allday_drop_windows_from_dapper_distributions.sql
-- and repoint its pin.

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
