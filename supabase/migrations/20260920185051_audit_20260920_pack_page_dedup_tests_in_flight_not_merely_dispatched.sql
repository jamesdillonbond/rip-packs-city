-- A page-dedup guard that did not test IN FLIGHT hung the walk it protects.
--
-- collect_pack_nft_identity decides whether to dispatch a wallet's next page with
-- NOT EXISTS (… d.after_cursor = <endCursor> AND d.dispatched_at > now() - '2 hours'),
-- else falls through to "the next page is already in flight; the sync stays open".
-- That arm was added 2026-09-19 to stop PREMATURE COMPLETION (6 wallets read
-- "confirmed (700 packs)" while page 6 was still on the wire) and it fixes that.
--
-- ⛔ But it matched on dispatched_at ALONE and never on whether the request was
-- still UNCOLLECTED. An already-collected request from a PREVIOUS cycle suppressed
-- the CURRENT cycle's dispatch, and nothing could ever complete that sync, because
-- the row it was waiting on was already done.
--
-- MEASURED 2026-09-20 on 0xd0a99bf6d6c93396: a forced re-sync at 10:25 PT collected
-- page 1 and derived an endCursor identical to the previous cycle's page-2 request
-- dispatched 09:18 PT — inside the 2 h window — so no page 3 was dispatched and
-- completed_at stayed NULL with uncollected_requests = 0, 83 min in flight.
--
-- ⭐ It RECURS rather than being a one-off: the cursor is STABLE across cycles while
-- holdings are stable (ce68d6d1 for days on this wallet), so any multi-page wallet
-- re-synced inside 2 h can collide with its own previous chain.
--
-- The fix adds AND d.collected_at IS NULL. It still suppresses a genuinely in-flight
-- page — the case the 09-19 arm exists for — and stops suppressing on an already
-- collected one, which can never complete the sync anyway. So it does NOT re-open
-- the premature-completion hole.
--
-- ⚠ Severity was LOW and this is not a data fix: the hang self-heals (the sweep
-- re-requests at completed_at IS NULL AND requested_at < now() - 2h) and corrupts
-- nothing, because pack_wallet_sync.last_clean_sync_at survives the re-dispatch, so
-- get_wallet_pack_history keeps using the last clean walk (no_floor = 0 and
-- check_wallet_pack_sync_floor_drift() = [] throughout). It cost a wasted cycle and
-- up to ~2 h extra staleness per occurrence.
--
-- ⭐ BASE VERIFIED, and the earlier claim that no committed copy matched was WRONG:
-- pg_get_functiondef REFORMATS THE HEADER, so comparing it to the whole migration
-- file showed a 4–5 char diff and read as drift. `prosrc` is stored VERBATIM — the
-- body of 20260919053000_*.sql is byte-identical to live prosrc (15,432 chars,
-- md5 d951ad91e2a1829d2b7bacefbb0c6dd0), which is the comparison that matters.
-- Compare prosrc to the migration's BODY, never functiondef to the file.
--
-- REVERT: re-apply the collect_pack_nft_identity body from
-- supabase/migrations/20260919053000_audit_20260918_wallet_pack_sync_one_request_per_wallet_and_hourly_freshness.sql
-- (unchanged apart from this one predicate).

-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of collect_pack_nft_identity (service_role only; unchanged by this migration, re-verified after apply).
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
  v_failed int := 0;
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
    SELECT q.request_id, q.pack_nft_ids, q.dispatched_at, q.kind, q.wallet, q.page,
           h.status_code, h.content, h.error_msg,
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
      v_failed := v_failed + 1;
      v_last_error := left(coalesce(v_body->'errors'->0->>'message', r.error_msg, r.content, ''), 200);
      IF r.kind = 'wallet' THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page ' || r.page || ': ' || v_last_error
         WHERE wallet = r.wallet AND completed_at IS NULL;
      ELSE
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

    v_edges := v_body->'data'->'searchPackNft'->'edges';

    -- Identity rows. For an 'ids' request only the ids we asked for; for a
    -- 'wallet' page every node. Collection from type_name; unknown types skipped.
    INSERT INTO public.pack_nft_identity
      (collection_id, pack_nft_id, dist_id, status, owner_address, type_name,
       dist_title, dist_tier, dist_image_url, acquired_at, request_id, checked_at)
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
      r.request_id, now()
    FROM jsonb_array_elements(v_edges) e
    WHERE e->'node'->>'id' IS NOT NULL
      AND e->'node'->>'type_name' IN ('A.0b2a3299cc857e29.PackNFT.NFT', 'A.e4cf4bdc1751c65d.PackNFT.NFT', 'A.87ca73a41bb50ad5.PackNFT.NFT')
      AND (r.kind = 'wallet' OR e->'node'->>'id' = ANY (r.pack_nft_ids))
    ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
      SET dist_id = coalesce(EXCLUDED.dist_id, public.pack_nft_identity.dist_id),
          status = EXCLUDED.status,
          owner_address = EXCLUDED.owner_address,
          type_name = EXCLUDED.type_name,
          dist_title = coalesce(EXCLUDED.dist_title, public.pack_nft_identity.dist_title),
          dist_tier = coalesce(EXCLUDED.dist_tier, public.pack_nft_identity.dist_tier),
          dist_image_url = coalesce(EXCLUDED.dist_image_url, public.pack_nft_identity.dist_image_url),
          acquired_at = coalesce(EXCLUDED.acquired_at, public.pack_nft_identity.acquired_at),
          request_id = EXCLUDED.request_id,
          checked_at = EXCLUDED.checked_at;
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
              AND v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor' IS NOT NULL) THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = NULL WHERE wallet = r.wallet;
        v_wallets_done := v_wallets_done + 1;
      ELSIF coalesce(r.page, 1) >= 60 THEN
        UPDATE public.pack_wallet_sync SET completed_at = now(), last_error = 'page cap 60 reached; holdings beyond 6,000 packs not walked' WHERE wallet = r.wallet;
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
        SELECT net.http_post(
          url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
          body := jsonb_build_object(
            'query', 'query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ id dist_id status owner_address type_name distribution{ id title tier image_urls } ownershipHistory{ flowAddress nftAcquiredAt } } } } }',
            'variables', jsonb_build_object('i', jsonb_build_object(
              'first', 1000,
              'after', v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor',
              'filters', jsonb_build_array(jsonb_build_object('owner_address', jsonb_build_object('eq', substr(r.wallet, 3))))
            ))
          ),
          headers := '{"Content-Type":"application/json","Origin":"https://nbatopshot.com","Referer":"https://nbatopshot.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb,
          timeout_milliseconds := 20000
        ) INTO v_next;
        INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page)
        VALUES (v_next, '{}', 0, 'wallet', r.wallet, v_body->'data'->'searchPackNft'->'pageInfo'->>'endCursor', coalesce(r.page, 1) + 1);
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
    jsonb_build_object('requests_ok', v_ok, 'requests_failed', v_failed, 'requests_expired', v_expired,
                       'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                       'propagated_to_pack_purchases', v_propagated, 'rips_named', v_rips_named,
                       'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages, 'wallets_done', v_wallets_done)
  );

  RETURN jsonb_build_object('ok', v_failed = 0, 'requests', v_requests, 'requests_ok', v_ok,
                            'requests_failed', v_failed, 'requests_expired', v_expired,
                            'identities', v_identities, 'not_found', v_misses, 'requeued', v_requeued,
                            'propagated', v_propagated, 'rips_named', v_rips_named,
                            'dists_seeded', v_dists_seeded, 'wallet_pages', v_wallet_pages,
                            'wallets_done', v_wallets_done, 'last_error', v_last_error);
END;
$function$;
