-- audit_20260918_pack_nft_identity_lane_names_sealed_packs_from_dapper_search_pack_nft
--
-- WHAT IS WRONG. A sealed Top Shot primary-drop pack had NO distribution recorded
-- anywhere on this platform until it was opened or resold: the on-chain
-- PackNFT.Withdraw carries no dist id, the PackNFT resource has no dist field
-- (its Display view is the generic "NBA Top Shot Pack"), and the only chain
-- signal is the PackNFT.Minted(id, hash, distId) event, which needs a block scan.
-- Measured 2026-09-18: 72,868 Top Shot + 243 All Day packs in pack_purchases
-- carry pack_dist_id NULL; for 0xbd94cade097e50ac that is 85 of 94 sealed packs
-- rendering as "Pack #<id tail>" with no name, thumbnail or market data.
--
-- THE SOURCE. Dapper's studio-platform GraphQL (the same host the pack-sales
-- walker already reads, no auth) exposes `searchPackNft`, which the walker never
-- used. Verified 2026-09-18 via pg_net from this database:
--   * filters[{ id: { in: ["216603793394446", ...] } }]  → node { id dist_id status
--     owner_address type_name distribution { id title tier image_urls } }
--   * ids accepted as JSON STRINGS (so no UInt64 precision loss), 100 per request;
--     a 100-id probe returned 90 nodes, every one with a dist_id, statuses
--     Sealed and Opened; the 10 misses are ids the index does not hold.
--   * owner_address comes back WITHOUT the 0x prefix.
--   * distribution can be { id: "0", title: null } for a dist Atlas has not
--     catalogued (seen on dist 8735) — dist_id is still populated.
--
-- WHAT THIS DOES. A pg_cron lane, every 5 minutes at :03/:08/…, modelled on the
-- #120 circulation sampler (pg_net is async, so dispatch and collect are two
-- steps; one job runs collect-then-dispatch):
--   pack_nft_identity           one row per (collection, pack): dist_id, status,
--                               owner, distribution title/tier/image, provenance.
--                               dist_id NULL + status 'not_found' when the index
--                               has no such id — recorded so it is not re-asked
--                               every tick, and so a NULL never reads as a name.
--   pack_nft_identity_requests  every pg_net request this lane sent (ids, outcome),
--                               kept so the 4xx arm can ATTRIBUTE a failure to
--                               this lane instead of filing it as 'unknown'.
--   dispatch_pack_nft_identity  picks unresolved packs (newest purchases first),
--                               POSTs up to p_batches × p_batch_size ids.
--   collect_pack_nft_identity   decodes landed responses, upserts identity rows,
--                               propagates dist_id into pack_purchases.pack_dist_id
--                               (only where NULL — the rip trigger's rule), seeds
--                               pack_distributions rows we lack when the response
--                               carries a title, logs a pipeline_runs row.
--   run_pack_nft_identity_lane  collect, then dispatch. The cron target.
-- Volume: 3 × 100 ids per tick = 36,000/h; ~73k unresolved clears in ~2 h and the
-- lane then idles at zero dispatches (a not-vacuous tick reports 'dispatched': 0
-- with 'unresolved': 0, which is the SUCCESS state, not a stall).
--
-- HONESTY. A response that never landed within 2 h is 'no_response' and its ids
-- stay unresolved (re-dispatched next tick), never written as anything. A non-200
-- or undecodable body is recorded on the request row with its status code and
-- leaves the ids unresolved. Ids the index does not know are 'not_found' with a
-- NULL dist. The 4xx arm of check_edge_fn_http_failures() gets a 'pack-identity'
-- lane via the same anchored in-place patch the site-probe lane used (every
-- anchor asserted unique, refuses to double-patch).
--
-- anon-exec: NOT intentional for dispatch_pack_nft_identity — ops writer, revoked below.
-- anon-exec: NOT intentional for collect_pack_nft_identity — ops writer, revoked below.
-- anon-exec: NOT intentional for run_pack_nft_identity_lane — ops writer, revoked below.
-- anon-exec: intentional — check_edge_fn_http_failures keeps its existing ACL (same signature; re-asserted below)
--
-- REVERT (all parts):
--   SELECT cron.unschedule('rpc-pack-nft-identity-lane');
--   DROP FUNCTION public.run_pack_nft_identity_lane();
--   DROP FUNCTION public.collect_pack_nft_identity();
--   DROP FUNCTION public.dispatch_pack_nft_identity(integer, integer, text[]);
--   DROP TABLE public.pack_nft_identity_requests;   -- after removing the 4xx-arm join
--   DROP TABLE public.pack_nft_identity;
--   DROP INDEX public.idx_pack_purchases_dist_unresolved;
--   pack_purchases.pack_dist_id values it wrote are recorded in pack_nft_identity
--   (request_id + checked_at) and can be nulled from there; the 4xx-arm patch is
--   reverted by re-applying the pre-patch body (pg_get_functiondef before this).

CREATE TABLE IF NOT EXISTS public.pack_nft_identity (
  collection_id  uuid        NOT NULL,
  pack_nft_id    text        NOT NULL,
  dist_id        text,                       -- NULL = the index did not name it
  status         text        NOT NULL,       -- Sealed | Opened | ... | not_found
  owner_address  text,                       -- 0x-prefixed, lowercase; NULL when not returned
  type_name      text,
  dist_title     text,
  dist_tier      text,
  dist_image_url text,
  source         text        NOT NULL DEFAULT 'dapper_searchPackNft',
  request_id     bigint,
  checked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id)
);
ALTER TABLE public.pack_nft_identity ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pack_nft_identity FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.pack_nft_identity IS
  'Per-pack identity read from Dapper searchPackNft. dist_id NULL + status not_found means the index has no such id — a recorded miss, never a name. owner_address/status are as of checked_at.';
CREATE INDEX IF NOT EXISTS idx_pack_nft_identity_checked ON public.pack_nft_identity (checked_at DESC);

CREATE TABLE IF NOT EXISTS public.pack_nft_identity_requests (
  request_id    bigint      PRIMARY KEY,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  pack_nft_ids  text[]      NOT NULL,
  n_ids         integer     NOT NULL,
  collected_at  timestamptz,
  status_code   integer,
  outcome       text,                        -- ok | http_<code> | graphql_error | undecodable | no_response
  n_returned    integer,
  n_not_found   integer
);
ALTER TABLE public.pack_nft_identity_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pack_nft_identity_requests FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_pack_nft_identity_requests_pending
  ON public.pack_nft_identity_requests (dispatched_at) WHERE collected_at IS NULL;

-- The lane's candidate scan: unresolved rows only, newest first. Rows leave the
-- index as they resolve, so it shrinks toward zero.
CREATE INDEX IF NOT EXISTS idx_pack_purchases_dist_unresolved
  ON public.pack_purchases (collection_id, sealed_at DESC) WHERE pack_dist_id IS NULL;

CREATE OR REPLACE FUNCTION public.dispatch_pack_nft_identity(
  p_batches integer DEFAULT 3,
  p_batch_size integer DEFAULT 100,
  p_pack_nft_ids text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid;
  v_ad uuid;
  v_batches int := greatest(0, least(coalesce(p_batches, 3), 10));
  v_size    int := greatest(1, least(coalesce(p_batch_size, 100), 100));
  v_ids     text[];
  v_req     bigint;
  v_sent    int := 0;
  v_ids_sent int := 0;
  v_unresolved bigint;
  i int;
BEGIN
  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  FOR i IN 1..v_batches LOOP
    IF p_pack_nft_ids IS NOT NULL THEN
      -- Targeted run: the caller's ids, minus anything already answered, in slices.
      SELECT array_agg(x.id) INTO v_ids
      FROM (
        SELECT DISTINCT u.id
        FROM unnest(p_pack_nft_ids) AS u(id)
        WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                           WHERE pi.pack_nft_id = u.id AND pi.collection_id IN (v_ts, v_ad))
          AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity_requests q
                           WHERE q.collected_at IS NULL AND u.id = ANY (q.pack_nft_ids))
        ORDER BY u.id
        LIMIT v_size
      ) x;
    ELSE
      SELECT array_agg(x.pack_nft_id) INTO v_ids
      FROM (
        SELECT pp.pack_nft_id, max(pp.sealed_at) AS newest
        FROM public.pack_purchases pp
        WHERE pp.pack_dist_id IS NULL
          AND pp.collection_id IN (v_ts, v_ad)
          AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                           WHERE pi.collection_id = pp.collection_id AND pi.pack_nft_id = pp.pack_nft_id)
          AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity_requests q
                           WHERE q.collected_at IS NULL AND pp.pack_nft_id = ANY (q.pack_nft_ids))
        GROUP BY pp.pack_nft_id
        ORDER BY newest DESC
        LIMIT v_size
      ) x;
    END IF;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    -- Ids are sent as JSON strings on purpose: UInt64 ids above 2^53 would lose
    -- precision as JSON numbers, and the API accepts strings (verified 2026-09-18).
    SELECT net.http_post(
      url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
      body := jsonb_build_object(
        'query', 'query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ hasNextPage } edges{ node{ id dist_id status owner_address type_name distribution{ id title tier image_urls } } } } }',
        'variables', jsonb_build_object('i', jsonb_build_object(
          'first', v_size,
          'filters', jsonb_build_array(jsonb_build_object('id', jsonb_build_object('in', to_jsonb(v_ids))))
        ))
      ),
      headers := '{"Content-Type":"application/json","Origin":"https://nbatopshot.com","Referer":"https://nbatopshot.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb,
      timeout_milliseconds := 20000
    ) INTO v_req;

    INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids)
    VALUES (v_req, v_ids, cardinality(v_ids));

    v_sent := v_sent + 1;
    v_ids_sent := v_ids_sent + cardinality(v_ids);
  END LOOP;

  SELECT count(DISTINCT pp.pack_nft_id) INTO v_unresolved
  FROM public.pack_purchases pp
  WHERE pp.pack_dist_id IS NULL AND pp.collection_id IN (v_ts, v_ad)
    AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                     WHERE pi.collection_id = pp.collection_id AND pi.pack_nft_id = pp.pack_nft_id);

  RETURN jsonb_build_object('ok', true, 'dispatched', v_sent, 'ids_sent', v_ids_sent,
                            'unresolved_after', v_unresolved,
                            'pending_requests', (SELECT count(*) FROM public.pack_nft_identity_requests WHERE collected_at IS NULL));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.dispatch_pack_nft_identity(integer, integer, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dispatch_pack_nft_identity(integer, integer, text[]) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.collect_pack_nft_identity()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid;
  v_ad uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_returned int;
  v_not_found int;
  v_requests int := 0;
  v_ok int := 0;
  v_failed int := 0;
  v_expired int := 0;
  v_identities int := 0;
  v_misses int := 0;
  v_propagated int := 0;
  v_dists_seeded int := 0;
  v_n int;
  v_touched text[] := '{}';
  v_last_error text := NULL;
BEGIN
  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  FOR r IN
    SELECT q.request_id, q.pack_nft_ids, q.dispatched_at,
           h.status_code, h.content, h.error_msg,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_nft_identity_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      -- pg_net purges responses after ~6 h; a request older than 2 h with nothing
      -- back is recorded as no_response and its ids fall back into the pool.
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_nft_identity_requests
           SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
      END IF;
      CONTINUE;
    END IF;

    IF r.status_code IS DISTINCT FROM 200 THEN
      UPDATE public.pack_nft_identity_requests
         SET collected_at = now(), status_code = r.status_code,
             outcome = 'http_' || coalesce(r.status_code::text, 'null')
       WHERE request_id = r.request_id;
      v_failed := v_failed + 1;
      v_last_error := 'http_' || coalesce(r.status_code::text, 'null') || ' ' || left(coalesce(r.error_msg, r.content, ''), 200);
      CONTINUE;
    END IF;

    BEGIN
      v_body := r.content::jsonb;
    EXCEPTION WHEN others THEN
      v_body := NULL;
    END;

    IF v_body IS NULL OR v_body->'data'->'searchPackNft'->'edges' IS NULL THEN
      UPDATE public.pack_nft_identity_requests
         SET collected_at = now(), status_code = r.status_code,
             outcome = CASE WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      v_failed := v_failed + 1;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.content, ''), 200);
      CONTINUE;
    END IF;

    v_edges := v_body->'data'->'searchPackNft'->'edges';

    -- Named packs: one identity row per returned node, collection from type_name.
    INSERT INTO public.pack_nft_identity
      (collection_id, pack_nft_id, dist_id, status, owner_address, type_name,
       dist_title, dist_tier, dist_image_url, request_id, checked_at)
    SELECT
      CASE e->'node'->>'type_name'
        WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
        WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
      END,
      e->'node'->>'id',
      NULLIF(e->'node'->>'dist_id', ''),
      coalesce(e->'node'->>'status', 'unknown'),
      CASE WHEN e->'node'->>'owner_address' IS NULL THEN NULL
           WHEN e->'node'->>'owner_address' LIKE '0x%' THEN lower(e->'node'->>'owner_address')
           ELSE '0x' || lower(e->'node'->>'owner_address') END,
      e->'node'->>'type_name',
      NULLIF(e->'node'->'distribution'->>'title', ''),
      NULLIF(e->'node'->'distribution'->>'tier', ''),
      NULLIF(e->'node'->'distribution'->'image_urls'->>0, ''),
      r.request_id, now()
    FROM jsonb_array_elements(v_edges) e
    WHERE e->'node'->>'id' IS NOT NULL
      AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT')
      AND e->'node'->>'id' = ANY (r.pack_nft_ids)
    ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
      SET dist_id = coalesce(EXCLUDED.dist_id, public.pack_nft_identity.dist_id),
          status = EXCLUDED.status,
          owner_address = EXCLUDED.owner_address,
          type_name = EXCLUDED.type_name,
          dist_title = coalesce(EXCLUDED.dist_title, public.pack_nft_identity.dist_title),
          dist_tier = coalesce(EXCLUDED.dist_tier, public.pack_nft_identity.dist_tier),
          dist_image_url = coalesce(EXCLUDED.dist_image_url, public.pack_nft_identity.dist_image_url),
          request_id = EXCLUDED.request_id,
          checked_at = EXCLUDED.checked_at;
    GET DIAGNOSTICS v_returned = ROW_COUNT;
    v_identities := v_identities + v_returned;

    -- Misses: ids we asked for that came back with no node. Recorded as
    -- not_found with a NULL dist under the pack's own collection, so the lane
    -- does not re-ask every tick and a reader sees an explicit miss.
    INSERT INTO public.pack_nft_identity (collection_id, pack_nft_id, dist_id, status, request_id, checked_at)
    SELECT DISTINCT pp.collection_id, u.id, NULL, 'not_found', r.request_id, now()
    FROM unnest(r.pack_nft_ids) AS u(id)
    JOIN public.pack_purchases pp ON pp.pack_nft_id = u.id AND pp.collection_id IN (v_ts, v_ad)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_edges) e WHERE e->'node'->>'id' = u.id)
    ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    GET DIAGNOSTICS v_not_found = ROW_COUNT;
    v_misses := v_misses + v_not_found;

    UPDATE public.pack_nft_identity_requests
       SET collected_at = now(), status_code = 200, outcome = 'ok',
           n_returned = v_returned, n_not_found = v_not_found
     WHERE request_id = r.request_id;
    v_ok := v_ok + 1;
    v_touched := v_touched || r.pack_nft_ids;
  END LOOP;

  IF cardinality(v_touched) > 0 THEN
    -- Seed distributions we do not know yet, only when the response NAMED them.
    INSERT INTO public.pack_distributions (collection_id, dist_id, title, nft_type, image_url, metadata)
    SELECT DISTINCT ON (i.collection_id, i.dist_id)
           i.collection_id, i.dist_id, i.dist_title, i.type_name, i.dist_image_url,
           jsonb_strip_nulls(jsonb_build_object('tier', i.dist_tier, 'seeded_from', 'dapper_searchPackNft'))
    FROM public.pack_nft_identity i
    WHERE i.pack_nft_id = ANY (v_touched)
      AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
      AND i.dist_title IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.pack_distributions pd
                       WHERE pd.collection_id = i.collection_id AND pd.dist_id = i.dist_id)
    ORDER BY i.collection_id, i.dist_id, i.checked_at DESC
    ON CONFLICT (dist_id, collection_id) DO NOTHING;
    GET DIAGNOSTICS v_dists_seeded = ROW_COUNT;

    -- Propagate into pack_purchases, only where still NULL (the rip trigger's rule).
    UPDATE public.pack_purchases pp
       SET pack_dist_id = i.dist_id
      FROM public.pack_nft_identity i
     WHERE i.collection_id = pp.collection_id
       AND i.pack_nft_id = pp.pack_nft_id
       AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
       AND pp.pack_dist_id IS NULL
       AND pp.pack_nft_id = ANY (v_touched);
    GET DIAGNOSTICS v_propagated = ROW_COUNT;
  END IF;

  -- Telemetry: rows_found = requests inspected, rows_written = identity rows
  -- upserted; the split lives in extra, and a failed request carries its error.
  PERFORM public.log_pipeline_run(
    'pack-nft-identity', v_started,
    v_requests, v_identities, v_misses,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'identities', v_identities, 'not_found', v_misses,
                       'propagated_to_pack_purchases', v_propagated, 'dists_seeded', v_dists_seeded)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'identities', v_identities, 'not_found', v_misses,
                            'propagated', v_propagated, 'dists_seeded', v_dists_seeded,
                            'last_error', v_last_error);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.collect_pack_nft_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_pack_nft_identity() TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.run_pack_nft_identity_lane()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_collect jsonb;
  v_dispatch jsonb;
BEGIN
  v_collect := public.collect_pack_nft_identity();
  v_dispatch := public.dispatch_pack_nft_identity(3, 100, NULL);
  RETURN jsonb_build_object('collect', v_collect, 'dispatch', v_dispatch);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.run_pack_nft_identity_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pack_nft_identity_lane() TO postgres, service_role;

-- ── 4xx arm: attribute this lane's failures instead of filing them as 'unknown' ──
DO $mig$
DECLARE
  v_src  text;
  v_new  text;
  v_args text := 'p_window interval DEFAULT ''02:00:00''::interval';

  c_join_anchor CONSTANT text := 'LEFT JOIN public.site_probe sp ON sp.request_id = r.id';
  c_lane_anchor CONSTANT text := 'ELSE ''unknown''';
  c_ord_anchor  CONSTANT text := 'WHEN ''chain-moved'' THEN 4 WHEN ''chain'' THEN 5 WHEN ''site-probe'' THEN 6 ELSE 0 END AS ord,';
  c_else_anchor CONSTANT text := '          ''severity'', CASE WHEN g.status_code IN (401, 403) THEN ''critical'' ELSE ''high'' END,';

  c_branch CONSTANT text :=
'      WHEN ''pack-identity'' THEN
        jsonb_build_object(
          ''severity'', ''high'',
          ''type'',     ''edge_fn_http_error'',
          ''pipeline'', ''pack-nft-identity-'' || g.status_code::text,
          ''detail'',   g.n || '' pack-identity lookup(s) to Dapper searchPackNft returned HTTP '' || g.status_code
                      || '' in the last '' || p_window::text
                      || ''. ATTRIBUTED, NOT GUESSED: net._http_response.id joined to ''
                      || ''pack_nft_identity_requests.request_id, recorded at dispatch time. ''
                      || ''This is the lane that names SEALED packs (dist_id for pack_purchases); ''
                      || ''while it fails, sealed packs stay unnamed and nothing else breaks. ''
                      || ''A 4xx here means the studio-platform GraphQL host rejected the request ''
                      || ''(schema change, WAF, or the id filter shape) -- check pack_nft_identity_requests.outcome. ''
                      || ''Body: '' || COALESCE(g.sample, ''(empty)'')
        )
';
BEGIN
  SELECT p.prosrc INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'check_edge_fn_http_failures';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'check_edge_fn_http_failures() not found';
  END IF;
  IF position('pack_nft_identity_requests' in v_src) > 0 THEN
    RAISE EXCEPTION 'body already references pack_nft_identity_requests -- refusing to double-patch';
  END IF;
  IF position('$f$' in v_src) > 0 THEN
    RAISE EXCEPTION 'body contains the dollar-quote tag this migration uses';
  END IF;

  IF (length(v_src) - length(replace(v_src, c_join_anchor, ''))) / length(c_join_anchor) <> 1 THEN
    RAISE EXCEPTION 'join anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_lane_anchor, ''))) / length(c_lane_anchor) <> 1 THEN
    RAISE EXCEPTION 'lane anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_ord_anchor, ''))) / length(c_ord_anchor) <> 1 THEN
    RAISE EXCEPTION 'ord anchor is not unique';
  END IF;
  IF (length(v_src) - length(replace(v_src, c_else_anchor, ''))) / length(c_else_anchor) <> 1 THEN
    RAISE EXCEPTION 'else anchor is not unique';
  END IF;

  v_new := replace(v_src, c_join_anchor,
                   c_join_anchor || E'\n      LEFT JOIN public.pack_nft_identity_requests pq ON pq.request_id = r.id');

  v_new := replace(v_new, c_lane_anchor,
                   'WHEN (SELECT can_attribute FROM bounds) AND pq.request_id IS NOT NULL THEN ''pack-identity''' ||
                   E'\n             ' || c_lane_anchor);

  v_new := replace(v_new, c_ord_anchor,
                   'WHEN ''chain-moved'' THEN 4 WHEN ''chain'' THEN 5 WHEN ''site-probe'' THEN 6 WHEN ''pack-identity'' THEN 7 ELSE 0 END AS ord,');

  v_new := replace(v_new, '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor,
                   c_branch || '      ELSE' || E'\n' || '        jsonb_build_object(' || E'\n' || c_else_anchor);

  IF position('pack_nft_identity_requests' in v_new) = 0 OR position('pack-identity' in v_new) = 0 THEN
    RAISE EXCEPTION 'transform produced no pack-identity reference';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.check_edge_fn_http_failures(%s) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp, net AS $f$%s$f$',
    v_args, v_new);
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_edge_fn_http_failures(interval) TO postgres, service_role;

-- ── schedule: every 5 minutes at :03/:08/… (the :02 and :04 slots carry other lanes) ──
SELECT cron.schedule('rpc-pack-nft-identity-lane', '3-58/5 * * * *',
                     $$SELECT public.run_pack_nft_identity_lane();$$);

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-pack-nft-identity-lane' AND active) THEN
    RAISE EXCEPTION 'the pack identity lane is not scheduled';
  END IF;
  IF (SELECT count(*) FROM public.pack_purchases WHERE pack_dist_id IS NULL) = 0 THEN
    RAISE EXCEPTION 'no unresolved packs -- the lane would have nothing to do, which contradicts the 2026-09-18 measurement';
  END IF;
END
$verify$;
