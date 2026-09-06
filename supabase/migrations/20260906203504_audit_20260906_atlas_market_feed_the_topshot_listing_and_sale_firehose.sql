-- audit_20260906_atlas_market_feed_the_topshot_listing_and_sale_firehose
--
-- THE TOP SHOT FEED, BACK — from the same Dapper backend the badge lane already
-- reads (2026-09-04 audit: `api.production.atlas.dapperlabs.com` answers
-- unauthenticated from Supabase pg_net; Vercel and Cloudflare are WAF-blocked).
--
-- Found 2026-09-06 by watching what nbatopshot.com itself calls (real Chromium,
-- the edition page's Listings/Offers/Activity tabs), then re-probed FROM THIS
-- DATABASE with pg_net so the egress that matters is the one measured:
--
--   MarketplaceService/SearchMarketplaceTransactions {product:'nba'|'nfl', …}
--     · no filter                → the platform-wide firehose, newest `listedAt`
--                                   first: LISTINGS (completed=false),
--                                   SALES (completed+purchased, purchasedAt,
--                                   buyer+seller, marketplaceFeeCents,
--                                   sellerProceedsCents), OFFERS (offerType
--                                   EDITION|PARALLEL|SERIAL, buyerAddress) and
--                                   filled offers (completed, purchased=false).
--                                   200/page, `offset` pages; measured ~6.7
--                                   events/min on nba (200 rows spanned 30 min).
--     · {editionId}              → that edition's OPEN listings, price ascending,
--                                   serial + nftId + seller (= the site's tab).
--     · {editionId, completed}   → its sales history.
--     · {nftId}                  → one NFT's listing + sale history — this is a
--                                   VERIFICATION-BY-LISTING check with no dead host.
--     · {sellerAddress}          → a wallet's listings (0x optional).
--     Unknown keys are IGNORED (no error) — a typo silently returns the firehose.
--   ProfileService/SearchUserProfiles {product:'nba', username} → flowAddress
--     (and `flow_addresses` for the reverse) — the username resolver
--     `resolve-wallet-usernames` lost on 08-28.
--
-- What ships here (DB only; readers follow in code):
--   1. topshot_atlas_market_events — one row per Atlas transaction uuid, both
--      products, upserted so a listing that sells flips in place.
--   2. atlas_market_dispatch() / atlas_market_drain() on pg_cron every 2 min,
--      the same dispatch/drain shape as atlas_editions_* (pg_net is async; a
--      hung request must never hold a cron worker — jobid 55's lesson).
--   3. atlas_resolve_username_{begin,collect} and atlas_verify_listing_{begin,collect}
--      — TWO-PHASE wrappers for the two API routes that need an answer inside
--      a request: `begin` enqueues (pg_net sends only after COMMIT — measured,
--      a same-transaction poll never sees the answer), `collect` polls
--      net._http_response ≤ 8 s in the caller's NEXT transaction. service_role only.
--
-- Revert: cron.unschedule the two jobs; DROP the eight functions + two tables.
-- Nothing else reads them yet.

CREATE TABLE IF NOT EXISTS public.topshot_atlas_market_events (
  uuid                  text PRIMARY KEY,
  product               text NOT NULL,                       -- 'nba' | 'nfl'
  kind                  text NOT NULL,                       -- 'listing' | 'offer'
  offer_type            text,                                -- EDITION | PARALLEL | SERIAL (offers only)
  price_cents           bigint,
  seller_address        text,
  buyer_address         text,
  nft_id                text,
  nft_type              text,
  atlas_edition_id      text,
  serial_number         integer,
  completed             boolean NOT NULL DEFAULT false,
  purchased             boolean NOT NULL DEFAULT false,
  listed_at             timestamptz,
  purchased_at          timestamptz,
  listing_resource_id   text,
  marketplace_fee_cents bigint,
  seller_proceeds_cents bigint,
  tier                  text,
  set_id_onchain        integer,
  play_id_onchain       integer,
  parallel              text,
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tame_open_by_edition ON public.topshot_atlas_market_events (product, atlas_edition_id, price_cents) WHERE kind = 'listing' AND NOT completed;
CREATE INDEX IF NOT EXISTS idx_tame_nft ON public.topshot_atlas_market_events (nft_id);
CREATE INDEX IF NOT EXISTS idx_tame_listed_at ON public.topshot_atlas_market_events (listed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tame_seller ON public.topshot_atlas_market_events (seller_address) WHERE seller_address IS NOT NULL AND seller_address <> '';
CREATE INDEX IF NOT EXISTS idx_tame_sales ON public.topshot_atlas_market_events (product, purchased_at DESC) WHERE purchased;
ALTER TABLE public.topshot_atlas_market_events ENABLE ROW LEVEL SECURITY;
-- Public market facts: anon may read (the sniper and the edition pages will).
DROP POLICY IF EXISTS tame_read ON public.topshot_atlas_market_events;
CREATE POLICY tame_read ON public.topshot_atlas_market_events FOR SELECT USING (true);
REVOKE ALL ON public.topshot_atlas_market_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.topshot_atlas_market_events TO anon, authenticated;

CREATE TABLE IF NOT EXISTS public.topshot_atlas_market_requests (
  request_id     bigint PRIMARY KEY,
  product        text NOT NULL,
  offset_at      integer NOT NULL DEFAULT 0,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  drained_at     timestamptz,
  status_code    integer,
  rows_upserted  integer,
  error          text
);
ALTER TABLE public.topshot_atlas_market_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.topshot_atlas_market_requests FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.atlas_market_headers(p_product text)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'content-type', 'application/json',
    'connect-protocol-version', '1',
    'origin',  CASE WHEN p_product = 'nfl' THEN 'https://nflallday.com' ELSE 'https://nbatopshot.com' END,
    'referer', CASE WHEN p_product = 'nfl' THEN 'https://nflallday.com/' ELSE 'https://nbatopshot.com/' END,
    'user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36')
$$;
REVOKE ALL ON FUNCTION public.atlas_market_headers(text) FROM PUBLIC, anon, authenticated;

-- ── dispatch ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atlas_market_dispatch()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_req bigint; v_n int := 0; p text; v_offset int;
BEGIN
  FOREACH p IN ARRAY ARRAY['nba','nfl'] LOOP
    -- One in flight per product. A request older than 10 min with no response is abandoned by the drain.
    IF EXISTS (SELECT 1 FROM public.topshot_atlas_market_requests q WHERE q.product = p AND q.drained_at IS NULL AND q.dispatched_at > now() - interval '10 minutes') THEN
      CONTINUE;
    END IF;
    -- Overflow paging: the previous drain sets offset_at on a marker row when a full page was all-new.
    SELECT COALESCE((SELECT q.offset_at FROM public.topshot_atlas_market_requests q WHERE q.product = p AND q.error = '__next_offset__' ORDER BY q.dispatched_at DESC LIMIT 1), 0) INTO v_offset;
    DELETE FROM public.topshot_atlas_market_requests WHERE product = p AND error = '__next_offset__';
    v_req := net.http_post(
      url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
      body := jsonb_build_object('product', p, 'limit', 200, 'offset', v_offset),
      headers := public.atlas_market_headers(p),
      timeout_milliseconds := 20000);
    INSERT INTO public.topshot_atlas_market_requests (request_id, product, offset_at) VALUES (v_req, p, v_offset);
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('dispatched', v_n);
END $$;
REVOKE ALL ON FUNCTION public.atlas_market_dispatch() FROM PUBLIC, anon, authenticated;

-- ── drain ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.atlas_market_upsert_events(p_product text, p_txs jsonb)
RETURNS TABLE (upserted int, new_rows int, listings int, sales int, offers int) LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  RETURN QUERY
  WITH src AS (
    SELECT t,
           t->>'uuid' AS uuid,
           CASE WHEN t ? 'offerType' THEN 'offer' ELSE 'listing' END AS kind,
           NULLIF(t->>'offerType','') AS offer_type,
           NULLIF(t->>'priceCents','')::bigint AS price_cents,
           NULLIF(t->>'sellerAddress','') AS seller_address,
           NULLIF(t->>'buyerAddress','') AS buyer_address,
           NULLIF(t->>'nftId','') AS nft_id,
           NULLIF(t->>'nftType','') AS nft_type,
           NULLIF(t->>'editionId','') AS atlas_edition_id,
           NULLIF(t->>'serialNumber','')::int AS serial_number,
           COALESCE((t->>'completed')::boolean, false) AS completed,
           COALESCE((t->>'purchased')::boolean, false) AS purchased,
           NULLIF(t->>'listedAt','')::timestamptz AS listed_at,
           COALESCE(NULLIF(t->>'purchasedAt',''), NULLIF(t->>'completedAt',''))::timestamptz AS purchased_at,
           NULLIF(t->>'listingResourceId','') AS listing_resource_id,
           NULLIF(t->>'marketplaceFeeCents','')::bigint AS marketplace_fee_cents,
           NULLIF(t->>'sellerProceedsCents','')::bigint AS seller_proceeds_cents,
           NULLIF(t->'edition'->>'tier','') AS tier,
           NULLIF(t->'edition'->>'setId','')::int AS set_id_onchain,
           NULLIF(t->'edition'->>'editionTemplateId','')::int AS play_id_onchain,
           NULLIF(t->'edition'->>'parallel','') AS parallel
      FROM jsonb_array_elements(p_txs) AS x(t)
     WHERE t->>'uuid' IS NOT NULL
  ),
  up AS (
    INSERT INTO public.topshot_atlas_market_events AS e
      (uuid, product, kind, offer_type, price_cents, seller_address, buyer_address, nft_id, nft_type, atlas_edition_id,
       serial_number, completed, purchased, listed_at, purchased_at, listing_resource_id, marketplace_fee_cents,
       seller_proceeds_cents, tier, set_id_onchain, play_id_onchain, parallel)
    SELECT s.uuid, p_product, s.kind, s.offer_type, s.price_cents, s.seller_address, s.buyer_address, s.nft_id, s.nft_type,
           s.atlas_edition_id, s.serial_number, s.completed, s.purchased, s.listed_at, s.purchased_at, s.listing_resource_id,
           s.marketplace_fee_cents, s.seller_proceeds_cents, s.tier, s.set_id_onchain, s.play_id_onchain, s.parallel
      FROM src s
    ON CONFLICT (uuid) DO UPDATE SET
      completed = EXCLUDED.completed OR e.completed,
      purchased = EXCLUDED.purchased OR e.purchased,
      purchased_at = COALESCE(EXCLUDED.purchased_at, e.purchased_at),
      buyer_address = COALESCE(EXCLUDED.buyer_address, e.buyer_address),
      price_cents = COALESCE(EXCLUDED.price_cents, e.price_cents),
      marketplace_fee_cents = COALESCE(EXCLUDED.marketplace_fee_cents, e.marketplace_fee_cents),
      seller_proceeds_cents = COALESCE(EXCLUDED.seller_proceeds_cents, e.seller_proceeds_cents),
      last_seen_at = now()
    RETURNING (xmax = 0) AS inserted, e.kind, e.purchased
  )
  SELECT count(*)::int, count(*) FILTER (WHERE inserted)::int,
         count(*) FILTER (WHERE kind = 'listing' AND NOT purchased)::int,
         count(*) FILTER (WHERE purchased)::int,
         count(*) FILTER (WHERE kind = 'offer')::int
    FROM up;
END $$;
REVOKE ALL ON FUNCTION public.atlas_market_upsert_events(text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.atlas_market_drain()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
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
      -- between them were missed — page once more next tick from offset+page.
      SELECT min(NULLIF(t->>'listedAt','')::timestamptz) INTO v_oldest FROM jsonb_array_elements(v_body->'transactions') AS x(t);
      IF v_more AND v_page >= 200 AND v_prev_max IS NOT NULL AND v_oldest > v_prev_max AND q.offset_at < 1000 THEN
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
END $$;
REVOKE ALL ON FUNCTION public.atlas_market_drain() FROM PUBLIC, anon, authenticated;

-- ── two-phase helpers for the API routes (service_role only) ────────────────
-- ⚠ pg_net SENDS ONLY AFTER THE ENQUEUING TRANSACTION COMMITS (measured 09-06:
-- a request posted and polled inside one transaction is never seen in
-- net._http_response, and rolls back with it). So a "synchronous" post+await
-- function is structurally impossible; every caller does TWO rpc() calls —
-- `*_begin` (returns the request id; PostgREST commits) then `*_collect`
-- (a fresh transaction, READ COMMITTED, so its poll loop sees the worker's row).
CREATE OR REPLACE FUNCTION public.atlas_await_response(p_request_id bigint, p_max_ms int DEFAULT 8000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_deadline timestamptz := clock_timestamp() + make_interval(secs => LEAST(GREATEST(p_max_ms, 250), 20000) / 1000.0); r record;
BEGIN
  LOOP
    SELECT status_code, content, error_msg, timed_out INTO r FROM net._http_response WHERE id = p_request_id;
    IF FOUND THEN
      IF r.status_code = 200 AND NOT COALESCE(r.timed_out, false) THEN
        RETURN jsonb_build_object('ok', true, 'body', r.content::jsonb);
      END IF;
      RETURN jsonb_build_object('ok', false, 'status', r.status_code, 'error', COALESCE(r.error_msg, left(r.content, 200)));
    END IF;
    IF clock_timestamp() > v_deadline THEN
      RETURN jsonb_build_object('ok', false, 'status', NULL, 'error', 'atlas_timeout');
    END IF;
    PERFORM pg_sleep(0.25);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.atlas_await_response(bigint, int) FROM PUBLIC, anon, authenticated;

-- username -> flow address (and profile facts). Phase 1: enqueue. Returns the pg_net request id.
CREATE OR REPLACE FUNCTION public.atlas_resolve_username_begin(p_username text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF p_username IS NULL OR length(trim(p_username)) = 0 OR length(p_username) > 64 THEN
    RAISE EXCEPTION 'bad_username' USING ERRCODE = '22023';
  END IF;
  RETURN net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.ProfileService/SearchUserProfiles',
    body := jsonb_build_object('product', 'nba', 'username', trim(p_username)),
    headers := public.atlas_market_headers('nba'), timeout_milliseconds := 8000);
END $$;
REVOKE ALL ON FUNCTION public.atlas_resolve_username_begin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_resolve_username_begin(text) TO service_role;

-- Phase 2: collect. found=false with ok=true is a real "no such user"; ok=false is a FAILED READ — say so, never "not found".
CREATE OR REPLACE FUNCTION public.atlas_resolve_username_collect(p_request_id bigint, p_max_ms int DEFAULT 8000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_res jsonb; v_prof jsonb;
BEGIN
  v_res := public.atlas_await_response(p_request_id, p_max_ms);
  IF NOT (v_res->>'ok')::boolean THEN RETURN v_res; END IF;
  v_prof := v_res->'body'->'userProfiles'->0;
  RETURN jsonb_build_object('ok', true,
    'found', v_prof IS NOT NULL,
    'flow_address', lower(v_prof->>'flowAddress'),
    'username', v_prof->>'username',
    'profile_image_url', v_prof->>'profileImageUrl',
    'favorite_team_ids', v_prof->'favoriteTeamIds',
    'created_at', v_prof->>'createdAt');
END $$;
REVOKE ALL ON FUNCTION public.atlas_resolve_username_collect(bigint, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_resolve_username_collect(bigint, int) TO service_role;

-- Is THIS nft listed by THIS wallet at THIS price right now? The verification-by-listing check, two-phase.
CREATE OR REPLACE FUNCTION public.atlas_verify_listing_begin(p_nft_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
  IF p_nft_id IS NULL OR p_nft_id !~ '^[0-9]{1,12}$' THEN RAISE EXCEPTION 'bad_nft_id' USING ERRCODE = '22023'; END IF;
  RETURN net.http_post(
    url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
    body := jsonb_build_object('product', 'nba', 'nftId', p_nft_id, 'limit', 20),
    headers := public.atlas_market_headers('nba'), timeout_milliseconds := 8000);
END $$;
REVOKE ALL ON FUNCTION public.atlas_verify_listing_begin(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_verify_listing_begin(text) TO service_role;

CREATE OR REPLACE FUNCTION public.atlas_verify_listing_collect(p_request_id bigint, p_wallet text, p_price_cents bigint, p_max_ms int DEFAULT 8000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
DECLARE v_res jsonb; v_wallet text := lower(regexp_replace(COALESCE(p_wallet,''), '^0x', '')); v_match jsonb; v_open int;
BEGIN
  v_res := public.atlas_await_response(p_request_id, p_max_ms);
  IF NOT (v_res->>'ok')::boolean THEN RETURN v_res; END IF;
  SELECT count(*) INTO v_open FROM jsonb_array_elements(COALESCE(v_res->'body'->'transactions','[]'::jsonb)) t
   WHERE NOT COALESCE((t->>'completed')::boolean,false) AND NOT (t ? 'offerType');
  SELECT t INTO v_match FROM jsonb_array_elements(COALESCE(v_res->'body'->'transactions','[]'::jsonb)) t
   WHERE NOT COALESCE((t->>'completed')::boolean,false) AND NOT (t ? 'offerType')
     AND lower(regexp_replace(COALESCE(t->>'sellerAddress',''), '^0x', '')) = v_wallet
     AND (p_price_cents IS NULL OR (t->>'priceCents')::bigint = p_price_cents)
   ORDER BY (t->>'listedAt') DESC LIMIT 1;
  RETURN jsonb_build_object('ok', true, 'matched', v_match IS NOT NULL, 'open_listings', v_open,
                            'listed_at', v_match->>'listedAt', 'price_cents', (v_match->>'priceCents')::bigint,
                            'serial_number', (v_match->>'serialNumber')::int, 'listing_resource_id', v_match->>'listingResourceId');
END $$;
REVOKE ALL ON FUNCTION public.atlas_verify_listing_collect(bigint, text, bigint, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_verify_listing_collect(bigint, text, bigint, int) TO service_role;

-- ── schedules ───────────────────────────────────────────────────────────────
DO $sched$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-atlas-market-dispatch') THEN
    PERFORM cron.schedule('rpc-atlas-market-dispatch', '*/2 * * * *', $$SELECT public.atlas_market_dispatch();$$);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rpc-atlas-market-drain') THEN
    PERFORM cron.schedule('rpc-atlas-market-drain', '1-59/2 * * * *', $$SELECT public.atlas_market_drain();$$);
  END IF;
END $sched$;

-- ── positive controls ───────────────────────────────────────────────────────
-- NOT in this transaction (pg_net cannot answer before it commits). Run after apply:
--   select public.atlas_resolve_username_begin('jamesdillonbond');  -- then, in a new call:
--   select public.atlas_resolve_username_collect(<id>, 8000);       -- flow_address = 0xbd94cade097e50ac
--   select public.atlas_market_dispatch(); -- wait ~6 s -- select public.atlas_market_drain();
--   select count(*) from public.topshot_atlas_market_events where product = 'nba';  -- >= 50 after one page
