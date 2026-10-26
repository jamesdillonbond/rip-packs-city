-- DB invariant: public.refresh_panini_edition_ask_daily — Panini's per-edition ask history, CHANGE rows only
-- (migration 20261026040131_audit_20261025_panini_edition_ask_daily.sql). Claims:
--   1. an edition first seen on the board gets a row on today's PT day;
--   2. an unchanged ask writes NOTHING (change rows only);
--   3. a changed ask writes a row; a listed-count change does too, but only once the previous row carries a count;
--   4. an edition that LEFT the board gets one NULL-ask row — and only one (no NULL row after a NULL row);
--   5. a same-day rerun updates the day's row in place (one row per edition per day, never two);
--   6. every run is logged ok.
--
-- The function DDL below is VERBATIM from the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.panini_market_board (external_id varchar, low_ask_usd numeric, listed_count integer, ask_confirmed_at timestamptz);
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_written integer);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_rows_written) RETURNING 1::bigint
$$;

CREATE TABLE IF NOT EXISTS public.panini_edition_ask_daily (
  external_id       text        NOT NULL,
  day               date        NOT NULL,
  low_ask_usd       numeric,
  listed_count      integer,
  ask_confirmed_at  timestamptz,
  source            text        NOT NULL DEFAULT 'board',
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (external_id, day)
);

-- yesterday's history (PT day before today): A at $10 (3 listed), B at $20, C at $30, D already gone (NULL)
INSERT INTO public.panini_edition_ask_daily (external_id, day, low_ask_usd, listed_count) VALUES
  ('A', (now() AT TIME ZONE 'America/Los_Angeles')::date - 1, 10, 3),
  ('B', (now() AT TIME ZONE 'America/Los_Angeles')::date - 1, 20, NULL),
  ('C', (now() AT TIME ZONE 'America/Los_Angeles')::date - 1, 30, 1),
  ('D', (now() AT TIME ZONE 'America/Los_Angeles')::date - 2, 40, 1),
  ('D', (now() AT TIME ZONE 'America/Los_Angeles')::date - 1, NULL, NULL);

-- today's board: A unchanged, B listed count appears (prev count NULL → no row), C gone, E new, F count changed
INSERT INTO public.panini_market_board VALUES
  ('A', 10, 3, now()),
  ('B', 20, 5, now()),
  ('E', 50, 2, now());

-- >>> BEGIN verbatim refresh_panini_edition_ask_daily >>>
CREATE OR REPLACE FUNCTION public.refresh_panini_edition_ask_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_day     date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  v_rows    integer := 0;
BEGIN
  WITH cur AS MATERIALIZED (
    SELECT b.external_id::text AS external_id, b.low_ask_usd, b.listed_count::int AS listed_count, b.ask_confirmed_at
      FROM public.panini_market_board b
     WHERE b.low_ask_usd > 0
  ), prev AS MATERIALIZED (
    SELECT DISTINCT ON (h.external_id) h.external_id, h.low_ask_usd, h.listed_count
      FROM public.panini_edition_ask_daily h
     WHERE h.day < v_day
     ORDER BY h.external_id, h.day DESC
  ), changed AS (
    SELECT COALESCE(c.external_id, p.external_id) AS external_id,
           c.low_ask_usd, c.listed_count, c.ask_confirmed_at
      FROM cur c
      FULL JOIN prev p ON p.external_id = c.external_id
     WHERE (c.external_id IS NOT NULL AND (p.external_id IS NULL
              OR c.low_ask_usd IS DISTINCT FROM p.low_ask_usd
              OR (p.listed_count IS NOT NULL AND c.listed_count IS DISTINCT FROM p.listed_count)))
        OR (c.external_id IS NULL AND p.low_ask_usd IS NOT NULL)
  )
  INSERT INTO public.panini_edition_ask_daily AS h (external_id, day, low_ask_usd, listed_count, ask_confirmed_at, source, recorded_at)
  SELECT external_id, v_day, low_ask_usd, listed_count, ask_confirmed_at, 'board', v_started FROM changed
  ON CONFLICT (external_id, day) DO UPDATE SET
    low_ask_usd = EXCLUDED.low_ask_usd, listed_count = EXCLUDED.listed_count,
    ask_confirmed_at = EXCLUDED.ask_confirmed_at, source = EXCLUDED.source, recorded_at = EXCLUDED.recorded_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  PERFORM public.log_pipeline_run('panini-edition-ask-daily', v_started, v_rows, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'day', v_day));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-edition-ask-daily', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;
-- <<< END verbatim refresh_panini_edition_ask_daily <<<

DO $$
DECLARE
  v int;
  today date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  v := public.refresh_panini_edition_ask_daily();
  PERFORM _assert_eq(v::text, '2', 'today writes E (new) and C (left the board) only');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.panini_edition_ask_daily WHERE external_id = 'A' AND day = today), 'an unchanged ask writes nothing (claim 2)');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.panini_edition_ask_daily WHERE external_id = 'B' AND day = today), 'a count appearing after a NULL count is not a change (claim 3)');
  PERFORM _assert_eq((SELECT low_ask_usd::text FROM public.panini_edition_ask_daily WHERE external_id = 'E' AND day = today), '50', 'a new edition gets a row (claim 1)');
  PERFORM _assert((SELECT low_ask_usd IS NULL FROM public.panini_edition_ask_daily WHERE external_id = 'C' AND day = today), 'an edition that left the board gets a NULL-ask row (claim 4)');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.panini_edition_ask_daily WHERE external_id = 'D' AND day = today), 'no second NULL row after a NULL row (claim 4)');

  -- same day: A's ask drops and C relists — one row each, updated in place on a rerun
  UPDATE public.panini_market_board SET low_ask_usd = 8 WHERE external_id = 'A';
  INSERT INTO public.panini_market_board VALUES ('C', 25, 1, now());
  v := public.refresh_panini_edition_ask_daily();
  PERFORM _assert_eq((SELECT low_ask_usd::text FROM public.panini_edition_ask_daily WHERE external_id = 'A' AND day = today), '8', 'a changed ask writes a row (claim 3)');
  PERFORM _assert_eq((SELECT low_ask_usd::text FROM public.panini_edition_ask_daily WHERE external_id = 'C' AND day = today), '25', 'a same-day rerun updates the day''s row (claim 5)');
  PERFORM _assert_eq((SELECT count(*) FROM public.panini_edition_ask_daily WHERE day = today)::text, '3', 'one row per edition per day (claim 5)');

  UPDATE public.panini_market_board SET listed_count = 4 WHERE external_id = 'E';
  v := public.refresh_panini_edition_ask_daily();
  PERFORM _assert_eq((SELECT listed_count::text FROM public.panini_edition_ask_daily WHERE external_id = 'E' AND day = today), '4', 'a same-day rerun keeps the day''s row at the LATEST state (claim 5)');
  PERFORM _assert_eq((SELECT count(*) FROM public.pipeline_runs_stub WHERE pipeline = 'panini-edition-ask-daily' AND ok)::text, '3', 'every run is logged ok (claim 6)');
END $$;

SELECT '✓ refresh_panini_edition_ask_daily invariants pass' AS result;

ROLLBACK;
