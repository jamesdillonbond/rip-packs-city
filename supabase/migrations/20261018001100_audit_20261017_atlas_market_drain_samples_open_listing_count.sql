-- APPLIED 2026-10-17 5:11 PM PT through the Supabase SQL editor (Trevor's go-ahead in chat); the MCP held it 10-17 ~10:12 AM PT
-- because the body carries the drain's existing 24 h DELETE. schema_migrations row inserted by hand under this version.
-- Verified: live md5(prosrc) 37cfcc0dae2bdddc25c1687807984616 (the guard's expected post-apply value), anon/authenticated EXECUTE false.
-- The md5 guard below refuses to run if atlas_market_drain changed since this was written.
--
-- 2026-10-17 (Claude Code cloud). atlas_market_drain: the open-listings diagnostic count runs twice an hour
-- instead of on every 2-minute tick.
--
-- WHY. Every logged tick put `open_listings_nba` into pipeline_runs.extra: a count(*) over the ~422 k open
-- nba listings (Parallel Index Only Scan, 56,833 blocks, 10-17 10:15 AM PT). The whole call averages ~68 k
-- blocks (pgss, 28,960 calls), so the count is ~80 % of the lane's buffer cost, 720 times a day, and nothing
-- in code or SQL reads the field (grep of app/lib/scripts/supabase and every public function body).
--
-- HOW. Sampled on the :01 and :31 ticks of the '1-59/2' schedule (minute % 30 < 2); other ticks write JSON
-- null, never 0. Everything else, including the drain, upsert, overflow re-page and the log row itself, is
-- byte-identical. Built from the live prosrc (md5 0fd92cb723d34453b46848b58dec8ad5, last changed by
-- 20260907020428) by one asserted replacement.
-- REVERT: re-apply the atlas_market_drain body of 20260907020428 (prosrc md5 0fd92cb7...).
-- anon-exec: unchanged (atlas_market_drain) — CREATE OR REPLACE of an existing fn; ACL preserved.

DO $guard$
DECLARE v_md5 text;
BEGIN
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = 'public.atlas_market_drain()'::regprocedure;
  IF v_md5 NOT IN ('0fd92cb723d34453b46848b58dec8ad5', '37cfcc0dae2bdddc25c1687807984616') THEN
    RAISE EXCEPTION 'atlas_market_drain changed since base 0fd92cb7 (live md5 %) -- re-splice', v_md5;
  END IF;
END
$guard$;

-- when-others-timeout-blind: intentional — the body's one bare handler (unchanged since 20260907020428) is per-request,
-- inside the drain LOOP: it records that request's error and moves to the next. Catching 57014 there would swallow a
-- kill and keep looping (R118). The run as a whole is recorded by log_pipeline_run after the loop.
CREATE OR REPLACE FUNCTION public.atlas_market_drain()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  q record; v_body jsonb; v_page int; v_more boolean;
  v_reqs int := 0; v_rows int := 0; v_new int := 0; v_errs int := 0; v_sales int := 0; v_listings int := 0; v_offers int := 0;
  r record; v_oldest timestamptz; v_prev_max timestamptz;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('atlas_market_drain')::bigint) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  FOR q IN
    SELECT a.request_id, a.product, a.offset_at, r0.status_code, r0.content, r0.error_msg, r0.timed_out
      FROM public.topshot_atlas_market_requests a
      LEFT JOIN net._http_response r0 ON r0.id = a.request_id
     WHERE a.drained_at IS NULL AND a.error IS DISTINCT FROM '__next_offset__'
       AND (r0.id IS NOT NULL OR a.dispatched_at < now() - interval '10 minutes')
     ORDER BY a.dispatched_at
     LIMIT 10
  LOOP
    v_reqs := v_reqs + 1;
    BEGIN
      IF q.status_code IS NULL OR q.status_code <> 200 OR q.timed_out THEN
        RAISE EXCEPTION 'atlas % (%): %', COALESCE(q.status_code::text, 'no-response'), COALESCE(q.error_msg, ''), left(COALESCE(q.content, ''), 120);
      END IF;
      v_body := q.content::jsonb;
      IF jsonb_typeof(v_body->'transactions') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'atlas 200 without transactions[]: %', left(q.content, 160);
      END IF;
      v_page := jsonb_array_length(v_body->'transactions');
      v_more := COALESCE((v_body->'pagination'->>'hasMore')::boolean, false);

      -- What did we already hold before this page? Used to decide whether the page overflowed.
      SELECT max(listed_at) INTO v_prev_max FROM public.topshot_atlas_market_events WHERE product = q.product;

      SELECT * INTO r FROM public.atlas_market_upsert_events(q.product, v_body->'transactions');
      v_rows := v_rows + COALESCE(r.upserted, 0);
      v_new := v_new + COALESCE(r.new_rows, 0);
      v_sales := v_sales + COALESCE(r.sales, 0);
      v_listings := v_listings + COALESCE(r.listings, 0);
      v_offers := v_offers + COALESCE(r.offers, 0);

      -- Overflow: a FULL page whose oldest row is still newer than everything we held means events
      -- between them were missed — page once more next tick from offset+page. FIREHOSE pages only
      -- (offset_at >= 0): probe and verify responses (-1/-2/-3) never re-page (2026-09-07).
      SELECT min(NULLIF(t->>'listedAt','')::timestamptz) INTO v_oldest FROM jsonb_array_elements(v_body->'transactions') AS x(t);
      IF q.offset_at >= 0 AND v_more AND v_page >= 200 AND v_prev_max IS NOT NULL AND v_oldest > v_prev_max AND q.offset_at < 1000 THEN
        INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, dispatched_at, drained_at, error)
        VALUES (-(q.request_id), q.product, q.offset_at + v_page, now(), now(), '__next_offset__')
        ON CONFLICT (request_id) DO NOTHING;
      END IF;

      UPDATE public.topshot_atlas_market_requests SET drained_at = now(), status_code = q.status_code, rows_upserted = r.upserted WHERE request_id = q.request_id;
    EXCEPTION WHEN OTHERS THEN
      v_errs := v_errs + 1;
      UPDATE public.topshot_atlas_market_requests SET drained_at = now(), status_code = q.status_code, error = left(SQLERRM, 300) WHERE request_id = q.request_id;
    END;
  END LOOP;

  DELETE FROM public.topshot_atlas_market_requests WHERE drained_at < now() - interval '24 hours' AND error IS DISTINCT FROM '__next_offset__';

  IF v_reqs > 0 THEN
    PERFORM public.log_pipeline_run('atlas-market-feed', v_started, v_reqs, v_new, v_errs, v_errs = 0 OR v_rows > 0,
      CASE WHEN v_errs > 0 THEN v_errs || ' request(s) failed — see topshot_atlas_market_requests.error' END,
      'nba_top_shot', NULL, NULL,
      jsonb_build_object('duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int,
                         'requests', v_reqs, 'rows_seen', v_rows, 'rows_new', v_new, 'listings', v_listings, 'sales', v_sales, 'offers', v_offers,
                         'errors', v_errs, 'via', 'pg_cron',
                         -- 2026-10-17: a ~422 k-row count, 56.8 k of the call's ~68 k blocks every 2 min, read by
                         -- nothing in code or SQL. Sampled on the :01 and :31 ticks (minute % 30 < 2); NULL otherwise, never 0.
                         'open_listings_nba', CASE WHEN (extract(minute FROM clock_timestamp())::int % 30) < 2
                           THEN (SELECT count(*) FROM public.topshot_atlas_market_events WHERE product='nba' AND kind='listing' AND NOT completed) END,
                         'newest_listed_at', (SELECT max(listed_at) FROM public.topshot_atlas_market_events)));
  END IF;
  RETURN jsonb_build_object('requests', v_reqs, 'rows_seen', v_rows, 'rows_new', v_new, 'errors', v_errs);
END $function$;
