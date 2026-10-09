-- audit_20261009_atlas_supply_retries_a_challenged_page
--
-- 2026-10-09 ~8:10 AM PT (Claude Code, cloud). Sentinel WARN + pipeline alert:
--   atlas-edition-supply · failure_rate — 8/10 runs failed (80.0%) over 3 days; 1186 min
--   since the last success (> 780). Last error: "5 page(s) failed".
--
-- MEASURED (pipeline_runs, the last 10 walks 10-06 11:18 PM .. 10-09 5:18 AM PT): every
-- failure is a Cloudflare 403 (one 502) on 2-12 of the walk's 38 pages, at DIFFERENT offsets
-- each walk; 2 of 10 walks were clean. Supply stayed fresh because the next walk re-reads
-- the page — but the lane read as 80% failed, and a run was "ok" only on a burst Cloudflare
-- happened to let through whole. The 10-03..10-09 handoffs filed this as do-not-reflag;
-- this removes the failure mode instead of muting the detector.
--
-- WHAT THIS DOES.
--   · atlas_supply_requests.attempt (default 1).
--   · atlas_supply_request_page(product, offset, attempt): the one pg_net call + request row,
--     now shared by the dispatcher and the drain (URL / headers unchanged).
--   · atlas_supply_drain: a page refused transiently (no response, 403/408/429, 5xx, a
--     pg_net transport error) with attempt < 3 is marked drained with error 'retried …' and
--     asked for again; the retry lands on the next 5-minute drain. A 200 with a bad body, any
--     other 4xx, or a page on its 3rd attempt still FAILS the run exactly as before.
--     ok = no page failed for good AND (rows written OR a page re-asked). The error text
--     ("N page(s) failed") is unchanged; extra gains pages_retried + retried_sample.
--   · atlas_supply_dispatch: unchanged except that it calls the helper.
--
-- The pipeline_alerts failure_rate row pools across this change for 3 days — split runs at
-- the apply time before reading it.
--
-- anon-exec: revoked (atlas_supply_request_page) — new internal fn; called only by atlas_supply_dispatch / atlas_supply_drain (pg_cron, postgres).
-- anon-exec: unchanged (atlas_supply_dispatch) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-09).
-- anon-exec: unchanged (atlas_supply_drain) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege anon=false, authenticated=false (2026-10-09).
--
-- Base verified: live prosrc md5 (whitespace-normalised) dispatch 7068a56d3cc87c42a26c83c8a539df0a,
-- drain d60ee4489fb6e37fd0e2d8277de3bbbb = the bodies in 20261003213000.
--
-- REVERT: re-apply the atlas_supply_dispatch and atlas_supply_drain blocks of
-- 20261003213000_audit_20261003_atlas_edition_supply_for_golazos_and_pinnacle.sql verbatim, then
--   DROP FUNCTION public.atlas_supply_request_page(text, integer, integer);
--   ALTER TABLE public.atlas_supply_requests DROP COLUMN attempt;

ALTER TABLE public.atlas_supply_requests ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1;

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

REVOKE ALL ON FUNCTION public.atlas_supply_request_page(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_supply_request_page(text, integer, integer) TO service_role;
