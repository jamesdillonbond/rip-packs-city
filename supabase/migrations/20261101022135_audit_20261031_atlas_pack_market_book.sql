CREATE TABLE IF NOT EXISTS public.atlas_pack_market (
  product           text        NOT NULL CHECK (product IN ('nba', 'nfl')),
  dist_id           text        NOT NULL,
  dist_uuid         text,
  title             text,
  tier              text,
  image_url         text,
  pack_type         text,
  dist_type         text,
  slots             integer,
  retail_usd        numeric,
  start_time        timestamptz,
  end_time          timestamptz,
  low_ask_usd       numeric,
  num_listed        integer,
  latest_listed_at  timestamptz,
  last_purchase_usd numeric,
  avg_sale_usd      numeric,
  observed_at       timestamptz NOT NULL,
  pass_started_at   timestamptz NOT NULL,
  PRIMARY KEY (product, dist_id)
);

CREATE TABLE IF NOT EXISTS public.atlas_pack_market_state (
  product                       text PRIMARY KEY CHECK (product IN ('nba', 'nfl')),
  pass_started_at               timestamptz,
  next_offset                   integer NOT NULL DEFAULT 0,
  pages_expected                integer,
  last_complete_pass_started_at timestamptz,
  last_complete_at              timestamptz,
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.atlas_pack_market_state (product) VALUES ('nba'), ('nfl') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.atlas_pack_market_requests (
  request_id      bigint      PRIMARY KEY,
  product         text        NOT NULL,
  offset_at       integer     NOT NULL,
  attempt         integer     NOT NULL DEFAULT 1,
  pass_started_at timestamptz NOT NULL,
  dispatched_at   timestamptz NOT NULL DEFAULT now(),
  drained_at      timestamptz,
  status_code     integer,
  rows_upserted   integer,
  error           text
);
CREATE INDEX IF NOT EXISTS idx_atlas_pack_market_requests_open
  ON public.atlas_pack_market_requests (product) WHERE drained_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_atlas_pack_market_requests_pass
  ON public.atlas_pack_market_requests (product, pass_started_at);

ALTER TABLE public.atlas_pack_market          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_pack_market_state    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atlas_pack_market_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.atlas_pack_market, public.atlas_pack_market_state, public.atlas_pack_market_requests
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.atlas_pack_market_ingest_page(p_product text, p_body jsonb, p_pass timestamptz)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_n integer;
BEGIN
  INSERT INTO public.atlas_pack_market AS t
    (product, dist_id, dist_uuid, title, tier, image_url, pack_type, dist_type, slots, retail_usd,
     start_time, end_time, low_ask_usd, num_listed, latest_listed_at, last_purchase_usd, avg_sale_usd,
     observed_at, pass_started_at)
  SELECT DISTINCT ON (x->>'id')
         p_product, x->>'id', x->>'uuid', x->>'title', x->>'tier', nullif(x->>'imageUrl', ''),
         x->>'packType', x->>'type',
         CASE WHEN x->>'numberOfPackSlots' ~ '^[0-9]+$' THEN (x->>'numberOfPackSlots')::integer END,
         CASE WHEN jsonb_typeof(x->'price') = 'number' THEN (x->>'price')::numeric END,
         CASE WHEN pg_input_is_valid(x->>'startTime', 'timestamptz') THEN (x->>'startTime')::timestamptz END,
         CASE WHEN pg_input_is_valid(x->>'endTime', 'timestamptz') THEN (x->>'endTime')::timestamptz END,
         CASE WHEN x->>'packLowAskCents' ~ '^[0-9]+$' THEN (x->>'packLowAskCents')::numeric / 100 END,
         CASE WHEN x->>'packNumListed' ~ '^[0-9]+$' THEN (x->>'packNumListed')::integer END,
         CASE WHEN pg_input_is_valid(x->>'packLatestListedAt', 'timestamptz') THEN (x->>'packLatestListedAt')::timestamptz END,
         CASE WHEN x->>'packLastPurchasePriceCents' ~ '^[0-9]+$' THEN (x->>'packLastPurchasePriceCents')::numeric / 100 END,
         CASE WHEN x->>'packAverageSalePriceCents' ~ '^[0-9]+$' THEN (x->>'packAverageSalePriceCents')::numeric / 100 END,
         clock_timestamp(), p_pass
    FROM jsonb_array_elements(p_body -> 'distributions') x
   WHERE x->>'id' ~ '^[0-9]+$'
   ORDER BY x->>'id'
  ON CONFLICT (product, dist_id) DO UPDATE
     SET dist_uuid = EXCLUDED.dist_uuid, title = EXCLUDED.title, tier = EXCLUDED.tier,
         image_url = EXCLUDED.image_url, pack_type = EXCLUDED.pack_type, dist_type = EXCLUDED.dist_type,
         slots = EXCLUDED.slots, retail_usd = EXCLUDED.retail_usd, start_time = EXCLUDED.start_time,
         end_time = EXCLUDED.end_time, low_ask_usd = EXCLUDED.low_ask_usd, num_listed = EXCLUDED.num_listed,
         latest_listed_at = EXCLUDED.latest_listed_at, last_purchase_usd = EXCLUDED.last_purchase_usd,
         avg_sale_usd = EXCLUDED.avg_sale_usd, observed_at = EXCLUDED.observed_at,
         pass_started_at = EXCLUDED.pass_started_at
   -- A retried page from an OLDER pass landing late must not roll a newer observation back.
   WHERE EXCLUDED.pass_started_at >= t.pass_started_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atlas_pack_market_request_page(p_product text, p_offset integer, p_attempt integer, p_pass timestamptz)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_req bigint;
  v_site text := CASE p_product WHEN 'nfl' THEN 'https://nflallday.com' ELSE 'https://nbatopshot.com' END;
BEGIN
  v_req := net.http_post(
    url     := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.DistributionService/SearchDistributions',
    body    := jsonb_build_object('product', p_product, 'limit', '100', 'offset', p_offset::text),
    headers := jsonb_build_object('content-type', 'application/json', 'connect-protocol-version', '1',
                 'origin', v_site, 'referer', v_site || '/',
                 'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'),
    timeout_milliseconds := 30000);
  INSERT INTO public.atlas_pack_market_requests (request_id, product, offset_at, attempt, pass_started_at)
  VALUES (v_req, p_product, p_offset, p_attempt, p_pass);
  RETURN v_req;
END;
$function$;

CREATE OR REPLACE FUNCTION public.atlas_pack_market_tick()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  MAX_ATTEMPTS  constant integer  := 3;
  PER_TICK      constant integer  := 4;   -- pages dispatched per product per minute
  MAX_INFLIGHT  constant integer  := 4;   -- undrained pages per product
  PASS_EVERY    constant interval := interval '15 minutes';
  PASS_ABANDON  constant interval := interval '60 minutes';
  v_started   timestamptz := clock_timestamp();
  r           record;
  s           record;
  v_body      jsonb;
  v_retry     boolean;
  v_n         integer;
  v_pages     integer := 0;
  v_failed    integer := 0;
  v_retried   integer := 0;
  v_written   integer := 0;
  v_sent      integer := 0;
  v_completed jsonb := '[]'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
  v_market    integer;
  v_market403 integer;
  v_held      boolean;
  v_inflight  integer;
  v_k         integer;
  v_ok_pages  integer;
BEGIN
  DELETE FROM public.atlas_pack_market_requests WHERE drained_at < now() - interval '2 days';

  -- ── drain ────────────────────────────────────────────────────────────────
  FOR r IN
    SELECT q.request_id, q.product, q.offset_at, q.attempt, q.pass_started_at,
           h.status_code, h.error_msg, h.content, (h.id IS NOT NULL) AS has_resp
      FROM public.atlas_pack_market_requests q
      LEFT JOIN net._http_response h ON h.id = q.request_id
     WHERE q.drained_at IS NULL
       AND (h.id IS NOT NULL OR q.dispatched_at < now() - interval '10 minutes')
     ORDER BY q.request_id
     LIMIT 60
  LOOP
    v_pages := v_pages + 1;
    v_body := CASE WHEN r.has_resp AND r.status_code = 200 AND r.content IS NOT NULL
                        AND pg_input_is_valid(r.content, 'jsonb') THEN r.content::jsonb END;
    IF v_body IS NULL OR jsonb_typeof(v_body -> 'distributions') IS DISTINCT FROM 'array' THEN
      v_retry := r.attempt < MAX_ATTEMPTS
                 AND (NOT r.has_resp OR r.status_code IS NULL
                      OR r.status_code IN (403, 408, 429) OR r.status_code >= 500);
      UPDATE public.atlas_pack_market_requests
         SET drained_at = clock_timestamp(), status_code = r.status_code,
             error = CASE WHEN v_retry THEN 'retried ' ELSE '' END
                  || CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
      IF v_retry THEN
        PERFORM public.atlas_pack_market_request_page(r.product, r.offset_at, r.attempt + 1, r.pass_started_at);
        v_retried := v_retried + 1;
      ELSE
        v_failed := v_failed + 1;
        v_errors := v_errors || jsonb_build_object('product', r.product, 'offset', r.offset_at,
                      'status', r.status_code, 'has_response', r.has_resp);
      END IF;
      CONTINUE;
    END IF;

    v_n := public.atlas_pack_market_ingest_page(r.product, v_body, r.pass_started_at);
    v_written := v_written + v_n;
    UPDATE public.atlas_pack_market_requests
       SET drained_at = clock_timestamp(), status_code = 200, rows_upserted = v_n
     WHERE request_id = r.request_id;
    -- The first page of a pass sizes it. totalCount is a string on the wire.
    IF r.offset_at = 0 AND v_body -> 'pagination' ->> 'totalCount' ~ '^[0-9]+$' THEN
      UPDATE public.atlas_pack_market_state
         SET pages_expected = greatest(1, ceil(((v_body -> 'pagination' ->> 'totalCount')::integer) / 100.0)::integer),
             updated_at = now()
       WHERE product = r.product AND pass_started_at = r.pass_started_at;
    END IF;
  END LOOP;

  -- ── completion: a pass is the book only when EVERY page of it landed ─────
  FOR s IN SELECT * FROM public.atlas_pack_market_state LOOP
    IF s.pass_started_at IS NOT NULL AND s.pages_expected IS NOT NULL
       AND s.last_complete_pass_started_at IS DISTINCT FROM s.pass_started_at THEN
      SELECT count(DISTINCT q.offset_at) INTO v_ok_pages
        FROM public.atlas_pack_market_requests q
       WHERE q.product = s.product AND q.pass_started_at = s.pass_started_at AND q.rows_upserted IS NOT NULL
         AND q.offset_at < s.pages_expected * 100;
      IF v_ok_pages >= s.pages_expected THEN
        UPDATE public.atlas_pack_market_state
           SET last_complete_pass_started_at = s.pass_started_at, last_complete_at = clock_timestamp(), updated_at = now()
         WHERE product = s.product;
        v_completed := v_completed || to_jsonb(s.product);
      END IF;
    END IF;
  END LOOP;

  -- ── dispatch ─────────────────────────────────────────────────────────────
  -- Hold while the Atlas market lane is being challenged (topshot_pack_supply_tick's rule):
  -- that lane is the one the moment Sniper reads, this one is the fallback book.
  SELECT count(*), count(*) FILTER (WHERE error LIKE 'atlas 403%')
    INTO v_market, v_market403
    FROM public.topshot_atlas_market_requests
   WHERE dispatched_at > now() - interval '10 minutes' AND drained_at IS NOT NULL;
  v_held := v_market >= 4 AND v_market403 * 2 > v_market;

  IF NOT v_held THEN
    FOR s IN SELECT * FROM public.atlas_pack_market_state ORDER BY product LOOP
      -- A new pass: none yet, the last one completed and is PASS_EVERY old, or it has
      -- been stuck for PASS_ABANDON (a page out of attempts never completes it).
      IF s.pass_started_at IS NULL
         OR (s.last_complete_pass_started_at = s.pass_started_at AND s.pass_started_at < now() - PASS_EVERY)
         OR s.pass_started_at < now() - PASS_ABANDON THEN
        UPDATE public.atlas_pack_market_state
           SET pass_started_at = clock_timestamp(), next_offset = 0, pages_expected = NULL, updated_at = now()
         WHERE product = s.product
        RETURNING * INTO s;
      END IF;
      SELECT count(*) INTO v_inflight FROM public.atlas_pack_market_requests
       WHERE product = s.product AND drained_at IS NULL;
      v_k := 0;
      WHILE v_k < PER_TICK AND v_inflight < MAX_INFLIGHT
            -- Page 0 alone until it sizes the pass; then up to the last page.
            AND ((s.pages_expected IS NULL AND s.next_offset = 0)
                 OR (s.pages_expected IS NOT NULL AND s.next_offset < s.pages_expected * 100)) LOOP
        PERFORM public.atlas_pack_market_request_page(s.product, s.next_offset, 1, s.pass_started_at);
        UPDATE public.atlas_pack_market_state SET next_offset = next_offset + 100, updated_at = now()
         WHERE product = s.product RETURNING * INTO s;
        v_k := v_k + 1; v_inflight := v_inflight + 1; v_sent := v_sent + 1;
      END LOOP;
    END LOOP;
  END IF;

  IF v_pages > 0 THEN
    -- ok = no page failed for good AND the tick moved a walk forward (rows written, or a page
    -- re-asked that may still land). rows_written = dist rows actually upserted.
    PERFORM public.log_pipeline_run(
      'atlas-pack-market', v_started, v_pages, v_written, v_failed,
      v_failed = 0 AND (v_written > 0 OR v_retried > 0),
      CASE WHEN v_failed > 0 THEN v_failed || ' page(s) failed' END,
      NULL, NULL, NULL,
      jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                         'rows_upserted', v_written, 'pages_sent', v_sent, 'held', v_held,
                         'passes_completed', v_completed, 'errors_sample', v_errors));
  END IF;
  RETURN jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'pages_retried', v_retried,
                            'rows_upserted', v_written, 'pages_sent', v_sent, 'held', v_held,
                            'passes_completed', v_completed);
END;
$function$;

CREATE OR REPLACE FUNCTION public.atlas_pack_book(p_product text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH st AS (
    SELECT * FROM public.atlas_pack_market_state WHERE product = p_product
  ), book AS (
    SELECT m.* FROM public.atlas_pack_market m, st
     WHERE m.product = p_product
       AND st.last_complete_pass_started_at IS NOT NULL
       AND m.pass_started_at >= st.last_complete_pass_started_at
  )
  SELECT jsonb_build_object(
    'product', p_product,
    'complete_at', (SELECT last_complete_at FROM st),
    'complete_pass_started_at', (SELECT last_complete_pass_started_at FROM st),
    'dists_in_book', (SELECT count(*) FROM book),
    'atlas_newest_listing_at', (SELECT max(latest_listed_at) FROM book),
    -- Studio's sales mirror stamps each row with the LISTING's creation block, so its max is the
    -- newest listing Studio has indexed — the like-for-like comparison with Atlas's.
    'studio_newest_listing_at', CASE p_product
        WHEN 'nba' THEN (SELECT max(block_time) FROM public.topshot_pack_sales_history)
        WHEN 'nfl' THEN (SELECT max(block_time) FROM public.allday_pack_sales_history) END,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'dist_id', b.dist_id, 'dist_uuid', b.dist_uuid, 'title', b.title, 'tier', b.tier,
               'image_url', b.image_url, 'pack_type', b.pack_type, 'dist_type', b.dist_type,
               'slots', b.slots, 'retail_usd', b.retail_usd, 'start_time', b.start_time,
               'low_ask_usd', b.low_ask_usd, 'num_listed', b.num_listed,
               'latest_listed_at', b.latest_listed_at, 'observed_at', b.observed_at)
             ORDER BY b.dist_id)
        FROM book b WHERE b.num_listed > 0 AND b.low_ask_usd > 0), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.atlas_pack_market_ingest_page(text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_pack_market_request_page(text, integer, integer, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_pack_market_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_pack_book(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_pack_book(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_pack_market_tick() TO service_role;

SELECT cron.schedule('rpc-atlas-pack-market', '* * * * *', 'SELECT public.atlas_pack_market_tick()');