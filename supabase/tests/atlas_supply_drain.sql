-- DB invariant: public.atlas_supply_dispatch / atlas_supply_drain — the Atlas
-- EditionService walk that gives Golazos ('laliga') and Pinnacle ('disney') their
-- burned / issuer-held split. Pins:
--   · a 200 page upserts every edition carrying ALL SIX buckets and SKIPS one missing
--     any bucket (never stores a fabricated zero);
--   · a TRANSIENT refusal (5xx, 403, no response after 15 minutes) is re-asked, up to
--     3 attempts, and does not fail the run while it has attempts left;
--   · an unparseable 200 body, a non-transient 4xx, and a page on its 3rd attempt are
--     each recorded as failed on their request row — and the run's pipeline row is NOT
--     ok when any page failed;
--   · a request still inside its 15-minute window is left for the next drain;
--   · drained requests are not reprocessed; the upsert stamps fetched_at;
--   · dispatch issues one walk per product and refuses a second while one is in flight.
--
-- The function DDL below is a VERBATIM copy of the committed migrations
-- (supabase/migrations/20261009150802_audit_20261009_atlas_supply_retries_a_challenged_page.sql
--  for request_page / dispatch / drain; 20261003213000 for ingest_page);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if a copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.
BEGIN;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_response (id bigint PRIMARY KEY, status_code integer, error_msg text, content text);
CREATE SEQUENCE net.req_seq START 9000;
CREATE FUNCTION net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
RETURNS bigint LANGUAGE sql AS $$ SELECT nextval('net.req_seq') $$;

CREATE TABLE public.pipeline_log (pipeline text, rows_found integer, rows_written integer, ok boolean, error text, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p_pipeline, p_rows_found, p_rows_written, p_ok, p_error, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.atlas_edition_supply (
  product     text        NOT NULL,
  edition_id  text        NOT NULL,
  minted      bigint      NOT NULL,
  burned      bigint      NOT NULL,
  owned       bigint      NOT NULL,
  locked      bigint      NOT NULL,
  listed      bigint      NOT NULL,
  hidden      bigint      NOT NULL,
  max_mint    bigint,
  fetched_at  timestamptz NOT NULL,
  PRIMARY KEY (product, edition_id)
);
CREATE TABLE public.atlas_supply_requests (
  request_id     bigint      PRIMARY KEY,
  product        text        NOT NULL,
  offset_at      integer     NOT NULL,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  drained_at     timestamptz,
  rows_upserted  integer,
  error          text,
  attempt        integer     NOT NULL DEFAULT 1
);


-- >>> BEGIN verbatim atlas_supply_request_page (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.atlas_supply_request_page(p_product text, p_offset integer, p_attempt integer)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req bigint;
BEGIN
  v_req := net.http_post(
    url     := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
    body    := jsonb_build_object('product', p_product, 'limit', '100', 'offset', p_offset::text),
    headers := '{"content-type":"application/json","connect-protocol-version":"1","origin":"https://nbatopshot.com","referer":"https://nbatopshot.com/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}'::jsonb,
    timeout_milliseconds := 30000);
  INSERT INTO public.atlas_supply_requests (request_id, product, offset_at, attempt)
  VALUES (v_req, p_product, p_offset, p_attempt);
  RETURN v_req;
END;
$function$;
-- <<< END verbatim atlas_supply_request_page <<<

-- >>> BEGIN verbatim atlas_supply_dispatch (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.atlas_supply_dispatch()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_product text;
  v_pages   integer;
  v_out     jsonb := '{}'::jsonb;
BEGIN
  DELETE FROM public.atlas_supply_requests WHERE drained_at < now() - interval '7 days';
  FOREACH v_product IN ARRAY ARRAY['laliga', 'disney'] LOOP
    -- One walk in flight per product.
    IF EXISTS (SELECT 1 FROM public.atlas_supply_requests q
               WHERE q.product = v_product AND q.drained_at IS NULL
                 AND q.dispatched_at > now() - interval '30 minutes') THEN
      v_out := v_out || jsonb_build_object(v_product, 'in_flight');
      CONTINUE;
    END IF;
    -- Pages of 100 (Atlas's cap): the known population plus two spare pages, and
    -- never fewer than the measured 2026-10-03 sizes (519 / 2,771).
    SELECT greatest(ceil(count(*) / 100.0)::integer + 2,
                    CASE v_product WHEN 'laliga' THEN 8 ELSE 30 END)
      INTO v_pages
      FROM public.atlas_edition_supply s WHERE s.product = v_product;
    FOR i IN 0 .. v_pages - 1 LOOP
      PERFORM public.atlas_supply_request_page(v_product, i * 100, 1);
    END LOOP;
    v_out := v_out || jsonb_build_object(v_product, v_pages);
  END LOOP;
  RETURN v_out;
END;
$function$;
-- <<< END verbatim atlas_supply_dispatch <<<

-- >>> BEGIN verbatim atlas_supply_ingest_page (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.atlas_supply_ingest_page(p_product text, p_body jsonb)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    WITH x AS (
      SELECT e->>'id' AS edition_id,
             (e->>'numMinted')::bigint AS minted, (e->>'numBurned')::bigint AS burned,
             (e->>'numOwned')::bigint AS owned, (e->>'numLocked')::bigint AS locked,
             (e->>'numListed')::bigint AS listed, nullif(e->>'numHiddenInPacks', '')::bigint AS hidden,
             nullif(e->>'maxMintSize', '')::bigint AS max_mint
      FROM jsonb_array_elements(p_body -> 'editions') e
      WHERE e->>'id' IS NOT NULL
    ), up AS (
      INSERT INTO public.atlas_edition_supply AS s
        (product, edition_id, minted, burned, owned, locked, listed, hidden, max_mint, fetched_at)
      SELECT p_product, x.edition_id, x.minted, x.burned, x.owned, x.locked, x.listed, x.hidden, x.max_mint, clock_timestamp()
      FROM x
      -- A row missing any bucket is not a split; skip it rather than store a zero.
      WHERE x.minted IS NOT NULL AND x.burned IS NOT NULL AND x.owned IS NOT NULL
        AND x.locked IS NOT NULL AND x.listed IS NOT NULL AND x.hidden IS NOT NULL
      ON CONFLICT (product, edition_id) DO UPDATE
        SET minted = EXCLUDED.minted, burned = EXCLUDED.burned, owned = EXCLUDED.owned,
            locked = EXCLUDED.locked, listed = EXCLUDED.listed, hidden = EXCLUDED.hidden,
            max_mint = EXCLUDED.max_mint, fetched_at = EXCLUDED.fetched_at
      RETURNING 1
    )
    SELECT count(*)::integer FROM up;
$function$;
-- <<< END verbatim atlas_supply_ingest_page <<<

-- >>> BEGIN verbatim atlas_supply_drain (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.atlas_supply_drain()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- A page is asked for at most this many times per walk (the dispatch + 2 retries).
  MAX_ATTEMPTS constant integer := 3;
  v_started   timestamptz := clock_timestamp();
  v_retry     boolean;
  v_retried   integer := 0;
  v_retries   jsonb := '[]'::jsonb;
  r           record;
  v_n         integer;
  v_pages     integer := 0;
  v_failed    integer := 0;
  v_written   integer := 0;
  v_full_last jsonb := '{}'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT q.request_id, q.product, q.offset_at, q.attempt,
           h.status_code, h.error_msg, h.content, (h.id IS NOT NULL) AS has_resp
    FROM public.atlas_supply_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.drained_at IS NULL
      AND (h.id IS NOT NULL OR q.dispatched_at < now() - interval '15 minutes')
    ORDER BY q.request_id
  LOOP
    v_pages := v_pages + 1;
    IF NOT r.has_resp OR r.status_code IS DISTINCT FROM 200
       OR r.content IS NULL OR NOT pg_input_is_valid(r.content, 'jsonb')
       OR jsonb_typeof(r.content::jsonb -> 'editions') IS DISTINCT FROM 'array' THEN
      -- Cloudflare challenges a share of every 38-request burst (403 on 2-12 pages a walk,
      -- different offsets each time, 2026-10-06..09), so a transient refusal is asked for
      -- again on this tick and lands on the next. A 200 with a bad body and any other 4xx
      -- are not transient: they fail at once. A page out of attempts fails the run.
      v_retry := r.attempt < MAX_ATTEMPTS
                 AND (NOT r.has_resp OR r.status_code IS NULL
                      OR r.status_code IN (403, 408, 429) OR r.status_code >= 500);
      UPDATE public.atlas_supply_requests
         SET drained_at = clock_timestamp(),
             error = CASE WHEN v_retry THEN 'retried ' ELSE '' END
                  || CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
      IF v_retry THEN
        PERFORM public.atlas_supply_request_page(r.product, r.offset_at, r.attempt + 1);
        v_retried := v_retried + 1;
        v_retries := v_retries || jsonb_build_object('product', r.product, 'offset', r.offset_at,
                       'status', r.status_code, 'has_response', r.has_resp, 'attempt', r.attempt);
        CONTINUE;
      END IF;
      v_failed := v_failed + 1;
      v_errors := v_errors || jsonb_build_object('product', r.product, 'offset', r.offset_at,
                    'status', r.status_code, 'has_response', r.has_resp);
      CONTINUE;
    END IF;

    v_n := public.atlas_supply_ingest_page(r.product, r.content::jsonb);
    v_written := v_written + v_n;
    UPDATE public.atlas_supply_requests
       SET drained_at = clock_timestamp(), rows_upserted = v_n
     WHERE request_id = r.request_id;
    -- The offset of each product's last FULL page: when it equals the walk's last
    -- dispatched offset, the walk may have stopped short of the population.
    IF jsonb_array_length(r.content::jsonb -> 'editions') >= 100 THEN
      v_full_last := v_full_last || jsonb_build_object(r.product, r.offset_at);
    END IF;
  END LOOP;

  IF v_pages > 0 THEN
    -- ok = no page failed for good AND the tick moved the walk forward (wrote rows, or
    -- re-asked for a page that may still land). A page out of attempts is never ok.
    PERFORM public.log_pipeline_run(
      'atlas-edition-supply', v_started, v_pages, v_written, v_failed,
      v_failed = 0 AND (v_written > 0 OR v_retried > 0),
      CASE WHEN v_failed > 0 THEN v_failed || ' page(s) failed' END,
      NULL, NULL, NULL,
      jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                         'rows_upserted', v_written, 'last_full_page_offset', v_full_last,
                         'errors_sample', v_errors, 'retried_sample', v_retries));
  END IF;
  RETURN jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                            'rows_upserted', v_written, 'last_full_page_offset', v_full_last);
END;
$function$;
-- <<< END verbatim atlas_supply_drain <<<

-- ── dispatch ───────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT atlas_supply_dispatch()::text), '{"disney": 30, "laliga": 8}',
  'one walk per product at the measured minimum page counts');
SELECT _assert_eq((SELECT count(*)::text FROM atlas_supply_requests), '38', '38 page requests recorded');
SELECT _assert_eq((SELECT count(*)::text FROM atlas_supply_requests WHERE attempt = 1), '38', 'every dispatched page is attempt 1');
SELECT _assert_eq((SELECT atlas_supply_dispatch()::text), '{"disney": "in_flight", "laliga": "in_flight"}',
  'a second dispatch while a walk is in flight issues nothing');
SELECT _assert_eq((SELECT count(*)::text FROM atlas_supply_requests), '38', 'still 38');

-- ── drain ──────────────────────────────────────────────────────────────────
-- Replace the dispatched rows with a controlled set of responses.
DELETE FROM atlas_supply_requests;
INSERT INTO atlas_supply_requests (request_id, product, offset_at, dispatched_at) VALUES
  (1, 'laliga', 0,   now() - interval '1 minute'),   -- 200, one complete + one missing a bucket
  (2, 'laliga', 100, now() - interval '1 minute'),   -- 500 → re-asked
  (3, 'disney', 0,   now() - interval '1 minute'),   -- 200 but the body is not JSON → fails
  (4, 'disney', 100, now() - interval '20 minutes'), -- never answered, past the window → re-asked
  (5, 'disney', 200, now() - interval '2 minutes'),  -- not answered yet, inside the window
  (6, 'laliga', 200, now() - interval '1 minute');   -- 400 → not transient, fails
INSERT INTO net._http_response VALUES
  (1, 200, NULL, '{"editions":[{"id":"575","numMinted":"29","numBurned":"2","numOwned":"20","numLocked":"1","numListed":"1","numHiddenInPacks":"5","maxMintSize":"29"},{"id":"576","numMinted":"10","numBurned":"0","numOwned":"10","numLocked":"0","numListed":"0","maxMintSize":"10"}]}'),
  (2, 500, NULL, 'upstream exploded'),
  (3, 200, NULL, '<html>not json</html>'),
  (6, 400, NULL, 'product is required');

SELECT _assert_eq((SELECT (r->>'pages') || '/' || (r->>'pages_failed') || '/' || (r->>'pages_retried') || '/' || (r->>'rows_upserted') FROM (SELECT atlas_supply_drain() r) x),
  '5/2/2/1', 'five pages drained (the in-window one waits): two failed, two re-asked, one row upserted');
SELECT _assert_eq((SELECT minted || '/' || burned || '/' || owned || '/' || locked || '/' || listed || '/' || hidden FROM atlas_edition_supply WHERE product = 'laliga' AND edition_id = '575'),
  '29/2/20/1/1/5', 'the complete edition is stored bucket for bucket');
SELECT _assert(NOT EXISTS (SELECT 1 FROM atlas_edition_supply WHERE edition_id = '576'),
  'an edition missing a bucket is SKIPPED, not stored with a zero');
SELECT _assert((SELECT fetched_at IS NOT NULL FROM atlas_edition_supply WHERE edition_id = '575'), 'fetched_at is stamped');
SELECT _assert_eq((SELECT string_agg(request_id || ':' || coalesce(left(error, 11), 'ok'), ',' ORDER BY request_id) FROM atlas_supply_requests WHERE request_id < 100 AND drained_at IS NOT NULL),
  '1:ok,2:retried 500,3:200: <html>,4:retried no-,6:400: produc', 'each page records on its own row whether it was re-asked or failed, and why');
SELECT _assert_eq((SELECT string_agg(product || ':' || offset_at || ':' || attempt || ':' || (drained_at IS NULL), ',' ORDER BY offset_at) FROM atlas_supply_requests WHERE request_id >= 9000),
  'laliga:100:2:true,disney:100:2:true', 'the two transient pages are asked for again, same product + offset, attempt 2, open');
SELECT _assert((SELECT drained_at IS NULL FROM atlas_supply_requests WHERE request_id = 5), 'a request inside its 15-minute window is left for the next drain');
SELECT _assert_eq((SELECT pipeline || '/' || ok || '/' || rows_written || '/' || error FROM pipeline_log), 'atlas-edition-supply/false/1/2 page(s) failed',
  'a run with failed pages is NOT ok, whatever it wrote or re-asked');

-- Re-draining processes nothing already drained, and logs nothing for an empty pass.
SELECT _assert_eq((SELECT (atlas_supply_drain() ->> 'pages')), '0', 'drained requests are not reprocessed');
SELECT _assert_eq((SELECT count(*)::text FROM pipeline_log), '1', 'an empty pass writes no pipeline row');

-- The retries land: one clean, one challenged again (attempt 2 → 3); the window page lands clean.
INSERT INTO net._http_response
  SELECT request_id, 200, NULL, '{"editions":[{"id":"577","numMinted":"3","numBurned":"0","numOwned":"3","numLocked":"0","numListed":"0","numHiddenInPacks":"0"}]}'
  FROM atlas_supply_requests WHERE request_id >= 9000 AND product = 'laliga';
INSERT INTO net._http_response
  SELECT request_id, 403, NULL, '<html>Just a moment...</html>'
  FROM atlas_supply_requests WHERE request_id >= 9000 AND product = 'disney';
INSERT INTO net._http_response VALUES (5, 200, NULL, '{"editions":[{"id":"d9","numMinted":"5","numBurned":"0","numOwned":"5","numLocked":"0","numListed":"0","numHiddenInPacks":"0"}]}');
SELECT _assert_eq((SELECT (r->>'pages') || '/' || (r->>'pages_failed') || '/' || (r->>'pages_retried') || '/' || (r->>'rows_upserted') FROM (SELECT atlas_supply_drain() r) x),
  '3/0/1/2', 'retry pass: two pages land, the challenged one is re-asked as attempt 3');
SELECT _assert_eq((SELECT count(*) FILTER (WHERE ok) || '/' || count(*) FROM pipeline_log), '1/2', 'a pass with nothing failed for good is ok');
SELECT _assert_eq((SELECT attempt::text FROM atlas_supply_requests WHERE drained_at IS NULL), '3', 'the open page is attempt 3');

-- A tick that only re-asked (nothing landed, nothing failed for good) is ok — it moved the walk.
-- Attempt 3 refused: out of attempts, it FAILS and is not re-asked.
INSERT INTO net._http_response
  SELECT request_id, 403, NULL, '<html>Just a moment...</html>' FROM atlas_supply_requests WHERE drained_at IS NULL;
SELECT _assert_eq((SELECT (r->>'pages') || '/' || (r->>'pages_failed') || '/' || (r->>'pages_retried') || '/' || (r->>'rows_upserted') FROM (SELECT atlas_supply_drain() r) x),
  '1/1/0/0', 'a page refused on its 3rd attempt fails and is not asked for again');
SELECT _assert(NOT EXISTS (SELECT 1 FROM atlas_supply_requests WHERE drained_at IS NULL), 'nothing left open');
SELECT _assert_eq((SELECT ok || '/' || error FROM pipeline_log ORDER BY ctid DESC LIMIT 1), 'false/1 page(s) failed', 'an exhausted page makes the run NOT ok');

-- A re-ask-only tick is ok.
INSERT INTO atlas_supply_requests (request_id, product, offset_at, dispatched_at) VALUES (7, 'disney', 300, now() - interval '1 minute');
INSERT INTO net._http_response VALUES (7, 429, NULL, 'slow down');
SELECT _assert_eq((SELECT (r->>'pages_failed') || '/' || (r->>'pages_retried') || '/' || (r->>'rows_upserted') FROM (SELECT atlas_supply_drain() r) x), '0/1/0', 're-ask only');
SELECT _assert_eq((SELECT ok || '/' || coalesce(error, 'null') FROM pipeline_log ORDER BY ctid DESC LIMIT 1), 'true/null', 'a tick that only re-asked a page is ok (nothing failed for good)');

SELECT '✓ atlas_supply_request_page / atlas_supply_dispatch / atlas_supply_drain: all assertions passed' AS result;

ROLLBACK;
