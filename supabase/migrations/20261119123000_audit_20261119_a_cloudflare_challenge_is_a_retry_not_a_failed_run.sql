-- audit_20261119_a_cloudflare_challenge_is_a_retry_not_a_failed_run
--
-- 2026-11-19 (PT, morning by DB clock; Claude Code cloud; Trevor: "Figure out how we can fix all of this and look
-- for better continuity").
-- collect_pack_nft_identity() and collect_wallet_pack_pulls() (moved to Atlas 11-18, 20261119050000) logged
-- ok = (v_failed = 0), and v_failed counted Cloudflare challenges. Atlas challenges ~5-15 pct of this egress's
-- calls, so ~1 run in 6-12 logged ok=false although every challenged request was retried (ids re-queued; the
-- wallet re-synced next time). Measured 11-18 9-10 PM PT: identity 2/12 runs "failed" with 31 ok + 2 challenged
-- requests each. The failure-rate arm only clears a lane after 20 clean runs and 12 h without a failure -- so
-- these two lanes could NEVER clear, and sat medium on the board for good: the permanently-red-arm shape that
-- trains the operator to skim the board.
--
-- WHAT. In both collectors a 403/429 response counts as requests_challenged (reported in extra), not
-- requests_failed. Every other failure (5xx, undecodable, GraphQL/Connect error) still fails the run. A real
-- Atlas outage still pages: check_edge_fn_http_failures' pack-identity / pack-pulls arms go HIGH when the lane
-- collected no 200 in 2 h (20261119074500 and before). Nothing else in either body changes.
-- collect_wallet_pack_pulls is pinned (supabase/tests/collect_wallet_pack_pulls.sql + drift guard, re-pointed).
--
-- REVERT: re-create both from 20261119050000_audit_20261118_pack_identity_and_pulls_off_studio_onto_atlas.sql.

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
  v_gz uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_returned int;
  v_not_found int;
  v_requests int := 0;
  v_ok int := 0;
  v_failed int := 0; v_challenged int := 0;
  v_expired int := 0;
  v_identities int := 0;
  v_misses int := 0;
  v_propagated int := 0;
  v_rips_named int := 0;
  v_dists_seeded int := 0;
  v_requeued int := 0;
  v_wallet_pages int := 0;
  v_wallets_done int := 0;
  v_touched text[] := '{}';
  v_last_error text := NULL;
  v_next bigint;
BEGIN
  -- One collector at a time. A cron tick and a manual run overlapping on
  -- 2026-09-18 both collected the same wallet page and each dispatched the
  -- next one -- a duplicated page chain. The lock is transaction-scoped.
  IF NOT pg_try_advisory_xact_lock(hashtext('collect_pack_nft_identity')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another collector holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  FOR r IN
    -- 2026-11-18 (#218): an Atlas request (q.product set) is translated into the Studio
    -- searchPackNft shape here, so everything below is unchanged. A 404 not_found is a valid
    -- "no such pack" and reads as an empty 200; anything untranslatable keeps its raw status.
    SELECT q.request_id, q.pack_nft_ids, q.dispatched_at, q.kind, q.wallet, q.page, q.product,
           CASE WHEN q.product IS NOT NULL
                 AND public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.pack_nft_ids) IS NOT NULL
                THEN 200 ELSE h.status_code END AS status_code,
           CASE WHEN q.product IS NULL THEN h.content
                ELSE coalesce(public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.pack_nft_ids)::text, h.content)
           END AS content,
           h.error_msg,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_nft_identity_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_nft_identity_requests
           SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        IF r.kind = 'wallet' THEN
          UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'no_response on page ' || r.page
           WHERE wallet = r.wallet AND completed_at IS NULL;
        ELSE
          INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
          SELECT k.collection_id, k.pack_nft_id, max(k.at), 1
          FROM (
            SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
             WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
            UNION ALL
            SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
             WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
          ) k
          WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
          -- A pack both BOUGHT and RIPPED is in both legs: collapse to one row per key, or
          -- ON CONFLICT DO UPDATE aborts the whole collector ("cannot affect row a second time").
          GROUP BY k.collection_id, k.pack_nft_id
          ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
          GET DIAGNOSTICS v_returned = ROW_COUNT;
          v_requeued := v_requeued + v_returned;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    BEGIN
      v_body := CASE WHEN r.status_code = 200 THEN r.content::jsonb ELSE NULL END;
    EXCEPTION WHEN others THEN
      v_body := NULL;
    END;

    IF r.status_code IS DISTINCT FROM 200 OR v_body IS NULL OR v_body->'data'->'searchPackNft'->'edges' IS NULL THEN
      UPDATE public.pack_nft_identity_requests
         SET collected_at = now(), status_code = r.status_code,
             outcome = CASE WHEN r.status_code IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.status_code::text, 'null')
                            WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      -- 2026-11-19: a Cloudflare challenge (403/429, ~5-15 pct of Atlas calls from this egress) is retried
      -- (ids re-queued / the wallet re-synced next time) -- a retry, not a lane failure; the 4xx arm
      -- pages HIGH if no 200 lands for 2 h. Anything else still fails the run.
      IF r.status_code IN (403, 429) THEN v_challenged := v_challenged + 1; ELSE v_failed := v_failed + 1; END IF;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.error_msg, r.content, ''), 200);
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page ' || r.page || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      ELSE
        INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at, attempts)
        SELECT k.collection_id, k.pack_nft_id, max(k.at), 1
        FROM (
          SELECT pp.collection_id, pp.pack_nft_id, max(pp.sealed_at) AS at FROM public.pack_purchases pp
           WHERE pp.pack_nft_id = ANY (r.pack_nft_ids) AND pp.collection_id IN (v_ts, v_ad) AND pp.pack_dist_id IS NULL GROUP BY 1, 2
          UNION ALL
          SELECT rp.collection_id, rp.pack_nft_id, rp.sealed_at FROM public.pack_rips rp
           WHERE rp.pack_nft_id = ANY (r.pack_nft_ids) AND rp.collection_id IN (v_ts, v_ad) AND rp.dist_id IS NULL
        ) k
        WHERE NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi WHERE pi.collection_id = k.collection_id AND pi.pack_nft_id = k.pack_nft_id)
        -- A pack both BOUGHT and RIPPED is in both legs: collapse to one row per key, or
        -- ON CONFLICT DO UPDATE aborts the whole collector ("cannot affect row a second time").
        GROUP BY k.collection_id, k.pack_nft_id
        ON CONFLICT (collection_id, pack_nft_id) DO UPDATE SET attempts = public.pack_nft_identity_queue.attempts + 1;
        GET DIAGNOSTICS v_returned = ROW_COUNT;
        v_requeued := v_requeued + v_returned;
      END IF;
      CONTINUE;
    END IF;

    v_edges := v_body->'data'->'searchPackNft'->'edges';

    -- Identity rows. For an 'ids' request only the ids we asked for; for a
    -- 'wallet' page every node. Collection from type_name; unknown types skipped.
    INSERT INTO public.pack_nft_identity
      (collection_id, pack_nft_id, dist_id, status, owner_address, type_name,
       dist_title, dist_tier, dist_image_url, acquired_at, request_id, checked_at, source)
    SELECT
      CASE e->'node'->>'type_name'
        WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
        WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
        WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
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
      (SELECT max((o->>'nftAcquiredAt')::timestamptz)
         FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e->'node'->'ownershipHistory') = 'array' THEN e->'node'->'ownershipHistory' ELSE '[]'::jsonb END) o
        WHERE lower(coalesce(o->>'flowAddress', '')) = lower(regexp_replace(coalesce(e->'node'->>'owner_address', ''), '^0x', ''))),
      r.request_id, now(),
      CASE WHEN r.product IS NOT NULL THEN 'atlas_pack_service' ELSE 'dapper_searchPackNft' END
    FROM jsonb_array_elements(v_edges) e
    WHERE e->'node'->>'id' IS NOT NULL
      AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
      AND (r.kind = 'wallet' OR e->'node'->>'id' = ANY (r.pack_nft_ids))
    ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
      SET dist_id = coalesce(EXCLUDED.dist_id, public.pack_nft_identity.dist_id),
          -- Atlas ResolvePackDistribution names the dist but not status/owner: 'unknown' and a
          -- NULL owner must not overwrite what an earlier answer recorded (a not_found becomes unknown).
          status = CASE WHEN EXCLUDED.status = 'unknown'
                        THEN coalesce(NULLIF(public.pack_nft_identity.status, 'not_found'), 'unknown')
                        ELSE EXCLUDED.status END,
          owner_address = coalesce(EXCLUDED.owner_address, public.pack_nft_identity.owner_address),
          type_name = EXCLUDED.type_name,
          dist_title = coalesce(EXCLUDED.dist_title, public.pack_nft_identity.dist_title),
          dist_tier = coalesce(EXCLUDED.dist_tier, public.pack_nft_identity.dist_tier),
          dist_image_url = coalesce(EXCLUDED.dist_image_url, public.pack_nft_identity.dist_image_url),
          acquired_at = coalesce(EXCLUDED.acquired_at, public.pack_nft_identity.acquired_at),
          request_id = EXCLUDED.request_id,
          checked_at = EXCLUDED.checked_at,
          source = EXCLUDED.source;
    GET DIAGNOSTICS v_returned = ROW_COUNT;
    v_identities := v_identities + v_returned;

    v_not_found := 0;
    IF r.kind = 'ids' AND v_returned < cardinality(r.pack_nft_ids) THEN
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
    END IF;

    UPDATE public.pack_nft_identity_requests
       SET collected_at = now(), status_code = 200, outcome = 'ok',
           n_returned = v_returned, n_not_found = v_not_found
     WHERE request_id = r.request_id;
    v_ok := v_ok + 1;

    IF r.kind = 'wallet' THEN
      v_wallet_pages := v_wallet_pages + 1;
      v_touched := v_touched || coalesce((SELECT array_agg(e->'node'->>'id') FROM jsonb_array_elements(v_edges) e), '{}');
      UPDATE public.pack_wallet_sync
         SET pages = pages + 1, packs = packs + v_returned
       WHERE wallet = r.wallet;
      -- Four outcomes, and only the first two END the sync. A concurrent
      -- collector may already have dispatched this same next page (the cursor
      -- guard below): that is "still in flight", NOT "finished" — stamping
      -- completed_at there is how 6 wallets read "confirmed (700 packs)" while
      -- page 6 was still on the wire (2026-09-19 02:22 UTC, caught before push).
      IF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL)
         AND public.atlas_next_pack_product('sync', r.product) IS NOT NULL THEN
        -- Atlas walks one product at a time: this one is done, start the next at offset 0.
        v_next := public.atlas_pack_dispatch('owner', public.atlas_next_pack_product('sync', r.product), r.wallet, 0, NULL);
        INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page, product)
        VALUES (v_next, '{}', 0, 'wallet', r.wallet, NULL, coalesce(r.page, 1) + 1, public.atlas_next_pack_product('sync', r.product));
      ELSIF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF r.product IS NULL THEN
        -- A walk started on Studio carries a Studio cursor, not an Atlas offset: it cannot be
        -- continued. End it with the reason; the next sweep restarts the wallet on Atlas.
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': a Studio walk cannot continue on Atlas (#218); the next sweep restarts it' WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 300 THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page cap 300 reached (Atlas pages hold 200 packs); holdings beyond it not walked' WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.pack_nft_identity_requests d
                          WHERE d.kind = 'wallet' AND d.wallet = r.wallet
                            AND d.after_cursor = v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor'
                            AND d.dispatched_at > now() - interval '2 hours'
                            -- ... AND IT IS STILL IN FLIGHT. Matching on dispatched_at
                            -- alone let an ALREADY-COLLECTED request from a PREVIOUS cycle
                            -- suppress this cycle's dispatch, and nothing could ever complete
                            -- the sync because the row it waited on was already done.
                            AND d.collected_at IS NULL) THEN
        v_next := public.atlas_pack_dispatch('owner', coalesce(r.product, 'nba'), r.wallet,
                    (v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor')::bigint, NULL);
        INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page, product)
        VALUES (v_next, '{}', 0, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1, coalesce(r.product, 'nba'));
      END IF;  -- else: the next page is already in flight; the sync stays open
    ELSE
      v_touched := v_touched || r.pack_nft_ids;
    END IF;
  END LOOP;

  IF cardinality(v_touched) > 0 THEN
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

    UPDATE public.pack_purchases pp
       SET pack_dist_id = i.dist_id
      FROM public.pack_nft_identity i
     WHERE i.collection_id = pp.collection_id
       AND i.pack_nft_id = pp.pack_nft_id
       AND i.dist_id IS NOT NULL AND i.dist_id <> '0'
       AND pp.pack_dist_id IS NULL
       AND pp.pack_nft_id = ANY (v_touched);
    GET DIAGNOSTICS v_propagated = ROW_COUNT;

    DELETE FROM public.pack_nft_identity_queue q
    USING public.pack_nft_identity i
    WHERE i.collection_id = q.collection_id AND i.pack_nft_id = q.pack_nft_id
      AND q.pack_nft_id = ANY (v_touched);
  END IF;

  PERFORM public.log_pipeline_run(
    'pack-nft-identity', v_started,
    v_requests, v_identities, v_misses,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_challenged', v_challenged, 'requests_expired', v_expired,
                       'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                       'propagated_to_pack_purchases', v_propagated, 'rips_named', v_rips_named,
                       'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages, 'wallets_done', v_wallets_done)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_challenged', v_challenged, 'requests_expired', v_expired,
                            'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                            'propagated', v_propagated, 'rips_named', v_rips_named,
                            'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages,
                            'wallets_done', v_wallets_done, 'last_error', v_last_error);
END;
$function$;

CREATE OR REPLACE FUNCTION public.collect_wallet_pack_pulls()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ts uuid; v_ad uuid; v_gz uuid;
  r record;
  v_body jsonb;
  v_edges jsonb;
  v_n int;
  v_next bigint;
  v_requests int := 0; v_ok int := 0; v_failed int := 0; v_challenged int := 0; v_expired int := 0;
  v_pages int := 0; v_wallets_done int := 0;
  v_pulls_new int := 0; v_api_named int := 0; v_local_named int := 0;
  v_lookups int := 0; v_priced_packs int := 0; v_valued_packs int := 0;
  v_last_error text := NULL;
  v_touched_packs text[] := '{}';
  b record;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('collect_wallet_pack_pulls')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another collector holds the lock');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';
  SELECT id INTO v_gz FROM public.collections WHERE slug = 'laliga_golazos';

  -- (1) Collect every landed request.
  FOR r IN
    -- 2026-11-18 (#218): an Atlas request (q.product set) is translated into the Studio shape
    -- here (searchPackNft for wallet pages, searchAllDayNft for edition lookups), so the parsing
    -- below is unchanged. Anything untranslatable keeps its raw status and fails as before.
    SELECT q.*,
           CASE WHEN q.product IS NOT NULL
                 AND public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.nft_ids) IS NOT NULL
                THEN 200 ELSE h.status_code END AS h_status,
           CASE WHEN q.product IS NULL THEN h.content
                ELSE coalesce(public.atlas_pack_to_studio(q.product, h.status_code, h.content, q.nft_ids)::text, h.content)
           END AS h_content,
           h.error_msg AS h_error,
           (h.id IS NOT NULL) AS landed
    FROM public.pack_pull_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    v_requests := v_requests + 1;

    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '2 hours' THEN
        UPDATE public.pack_pull_requests SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        IF r.kind = 'wallet' THEN
          UPDATE public.pack_pull_wallet_state
             SET completed_at = now(), last_error = 'no_response on page ' || coalesce(r.page, 1)
           WHERE wallet = r.wallet AND completed_at IS NULL;
        END IF;
      END IF;
      CONTINUE;
    END IF;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb')
                   THEN r.h_content::jsonb END;
    v_edges := CASE r.kind
                 WHEN 'wallet' THEN v_body->'data'->'searchPackNft'->'edges'
                 ELSE coalesce(v_body->'data'->'searchAllDayNft'->'edges',
                               v_body->'data'->'searchGolazosNft'->'edges')
               END;

    IF v_body IS NULL OR jsonb_typeof(v_edges) IS DISTINCT FROM 'array' THEN
      -- 2026-11-19: a Cloudflare challenge (403/429, ~5-15 pct of Atlas calls from this egress) is retried
      -- (ids re-queued / the wallet re-synced next time) -- a retry, not a lane failure; the 4xx arm
      -- pages HIGH if no 200 lands for 2 h. Anything else still fails the run.
      IF r.h_status IN (403, 429) THEN v_challenged := v_challenged + 1; ELSE v_failed := v_failed + 1; END IF;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.h_error, r.h_content, 'http ' || r.h_status), 200);
      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = r.h_status,
             outcome = CASE WHEN r.h_status IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.h_status::text, 'null')
                            WHEN v_body ? 'errors' THEN 'graphql_error' ELSE 'undecodable' END
       WHERE request_id = r.request_id;
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      END IF;
      CONTINUE;
    END IF;

    IF r.kind = 'wallet' THEN
      -- 2026-09-29: a BOX yields packs, not moments ("A.<addr>.PackNFT.<id>",
      -- e.g. "2026 NBA Finals Box" -> 8 PackNFTs). Those go to
      -- pack_box_contents; before, each was stored as an unnamed moment and the
      -- box read "0 of 8 priced" for ever (430 Top Shot boxes, 12 wallets).
      -- 2026-10-10 (#188): ... and each NEW inner pack the index does not name yet is queued for
      -- the pack-nft-identity lane. The per-owner sync cannot see one the opener sold or sent on
      -- sealed (1,516 of 3,404 had no identity row), so its dist was never learned.
      WITH box_ins AS (
      INSERT INTO public.pack_box_contents (collection_id, box_pack_nft_id, pack_nft_id, opener_address)
      SELECT DISTINCT
             CASE e->'node'->>'type_name'
               WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
               WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
               WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
             END,
             e->'node'->>'id',
             split_part(t.tok, '.', 4),
             r.wallet
      FROM jsonb_array_elements(v_edges) e
      CROSS JOIN LATERAL regexp_split_to_table(coalesce(e->'node'->>'nfts', ''), '\s*,\s*') AS t(tok)
      WHERE (e->'node'->>'status' = 'Opened'
             -- 2026-10-19: a Top Shot pack Dapper left at 'Revealed' WAS opened (see header)
             OR (e->'node'->>'status' = 'Revealed' AND e->'node'->>'type_name' = 'A.0b2a3299cc857e29.PackNFT.NFT'))
        AND e->'node'->>'id' IS NOT NULL
        AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
        AND t.tok ~ '^A\.[0-9a-f]+\.PackNFT\.[0-9]+$'
        -- 2026-10-19: a Revealed box's nfts can name a pack that was never this wallet's -- the open
        -- stalled because one assigned pack had already been sold to someone else (37 of 37 Revealed
        -- boxes: 45 of 259 listed packs first withdrawn by a third party; 0 of 3,404 on Opened boxes).
        -- Keep it out when a primary withdraw sent it to anyone but this wallet or the PDS contract.
        AND NOT (e->'node'->>'status' = 'Revealed' AND EXISTS (
              SELECT 1 FROM public.pack_purchases pp
               WHERE pp.pack_nft_id = split_part(t.tok, '.', 4)
                 AND pp.collection_id = v_ts
                 AND pp.event_kind = 'primary_withdraw'
                 AND pp.buyer_address NOT IN (r.wallet, '0xb6f2481eba4df97b')))
      ON CONFLICT (collection_id, box_pack_nft_id, pack_nft_id) DO NOTHING
      RETURNING collection_id, pack_nft_id
      )
      INSERT INTO public.pack_nft_identity_queue (collection_id, pack_nft_id, last_seen_at)
      SELECT DISTINCT bi.collection_id, bi.pack_nft_id, now()
      FROM box_ins bi
      WHERE bi.collection_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity pi
                         WHERE pi.collection_id = bi.collection_id AND pi.pack_nft_id = bi.pack_nft_id)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

      -- "A.<addr>.<Contract>.<id>" per pulled moment; the collection is the
      -- PACK's contract (a pack only ever yields its own collection's moments).
      WITH ins AS (
        INSERT INTO public.pack_open_pulls (collection_id, pack_nft_id, nft_id, opener_address)
        SELECT DISTINCT
               CASE e->'node'->>'type_name'
                 WHEN 'A.0b2a3299cc857e29.PackNFT.NFT' THEN v_ts
                 WHEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' THEN v_ad
                 WHEN 'A.87ca73a41bb50ad5.PackNFT.NFT' THEN v_gz
               END,
               e->'node'->>'id',
               split_part(t.tok, '.', 4),
               r.wallet
        FROM jsonb_array_elements(v_edges) e
        CROSS JOIN LATERAL regexp_split_to_table(coalesce(e->'node'->>'nfts', ''), '\s*,\s*') AS t(tok)
        WHERE (e->'node'->>'status' = 'Opened'
             -- 2026-10-19: a Top Shot pack Dapper left at 'Revealed' WAS opened (see header)
             OR (e->'node'->>'status' = 'Revealed' AND e->'node'->>'type_name' = 'A.0b2a3299cc857e29.PackNFT.NFT'))
          AND e->'node'->>'id' IS NOT NULL
          AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
          AND t.tok ~ '^A\.[0-9a-f]+\.[A-Za-z]+\.[0-9]+$'
          AND split_part(t.tok, '.', 3) <> 'PackNFT'
        ON CONFLICT (collection_id, pack_nft_id, nft_id) DO NOTHING
        RETURNING pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}') INTO v_n, v_touched_packs FROM ins;
      v_pulls_new := v_pulls_new + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
      v_pages := v_pages + 1;

      UPDATE public.pack_pull_wallet_state s
         SET pages = s.pages + 1,
             packs = s.packs + jsonb_array_length(v_edges),
             pulls = (SELECT count(*) FROM public.pack_open_pulls p WHERE p.opener_address = r.wallet)
       WHERE s.wallet = r.wallet;

      -- Three outcomes; only the first two END the walk. A next page already
      -- in flight is "still walking", never "done".
      IF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL)
         AND public.atlas_next_pack_product('pulls', r.product) IS NOT NULL THEN
        -- Atlas walks one product at a time: this one is done, start the next at offset 0.
        v_next := public.atlas_pack_dispatch('owner', public.atlas_next_pack_product('pulls', r.product), r.wallet, 0, NULL);
        INSERT INTO public.pack_pull_requests (request_id, kind, wallet, after_cursor, page, product)
        VALUES (v_next, 'wallet', r.wallet, NULL, coalesce(r.page, 1) + 1, public.atlas_next_pack_product('pulls', r.product));
      ELSIF NOT (coalesce((v_body->'data'->'searchPackNft'->'pageInfo'->>'hasNextPage')::boolean, false)
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_pull_wallet_state SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF r.product IS NULL THEN
        -- A walk started on Studio carries a Studio cursor, not an Atlas offset: it cannot be
        -- continued. End it with the reason; the next sweep restarts the wallet on Atlas.
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page ' || coalesce(r.page, 1) || ': a Studio walk cannot continue on Atlas (#218); the next sweep restarts it'
         WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 100 THEN
        UPDATE public.pack_pull_wallet_state
           SET completed_at = now(), last_error = 'page cap 100 reached (Atlas pages hold 200 packs); packs beyond it not walked'
         WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF NOT EXISTS (SELECT 1 FROM public.pack_pull_requests d
                         WHERE d.kind = 'wallet' AND d.wallet = r.wallet
                           AND d.after_cursor = v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor'
                           AND d.collected_at IS NULL) THEN
        v_next := public.atlas_pack_dispatch('owner', coalesce(r.product, 'nfl'), r.wallet,
                    (v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor')::bigint, NULL);
        INSERT INTO public.pack_pull_requests (request_id, kind, wallet, after_cursor, page, product)
        VALUES (v_next, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1, coalesce(r.product, 'nfl'));
      END IF;

    ELSE
      -- edition lookup: node.edition.id is the collection's on-chain edition id,
      -- which is editions.external_id for All Day and Golazos.
      WITH named AS (
        UPDATE public.pack_open_pulls p
           SET edition_id = ed.id, resolved_via = CASE WHEN r.product IS NOT NULL THEN 'atlas_api' ELSE 'studio_api' END, resolved_at = now()
          FROM jsonb_array_elements(v_edges) e
          JOIN public.editions ed
            ON ed.collection_id = r.collection_id
           AND ed.external_id = e->'node'->'edition'->>'id'
         WHERE p.collection_id = r.collection_id
           AND p.nft_id = e->'node'->>'id'
           AND p.edition_id IS NULL
        RETURNING p.pack_nft_id
      )
      SELECT count(*), coalesce(array_agg(DISTINCT pack_nft_id), '{}')
        INTO v_n, v_touched_packs FROM named;
      v_api_named := v_api_named + v_n;

      UPDATE public.pack_pull_requests
         SET collected_at = now(), status_code = 200, outcome = 'ok', n_returned = jsonb_array_length(v_edges)
       WHERE request_id = r.request_id;
      v_ok := v_ok + 1;
    END IF;

    -- packs whose inputs changed this tick are repriced below
    IF cardinality(v_touched_packs) > 0 THEN
      UPDATE public.pack_open_pull_values SET priced_at = '-infinity'
       WHERE pack_nft_id = ANY (v_touched_packs);
      INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
      SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
        FROM public.pack_open_pulls p WHERE p.pack_nft_id = ANY (v_touched_packs)
      ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;
    END IF;
  END LOOP;

  -- (2) Resolve editions from what we already hold. Oldest-checked first, stamped
  -- with clock_timestamp() so an unresolvable row rotates to the back instead of
  -- re-occupying the head every tick. moment ids are unique only WITHIN a
  -- collection, so every probe is collection-scoped.
  WITH cand AS MATERIALIZED (
    SELECT p.collection_id, p.pack_nft_id, p.nft_id
    FROM public.pack_open_pulls p
    WHERE p.edition_id IS NULL
    ORDER BY p.local_checked_at NULLS FIRST
    LIMIT 4000
  ), found AS (
    SELECT c.*, coalesce(m.edition_id, ap.edition_id, gz.id, wm.id,
                         CASE WHEN tx.n_named = 1 THEN tx.edition_id END) AS edition_id,
           CASE WHEN m.edition_id IS NOT NULL THEN 'moments'
                WHEN ap.edition_id IS NOT NULL THEN 'allday_pack_pull'
                WHEN gz.id IS NOT NULL THEN 'golazos_pack_open_pulls'
                WHEN wm.id IS NOT NULL THEN 'wallet_moments_cache'
                WHEN tx.n_named = 1 THEN tx.via END AS via
    FROM cand c
    LEFT JOIN LATERAL (
      SELECT mo.edition_id FROM public.moments mo
       WHERE mo.nft_id = c.nft_id AND mo.collection_id = c.collection_id AND mo.edition_id IS NOT NULL
       LIMIT 1
    ) m ON true
    LEFT JOIN LATERAL (
      SELECT a.edition_id FROM public.allday_pack_pull a
       WHERE c.collection_id = v_ad AND a.pack_nft_id = c.pack_nft_id AND a.moment_nft_id = c.nft_id
         AND a.edition_id IS NOT NULL
       LIMIT 1
    ) ap ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.golazos_pack_open_pulls g
        JOIN public.editions ed ON ed.collection_id = v_gz AND ed.external_id = g.edition_external_id
       WHERE c.collection_id = v_gz AND g.nft_id = c.nft_id
       LIMIT 1
    ) gz ON true
    LEFT JOIN LATERAL (
      SELECT ed.id FROM public.wallet_moments_cache w
        JOIN public.editions ed ON ed.collection_id = w.collection_id AND ed.external_id = w.edition_key
       WHERE w.moment_id = c.nft_id AND w.collection_id = c.collection_id AND w.edition_key IS NOT NULL
       LIMIT 1
    ) wm ON true
    -- 2026-09-26: a Top Shot moment that has LEFT the wallet is in neither
    -- moments nor the wallet cache, and Dapper's Top Shot index answers nothing
    -- -- 31,128 pulls sat unnamed. Four records we already hold name one by its
    -- id: a recorded sale, the on-chain ownership walk, the nft->edition map, and
    -- a Standard Atlas market event (parallels there matched 92 %, Standard
    -- 99.9 %, so parallels are not used). Named only when every source that
    -- answers agrees; a conflict stays unnamed. Top Shot only, product 'nba'.
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT o.edition_id) AS n_named,
             min(o.edition_id::text)::uuid AS edition_id,
             string_agg(DISTINCT o.via, '+' ORDER BY o.via) AS via
      FROM (
        SELECT s.edition_id, 'sales'::text AS via FROM public.sales s
         WHERE c.collection_id = v_ts AND s.collection_id = v_ts AND s.nft_id = c.nft_id
           AND s.edition_id IS NOT NULL
        UNION ALL
        SELECT ed.id, 'topshot_ownership' FROM public.topshot_ownership t
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = t.edition_external_id
         WHERE c.collection_id = v_ts AND t.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'nft_edition_map' FROM public.nft_edition_map n
          JOIN public.editions ed ON ed.collection_id = v_ts AND ed.external_id = n.edition_external_id
         WHERE c.collection_id = v_ts AND n.collection_id = v_ts AND n.nft_id = c.nft_id
        UNION ALL
        SELECT ed.id, 'atlas_market_events' FROM public.topshot_atlas_market_events a
          JOIN public.topshot_atlas_edition_map am ON am.atlas_edition_id = a.atlas_edition_id
          JOIN public.editions ed ON ed.id = am.rpc_edition_id AND ed.collection_id = v_ts
         WHERE c.collection_id = v_ts AND a.product = 'nba' AND a.nft_id = c.nft_id
           AND a.parallel = 'Standard' AND am.parallel = 'Standard'
      ) o
    ) tx ON true
  ), upd AS (
    UPDATE public.pack_open_pulls p
       SET edition_id = f.edition_id,
           resolved_via = f.via,
           resolved_at = CASE WHEN f.edition_id IS NOT NULL THEN now() END,
           local_checked_at = clock_timestamp()
      FROM found f
     WHERE p.collection_id = f.collection_id AND p.pack_nft_id = f.pack_nft_id AND p.nft_id = f.nft_id
    RETURNING p.collection_id, p.pack_nft_id, (f.edition_id IS NOT NULL) AS named
  ), bump AS (
    UPDATE public.pack_open_pull_values v SET priced_at = '-infinity'
      FROM (SELECT DISTINCT collection_id, pack_nft_id FROM upd WHERE named) u
     WHERE v.collection_id = u.collection_id AND v.pack_nft_id = u.pack_nft_id
    RETURNING 1
  )
  SELECT count(*) FILTER (WHERE named) INTO v_local_named FROM upd;

  -- (3) Ask Dapper's index for what is still unnamed (All Day, Golazos only --
  -- its Top Shot index returns nothing). 200 ids a request, 5 requests a tick,
  -- each id at most 5 times, at least 6 h apart.
  FOR b IN
    WITH pend AS (
      SELECT p.collection_id, p.nft_id,
             row_number() OVER (PARTITION BY p.collection_id ORDER BY p.api_checked_at NULLS FIRST, p.nft_id) AS rn
      FROM public.pack_open_pulls p
      WHERE p.edition_id IS NULL
        AND p.collection_id IN (v_ad, v_gz)
        AND p.local_checked_at IS NOT NULL
        AND p.api_attempts < 5
        AND (p.api_checked_at IS NULL OR p.api_checked_at < now() - interval '6 hours')
        AND NOT EXISTS (SELECT 1 FROM public.pack_pull_requests q
                         WHERE q.kind = 'editions' AND q.collected_at IS NULL AND p.nft_id = ANY (q.nft_ids))
    )
    SELECT collection_id, array_agg(DISTINCT nft_id) AS ids
    FROM pend
    WHERE rn <= 1000
    GROUP BY collection_id, (rn - 1) / 200
    ORDER BY collection_id, min(rn)
    LIMIT 5
  LOOP
    -- 2026-11-18 (#218): Atlas NFTService/GetNFTs (id -> edition + serial; verified against
    -- Studio's answer: All Day 5840678 -> edition 2387 both). Studio is HTTP 530.
    v_next := public.atlas_pack_dispatch('nfts', CASE WHEN b.collection_id = v_ad THEN 'nfl' ELSE 'laliga' END, NULL, NULL, b.ids);
    INSERT INTO public.pack_pull_requests (request_id, kind, collection_id, nft_ids, product)
    VALUES (v_next, 'editions', b.collection_id, b.ids, CASE WHEN b.collection_id = v_ad THEN 'nfl' ELSE 'laliga' END);
    UPDATE public.pack_open_pulls
       SET api_attempts = api_attempts + 1, api_checked_at = now()
     WHERE collection_id = b.collection_id AND nft_id = ANY (b.ids) AND edition_id IS NULL;
    v_lookups := v_lookups + 1;
  END LOOP;

  -- (4) (Re)price: packs whose inputs changed (priced_at = -infinity), then the
  -- stalest older than 24 h so the value tracks current FMV. Whole-pack,
  -- all-or-nothing; fmv_usd must be > 0 to count as priced.
  INSERT INTO public.pack_open_pull_values (collection_id, pack_nft_id, opener_address, n_pulls, n_resolved, n_priced, pull_value_usd, priced_at)
  SELECT DISTINCT ON (p.collection_id, p.pack_nft_id) p.collection_id, p.pack_nft_id, p.opener_address, 0, 0, 0, NULL, '-infinity'
    FROM public.pack_open_pulls p
   WHERE NOT EXISTS (SELECT 1 FROM public.pack_open_pull_values v
                      WHERE v.collection_id = p.collection_id AND v.pack_nft_id = p.pack_nft_id)
  ON CONFLICT (collection_id, pack_nft_id) DO NOTHING;

  WITH pk AS MATERIALIZED (
    SELECT v.collection_id, v.pack_nft_id
    FROM public.pack_open_pull_values v
    WHERE v.priced_at < now() - interval '24 hours'
    ORDER BY v.priced_at
    LIMIT 1500
  ), agg AS (
    SELECT p.collection_id, p.pack_nft_id,
           count(*)                              AS n_pulls,
           count(p.edition_id)                   AS n_resolved,
           count(f.fmv_usd)                      AS n_priced,
           sum(f.fmv_usd)                        AS total
    FROM pk
    JOIN public.pack_open_pulls p ON p.collection_id = pk.collection_id AND p.pack_nft_id = pk.pack_nft_id
    LEFT JOIN LATERAL (
      SELECT s.fmv_usd FROM public.fmv_snapshots s
       WHERE p.edition_id IS NOT NULL
         AND s.collection_id = p.collection_id AND s.edition_id = p.edition_id
       ORDER BY s.computed_at DESC
       LIMIT 1
    ) f0 ON true
    CROSS JOIN LATERAL (SELECT CASE WHEN f0.fmv_usd > 0 THEN f0.fmv_usd END AS fmv_usd) f
    GROUP BY p.collection_id, p.pack_nft_id
  ), upd AS (
    UPDATE public.pack_open_pull_values v
       SET n_pulls = a.n_pulls, n_resolved = a.n_resolved, n_priced = a.n_priced,
           pull_value_usd = CASE WHEN a.n_priced = a.n_pulls THEN round(a.total, 2) END,
           priced_at = clock_timestamp()
      FROM agg a
     WHERE v.collection_id = a.collection_id AND v.pack_nft_id = a.pack_nft_id
    RETURNING v.pull_value_usd
  )
  SELECT count(*), count(pull_value_usd) INTO v_priced_packs, v_valued_packs FROM upd;

  PERFORM public.log_pipeline_run(
    'wallet-pack-pulls', v_started,
    v_requests, v_pulls_new + v_api_named + v_local_named + v_priced_packs, 0,
    (v_failed = 0), v_last_error,
    NULL, NULL, NULL,
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_challenged', v_challenged, 'requests_expired', v_expired,
                       'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                       'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                       'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                       'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_challenged', v_challenged, 'requests_expired', v_expired,
                            'wallet_pages', v_pages, 'wallets_done', v_wallets_done,
                            'pulls_new', v_pulls_new, 'editions_named_local', v_local_named,
                            'editions_named_api', v_api_named, 'edition_lookups_dispatched', v_lookups,
                            'packs_priced', v_priced_packs, 'packs_valued', v_valued_packs,
                            'last_error', v_last_error);
END;
$function$;

REVOKE ALL ON FUNCTION public.collect_pack_nft_identity() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.collect_wallet_pack_pulls() FROM PUBLIC, anon, authenticated;
