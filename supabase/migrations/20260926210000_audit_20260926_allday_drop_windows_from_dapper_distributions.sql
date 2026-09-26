-- 2026-09-26 (PT) — every All Day drop's sale window (start / end) and price,
-- read from Dapper's searchDistributions, so a pack with no buy row can be
-- judged against the drop it came from.
--
-- WHY. The pack history prices an unrecorded pack at its drop's retail only when
-- it was acquired inside the drop's sale window (20260926190300). The window
-- comes from pack_distributions.metadata->>'start_time' -- which 151 of 3,228
-- All Day distributions carry. 1,445 more carry `startTime` in Go's format
-- ("2025-11-21 00:00:00 +0000 UTC", not a Postgres timestamp) and 1,632 carry
-- no start at all. On 0xbd94cade097e50ac that left 400 of 468 unpriced All Day
-- packs with no window to test. Dapper's studio API answers the question
-- directly: searchDistributions(byProductID "AllDay") returns startTime /
-- endTime / price for every distribution (checked: 4078 Regal Rookies Quick
-- Rips 2024-10-31 20:00Z .. 11-04, $5; 1768 Rookie Debut Premium Wave 2
-- 2024-09-06 .. 09-10, $99 -- the same prices allday_pack_supply holds).
--
-- WHAT. A self-contained lane:
--   allday_drop_windows        one row per distribution: start_time, end_time,
--                              price_usd, title, fetched_at
--   allday_drop_window_pages   the walk's pg_net pages
--   allday_drop_window_state   one row: when the current / last walk started,
--                              finished, pages, rows, last_error
--   run_allday_drop_windows_lane()  collect landed pages (upsert every node,
--                              dispatch the next page), start a new walk when
--                              the last one finished > 24 h ago
-- pg_cron rpc-allday-drop-windows-lane at 2-57/5 (off the 0/1/20/21/40/41 ban).
-- The readers take it in the next migrations.
--
-- Revert:
--   SELECT cron.unschedule('rpc-allday-drop-windows-lane');
--   DROP FUNCTION public.run_allday_drop_windows_lane();
--   DROP TABLE public.allday_drop_window_pages, public.allday_drop_window_state,
--              public.allday_drop_windows;
--   (revert 20260926210100 / 210200 first -- they read allday_drop_windows.)

CREATE TABLE IF NOT EXISTS public.allday_drop_windows (
  dist_id     text PRIMARY KEY,
  start_time  timestamptz,
  end_time    timestamptz,
  price_usd   numeric(14,2),
  title       text,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.allday_drop_windows IS
  'Every All Day distribution''s sale window and price from Dapper searchDistributions(byProductID AllDay). dist_id = String(node.id), the same key as pack_distributions / allday_pack_supply. Written by run_allday_drop_windows_lane().';

CREATE TABLE IF NOT EXISTS public.allday_drop_window_pages (
  request_id    bigint PRIMARY KEY,
  page          int NOT NULL,
  after_cursor  text,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  collected_at  timestamptz,
  status_code   int,
  outcome       text,
  n_returned    int
);
CREATE INDEX IF NOT EXISTS idx_allday_drop_window_pages_open
  ON public.allday_drop_window_pages (dispatched_at) WHERE collected_at IS NULL;

CREATE TABLE IF NOT EXISTS public.allday_drop_window_state (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  started_at    timestamptz,
  completed_at  timestamptz,
  pages         int NOT NULL DEFAULT 0,
  rows_upserted int NOT NULL DEFAULT 0,
  last_error    text
);
INSERT INTO public.allday_drop_window_state (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.allday_drop_windows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allday_drop_window_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.allday_drop_window_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allday_drop_windows      FROM anon, authenticated;
REVOKE ALL ON public.allday_drop_window_pages FROM anon, authenticated;
REVOKE ALL ON public.allday_drop_window_state FROM anon, authenticated;


-- ── run_allday_drop_windows_lane ────────────────────────────────────────────
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
    ELSIF r.page >= 80 THEN
      UPDATE public.allday_drop_window_state
         SET completed_at = now(), last_error = 'page cap 80 reached; distributions beyond 8,000 not walked' WHERE id = 1;
      v_last_error := 'page cap 80 reached';
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

-- Service-side only: pg_cron (postgres).
REVOKE ALL ON FUNCTION public.run_allday_drop_windows_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_allday_drop_windows_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-allday-drop-windows-lane', '2-57/5 * * * *', 'SELECT public.run_allday_drop_windows_lane();');
