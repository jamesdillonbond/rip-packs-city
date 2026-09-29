-- 2026-09-28 (PT) — every All Day pack a saved wallet sold, opened or holds gets
-- its MINT instant and mint transaction from Dapper's pack index, so a pack the
-- wallet got at a primary drop can be dated (and priced) even when we hold no
-- buy row for it.
--
-- WHY. All Day packs are minted ON PURCHASE: PackNFT.created_at in Dapper's
-- searchPackNft index is the primary sale itself. Checked 2026-09-28 against
-- the 100 oldest All Day primary_mint rows in pack_purchases since 2026-05:
-- created_at.block_time = sealed_at on 100 of 100 (median gap 0 s) and
-- created_at.transaction_hash = tx_hash on 100 of 100. The index carries it for
-- every era (0xbd94cade097e50ac's oldest: 2021-12-10), while our on-chain
-- primary_mint ingest begins 2026-04.
--
-- The wallet pack history prices a pack with no buy row at its drop's retail
-- only when the wallet ACQUIRED it inside the drop's sale window. For a pack
-- the wallet has since SOLD, the only acquisition date it had was "no later
-- than the sale" -- so 72 of 0xbd94...'s sold All Day packs had no cost at
-- all, 61 of them minted inside their drop's window with no marketplace sale
-- by anyone else before the wallet sold them (i.e. bought at the drop).
-- The readers take the mint instant in 20260929062300 / 20260929062400.
--
-- WHAT. A self-contained lane:
--   pack_index_mints          one row per (collection, pack): minted_at +
--                             mint_tx from searchPackNft.created_at, or
--                             found = false when the index does not know the id
--   pack_index_mint_requests  the lane's pg_net requests (<= 1,000 ids each)
--   run_pack_index_mint_lane()  collect landed requests, then (nothing in
--                             flight) dispatch up to 3 x 1,000 All Day pack ids
--                             of saved wallets that have no row yet (sold on
--                             the marketplace, opened, or held per the index);
--                             a not-found id is re-asked after 7 days
-- pg_cron rpc-pack-index-mints-lane at 7-57/10 (off the 0/1/20/21/40/41 ban).
-- All Day only: a Top Shot PackNFT is pre-minted into Dapper's reserve, so its
-- created_at is NOT a purchase (pack_nft_mints covers Top Shot's minted-in case).
--
-- Revert:
--   SELECT cron.unschedule('rpc-pack-index-mints-lane');
--   DROP FUNCTION public.run_pack_index_mint_lane();
--   DROP TABLE public.pack_index_mint_requests, public.pack_index_mints, public.pack_index_mint_state;
--   (revert 20260929062300 / 20260929062400 first -- they read pack_index_mints.)

CREATE TABLE IF NOT EXISTS public.pack_index_mints (
  collection_id uuid NOT NULL,
  pack_nft_id   text NOT NULL,
  found         boolean NOT NULL,
  minted_at     timestamptz,
  mint_tx       text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, pack_nft_id),
  CHECK (found OR (minted_at IS NULL AND mint_tx IS NULL))
);
COMMENT ON TABLE public.pack_index_mints IS
  'A pack NFT''s mint instant + transaction from Dapper searchPackNft.created_at (All Day: the primary sale itself, 100/100 vs on-chain primary_mint 2026-09-28). found = false: the index returned nothing for the id (asked again after 7 days). minted_at can be NULL on a found row when the index carries no created_at. Written by run_pack_index_mint_lane().';

CREATE TABLE IF NOT EXISTS public.pack_index_mint_requests (
  request_id    bigint PRIMARY KEY,
  collection_id uuid NOT NULL,
  ids           jsonb NOT NULL,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  collected_at  timestamptz,
  status_code   int,
  outcome       text,
  n_found       int,
  n_not_found   int
);
CREATE INDEX IF NOT EXISTS idx_pack_index_mint_requests_open
  ON public.pack_index_mint_requests (dispatched_at) WHERE collected_at IS NULL;

-- The candidate scan reads ~47k buffers (9 s cold, measured 2026-09-28 -- the
-- pack_rips opener arm is most of it), so once a scan finds nothing to do the
-- next one waits 6 h instead of running every tick.
CREATE TABLE IF NOT EXISTS public.pack_index_mint_state (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_scan_at  timestamptz,
  last_scan_todo int
);
INSERT INTO public.pack_index_mint_state (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.pack_index_mints         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_index_mint_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_index_mint_state    ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pack_index_mints         FROM anon, authenticated;
REVOKE ALL ON public.pack_index_mint_requests FROM anon, authenticated;
REVOKE ALL ON public.pack_index_mint_state    FROM anon, authenticated;


-- ── run_pack_index_mint_lane ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.run_pack_index_mint_lane()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '110s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_ad constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_ad_type constant text := 'A.e4cf4bdc1751c65d.PackNFT.NFT';
  r record;
  v_body jsonb; v_edges jsonb;
  v_found int; v_missing int; v_req bigint; v_ids jsonb;
  v_collected int := 0; v_rows_found int := 0; v_rows_missing int := 0;
  v_failed int := 0; v_expired int := 0; v_dispatched int := 0; v_ids_dispatched int := 0;
  v_last_error text := NULL;
  v_scanned boolean := false; v_todo int := 0;
  v_state public.pack_index_mint_state%ROWTYPE;
  c_query constant text := 'query($f:[PackNftFilter!]){ searchPackNft(searchInput:{first:1000, filters:$f}){ edges{ node{ id type_name created_at{ block_time transaction_hash } } } } }';
  c_headers constant jsonb := '{"Content-Type":"application/json","Origin":"https://nflallday.com","Referer":"https://nflallday.com/","User-Agent":"RipPacksCity/1.0"}'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_pack_index_mint_lane')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'another run holds the lock');
  END IF;

  -- (1) Collect every landed request.
  FOR r IN
    SELECT q.*, h.status_code AS h_status, h.content AS h_content, h.error_msg AS h_error, (h.id IS NOT NULL) AS landed
    FROM public.pack_index_mint_requests q
    LEFT JOIN net._http_response h ON h.id = q.request_id
    WHERE q.collected_at IS NULL
    ORDER BY q.dispatched_at
  LOOP
    IF NOT r.landed THEN
      IF r.dispatched_at < now() - interval '30 minutes' THEN
        -- nothing written: the ids are still missing, so the next dispatch asks again
        UPDATE public.pack_index_mint_requests SET collected_at = now(), outcome = 'no_response'
         WHERE request_id = r.request_id;
        v_expired := v_expired + 1;
        v_last_error := 'no_response on request ' || r.request_id;
      END IF;
      CONTINUE;
    END IF;

    v_body := CASE WHEN r.h_status = 200 AND pg_input_is_valid(r.h_content, 'jsonb') THEN r.h_content::jsonb END;
    v_edges := v_body->'data'->'searchPackNft'->'edges';
    IF v_body IS NULL OR jsonb_typeof(v_edges) IS DISTINCT FROM 'array' THEN
      v_failed := v_failed + 1;
      v_last_error := 'request ' || r.request_id || ': ' || left(coalesce(v_body->'errors'->0->>'message', r.h_error, 'http ' || coalesce(r.h_status::text, 'null') || ' ' || r.h_content), 200);
      UPDATE public.pack_index_mint_requests
         SET collected_at = now(), status_code = r.h_status,
             outcome = CASE WHEN r.h_status IS DISTINCT FROM 200 THEN 'http_' || coalesce(r.h_status::text, 'null') ELSE 'graphql_error' END
       WHERE request_id = r.request_id;
      CONTINUE;
    END IF;

    -- Only nodes of the requested collection's contract: pack ids are not
    -- unique across contracts. The request filters by type_name too, so a
    -- Top Shot pack sharing an id cannot fill the 1,000 slots.
    WITH asked AS (
      SELECT DISTINCT jsonb_array_elements_text(r.ids) AS pack_nft_id
    ), nodes AS (
      SELECT DISTINCT ON (e->'node'->>'id')
             e->'node'->>'id' AS pack_nft_id,
             CASE WHEN pg_input_is_valid(e->'node'->'created_at'->>'block_time', 'timestamptz')
                  THEN (e->'node'->'created_at'->>'block_time')::timestamptz END AS minted_at,
             NULLIF(e->'node'->'created_at'->>'transaction_hash', '') AS mint_tx
      FROM jsonb_array_elements(v_edges) e
      WHERE e->'node'->>'type_name' = v_ad_type
      ORDER BY e->'node'->>'id'
    ), ins AS (
      INSERT INTO public.pack_index_mints (collection_id, pack_nft_id, found, minted_at, mint_tx, fetched_at)
      SELECT r.collection_id, a.pack_nft_id, (n.pack_nft_id IS NOT NULL),
             n.minted_at, CASE WHEN n.pack_nft_id IS NOT NULL THEN n.mint_tx END, now()
      FROM asked a LEFT JOIN nodes n ON n.pack_nft_id = a.pack_nft_id
      ON CONFLICT (collection_id, pack_nft_id) DO UPDATE
        SET found = EXCLUDED.found, minted_at = EXCLUDED.minted_at,
            mint_tx = EXCLUDED.mint_tx, fetched_at = EXCLUDED.fetched_at
      RETURNING found
    )
    SELECT count(*) FILTER (WHERE found), count(*) FILTER (WHERE NOT found) INTO v_found, v_missing FROM ins;

    v_rows_found := v_rows_found + v_found;
    v_rows_missing := v_rows_missing + v_missing;
    v_collected := v_collected + 1;
    UPDATE public.pack_index_mint_requests
       SET collected_at = now(), status_code = 200, outcome = 'ok', n_found = v_found, n_not_found = v_missing
     WHERE request_id = r.request_id;
  END LOOP;

  -- (2) Nothing in flight: dispatch up to 3 x 1,000 All Day pack ids of saved
  -- wallets that have no row yet (or a not-found row older than 7 days).
  -- A scan that last found nothing to do is not repeated for 6 h.
  SELECT * INTO v_state FROM public.pack_index_mint_state WHERE id = 1;
  IF NOT EXISTS (SELECT 1 FROM public.pack_index_mint_requests WHERE collected_at IS NULL)
     AND NOT (coalesce(v_state.last_scan_todo, 1) = 0 AND v_state.last_scan_at > now() - interval '6 hours') THEN
    v_scanned := true;
    FOR r IN
      WITH w AS (
        SELECT DISTINCT lower(trim(wallet_addr)) AS wallet FROM public.saved_wallets
         WHERE lower(trim(wallet_addr)) ~ '^0x[0-9a-f]{16}$'
      ), cand AS (
        SELECT s.pack_nft_id FROM public.allday_pack_sales_history s JOIN w ON s.storefront_address = w.wallet
         WHERE s.purchased
        UNION
        SELECT pr.pack_nft_id FROM public.pack_rips pr JOIN w ON pr.opener_address = w.wallet
         WHERE pr.collection_id = v_ad
        UNION
        SELECT i.pack_nft_id FROM public.pack_nft_identity i JOIN w ON i.owner_address = w.wallet
         WHERE i.collection_id = v_ad
      ), todo AS (
        SELECT c.pack_nft_id, row_number() OVER (ORDER BY c.pack_nft_id) - 1 AS rn
        FROM cand c
        LEFT JOIN public.pack_index_mints m ON m.collection_id = v_ad AND m.pack_nft_id = c.pack_nft_id
        WHERE c.pack_nft_id ~ '^[0-9]+$'
          AND (m.pack_nft_id IS NULL OR (NOT m.found AND m.fetched_at < now() - interval '7 days'))
        ORDER BY c.pack_nft_id
        LIMIT 3000
      )
      SELECT rn / 1000 AS batch, jsonb_agg(pack_nft_id ORDER BY pack_nft_id) AS ids
      FROM todo GROUP BY rn / 1000 ORDER BY 1
    LOOP
      SELECT net.http_post(
        url := 'https://api.production.studio-platform.dapperlabs.com/graphql',
        body := jsonb_build_object('query', c_query, 'variables', jsonb_build_object('f',
                  jsonb_build_array(jsonb_build_object('id', jsonb_build_object('in', r.ids),
                                                     'type_name', jsonb_build_object('eq', v_ad_type))))),
        headers := c_headers, timeout_milliseconds := 30000
      ) INTO v_req;
      INSERT INTO public.pack_index_mint_requests (request_id, collection_id, ids) VALUES (v_req, v_ad, r.ids);
      v_dispatched := v_dispatched + 1;
      v_ids_dispatched := v_ids_dispatched + jsonb_array_length(r.ids);
    END LOOP;
    v_todo := v_ids_dispatched;
    UPDATE public.pack_index_mint_state SET last_scan_at = now(), last_scan_todo = v_todo WHERE id = 1;
  END IF;

  -- rows_written = rows this run actually wrote (found + not-found); ok only
  -- when no landed request failed and none expired.
  PERFORM public.log_pipeline_run(
    'pack-index-mints', v_started,
    v_collected, v_rows_found + v_rows_missing, 0,
    (v_failed = 0 AND v_expired = 0), v_last_error,
    'nfl_all_day', NULL, NULL,
    jsonb_build_object('collected', v_collected, 'found', v_rows_found, 'not_found', v_rows_missing,
                       'failed', v_failed, 'expired', v_expired,
                       'dispatched', v_dispatched, 'ids_dispatched', v_ids_dispatched,
                       'scanned', v_scanned)
  );

  RETURN jsonb_build_object('ok', v_failed = 0 AND v_expired = 0, 'collected', v_collected,
                            'found', v_rows_found, 'not_found', v_rows_missing,
                            'failed', v_failed, 'expired', v_expired,
                            'dispatched', v_dispatched, 'ids_dispatched', v_ids_dispatched,
                            'last_error', v_last_error);
END;
$function$;

-- Service-side only: pg_cron (postgres).
REVOKE ALL ON FUNCTION public.run_pack_index_mint_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_pack_index_mint_lane() TO postgres, service_role;

SELECT cron.schedule('rpc-pack-index-mints-lane', '7-57/10 * * * *', 'SELECT public.run_pack_index_mint_lane();');
