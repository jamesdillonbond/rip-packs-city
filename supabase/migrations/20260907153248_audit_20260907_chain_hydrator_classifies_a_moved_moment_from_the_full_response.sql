-- audit_20260907: the chain hydrator classified a moved Moment as `error` — the panic text sits past the 300-char body excerpt.
--
-- First manual tick (20 scripts): 13 written, 7 `error` — all seven were `panic: no nft` at
-- character 327 of a 671-char Flow error body, and the classifier read the 300-char excerpt.
-- The class is decided on the FULL response now (`panic` column), the excerpt stays for display.
-- Consequence of the miss: `error` retries after 1 day, `no_nft` after 30 — a moved Moment would
-- have been re-asked daily. The seven rows are reclassified below.
-- REVERT: re-apply the drain body from the creating migration (audit_20260907_pack_pull_hydration_reads_the_chain…).

CREATE OR REPLACE FUNCTION public.topshot_moment_hydrate_drain()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_coll uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_payload jsonb; v_written int := 0; v_resolved int := 0; v_unmapped int := 0;
  v_no_nft int := 0; v_no_coll int := 0; v_err int := 0; v_timeout int := 0; v_429 int := 0;
BEGIN
  DROP TABLE IF EXISTS _hyd_resp;
  CREATE TEMP TABLE _hyd_resp ON COMMIT DROP AS
  SELECT q.request_id, q.nft_id, q.wallet, q.dispatched_at, r.status_code,
         CASE WHEN r.status_code = 200 AND r.content ~ '^"[A-Za-z0-9+/=]+"$'
              THEN convert_from(decode(trim(both '"' from r.content), 'base64'), 'UTF8')::jsonb
              ELSE NULL END AS cdc,
         CASE WHEN r.status_code = 200 THEN NULL ELSE left(r.content, 300) END AS body,
         CASE WHEN r.content LIKE '%panic: no nft%' THEN 'no_nft'
              WHEN r.content LIKE '%panic: no collection%' THEN 'no_collection' END AS panic,
         r.error_msg
    FROM public.topshot_moment_hydrate_requests q
    JOIN net._http_response r ON r.id = q.request_id
   WHERE q.drained_at IS NULL;

  -- Decode: a JSON-CDC Dictionary of String → String.
  DROP TABLE IF EXISTS _hyd_dec;
  CREATE TEMP TABLE _hyd_dec ON COMMIT DROP AS
  SELECT x.request_id, x.nft_id, x.wallet, x.status_code, x.body, x.panic, x.error_msg,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'setID')::int  AS set_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'playID')::int AS play_id,
         (SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'serial')::int AS serial_number,
         NULLIF((SELECT (e->'value'->>'value') FROM jsonb_array_elements(x.cdc->'value') e WHERE e->'key'->>'value' = 'sub'), '')::int AS sub_id
    FROM _hyd_resp x;

  -- Resolve editions: the parallel keys `set:play::sub`, a Standard `set:play`.
  DROP TABLE IF EXISTS _hyd_res;
  CREATE TEMP TABLE _hyd_res ON COMMIT DROP AS
  SELECT d.request_id, d.nft_id, d.wallet, d.status_code, d.body, d.panic, d.error_msg, d.serial_number, d.set_id,
         e.id AS edition_id
    FROM _hyd_dec d
    LEFT JOIN public.editions e
      ON d.status_code = 200 AND e.collection_id = v_coll
     AND e.external_id = CASE WHEN COALESCE(d.sub_id, 0) > 0
                              THEN d.set_id || ':' || d.play_id || '::' || d.sub_id
                              ELSE d.set_id || ':' || d.play_id END;

  SELECT jsonb_agg(jsonb_build_object('nft_id', nft_id, 'edition_id', edition_id,
                                      'serial_number', serial_number, 'owner_address', wallet)),
         count(*)
    INTO v_payload, v_resolved
    FROM _hyd_res WHERE status_code = 200 AND edition_id IS NOT NULL AND serial_number IS NOT NULL;
  IF v_resolved > 0 THEN
    v_written := public.replace_topshot_moments_batch(v_payload);
  END IF;

  UPDATE public.topshot_moment_hydrate_requests q
     SET drained_at = now(), status_code = x.status_code,
         outcome = CASE
           WHEN x.status_code = 200 AND x.edition_id IS NOT NULL AND x.serial_number IS NOT NULL THEN 'written'
           WHEN x.status_code = 200 AND x.set_id IS NOT NULL THEN 'unmapped'
           WHEN x.status_code = 200 THEN 'error'   -- a 200 whose body did not decode
           WHEN x.status_code = 400 AND x.panic IS NOT NULL THEN x.panic
           ELSE 'error' END,
         error = CASE WHEN x.status_code = 200 THEN NULL ELSE COALESCE(x.error_msg, x.body) END
    FROM _hyd_res x WHERE x.request_id = q.request_id;

  SELECT count(*) FILTER (WHERE outcome = 'unmapped'), count(*) FILTER (WHERE outcome = 'no_nft'),
         count(*) FILTER (WHERE outcome = 'no_collection'), count(*) FILTER (WHERE outcome = 'error'),
         count(*) FILTER (WHERE status_code = 429)
    INTO v_unmapped, v_no_nft, v_no_coll, v_err, v_429
    FROM public.topshot_moment_hydrate_requests WHERE request_id IN (SELECT request_id FROM _hyd_res);

  -- Requests pg_net never answered.
  UPDATE public.topshot_moment_hydrate_requests
     SET drained_at = now(), outcome = 'timeout', error = 'no response within 3 min'
   WHERE drained_at IS NULL AND dispatched_at < now() - interval '3 minutes';
  GET DIAGNOSTICS v_timeout = ROW_COUNT;

  RETURN jsonb_build_object('drained', (SELECT count(*) FROM _hyd_res), 'resolved', v_resolved, 'written', v_written,
                            'unmapped', v_unmapped, 'no_nft', v_no_nft, 'no_collection', v_no_coll,
                            'error', v_err, 'http_429', v_429, 'timeout', v_timeout);
END $$;
-- anon-exec: intentional — same signature as the creating migration, ACLs preserved (topshot_moment_hydrate_drain)

-- Reclassify from the full responses (still in net._http_response; the stored excerpt cannot tell).
UPDATE public.topshot_moment_hydrate_requests q SET outcome = 'no_nft'
  FROM net._http_response r WHERE r.id = q.request_id AND q.outcome = 'error' AND r.content LIKE '%panic: no nft%';
UPDATE public.topshot_moment_hydrate_requests q SET outcome = 'no_collection'
  FROM net._http_response r WHERE r.id = q.request_id AND q.outcome = 'error' AND r.content LIKE '%panic: no collection%';
