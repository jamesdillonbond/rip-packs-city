-- audit_20260918_wallet_packs_transferred_status_and_identity_lane_covers_rips
--
-- Follow-up to 20260919021500 (the pack identity lane), one hour in.
--
-- 1. THE LANE'S CANDIDATE SCAN WAS THE KIND OF QUERY THIS INSTANCE CANNOT AFFORD.
--    "unresolved packs, newest first" re-read every unresolved row on every
--    tick: 87,158 rows through the partial index, 23,252 buffers (9,023 from
--    disk), 26.9 s per batch, three batches a tick, plus a count(DISTINCT) of
--    the same set — measured on the FIRST scheduled tick, 2026-09-18 6:28pm PT,
--    which was still running at 1 m 02 s with wait_event DataFileRead beside
--    four other lanes. The job was paused at that point (cron.alter_job).
--    ⚠ This is the "LIMIT bounds OUTPUT, not COST" trap from CLAUDE.md, one
--    tick after being warned. The candidate set is now a QUEUE seeded once here
--    (every unresolved purchase and rip, newest first) that dispatch POPS by
--    primary key, and a cheap top-up walks only the last day of the partial
--    index. A request that fails or expires puts its ids back on the queue.
--    The two count(DISTINCT) full scans in the return value are gone; the lane
--    reports queue depth instead.
--
-- 2. A HELD ROW THAT IS A FALSE CLAIM. The first targeted run named 92 of
--    0xbd94cade097e50ac's 94 "held" packs — and Dapper's index says 2 of them are
--    OPENED and owned by ANOTHER wallet. No marketplace sale, no rip by this
--    wallet: they left by transfer (gift, or a sale the walker has not reached).
--    get_wallet_pack_history v4 called them HELD. v5 adds status `transferred`:
--    has_buy, no sell, no rip, and pack_nft_identity.owner_address is a
--    DIFFERENT wallet. Rows carry `current_owner`, `identity_status`,
--    `identity_checked_at` so the reader sees what the claim rests on. The
--    identity table is also a dist source (`dist_source = 'dapper_index'`) for
--    packs the lane named that have no pack_purchases row to propagate into.
--    Additive: every existing key keeps its name and type; `status` gains one
--    value, which the UI, the route allowlist and the sold-packs alert accept.
--
-- 3. THE LANE ALSO NAMES OPENED PACKS. 85,530 Top Shot rips carry dist_id NULL
--    (82,693 of them with no purchase row to inherit from) — the "Unknown
--    distribution" rows on the Opened tab. Rips are queued too, and the
--    collector writes pack_rips.dist_id where NULL (the COALESCE-never-overwrite
--    rule of upsert_pack_rips_from_api) with provenance in
--    topshot_pack_rip_attribution under the new method 'dapper_index'
--    (confidence 'high': Dapper's own record of which distribution minted the
--    pack). pack_rips_propagate_dist_trg then fills the matching pack_purchases
--    rows as it always has.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_history (service_role only; verified 2026-09-18)
-- anon-exec: NOT intentional for dispatch_pack_nft_identity — ops writer, ACL re-asserted below.
-- anon-exec: NOT intentional for collect_pack_nft_identity — ops writer, ACL re-asserted below.
--
-- REVERT: re-apply the v4 history body and the v1 lane bodies from
--   20260919004500 / 20260919021500; DROP TABLE public.pack_nft_identity_queue;
--   drop 'dapper_index' from the attribution CHECK after deleting its rows.
--   dist_id values the collector wrote into pack_rips are the rows with a
--   'dapper_index' attribution.

ALTER TABLE public.topshot_pack_rip_attribution DROP CONSTRAINT IF EXISTS topshot_pack_rip_attribution_method_check;
ALTER TABLE public.topshot_pack_rip_attribution ADD CONSTRAINT topshot_pack_rip_attribution_method_check
  CHECK (method = ANY (ARRAY['rip_dist'::text, 'empirical_subset'::text, 'live_pool_subset'::text, 'gql_pool_subset'::text, 'dapper_index'::text]));

CREATE INDEX IF NOT EXISTS idx_pack_rips_dist_unresolved
  ON public.pack_rips (collection_id, sealed_at DESC) WHERE dist_id IS NULL;

-- ── the queue ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pack_nft_identity_queue (
  collection_id uuid        NOT NULL,
  pack_nft_id   text        NOT NULL,
  last_seen_at  timestamptz NOT NULL,   -- newest purchase/rip time: pops newest first
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, pack_nft_id)
);
ALTER TABLE public.pack_nft_identity_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pack_nft_identity_queue FROM PUBLIC, anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_pack_nft_identity_queue_pop ON public.pack_nft_identity_queue (last_seen_at DESC);

-- Seed once: every unresolved purchase and rip not already answered. This is
-- the ONE full walk; after it the lane only pops.
INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
SELECT c.collection_id, c.pack_nft_id, max(c.at)
FROM (
  SELECT pp.collection_id, pp.pack_nft_id, pp.sealed_at AS at
  FROM public.pack_purchases pp
  WHERE pp.pack_dist_id IS NULL
    AND pp.collection_id IN (SELECT id FROM public.collections WHERE slug IN ('nba_top_shot', 'nfl_all_day'))
  UNION ALL
  SELECT r.collection_id, r.pack_nft_id, r.sealed_at
  FROM public.pack_rips r
  WHERE r.dist_id IS NULL
    AND r.collection_id IN (SELECT id FROM public.collections WHERE slug IN ('nba_top_shot', 'nfl_all_day'))
) c
WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                   WHERE pi.collection_id = c.collection_id AND pi.pack_nft_id = c.pack_nft_id)
GROUP BY c.collection_id, c.pack_nft_id
ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

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
  v_topped_up int := 0;
  i int;
BEGIN
  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  IF p_pack_nft_ids IS NULL THEN
    -- Top-up: only the last day of the two partial indexes, index-ordered, so
    -- the walk is a few hundred rows however large the backlog is.
    INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
    SELECT c.collection_id, c.pack_nft_id, max(c.at)
    FROM (
      SELECT pp.collection_id, pp.pack_nft_id, pp.sealed_at AS at
      FROM public.pack_purchases pp
      WHERE pp.pack_dist_id IS NULL AND pp.collection_id IN (v_ts, v_ad)
        AND pp.sealed_at > now() - interval '1 day'
      UNION ALL
      SELECT r.collection_id, r.pack_nft_id, r.sealed_at
      FROM public.pack_rips r
      WHERE r.dist_id IS NULL AND r.collection_id IN (v_ts, v_ad)
        AND r.sealed_at > now() - interval '1 day'
    ) c
    WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                       WHERE pi.collection_id = c.collection_id AND pi.pack_nft_id = c.pack_nft_id)
    GROUP BY c.collection_id, c.pack_nft_id
    ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    GET DIAGNOSTICS v_topped_up = ROW_COUNT;
  END IF;

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
      -- Pop newest-first. The ids leave the queue here; a failed or expired
      -- request puts them back (collect), an answered one lands in identity.
      WITH pick AS (
        SELECT collection_id, pack_nft_id
        FROM public.pack_nft_identity_queue
        ORDER BY last_seen_at DESC
        LIMIT v_size
        FOR UPDATE SKIP LOCKED
      ), popped AS (
        DELETE FROM public.pack_nft_identity_queue q
        USING pick
        WHERE q.collection_id = pick.collection_id AND q.pack_nft_id = pick.pack_nft_id
        RETURNING q.pack_nft_id
      )
      SELECT array_agg(DISTINCT pack_nft_id) INTO v_ids FROM popped;
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

  RETURN jsonb_build_object('ok', true, 'dispatched', v_sent, 'ids_sent', v_ids_sent,
                            'topped_up', v_topped_up,
                            'queue_depth', (SELECT count(*) FROM public.pack_nft_identity_queue),
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
  v_rips_named int := 0;
  v_dists_seeded int := 0;
  v_requeued int := 0;
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
      -- back is recorded as no_response and its ids go back on the queue.
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_nft_identity_requests
           SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
        SELECT k.collection_id, k.pack_nft_id, k.at, 1
        FROM (
          SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
           WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
          UNION ALL
          SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
           WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
        ) k
        WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
        ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
        GET DIAGNOSTICS v_returned = ROW_COUNT;
        v_requeued := v_requeued + v_returned;
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
      INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
      SELECT k.collection_id, k.pack_nft_id, k.at, 1
      FROM (
        SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
         WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
        UNION ALL
        SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
         WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
      ) k
      WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
      ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
      GET DIAGNOSTICS v_returned = ROW_COUNT;
      v_requeued := v_requeued + v_returned;
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
      INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
      SELECT k.collection_id, k.pack_nft_id, k.at, 1
      FROM (
        SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
         WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
        UNION ALL
        SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
         WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
      ) k
      WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
      ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
      GET DIAGNOSTICS v_returned = ROW_COUNT;
      v_requeued := v_requeued + v_returned;
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
    -- not_found with a NULL dist under the pack's own collection (from either
    -- table), so the lane does not re-ask every tick and a reader sees an
    -- explicit miss.
    INSERT INTO public.pack_nft_identity (collection_id, pack_nft_id, dist_id, status, request_id, checked_at)
    SELECT DISTINCT k.collection_id, u.id, NULL, 'not_found', r.request_id, now()
    FROM unnest(r.pack_nft_ids) AS u(id)
    JOIN (
      SELECT collection_id, pack_nft_id FROM public.pack_purchases WHERE pack_nft_id = ANY (r.pack_nft_ids) AND collection_id IN (v_ts, v_ad)
      UNION
      SELECT collection_id, pack_nft_id FROM public.pack_rips WHERE pack_nft_id = ANY (r.pack_nft_ids) AND collection_id IN (v_ts, v_ad)
    ) k ON k.pack_nft_id = u.id
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

    -- Rips first: pack_rips_propagate_dist_trg then fills the matching
    -- pack_purchases rows, and the explicit propagation below catches the rest.
    WITH named AS (
      UPDATE public.pack_rips pr
         SET dist_id = i.dist_id
        FROM public.pack_nft_identity i
       WHERE i.collection_id = pr.collection_id
         AND i.pack_nft_id = pr.pack_nft_id
         AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
         AND pr.dist_id IS NULL
         AND pr.pack_nft_id = ANY (v_touched)
      RETURNING pr.id, pr.dist_id
    ), attributed AS (
      INSERT INTO public.topshot_pack_rip_attribution (rip_id, dist_id, method, confidence, n_editions)
      SELECT n.id, n.dist_id, 'dapper_index', 'high', NULL FROM named n
      ON CONFLICT (rip_id) DO NOTHING
      RETURNING 1
    )
    SELECT count(*) INTO v_rips_named FROM named;

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

    -- Anything answered is off the queue, whichever path put it there.
    DELETE FROM public.pack_nft_identity_queue q
    USING public.pack_nft_identity i
    WHERE i.collection_id = q.collection_id AND i.pack_nft_id = q.pack_nft_id
      AND q.pack_nft_id = ANY (v_touched);
  END IF;

  -- Telemetry: rows_found = requests inspected, rows_written = identity rows
  -- upserted; the split lives in extra, and a failed request carries its error.
  PERFORM public.log_pipeline_run(
    'pack-nft-identity', v_started,
    v_requests, v_identities, v_misses,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                       'propagated_to_pack_purchases', v_propagated, 'rips_named', v_rips_named,
                       'dists_seeded', v_dists_seeded)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                            'propagated', v_propagated, 'rips_named', v_rips_named,
                            'dists_seeded', v_dists_seeded, 'last_error', v_last_error);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.collect_pack_nft_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collect_pack_nft_identity() TO postgres, service_role;

-- >>> BEGIN verbatim get_wallet_pack_history (pinned by supabase/tests/get_wallet_pack_history.sql) >>>
CREATE OR REPLACE FUNCTION public.get_wallet_pack_history(p_wallet text, p_collection_slug text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '20s'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_safe_limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  v_ts uuid;
  v_ad uuid;
  v_total int;
  v_packs jsonb;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('error', 'wallet required');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  WITH buy_src AS (
    -- (1) on-chain, via pack-events-ingest: secondary ListingCompleted rows AND
    --     primary Withdraw/Mint rows (sale_price NULL on chain -> priced at retail below)
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, seller_address AS counterparty, is_primary_drop, event_kind,
           pack_dist_id AS dist_id, 'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE buyer_address = v_wallet
    UNION ALL
    -- (2) Dapper marketplace history (Atlas walker). Buyer-side rows. USD.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE buyer_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, storefront_address, false,
           'secondary_sale', dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE buyer_address = v_wallet AND purchased
  ),
  -- One buy per pack. The same purchase is often in BOTH sources with DIFFERENT
  -- timestamps: the marketplace row carries the sale moment, the on-chain row
  -- the settlement, which lands later by a median 4 h and a p90 of 9 DAYS
  -- (31,995 matched Top Shot pairs, Jun-Aug 2026). So rows within 30 days of
  -- the pack's latest buy row are ONE purchase: price/counterparty come from
  -- its latest row (on-chain on a tie), bought_at is the EARLIEST of them --
  -- otherwise a quick flip whose on-chain settlement post-dates the resale
  -- reads as "bought back" and renders HELD.
  buy_ranked AS (
    SELECT b.*, MAX(at) OVER (PARTITION BY collection_id, pack_nft_id) AS max_at
    FROM buy_src b
  ),
  latest_buys AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS buy_price, currency AS buy_currency,
           MIN(at) FILTER (WHERE at >= max_at - interval '30 days')
             OVER (PARTITION BY collection_id, pack_nft_id) AS bought_at,
           counterparty AS bought_from, is_primary_drop AS bought_primary,
           event_kind AS bought_event_kind, src AS buy_src
    FROM buy_ranked
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  buy_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM buy_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  sell_src AS (
    -- (1) on-chain rows whose seller IS this wallet: rows the worker ingests
    --     after its Withdraw.from fix, plus the 68,889 historical rows the
    --     2026-09-18 backfill re-attributed from the marketplace tables.
    SELECT pack_nft_id, collection_id, sale_price AS price, sale_currency AS currency,
           sealed_at AS at, buyer_address AS counterparty, pack_dist_id AS dist_id,
           'onchain'::text AS src, 1 AS pri
    FROM public.pack_purchases WHERE seller_address = v_wallet
    UNION ALL
    -- (2) marketplace history: storefront_address is the SELLING wallet.
    SELECT pack_nft_id, v_ts, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.topshot_pack_sales_history WHERE storefront_address = v_wallet AND purchased
    UNION ALL
    SELECT pack_nft_id, v_ad, sale_price_usd, 'USD', block_time, buyer_address, dist_id, 'marketplace', 2
    FROM public.allday_pack_sales_history WHERE storefront_address = v_wallet AND purchased
  ),
  latest_sells AS (
    SELECT DISTINCT ON (collection_id, pack_nft_id)
           pack_nft_id, collection_id, price AS sell_price, currency AS sell_currency,
           at AS sold_at, counterparty AS sold_to, src AS sell_src
    FROM sell_src
    ORDER BY collection_id, pack_nft_id, at DESC, pri
  ),
  sell_dist AS (
    SELECT collection_id, pack_nft_id, MAX(dist_id) AS dist_id
    FROM sell_src WHERE dist_id IS NOT NULL GROUP BY 1, 2
  ),
  wallet_rips AS (
    SELECT id, pack_nft_id, collection_id, sealed_at, moments_pulled, dist_id, pull_value_usd
    FROM public.pack_rips WHERE opener_address = v_wallet
  ),
  events AS (
    SELECT collection_id, pack_nft_id, bought_at AS event_at, 'buy'::text AS role FROM latest_buys
    UNION ALL
    SELECT collection_id, pack_nft_id, sold_at, 'sell' FROM latest_sells
    UNION ALL
    SELECT collection_id, pack_nft_id, sealed_at, 'rip' FROM wallet_rips
  ),
  dedup AS (
    SELECT collection_id, pack_nft_id,
      MAX(event_at)          AS latest_event_at,
      MIN(event_at)          AS first_event_at,
      bool_or(role = 'buy')  AS has_buy,
      bool_or(role = 'sell') AS has_sell,
      bool_or(role = 'rip')  AS has_rip
    FROM events GROUP BY 1, 2
  ),
  resolved AS (
    SELECT
      d.*,
      c.slug AS collection_slug, c.name AS collection_name,
      lb.buy_price, lb.buy_currency, lb.bought_at, lb.bought_from, lb.bought_primary,
      lb.bought_event_kind, lb.buy_src,
      ls.sell_price, ls.sell_currency, ls.sold_at, ls.sold_to, ls.sell_src,
      wr.id AS rip_id, wr.sealed_at AS ripped_at, wr.moments_pulled, wr.pull_value_usd,
      -- Dapper's own index of the pack (pack_nft_identity, filled by the
      -- pack-nft-identity lane): current owner + Sealed/Opened, as of checked_at.
      pi.owner_address AS current_owner,
      pi.status        AS identity_status,
      pi.checked_at    AS identity_checked_at,
      -- distribution: rip > the wallet's own rows > any marketplace row > the index
      COALESCE(wr.dist_id, bd.dist_id, sd.dist_id, hx.dist_id, NULLIF(pi.dist_id, '0')) AS dist_id,
      CASE
        WHEN wr.dist_id IS NOT NULL THEN 'rip'
        WHEN bd.dist_id IS NOT NULL OR sd.dist_id IS NOT NULL THEN 'own_row'
        WHEN hx.dist_id IS NOT NULL THEN 'peer_sale'
        WHEN NULLIF(pi.dist_id, '0') IS NOT NULL THEN 'dapper_index'
        ELSE NULL
      END AS dist_source
    FROM dedup d
    JOIN public.collections c ON c.id = d.collection_id
    LEFT JOIN latest_buys  lb ON lb.collection_id = d.collection_id AND lb.pack_nft_id = d.pack_nft_id
    LEFT JOIN latest_sells ls ON ls.collection_id = d.collection_id AND ls.pack_nft_id = d.pack_nft_id
    LEFT JOIN wallet_rips  wr ON wr.collection_id = d.collection_id AND wr.pack_nft_id = d.pack_nft_id
    LEFT JOIN buy_dist     bd ON bd.collection_id = d.collection_id AND bd.pack_nft_id = d.pack_nft_id
    LEFT JOIN sell_dist    sd ON sd.collection_id = d.collection_id AND sd.pack_nft_id = d.pack_nft_id
    LEFT JOIN public.pack_nft_identity pi ON pi.collection_id = d.collection_id AND pi.pack_nft_id = d.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT h.dist_id FROM public.topshot_pack_sales_history h
      WHERE d.collection_id = v_ts
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      UNION ALL
      SELECT h.dist_id FROM public.allday_pack_sales_history h
      WHERE d.collection_id = v_ad
        AND wr.dist_id IS NULL AND bd.dist_id IS NULL AND sd.dist_id IS NULL
        AND h.pack_nft_id = d.pack_nft_id AND h.dist_id IS NOT NULL
      LIMIT 1
    ) hx ON true
  ),
  enriched AS (
    SELECT
      r.*,
      pd.title              AS pack_name,
      pd.image_url          AS pack_image,
      pd.metadata->>'tier'  AS pack_tier,
      pd.total_sealed       AS dist_total_sealed,
      pd.total_opened       AS dist_total_opened,
      (pd.metadata->>'retail_price_usd')::numeric AS retail_usd,
      -- what the wallet PAID: on-chain/marketplace price for a secondary buy,
      -- the distribution's retail price for a primary drop, NULL when unknown.
      CASE WHEN r.bought_primary THEN (pd.metadata->>'retail_price_usd')::numeric
           ELSE r.buy_price END AS buy_usd,
      CASE
        WHEN NOT r.has_buy THEN NULL
        WHEN r.bought_primary AND (pd.metadata->>'retail_price_usd') IS NOT NULL THEN 'retail'
        WHEN r.bought_primary THEN NULL
        WHEN r.buy_price IS NULL THEN NULL
        ELSE r.buy_src
      END AS buy_price_source
    FROM resolved r
    LEFT JOIN public.pack_distributions pd
      ON pd.dist_id = r.dist_id AND pd.collection_id = r.collection_id
  ),
  classified AS (
    SELECT *,
      CASE
        WHEN has_rip                                            THEN 'ripped'
        WHEN has_sell AND has_buy AND sold_at >= bought_at      THEN 'flipped'
        WHEN has_sell AND NOT has_buy                           THEN 'sold'
        -- bought, never sold or opened by this wallet, and Dapper's index says a
        -- DIFFERENT wallet holds it now: it left by transfer, or by a sale the
        -- marketplace walker has not reached. Never HELD.
        WHEN has_buy AND current_owner IS NOT NULL AND current_owner <> v_wallet
                                                                THEN 'transferred'
        WHEN has_buy                                            THEN 'held'
        ELSE 'other'
      END AS status
    FROM enriched
  ),
  with_pl AS (
    SELECT *,
      CASE
        WHEN status = 'ripped'  AND pull_value_usd IS NOT NULL AND buy_usd IS NOT NULL THEN pull_value_usd - buy_usd
        WHEN status = 'flipped' AND sell_price     IS NOT NULL AND buy_usd IS NOT NULL THEN sell_price     - buy_usd
        ELSE NULL
      END AS realized_pl_usd
    FROM classified
  ),
  filtered AS (
    SELECT * FROM with_pl
    WHERE (p_collection_slug IS NULL OR collection_slug = p_collection_slug)
      AND (
        p_status IS NULL
        OR p_status = 'all'
        -- virtual status: every "no longer sealed in this wallet, sold on"
        -- outcome, regardless of whether a matching buy was attributable
        OR (p_status = 'sold_any' AND status IN ('flipped', 'sold'))
        OR status = p_status
      )
  ),
  page AS (
    SELECT * FROM filtered
    ORDER BY latest_event_at DESC, collection_id, pack_nft_id
    LIMIT v_safe_limit OFFSET v_safe_offset
  ),
  -- market context, PAGE rows only: current floor ask, latest EV snapshot, last
  -- recorded secondary sale of the same distribution. All NULL when unknown.
  page_market AS (
    SELECT
      p.*,
      CASE WHEN pas.is_listed THEN pas.lowest_ask END AS lowest_ask_usd,
      pas.last_checked_at                             AS ask_checked_at,
      ev.pack_ev                                      AS pack_ev_usd,
      ev.snapshotted_at                               AS ev_snapshotted_at,
      lsale.sale_price                                AS last_sale_usd,
      lsale.sealed_at                                 AS last_sale_at
    FROM page p
    LEFT JOIN public.pack_ask_state pas
      ON p.dist_id IS NOT NULL
     AND pas.dist_id = p.dist_id
     AND pas.collection_slug = replace(p.collection_slug, '_', '-')
    LEFT JOIN public.mv_pack_ev_latest ev
      ON p.dist_id IS NOT NULL
     AND ev.dist_id = p.dist_id AND ev.collection_id = p.collection_id
    LEFT JOIN LATERAL (
      SELECT pp.sale_price, pp.sealed_at
      FROM public.pack_purchases pp
      WHERE p.dist_id IS NOT NULL
        AND pp.pack_dist_id = p.dist_id
        AND pp.collection_id = p.collection_id
        AND pp.event_kind = 'secondary_sale'
        AND pp.sale_price IS NOT NULL
      ORDER BY pp.sealed_at DESC
      LIMIT 1
    ) lsale ON true
  )
  SELECT
    (SELECT COUNT(*) FROM filtered),
    COALESCE(jsonb_agg(
      jsonb_build_object(
        'pack_nft_id', pack_nft_id, 'collection_id', collection_id,
        'collection_slug', collection_slug, 'collection_name', collection_name,
        'status', status, 'has_buy', has_buy, 'has_sell', has_sell, 'has_rip', has_rip,
        'latest_event_at', latest_event_at, 'first_event_at', first_event_at,
        'pack_name', pack_name, 'pack_image', pack_image, 'pack_tier', pack_tier,
        'dist_id', dist_id, 'dist_source', dist_source,
        'dist_total_sealed', dist_total_sealed, 'dist_total_opened', dist_total_opened,
        'current_owner', current_owner, 'identity_status', identity_status,
        'identity_checked_at', identity_checked_at,
        'rip_id', rip_id, 'ripped_at', ripped_at,
        'moments_pulled', moments_pulled,
        'pull_value_usd', CASE WHEN pull_value_usd IS NULL THEN NULL ELSE ROUND(pull_value_usd::numeric, 2) END,
        'buy_price', CASE WHEN buy_price IS NULL THEN NULL ELSE ROUND(buy_price::numeric, 2) END,
        'buy_usd',   CASE WHEN buy_usd   IS NULL THEN NULL ELSE ROUND(buy_usd::numeric, 2) END,
        'buy_price_source', buy_price_source,
        'buy_currency', buy_currency, 'bought_at', bought_at, 'bought_from', bought_from,
        'bought_primary', bought_primary,
        'event_kind', bought_event_kind,
        'sell_price', CASE WHEN sell_price IS NULL THEN NULL ELSE ROUND(sell_price::numeric, 2) END,
        'sell_source', sell_src,
        'sell_currency', sell_currency, 'sold_at', sold_at, 'sold_to', sold_to,
        'realized_pl_usd', CASE WHEN realized_pl_usd IS NULL THEN NULL ELSE ROUND(realized_pl_usd::numeric, 2) END,
        'lowest_ask_usd', CASE WHEN lowest_ask_usd IS NULL THEN NULL ELSE ROUND(lowest_ask_usd::numeric, 2) END,
        'ask_checked_at', ask_checked_at,
        'pack_ev_usd', CASE WHEN pack_ev_usd IS NULL THEN NULL ELSE ROUND(pack_ev_usd::numeric, 2) END,
        'ev_snapshotted_at', ev_snapshotted_at,
        'last_sale_usd', CASE WHEN last_sale_usd IS NULL THEN NULL ELSE ROUND(last_sale_usd::numeric, 2) END,
        'last_sale_at', last_sale_at
      ) ORDER BY latest_event_at DESC, collection_id, pack_nft_id
    ), '[]'::jsonb)
  INTO v_total, v_packs
  FROM page_market;

  RETURN jsonb_build_object(
    'wallet', v_wallet,
    'collection_slug', p_collection_slug,
    'status_filter', p_status,
    'limit', v_safe_limit,
    'offset', v_safe_offset,
    'total_count', v_total,
    'packs', v_packs,
    'coverage', jsonb_build_object(
      'onchain', 'pack_purchases: Top Shot + All Day, block-indexed from 2026-04; primary drops carry no price on chain',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner) filled by the pack-nft-identity lane; a pack it has not reached yet has dist_id/pack_name NULL and cannot be marked transferred'
    ),
    'computed_at', now()
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_history <<<

-- The lane was paused by hand (cron.alter_job active := false) when its first
-- tick was measured; the queue makes it cheap, so it goes back on here.
SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'rpc-pack-nft-identity-lane'), active := true);

DO $verify$
DECLARE v_q bigint;
BEGIN
  SELECT count(*) INTO v_q FROM public.pack_nft_identity_queue;
  IF v_q < 100000 THEN
    RAISE EXCEPTION 'queue seeded with % rows; ~158k expected (73k unresolved purchases + 85k unresolved rips) -- the seed is drawing from the wrong set', v_q;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-pack-nft-identity-lane' AND active) THEN
    RAISE EXCEPTION 'the pack identity lane is not active';
  END IF;
END
$verify$;
