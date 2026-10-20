-- DB invariant: public.autograph_sweep_tick — the daily Atlas sweep that writes
-- editions.autographed_at (signed editions) and edition_autograph_checks (when each
-- edition was last confirmed). A regression either claims a signature Atlas never
-- gave, keeps one Atlas withdrew, stamps an unchecked edition as checked, or counts a
-- failed page as done.
--
-- Pins:
--   * an idle cycle (finished < 20 h ago) dispatches nothing; an old one restarts;
--   * a 200 page writes autographed_at ONLY where it changed, and re-stamps a check row
--     for every edition the page named (Top Shot via topshot_atlas_edition_map, All Day
--     via editions.external_id);
--   * a withdrawn signature is RETIRED (autographed_at -> NULL), never kept;
--   * a 403 page is drained as an error and dispatched again; a page counts as done only
--     from a 200;
--   * a page that fails to parse is recorded and reported in errors (ok=false upstream);
--   * the cycle closes only when nothing is pending and nothing is in flight.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261020030228_audit_20261019_editions_autographed_at_from_atlas.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE SEQUENCE net._req_seq START 100;
CREATE TABLE net._sent (id bigint, body jsonb);
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code int, content text, error_msg text);
CREATE FUNCTION net.http_post(url text, body jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds int DEFAULT 5000)
  RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net._sent VALUES (nextval('net._req_seq'), body) RETURNING id $$;
CREATE FUNCTION public.atlas_market_headers(text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

CREATE TABLE public.editions (id uuid PRIMARY KEY, collection_id uuid, external_id text, autographed_at timestamptz);
CREATE TABLE public.topshot_atlas_edition_map (rpc_edition_id uuid, atlas_edition_id text);
CREATE TABLE public.edition_autograph_checks (edition_id uuid PRIMARY KEY, autographed_at timestamptz, checked_at timestamptz NOT NULL);
CREATE TABLE public.autograph_sweep_state (product text PRIMARY KEY, cycle_started_at timestamptz, cycle_finished_at timestamptz, total_count integer);
CREATE TABLE public.autograph_sweep_requests (
  request_id bigint PRIMARY KEY, product text NOT NULL, page_offset integer NOT NULL, cycle_started_at timestamptz NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(), drained_at timestamptz, status_code integer,
  rows_seen integer, rows_written integer, error text);

-- >>> BEGIN verbatim autograph_sweep_tick (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.autograph_sweep_tick(p_pages_per_product integer DEFAULT 2)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_started  timestamptz := clock_timestamp();
  r          record;
  s          record;
  v_body     jsonb;
  v_seen     integer;
  v_changed  integer;
  v_checked  integer;
  v_drained  integer := 0;
  v_pages_ok integer := 0;
  v_pages_bad integer := 0;
  v_changed_total integer := 0;
  v_checked_total integer := 0;
  v_dispatched integer := 0;
  v_errors   text[] := '{}';
  v_offset   integer;
BEGIN
  -- 1. Drain: every dispatched request whose response has arrived (or that has waited 10 min).
  FOR r IN
    SELECT q.request_id, q.product, q.page_offset, q.cycle_started_at, h.status_code, h.content, h.error_msg,
           (h.id IS NULL) AS missing
      FROM public.autograph_sweep_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < clock_timestamp() - interval '10 minutes')
     ORDER BY q.request_id
     LIMIT 20
  LOOP
    v_drained := v_drained + 1;
    IF r.missing OR r.status_code IS DISTINCT FROM 200 OR left(coalesce(r.content, ''), 1) <> '{' THEN
      v_pages_bad := v_pages_bad + 1;
      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN r.missing THEN 'no_response' ELSE coalesce(left(r.error_msg, 200), 'http_' || coalesce(r.status_code::text, 'null')) END
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    BEGIN
      v_body := r.content::jsonb;

      -- One statement: parse the page, resolve each Atlas id to an RPC edition, write the flag on
      -- change, re-stamp every check row. (Data-modifying CTEs all run, whether or not they are read.)
      WITH page AS (
        SELECT x->>'id' AS atlas_id, nullif(x->>'autographedAt', '')::timestamptz AS autographed_at
          FROM jsonb_array_elements(coalesce(v_body->'editions', '[]'::jsonb)) x
         WHERE x->>'id' IS NOT NULL
      ), tgt AS (
        SELECT m.rpc_edition_id AS edition_id, p.autographed_at
          FROM page p JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = p.atlas_id
         WHERE r.product = 'nba'
        UNION ALL
        SELECT e.id, p.autographed_at
          FROM page p JOIN public.editions e
            ON e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND e.external_id = p.atlas_id
         WHERE r.product = 'nfl'
      ), upd AS (
        UPDATE public.editions e SET autographed_at = t.autographed_at
          FROM tgt t
         WHERE e.id = t.edition_id AND e.autographed_at IS DISTINCT FROM t.autographed_at
        RETURNING 1
      ), chk AS (
        INSERT INTO public.edition_autograph_checks (edition_id, autographed_at, checked_at)
        SELECT edition_id, autographed_at, clock_timestamp() FROM tgt
        ON CONFLICT (edition_id) DO UPDATE SET autographed_at = EXCLUDED.autographed_at, checked_at = EXCLUDED.checked_at
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM page), (SELECT count(*) FROM upd), (SELECT count(*) FROM chk)
        INTO v_seen, v_changed, v_checked;

      IF (v_body->'pagination'->>'totalCount') ~ '^[0-9]+$' THEN
        UPDATE public.autograph_sweep_state SET total_count = (v_body->'pagination'->>'totalCount')::int
         WHERE product = r.product;
      END IF;

      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = 200, rows_seen = v_seen, rows_written = v_changed + v_checked, error = NULL
       WHERE request_id = r.request_id;
      v_pages_ok := v_pages_ok + 1;
      v_changed_total := v_changed_total + v_changed;
      v_checked_total := v_checked_total + v_checked;
    -- when-others-timeout-blind: intentional — this handler records one page and the loop CONTINUES, so a
    -- caught 57014 would run on with the timer disarmed; a kill must end the run (the tick's next run retries).
    EXCEPTION WHEN OTHERS THEN
      v_pages_bad := v_pages_bad + 1;
      v_errors := v_errors || left(SQLERRM, 200);
      UPDATE public.autograph_sweep_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code, error = 'parse_or_write: ' || left(SQLERRM, 200)
       WHERE request_id = r.request_id;
    END;
  END LOOP;

  -- 2. Close or open cycles, then dispatch the next pending pages per product.
  FOR s IN SELECT * FROM public.autograph_sweep_state ORDER BY product LOOP
    IF s.cycle_finished_at IS NOT NULL AND s.cycle_finished_at >= s.cycle_started_at THEN
      IF s.cycle_finished_at > clock_timestamp() - interval '20 hours' THEN
        CONTINUE;  -- finished recently: idle until the next daily cycle
      END IF;
      UPDATE public.autograph_sweep_state SET cycle_started_at = clock_timestamp(), cycle_finished_at = NULL
       WHERE product = s.product
      RETURNING * INTO s;
    END IF;

    v_offset := NULL;
    FOR r IN
      SELECT o AS page_offset
        FROM generate_series(0, greatest(coalesce(s.total_count, 1) - 1, 0), 100) o
       WHERE NOT EXISTS (SELECT 1 FROM public.autograph_sweep_requests q
                          WHERE q.product = s.product AND q.cycle_started_at = s.cycle_started_at
                            AND q.page_offset = o
                            AND (q.status_code = 200 AND q.error IS NULL OR q.drained_at IS NULL))
       ORDER BY o
       LIMIT greatest(p_pages_per_product, 0)
    LOOP
      INSERT INTO public.autograph_sweep_requests (request_id, product, page_offset, cycle_started_at)
      VALUES (net.http_post(
                url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
                body := jsonb_build_object('product', s.product, 'limit', '100', 'offset', r.page_offset::text),
                headers := public.atlas_market_headers(s.product),
                timeout_milliseconds := 30000),
              s.product, r.page_offset, s.cycle_started_at);
      v_dispatched := v_dispatched + 1;
      v_offset := r.page_offset;
    END LOOP;

    -- Nothing left to dispatch and nothing in flight: the cycle is complete.
    IF v_offset IS NULL AND s.total_count IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM public.autograph_sweep_requests q
          WHERE q.product = s.product AND q.cycle_started_at = s.cycle_started_at AND q.drained_at IS NULL) THEN
      UPDATE public.autograph_sweep_state SET cycle_finished_at = clock_timestamp() WHERE product = s.product;
    END IF;
  END LOOP;

  -- No retention purge: ~250 request rows a day (~90k a year) is cheaper to keep than to prune.

  RETURN jsonb_build_object(
    'drained', v_drained, 'pages_ok', v_pages_ok, 'pages_failed', v_pages_bad,
    'editions_changed', v_changed_total, 'checks_written', v_checked_total,
    'dispatched', v_dispatched, 'errors', to_jsonb(v_errors),
    'duration_ms', (extract(epoch FROM clock_timestamp() - v_started) * 1000)::int);
END;
$fn$;
-- <<< END verbatim autograph_sweep_tick <<<

-- ── fixtures ────────────────────────────────────────────────────────────────
-- Top Shot: e1 (atlas 1) will be signed, e2 (atlas 2) unsigned. All Day: e3 (external_id 9).
INSERT INTO public.editions VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '219:7408::18', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000002', '95f28a17-224a-4025-96ad-adf8a4c63bfd', '219:7408::17', NULL),
  ('aaaaaaaa-0000-4000-8000-000000000003', 'dee28451-5d62-409e-a1ad-a83f763ac070', '9', NULL);
INSERT INTO public.topshot_atlas_edition_map VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', '1'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '2');
-- nba: 2 pages (total 150), its cycle finished 21 h ago -> restarts. nfl: finished 1 h ago -> idle.
INSERT INTO public.autograph_sweep_state VALUES
  ('nba', now() - interval '22 hours', now() - interval '21 hours', 150),
  ('nfl', now() - interval '2 hours', now() - interval '1 hour', 50);

-- ── 1. restart + dispatch: nba gets offsets 0 and 100, nfl stays idle ───────
SELECT _assert_eq((public.autograph_sweep_tick(2)->>'dispatched'), '2', 'tick 1 dispatches the two nba pages');
SELECT _assert_eq((SELECT string_agg(page_offset::text, ',' ORDER BY page_offset) FROM public.autograph_sweep_requests WHERE product = 'nba'), '0,100', 'offsets 0 and 100');
SELECT _assert((SELECT count(*) FROM public.autograph_sweep_requests WHERE product = 'nfl') = 0, 'nfl finished 1 h ago -> idle, nothing dispatched');
SELECT _assert((SELECT cycle_finished_at IS NULL FROM public.autograph_sweep_state WHERE product = 'nba'), 'the nba cycle reopened');

-- page 0 answers 200 (atlas 1 signed, atlas 2 unsigned); page 100 answers 403.
INSERT INTO net._http_response
SELECT request_id, 200, '{"editions":[{"id":"1","autographedAt":"2025-09-18T00:00:00Z"},{"id":"2","autographedAt":null}],"pagination":{"totalCount":"150"}}', NULL
  FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 0;
INSERT INTO net._http_response
SELECT request_id, 403, '<!DOCTYPE html>', NULL
  FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100;

-- ── 2. drain: one page ok, one failed; the flag written where it changed ────
CREATE TEMP TABLE r2 AS SELECT public.autograph_sweep_tick(2) AS r;
SELECT _assert_eq((SELECT r->>'pages_ok' FROM r2), '1', 'tick 2: one page ok');
SELECT _assert_eq((SELECT r->>'pages_failed' FROM r2), '1', 'tick 2: the 403 page failed');
SELECT _assert_eq((SELECT r->>'editions_changed' FROM r2), '1', 'tick 2: only the newly signed edition changed');
SELECT _assert_eq((SELECT r->>'checks_written' FROM r2), '2', 'tick 2: a check row for each edition the page named');
SELECT _assert((SELECT autographed_at IS NOT NULL FROM public.editions WHERE external_id = '219:7408::18'), 'e1 is signed');
SELECT _assert((SELECT autographed_at IS NULL FROM public.editions WHERE external_id = '219:7408::17'), 'e2 stays unsigned');
SELECT _assert((SELECT autographed_at IS NULL AND checked_at IS NOT NULL FROM public.edition_autograph_checks WHERE edition_id = 'aaaaaaaa-0000-4000-8000-000000000002'), 'e2 is VERIFIED unsigned (a check row with no signature)');
SELECT _assert((SELECT count(*) FROM public.edition_autograph_checks WHERE edition_id = 'aaaaaaaa-0000-4000-8000-000000000003') = 0, 'an edition no page named gets no check row');
SELECT _assert_eq((SELECT error FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100 AND status_code = 403), 'http_403', 'the 403 is recorded');
SELECT _assert((SELECT count(*) FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100) = 2, 'the 403 page was dispatched again in the same tick');
SELECT _assert((SELECT cycle_finished_at IS NULL FROM public.autograph_sweep_state WHERE product = 'nba'), 'a retried page keeps the cycle open');

-- The retry answers with a page that does not parse.
INSERT INTO net._http_response
SELECT request_id, 200, '{"editions":[{"id":', NULL
  FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100 AND drained_at IS NULL;

-- ── 3. a parse failure is reported, never counted as done ───────────────────
CREATE TEMP TABLE r3 AS SELECT public.autograph_sweep_tick(2) AS r;
SELECT _assert((SELECT jsonb_array_length(r->'errors') FROM r3) = 1, 'tick 3: the unparseable page is in errors');
SELECT _assert((SELECT count(*) FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100 AND error LIKE 'parse_or_write:%') = 1, 'recorded as parse_or_write');
SELECT _assert((SELECT cycle_finished_at IS NULL FROM public.autograph_sweep_state WHERE product = 'nba'), 'a page that failed to parse is not done');

-- The next retry answers 200 and WITHDRAWS e1's signature (atlas 1 now null).
INSERT INTO net._http_response
SELECT request_id, 200, '{"editions":[{"id":"1","autographedAt":null}],"pagination":{"totalCount":"150"}}', NULL
  FROM public.autograph_sweep_requests WHERE product = 'nba' AND page_offset = 100 AND drained_at IS NULL;

-- ── 4. a withdrawn signature is retired; the cycle then closes ──────────────
CREATE TEMP TABLE r4 AS SELECT public.autograph_sweep_tick(2) AS r;
SELECT _assert_eq((SELECT r->>'editions_changed' FROM r4), '1', 'tick 4: the withdrawn signature changed one edition');
SELECT _assert((SELECT autographed_at IS NULL FROM public.editions WHERE external_id = '219:7408::18'), 'e1 retired to unsigned, not kept');
SELECT _assert((SELECT cycle_finished_at IS NOT NULL FROM public.autograph_sweep_state WHERE product = 'nba'), 'every page done and nothing in flight -> the cycle closed');
SELECT _assert_eq((public.autograph_sweep_tick(2)->>'dispatched'), '0', 'a just-closed cycle dispatches nothing');

-- ── 5. All Day joins on editions.external_id ────────────────────────────────
UPDATE public.autograph_sweep_state SET cycle_finished_at = now() - interval '21 hours', cycle_started_at = now() - interval '22 hours' WHERE product = 'nfl';
SELECT public.autograph_sweep_tick(2);
INSERT INTO net._http_response
SELECT request_id, 200, '{"editions":[{"id":"9","autographedAt":"2025-04-08T00:00:00Z"}],"pagination":{"totalCount":"50"}}', NULL
  FROM public.autograph_sweep_requests WHERE product = 'nfl' AND drained_at IS NULL;
SELECT public.autograph_sweep_tick(2);
SELECT _assert((SELECT autographed_at IS NOT NULL FROM public.editions WHERE external_id = '9'), 'the All Day edition is signed via external_id');
SELECT _assert((SELECT cycle_finished_at IS NOT NULL FROM public.autograph_sweep_state WHERE product = 'nfl'), 'the one-page nfl cycle closed');

SELECT '✓ autograph_sweep_tick: all assertions passed' AS result;

ROLLBACK;
