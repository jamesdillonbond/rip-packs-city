-- audit_20260907: the Top Shot sniper's serial-grain feed comes back, from Atlas.
--
-- WHY. `ts_listings` — the sniper route's "primary TS feed source" (app/api/sniper-feed,
-- fetchTopShotPool) — held ONE row, ingested 2026-05-15: its GitHub-Actions writer died
-- with the Flowty/GQL hosts. The Top Shot sniper has been edition-level only (badge_editions
-- low_ask) since. The Atlas firehose (`topshot_atlas_market_events`, 2026-09-06) carries
-- every open Dapper-marketplace listing with nft id, set/play/parallel, serial, price and
-- seller — 611 open nba listings at write time, 611/611 resolvable to an `editions` row
-- through `topshot_atlas_edition_map` (parallels resolve to their `::sub` printing).
--
-- THREE PIECES.
--  1. sync_ts_listings_from_atlas(): rebuilds ts_listings (delete-then-insert, one txn)
--     from open nba listings VERIFIED in the last 24 h (last_seen_at). ⚠ Honesty: a
--     delisting (seller cancels) is NOT in the firehose — Atlas represents it as
--     completed=true/purchased=false on the listing's own history, which we only see by
--     re-reading. Hence:
--  2. atlas_listing_verify_dispatch(p_max): each tick re-reads up to p_max open listings,
--     oldest last_seen_at first, as {product:'nba', nftId} (one Moment's history, small).
--     The existing drain upserts the answer: a cancelled listing flips to completed, a
--     still-open one gets last_seen_at = now(). 3 per 2-min tick ≈ a full pass over ~600
--     listings in ~7 h, so nothing older than ~7 h of verification reaches the sniper on a
--     healthy day, and nothing older than 24 h EVER does (the sync's cut). Sales are
--     flipped by the firehose itself within 2 min. Atlas traffic stays ≈ 4.5 req/min total
--     (firehose ~1, All Day resolver ~2, this 1.5) — under the burst-challenge ceiling.
--     Requests are recorded with offset_at = -3, error '__verify__<nftId>' so the 403 arm
--     attributes them (market lane) and the firehose's one-in-flight check ignores them.
--  3. atlas_market_drain(): one-token guard — the overflow re-page only applies to
--     FIREHOSE pages (offset_at >= 0). A probe/verify response could never satisfy the
--     overflow predicate in practice, but a 200-row nft history with hasMore is now
--     structurally unable to enqueue a bogus '__next_offset__'.
--
-- pg_cron: rpc-ts-listings-atlas-sync (*/2, even minutes — the drain runs odd minutes, so
-- each tick syncs what the previous drain landed, then dispatches the next probes).
-- Pipeline 'ts-listings-atlas-sync'; cadence watchlist 20 / 45 min (same as the feed).
--
-- REVERT: SELECT cron.unschedule('rpc-ts-listings-atlas-sync');
--   DROP FUNCTION public.atlas_listing_verify_tick(int); DROP FUNCTION public.atlas_listing_verify_dispatch(int);
--   DROP FUNCTION public.sync_ts_listings_from_atlas();
--   DELETE FROM public.pipeline_cadence_watchlist WHERE pipeline = 'ts-listings-atlas-sync';
--   atlas_market_drain: re-apply the body from 20260906214103 (the guard is additive; leaving it is harmless).
--   ts_listings rows: TRUNCATE public.ts_listings (the sniper falls back to edition-level deals, as before).

CREATE OR REPLACE FUNCTION public.sync_ts_listings_from_atlas()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_n int; v_unverified int; v_unmapped int;
BEGIN
  -- Open nba listings we could not map to an edition are counted, never guessed at.
  SELECT count(*) INTO v_unmapped
    FROM public.topshot_atlas_market_events ev
    LEFT JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND m.rpc_edition_id IS NULL;
  SELECT count(*) INTO v_unverified
    FROM public.topshot_atlas_market_events ev
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.last_seen_at <= now() - interval '24 hours';

  DELETE FROM public.ts_listings;
  INSERT INTO public.ts_listings (listing_id, flow_id, set_id, play_id, parallel_id, serial_number, circulation_count, price_usd,
                                  seller_address, player_name, set_name, moment_tier, series_number, is_locked, asset_path_prefix,
                                  ingested_at, listed_at)
  -- One row per Moment: a relisted Moment carries its superseded listing as "open" until
  -- the verify probe flips it, so the NEWEST listing per nft wins here (measured 09-07:
  -- 614 open rows over 604 Moments).
  SELECT DISTINCT ON (ev.nft_id) ev.uuid, ev.nft_id, ev.set_id_onchain, ev.play_id_onchain,
         COALESCE(NULLIF(split_part(m.external_id, '::', 2), '')::int, 0),
         ev.serial_number, e.circulation_count, (ev.price_cents::numeric / 100),
         ev.seller_address, COALESCE(e.player_name, e.team_name), e.set_name, COALESCE(ev.tier, e.tier::text), e.series,
         false, NULL, ev.last_seen_at, ev.listed_at
    FROM public.topshot_atlas_market_events ev
    JOIN public.topshot_atlas_edition_map m ON m.atlas_edition_id = ev.atlas_edition_id
    JOIN public.editions e ON e.id = m.rpc_edition_id
   WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed
     AND ev.nft_id IS NOT NULL AND ev.price_cents > 0
     AND ev.last_seen_at > now() - interval '24 hours'
   ORDER BY ev.nft_id, ev.listed_at DESC NULLS LAST
  ON CONFLICT (listing_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_n, 'unverified_24h', v_unverified, 'unmapped', v_unmapped,
                            'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int);
END $$;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_dispatch(p_max int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE r record; v_req bigint; v_n int := 0;
BEGIN
  FOR r IN
    SELECT ev.nft_id, min(ev.last_seen_at) AS seen
      FROM public.topshot_atlas_market_events ev
     WHERE ev.product = 'nba' AND ev.kind = 'listing' AND NOT ev.completed AND ev.nft_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q
                        WHERE q.error = '__verify__' || ev.nft_id AND q.drained_at IS NULL
                          AND q.dispatched_at > now() - interval '10 minutes')
     GROUP BY ev.nft_id
     ORDER BY min(ev.last_seen_at) ASC
     LIMIT GREATEST(p_max, 0)
  LOOP
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', 'nba', 'nftId', r.nft_id, 'limit', 50),
      headers := public.atlas_market_headers('nba'),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at, error)
    VALUES (v_req, 'nba', -3, '__verify__' || r.nft_id);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;

CREATE OR REPLACE FUNCTION public.atlas_listing_verify_tick(p_max int DEFAULT 3)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_started timestamptz := clock_timestamp(); v_sync jsonb; v_disp jsonb; v_err text;
BEGIN
  BEGIN
    v_sync := public.sync_ts_listings_from_atlas();
    v_disp := public.atlas_listing_verify_dispatch(p_max);
  EXCEPTION WHEN OTHERS THEN
    v_err := left(SQLERRM, 300);
  END;
  PERFORM public.log_pipeline_run('ts-listings-atlas-sync', v_started, 1, COALESCE((v_sync->>'rows')::int, 0),
    CASE WHEN v_err IS NULL THEN 0 ELSE 1 END, v_err IS NULL, v_err, 'nba_top_shot', NULL, NULL,
    jsonb_build_object('sync', v_sync, 'verify', v_disp, 'via', 'pg_cron',
                       'duration_ms', (extract(epoch from clock_timestamp() - v_started) * 1000)::int));
  RETURN jsonb_build_object('sync', v_sync, 'verify', v_disp, 'error', v_err);
END $$;

REVOKE ALL ON FUNCTION public.sync_ts_listings_from_atlas() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_listing_verify_dispatch(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.atlas_listing_verify_tick(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_ts_listings_from_atlas() TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_listing_verify_dispatch(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.atlas_listing_verify_tick(int) TO service_role;

-- 3. the drain's overflow re-page applies to firehose pages only
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
                         'open_listings_nba', (SELECT count(*) FROM public.topshot_atlas_market_events WHERE product='nba' AND kind='listing' AND NOT completed),
                         'newest_listed_at', (SELECT max(listed_at) FROM public.topshot_atlas_market_events)));
  END IF;
  RETURN jsonb_build_object('requests', v_reqs, 'rows_seen', v_rows, 'rows_new', v_new, 'errors', v_errs);
END $function$;
-- anon-exec: intentional — same signature as 20260906203504, ACLs preserved (atlas_market_drain)

SELECT cron.schedule('rpc-ts-listings-atlas-sync', '*/2 * * * *', 'SELECT public.atlas_listing_verify_tick(3)');

INSERT INTO public.pipeline_cadence_watchlist (pipeline, severity, is_active, max_silent_minutes, max_minutes_without_success, notes)
VALUES ('ts-listings-atlas-sync', 'medium', true, 20, 45,
  'pg_cron rpc-ts-listings-atlas-sync every 2 min (even minutes): rebuilds ts_listings from open Atlas nba listings verified in the last 24 h, then re-reads 3 listings per tick as {nftId} so cancellations flip. Health is SILENCE; rows follow the market. Added 2026-09-07 (migration audit_20260907 ts_listings from atlas).')
ON CONFLICT (pipeline) DO UPDATE SET severity = EXCLUDED.severity, is_active = true,
  max_silent_minutes = EXCLUDED.max_silent_minutes, max_minutes_without_success = EXCLUDED.max_minutes_without_success, notes = EXCLUDED.notes;
