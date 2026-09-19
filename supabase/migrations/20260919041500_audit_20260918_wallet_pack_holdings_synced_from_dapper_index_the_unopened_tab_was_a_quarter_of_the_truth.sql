-- audit_20260918_wallet_pack_holdings_synced_from_dapper_index_the_unopened_tab_was_a_quarter_of_the_truth
--
-- WHAT IS WRONG. The wallet Unopened tab lists packs the wallet BOUGHT in our
-- tables — on-chain from 2026-04, marketplace history where the walker has
-- reached. Asked directly (searchPackNft, owner_address = the wallet, status
-- Sealed), Dapper's index says 0xbd94cade097e50ac holds **375 sealed Top Shot
-- packs and 59 sealed All Day packs**; the tab showed 94. Of the first 100 the
-- index returned, 33 exist in pack_purchases — the rest are Fast Break reward
-- packs, Metallic Gold LE boxes, Archive sets, quest packs, acquired before
-- on-chain coverage began and never resold. Same for Opened: 954 packs over the
-- wallet's life against 503 rips we hold.
--
-- WHAT THIS DOES. A per-wallet holdings sync on the same index, riding the
-- pack-nft-identity lane's request/collect machinery:
--   request_wallet_pack_sync(wallet)  dispatch page 1 of searchPackNft by
--                                      owner_address (all pack types), unless a
--                                      sync completed < 12 h ago or one is in
--                                      flight. The pack-history API route calls
--                                      it fire-and-forget on every view, so a
--                                      wallet is fresh within a tick of being
--                                      looked at.
--   collect_pack_nft_identity v3       a 'wallet' request upserts EVERY node
--                                      returned (id, dist, status, owner,
--                                      acquired_at from ownershipHistory) and
--                                      dispatches the next page from endCursor
--                                      until hasNextPage is false; then marks
--                                      pack_wallet_sync completed.
--   sweep_saved_wallet_pack_syncs()    hourly: re-request the saved wallets
--                                      (27 Flow addresses today) whose last
--                                      completed sync is > 24 h old, 10 per tick.
--   get_wallet_pack_history v6         a pack the index says the wallet HOLDS
--                                      (Sealed) is `held`; one it says the wallet
--                                      OPENED with no rip row is `ripped` with
--                                      pull value NULL — both with has_buy false
--                                      and buy price NULL (never 0), dist_source
--                                      'dapper_index', latest_event_at = the
--                                      index's acquisition time. Sales and rips
--                                      we hold still win, in the same order as
--                                      before. The response carries
--                                      `identity_sync` so the UI can say when
--                                      the holdings were last confirmed.
--   Golazos packs (A.87ca73a41bb50ad5.PackNFT.NFT) are mapped to laliga_golazos
--   so a wallet sync does not drop them on the floor.
--   ⚠ Collect takes a transaction-scoped advisory lock (a cron tick and a manual
--   run overlapped on the first wallet sync and duplicated a page chain), and a
--   next page is dispatched only when no request for that wallet already
--   carries its cursor.
--   ⚠ ownershipHistory comes back as JSON null (not absent) on some nodes; the
--   first wallet page raised "cannot extract elements from a scalar" and took
--   the whole collect tick down with it -- guarded with jsonb_typeof.
--
-- HONESTY. An index-only row has no price, no counterparty and no P&L; every
-- one of those is NULL and tagged by dist_source. A stale identity (owner =
-- wallet, but we hold a later sale) is out-ranked by the sale. A wallet whose
-- sync never completed shows what we have plus `identity_sync.completed_at`
-- NULL — the UI must not call that list complete.
--
-- anon-exec: intentional — CREATE OR REPLACE keeps the ACL of get_wallet_pack_history (service_role only; verified 2026-09-18)
-- anon-exec: NOT intentional for collect_pack_nft_identity — ops writer, ACL re-asserted below.
-- anon-exec: NOT intentional for request_wallet_pack_sync — service_role caller (the API route) + postgres, revoked below.
-- anon-exec: NOT intentional for sweep_saved_wallet_pack_syncs — ops writer, revoked below.
--
-- REVERT: cron.unschedule('rpc-wallet-pack-sync-sweep'); DROP FUNCTION
--   sweep_saved_wallet_pack_syncs(), request_wallet_pack_sync(text, boolean);
--   re-apply the v5 history + v2 collect bodies from 20260919031500;
--   DROP TABLE pack_wallet_sync; the added columns can stay (nullable/defaulted).

ALTER TABLE public.pack_nft_identity ADD COLUMN IF NOT EXISTS acquired_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_pack_nft_identity_owner ON public.pack_nft_identity (owner_address, status);

ALTER TABLE public.pack_nft_identity_requests
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'ids',
  ADD COLUMN IF NOT EXISTS wallet text,
  ADD COLUMN IF NOT EXISTS after_cursor text,
  ADD COLUMN IF NOT EXISTS page integer;

CREATE TABLE IF NOT EXISTS public.pack_wallet_sync (
  wallet        text        PRIMARY KEY,
  requested_at  timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  pages         integer     NOT NULL DEFAULT 0,
  packs         integer     NOT NULL DEFAULT 0,
  last_error    text
);
ALTER TABLE public.pack_wallet_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pack_wallet_sync FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.request_wallet_pack_sync(p_wallet text, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  v_wallet text := lower(coalesce(p_wallet, ''));
  v_sync public.pack_wallet_sync%ROWTYPE;
  v_req bigint;
BEGIN
  IF v_wallet !~ '^0x[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not a Flow address');
  END IF;

  SELECT * INTO v_sync FROM public.pack_wallet_sync WHERE wallet = v_wallet;
  IF FOUND AND NOT p_force THEN
    -- in flight: requested, not completed, and not stale enough to be a lost request
    IF v_sync.completed_at IS NULL AND v_sync.requested_at > now() - interval '2 hours' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'in_progress', 'requested_at', v_sync.requested_at);
    END IF;
    IF v_sync.completed_at IS NOT NULL AND v_sync.completed_at > now() - interval '12 hours' THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'fresh', 'completed_at', v_sync.completed_at);
    END IF;
  END IF;

  INSERT INTO public.pack_wallet_sync (wallet, requested_at, completed_at, pages, packs, last_error)
  VALUES (v_wallet, now(), NULL, 0, 0, NULL)
  ON CONFLICT (wallet) DO UPDATE
    SET requested_at = now(), completed_at = NULL, pages = 0, packs = 0, last_error = NULL;

  SELECT net.http_post(
    url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
    body := jsonb_build_object(
      'query', 'query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ id dist_id status owner_address type_name distribution{ id title tier image_urls } ownershipHistory{ flowAddress nftAcquiredAt } } } } }',
      'variables', jsonb_build_object('i', jsonb_build_object(
        'first', 100,
        'filters', jsonb_build_array(jsonb_build_object('owner_address', jsonb_build_object('eq', substr(v_wallet, 3))))
      ))
    ),
    headers := '{"Content-Type":"application/json","Origin":"https://nbatopshot.com","Referer":"https://nbatopshot.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb,
    timeout_milliseconds := 20000
  ) INTO v_req;

  INSERT INTO public.pack_nft_identity_requests (request_id, pack_nft_ids, n_ids, kind, wallet, after_cursor, page)
  VALUES (v_req, '{}', 0, 'wallet', v_wallet, NULL, 1);

  RETURN jsonb_build_object('ok', true, 'reason', 'dispatched', 'request_id', v_req);
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.request_wallet_pack_sync(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_wallet_pack_sync(text, boolean) TO postgres, service_role;

CREATE OR REPLACE FUNCTION public.sweep_saved_wallet_pack_syncs(p_limit integer DEFAULT 10)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'net', 'pg_temp'
AS $function$
DECLARE
  r record;
  v_requested int := 0;
  v_candidates int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT lower(sw.wallet_addr) AS wallet
    FROM public.saved_wallets sw
    LEFT JOIN public.pack_wallet_sync s ON s.wallet = lower(sw.wallet_addr)
    WHERE sw.wallet_addr ~ '^0x[0-9a-f]{16}$'
      AND (s.wallet IS NULL
           OR (s.completed_at IS NOT NULL AND s.completed_at < now() - interval '24 hours')
           OR (s.completed_at IS NULL AND s.requested_at < now() - interval '2 hours'))
    ORDER BY 1
    LIMIT greatest(1, least(coalesce(p_limit, 10), 50))
  LOOP
    v_candidates := v_candidates + 1;
    IF (public.request_wallet_pack_sync(r.wallet, false)->>'reason') = 'dispatched' THEN
      v_requested := v_requested + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'candidates', v_candidates, 'requested', v_requested,
                            'saved_wallets', (SELECT count(DISTINCT lower(wallet_addr)) FROM public.saved_wallets WHERE wallet_addr ~ '^0x[0-9a-f]{16}$'));
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.sweep_saved_wallet_pack_syncs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_saved_wallet_pack_syncs(integer) TO postgres, service_role;

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
                            AND d.dispatched_at > now() - interval '2 hours') THEN
        SELECT net.http_post(
          url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
          body := jsonb_build_object(
            'query', 'query($i: SearchPackNftsInput!){ searchPackNft(searchInput:$i){ totalCount pageInfo{ endCursor hasNextPage } edges{ node{ id dist_id status owner_address type_name distribution{ id title tier image_urls } ownershipHistory{ flowAddress nftAcquiredAt } } } } }',
            'variables', jsonb_build_object('i', jsonb_build_object(
              'first', 100,
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
  v_sync jsonb;
BEGIN
  IF v_wallet = '' THEN
    RETURN jsonb_build_object('error', 'wallet required');
  END IF;

  SELECT id INTO v_ts FROM public.collections WHERE slug = 'nba_top_shot';
  SELECT id INTO v_ad FROM public.collections WHERE slug = 'nfl_all_day';

  SELECT jsonb_build_object('requested_at', s.requested_at, 'completed_at', s.completed_at,
                            'pages', s.pages, 'packs', s.packs, 'last_error', s.last_error)
    INTO v_sync
    FROM public.pack_wallet_sync s WHERE s.wallet = v_wallet;

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
  -- (3) Dapper's index of what the wallet HOLDS or OPENED (pack_nft_identity,
  --     filled by the pack-nft-identity lane's wallet sync): the packs our
  --     buy/rip tables never saw -- reward packs, boxes and drops from before
  --     on-chain coverage. Ranked below every sale and rip we hold.
  index_holds AS (
    SELECT pack_nft_id, collection_id, coalesce(acquired_at, checked_at) AS at,
           CASE WHEN status = 'Opened' THEN 'idx_open' ELSE 'idx_hold' END AS role
    FROM public.pack_nft_identity
    WHERE owner_address = v_wallet AND status IN ('Sealed', 'Opened')
  ),
  events AS (
    SELECT collection_id, pack_nft_id, bought_at AS event_at, 'buy'::text AS role FROM latest_buys
    UNION ALL
    SELECT collection_id, pack_nft_id, sold_at, 'sell' FROM latest_sells
    UNION ALL
    SELECT collection_id, pack_nft_id, sealed_at, 'rip' FROM wallet_rips
    UNION ALL
    SELECT collection_id, pack_nft_id, at, role FROM index_holds
  ),
  dedup AS (
    SELECT collection_id, pack_nft_id,
      MAX(event_at)              AS latest_event_at,
      MIN(event_at)              AS first_event_at,
      bool_or(role = 'buy')      AS has_buy,
      bool_or(role = 'sell')     AS has_sell,
      bool_or(role = 'rip')      AS has_rip,
      bool_or(role = 'idx_hold') AS has_idx_hold,
      bool_or(role = 'idx_open') AS has_idx_open
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
        -- the index alone: opened by this wallet (no rip row of ours) or held
        WHEN has_idx_open                                       THEN 'ripped'
        WHEN has_idx_hold                                       THEN 'held'
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
    ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
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
      ) ORDER BY latest_event_at DESC NULLS LAST, collection_id, pack_nft_id
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
    'identity_sync', v_sync,
    'coverage', jsonb_build_object(
      'onchain', 'pack_purchases: Top Shot + All Day, block-indexed from 2026-04; primary drops carry no price on chain',
      'marketplace', 'topshot_pack_sales_history / allday_pack_sales_history: Dapper marketplace secondary sales (seller = storefront_address), Top Shot from 2023-09, All Day from 2022-12; ingest is bursty and can lag days',
      'identity', 'pack_nft_identity: Dapper searchPackNft index (dist_id, Sealed/Opened, current owner, acquired_at) filled by the pack-nft-identity lane and the per-wallet sync; identity_sync says when this wallet''s holdings were last confirmed (NULL completed_at = not yet, the list is what we hold so far)'
    ),
    'computed_at', now()
  );
END;
$function$;
-- <<< END verbatim get_wallet_pack_history <<<

SELECT cron.schedule('rpc-wallet-pack-sync-sweep', '17 * * * *',
                     $$SELECT public.sweep_saved_wallet_pack_syncs(10);$$);

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-wallet-pack-sync-sweep' AND active) THEN
    RAISE EXCEPTION 'the wallet sync sweep is not scheduled';
  END IF;
  IF (SELECT count(DISTINCT lower(wallet_addr)) FROM public.saved_wallets WHERE wallet_addr ~ '^0x[0-9a-f]{16}$') = 0 THEN
    RAISE EXCEPTION 'no saved Flow wallets -- the sweep would have nothing to do, which contradicts the 2026-09-18 count of 27';
  END IF;
END
$verify$;
