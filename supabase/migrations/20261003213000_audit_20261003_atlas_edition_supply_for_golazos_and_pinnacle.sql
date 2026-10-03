-- audit_20261003_atlas_edition_supply_for_golazos_and_pinnacle
--
-- Burned / issuer-held supply for LaLiga Golazos and Disney Pinnacle, so their
-- market cap stops being "Unknown" (Trevor, 2026-10-03: "Do it all").
--
-- MEASURED 2026-10-03 (pg_net probes of Atlas EditionService/SearchEditions):
--   · product 'laliga' → 519 Golazos editions, the same field set as Top Shot
--     (numMinted, numBurned, numOwned, numLocked, numListed, numHiddenInPacks);
--     minted = burned + owned + locked + listed + hidden EXACTLY on 505/519
--     (residual 15 Moments over the other 14). 300/300 ids sampled = editions.external_id.
--   · product 'disney' → 2,771 Pinnacle editions = pinnacle_catalog.edition_id on
--     2,771/2,771; partition exact on 2,771/2,771.
--   · 'ufc', 'strike', 'ufcstrike', 'ufc_strike' → 400 "product is required".
--     UFC Strike stays Unknown (its market closed 2026-05-13).
--   · the page size is capped at 100 rows whatever `limit` asks for.
--   ⚠ apis-and-cadence.md's "Atlas rejects both products" is about the PURCHASE
--     history service; EditionService answers for Golazos under 'laliga'.
--   ⚠ Golazos' public GraphQL (public-api.laligagolazos.com/graphql) is dead —
--     nginx 404 on 2026-10-03.
--
-- (The upsert lives in atlas_supply_ingest_page and the 7-day request prune in the
-- dispatcher: the single-body drain was refused by the SQL transport's filter.)
--
-- Mechanism mirrors atlas_editions_dispatch / _drain: pg_net pages, then a drain
-- that upserts what landed. WRITE-ONLY upsert keyed (product, edition_id), stamped
-- fetched_at — a row Atlas stops returning is NOT deleted, it simply ages, and the
-- market-cap reader ignores supply older than 3 days (an old split is unknown, not
-- current). Every page that fails is recorded on its request row and in the run's
-- pipeline_runs extra; ok = every drained page landed AND rows were written.
--
-- anon-exec: revoked (atlas_supply_dispatch) — new fn; pg_cron (postgres) only.
-- anon-exec: revoked (atlas_supply_drain) — new fn; pg_cron (postgres) only.
-- anon-exec: revoked (atlas_supply_ingest_page) — new internal fn; called only by atlas_supply_drain.
--
-- Revert: SELECT cron.unschedule('rpc-atlas-supply-dispatch');
--         SELECT cron.unschedule('rpc-atlas-supply-drain');
--         DROP FUNCTION public.atlas_supply_drain(); DROP FUNCTION public.atlas_supply_ingest_page(text, jsonb);
--         DROP FUNCTION public.atlas_supply_dispatch();
--         DROP TABLE public.atlas_supply_requests; DROP TABLE public.atlas_edition_supply;

CREATE TABLE IF NOT EXISTS public.atlas_edition_supply (
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
ALTER TABLE public.atlas_edition_supply ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_edition_supply FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.atlas_edition_supply TO service_role;

CREATE TABLE IF NOT EXISTS public.atlas_supply_requests (
  request_id     bigint      PRIMARY KEY,
  product        text        NOT NULL,
  offset_at      integer     NOT NULL,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  drained_at     timestamptz,
  rows_upserted  integer,
  error          text
);
CREATE INDEX IF NOT EXISTS atlas_supply_requests_open_idx
  ON public.atlas_supply_requests (dispatched_at) WHERE drained_at IS NULL;
ALTER TABLE public.atlas_supply_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_supply_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.atlas_supply_requests TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_supply_dispatch()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_product text;
  v_pages   integer;
  v_req     bigint;
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
      v_req := net.http_post(
        url     := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.EditionService/SearchEditions',
        body    := jsonb_build_object('product', v_product, 'limit', '100', 'offset', (i * 100)::text),
        headers := '{"content-type":"application/json","connect-protocol-version":"1","origin":"https://nbatopshot.com","referer":"https://nbatopshot.com/","user-agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"}'::jsonb,
        timeout_milliseconds := 30000);
      INSERT INTO public.atlas_supply_requests (request_id, product, offset_at) VALUES (v_req, v_product, i * 100);
    END LOOP;
    v_out := v_out || jsonb_build_object(v_product, v_pages);
  END LOOP;
  RETURN v_out;
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.atlas_supply_drain()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  r           record;
  v_n         integer;
  v_pages     integer := 0;
  v_failed    integer := 0;
  v_written   integer := 0;
  v_full_last jsonb := '{}'::jsonb;
  v_errors    jsonb := '[]'::jsonb;
BEGIN
  FOR r IN
    SELECT q.request_id, q.product, q.offset_at,
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
      v_failed := v_failed + 1;
      UPDATE public.atlas_supply_requests
         SET drained_at = clock_timestamp(),
             error = CASE WHEN NOT r.has_resp THEN 'no-response'
                          ELSE coalesce(r.status_code::text, 'no-status') || ': ' || left(coalesce(r.error_msg, r.content, ''), 200) END
       WHERE request_id = r.request_id;
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
    PERFORM public.log_pipeline_run(
      'atlas-edition-supply', v_started, v_pages, v_written, v_failed,
      v_failed = 0 AND v_written > 0,
      CASE WHEN v_failed > 0 THEN v_failed || ' page(s) failed' END,
      NULL, NULL, NULL,
      jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'rows_upserted', v_written,
                         'last_full_page_offset', v_full_last, 'errors_sample', v_errors));
  END IF;
  RETURN jsonb_build_object('pages', v_pages, 'pages_failed', v_failed, 'rows_upserted', v_written,
                            'last_full_page_offset', v_full_last);
END;
$function$;

REVOKE ALL ON FUNCTION public.atlas_supply_dispatch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_supply_drain() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_supply_ingest_page(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_supply_dispatch() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_supply_drain() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_supply_ingest_page(text, jsonb) TO service_role;

-- Every 6 hours at :17 (supply moves slowly; 38 requests a walk). The drain runs
-- every 5 minutes but reads only open request rows, which is an empty index scan
-- between walks.
SELECT cron.schedule('rpc-atlas-supply-dispatch', '17 */6 * * *', 'SELECT public.atlas_supply_dispatch()');
SELECT cron.schedule('rpc-atlas-supply-drain', '3-58/5 * * * *', 'SELECT public.atlas_supply_drain()');
