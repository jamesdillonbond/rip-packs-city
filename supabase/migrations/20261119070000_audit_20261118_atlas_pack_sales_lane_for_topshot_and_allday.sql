-- audit_20261118_atlas_pack_sales_lane_for_topshot_and_allday
--
-- 2026-11-18 (PT, ~10:15 PM; Claude Code cloud; Trevor: "Keep going") -- #218.
--
-- WHY. topshot_pack_sales_history / allday_pack_sales_history were filled by the Studio GraphQL
-- head-sweep walkers (backfill-{topshot,allday}-pack-sales, searchPackMarketplaceHistory). Studio's
-- pack index FROZE on 10-29 (Top Shot newest row 10-29 7:50 AM PT; All Day 10-26 9:09 AM PT) and the
-- host has answered HTTP 530 since 11-17 4 PM PT, so three weeks of pack sales are missing and every
-- reader (pack market board, pack_market_sales_stats, wallet pack history/summary) serves 10-29.
--
-- ATLAS HAS THEM. MarketplaceService/SearchMarketplaceTransactions takes `entity` (enum atlas.v1.Entity,
-- PACKNFT = 2), decoded from nflallday.com's embedded protobuf descriptors 11-18 (field 44 of
-- SearchMarketplaceTransactionsRequest). Verified live: with entity ENTITY_PACKNFT every row is
-- A.<contract>.PackNFT.NFT; without it the same call returns moments (control). ⚠ Atlas SILENTLY IGNORES
-- unknown fields, so the collector REFUSES a page holding any non-pack nftType (a dropped filter must
-- not write moments into a pack table).
-- Same records, measured row-for-row: Top Shot pack 213305258574175 / listing 269380351602201 /
-- $13.69 / dist 8907 and All Day pack 251788165311310 / listing 123145305096617 / $2.48 match Studio's
-- rows exactly; Studio's block_time is the LISTING's creation (2-3 s before Atlas listedAt), so
-- block_time := listedAt keeps the column's meaning. Golazos: the same call answers 0 rows (no Golazos
-- pack sales in Atlas), so it is not walked.
--
-- WHAT.
--  (1) Atlas rows are keyed tx_hash = 'atlas:' || uuid (Atlas carries no transaction hash; no DB
--      function or view reads tx_hash -- checked 11-18), and skipped when Studio already holds the same
--      (pack_nft_id, listing_resource_id). block_height / custom_id / nft_status stay NULL (not carried).
--      Only purchased rows (sales) are written.
--  (2) atlas_pack_book's studio_newest_listing_at now excludes 'atlas:' rows -- they are not Studio's
--      index, and counting them would call a frozen Studio current. A partial index per table keeps
--      that max an index probe. Pinned: supabase/tests/atlas_pack_market_tick.sql + drift guard.
--  (3) run_atlas_pack_sales_lane(), every minute: per product (nba, nfl) one HEAD page (offset 0, newest
--      COMPLETED_AT first, 200 rows) and one BACKFILL page walking down by offset until a page reaches
--      backfill_floor (the Studio watermark minus 1 day) or comes back empty. A DESC feed that grows at
--      the top only pushes rows to HIGHER offsets, so the walk re-reads, never skips. Each request is
--      recorded in atlas_ondemand_requests (fn 'pack-sales:<product>:<head|backfill>'), the table the
--      4xx arm joins. Logs pipeline 'atlas-pack-sales-ingest'.
--
-- REVERT:
--   SELECT cron.unschedule('rpc-atlas-pack-sales');
--   DROP FUNCTION public.run_atlas_pack_sales_lane(); DROP FUNCTION public.atlas_pack_sales_ingest(text, integer, text, boolean);
--   DROP TABLE public.atlas_pack_sales_state;
--   atlas_pack_book: re-create from 20261101022135_audit_20261031_atlas_pack_market_book.sql;
--   data: DELETE FROM public.topshot_pack_sales_history WHERE tx_hash LIKE 'atlas:%';
--         DELETE FROM public.allday_pack_sales_history WHERE tx_hash LIKE 'atlas:%';
--   DROP INDEX public.idx_ts_pack_sales_hist_block_time_studio, public.idx_allday_pack_sales_hist_block_time_studio;

CREATE INDEX IF NOT EXISTS idx_ts_pack_sales_hist_block_time_studio
  ON public.topshot_pack_sales_history (block_time) WHERE tx_hash NOT LIKE 'atlas:%';
CREATE INDEX IF NOT EXISTS idx_allday_pack_sales_hist_block_time_studio
  ON public.allday_pack_sales_history (block_time) WHERE tx_hash NOT LIKE 'atlas:%';

CREATE OR REPLACE FUNCTION public.atlas_pack_book(p_product text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH st AS (
    SELECT * FROM public.atlas_pack_market_state WHERE product = p_product
  ), book AS (
    SELECT m.* FROM public.atlas_pack_market m, st
     WHERE m.product = p_product
       AND st.last_complete_pass_started_at IS NOT NULL
       AND m.pass_started_at >= st.last_complete_pass_started_at
  )
  SELECT jsonb_build_object(
    'product', p_product,
    'complete_at', (SELECT last_complete_at FROM st),
    'complete_pass_started_at', (SELECT last_complete_pass_started_at FROM st),
    'dists_in_book', (SELECT count(*) FROM book),
    'atlas_newest_listing_at', (SELECT max(latest_listed_at) FROM book),
    -- Studio's sales mirror stamps each row with the LISTING's creation block, so its max is the
    -- newest listing Studio has indexed — the like-for-like comparison with Atlas's.
    -- 2026-11-18: Atlas-sourced rows ('atlas:' tx_hash, run_atlas_pack_sales_lane) are excluded --
    -- they are not Studio's index, and counting them would call a frozen Studio current.
    'studio_newest_listing_at', CASE p_product
        WHEN 'nba' THEN (SELECT max(block_time) FROM public.topshot_pack_sales_history WHERE tx_hash NOT LIKE 'atlas:%')
        WHEN 'nfl' THEN (SELECT max(block_time) FROM public.allday_pack_sales_history WHERE tx_hash NOT LIKE 'atlas:%') END,
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'dist_id', b.dist_id, 'dist_uuid', b.dist_uuid, 'title', b.title, 'tier', b.tier,
               'image_url', b.image_url, 'pack_type', b.pack_type, 'dist_type', b.dist_type,
               'slots', b.slots, 'retail_usd', b.retail_usd, 'start_time', b.start_time,
               'low_ask_usd', b.low_ask_usd, 'num_listed', b.num_listed,
               'latest_listed_at', b.latest_listed_at, 'observed_at', b.observed_at)
             ORDER BY b.dist_id)
        FROM book b WHERE b.num_listed > 0 AND b.low_ask_usd > 0), '[]'::jsonb)
  )
$function$;

REVOKE ALL ON FUNCTION public.atlas_pack_book(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_pack_book(text) TO service_role;

CREATE TABLE IF NOT EXISTS public.atlas_pack_sales_state (
  product text PRIMARY KEY CHECK (product IN ('nba', 'nfl')),
  backfill_floor timestamptz NOT NULL,      -- walk down until a page's oldest sale is older than this
  backfill_offset integer NOT NULL DEFAULT 0,
  backfill_done boolean NOT NULL DEFAULT false,
  head_req bigint,                           -- in-flight pg_net ids (also in atlas_ondemand_requests)
  head_sent_at timestamptz,
  backfill_req bigint,
  backfill_req_offset integer,
  backfill_sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.atlas_pack_sales_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.atlas_pack_sales_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.atlas_pack_sales_state TO service_role;

INSERT INTO public.atlas_pack_sales_state (product, backfill_floor)
SELECT 'nba', coalesce((SELECT max(block_time) FROM public.topshot_pack_sales_history WHERE tx_hash NOT LIKE 'atlas:%'), now() - interval '30 days') - interval '1 day'
UNION ALL
SELECT 'nfl', coalesce((SELECT max(block_time) FROM public.allday_pack_sales_history WHERE tx_hash NOT LIKE 'atlas:%'), now() - interval '30 days') - interval '1 day'
ON CONFLICT (product) DO NOTHING;

-- One response page -> rows written. Never raises on a bad page; reports it.
CREATE OR REPLACE FUNCTION public.atlas_pack_sales_ingest(p_product text, p_status integer, p_content text, p_timed_out boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $f$
DECLARE
  j jsonb;
  v_type text := CASE p_product WHEN 'nba' THEN 'A.0b2a3299cc857e29.PackNFT.NFT'
                                WHEN 'nfl' THEN 'A.e4cf4bdc1751c65d.PackNFT.NFT' END;
  v_n int; v_bad int; v_sales int; v_ins int := 0; v_min timestamptz;
BEGIN
  IF v_type IS NULL THEN RETURN jsonb_build_object('ok', false, 'kind', 'bad_product'); END IF;
  IF p_status IS DISTINCT FROM 200 OR coalesce(p_timed_out, false) OR NOT pg_input_is_valid(coalesce(p_content, ''), 'jsonb') THEN
    RETURN jsonb_build_object('ok', false, 'kind', CASE WHEN p_status IN (403, 429) THEN 'challenge' ELSE 'http' END,
      'error', 'HTTP ' || coalesce(p_status::text, 'none') || ': ' || left(regexp_replace(coalesce(p_content, ''), '\s+', ' ', 'g'), 80));
  END IF;
  j := p_content::jsonb;
  IF jsonb_typeof(j->'transactions') IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('ok', false, 'kind', 'malformed', 'error', 'no transactions array');
  END IF;
  v_n := jsonb_array_length(j->'transactions');
  SELECT count(*) FILTER (WHERE x->>'nftType' IS DISTINCT FROM v_type),
         count(*) FILTER (WHERE x->>'purchased' = 'true' AND x->>'completedAt' IS NOT NULL),
         min((x->>'completedAt')::timestamptz)
    INTO v_bad, v_sales, v_min
    FROM jsonb_array_elements(j->'transactions') x;
  -- Atlas ignores fields it does not know: a page with ANY non-pack row means the entity filter did
  -- not apply. Write nothing from it.
  IF v_bad > 0 THEN
    RETURN jsonb_build_object('ok', false, 'kind', 'filter_not_applied', 'rows', v_n,
      'error', v_bad || ' of ' || v_n || ' rows are not ' || v_type);
  END IF;

  IF p_product = 'nba' THEN
    WITH src AS (
      SELECT DISTINCT ON (x->>'uuid')
             'atlas:' || (x->>'uuid') AS tx_hash, x->>'nftId' AS pack_nft_id,
             nullif(x->>'listingResourceId', '') AS listing_resource_id,
             round((x->>'priceCents')::numeric / 100, 2) AS sale_price_usd,
             '0x' || lower(nullif(x->>'buyerAddress', '')) AS buyer_address,
             '0x' || lower(nullif(x->>'sellerAddress', '')) AS storefront_address,
             nullif(nullif(x->'distribution'->>'id', ''), '0') AS dist_id,
             coalesce((x->>'listedAt')::timestamptz, (x->>'completedAt')::timestamptz) AS block_time
        FROM jsonb_array_elements(j->'transactions') x
       WHERE x->>'purchased' = 'true' AND x->>'completedAt' IS NOT NULL
         AND x->>'uuid' IS NOT NULL AND x->>'nftId' ~ '^[1-9][0-9]{0,19}$'
         AND x->>'priceCents' ~ '^[0-9]+$'
    ), ins AS (
      INSERT INTO public.topshot_pack_sales_history
             (tx_hash, pack_nft_id, listing_resource_id, sale_price_usd, purchased, buyer_address,
              storefront_address, custom_id, dist_id, nft_status, block_height, block_time)
      SELECT s.tx_hash, s.pack_nft_id, s.listing_resource_id, s.sale_price_usd, true, s.buyer_address,
             s.storefront_address, NULL, s.dist_id, NULL, NULL, s.block_time
        FROM src s
       WHERE NOT EXISTS (SELECT 1 FROM public.topshot_pack_sales_history h
                          WHERE h.pack_nft_id = s.pack_nft_id
                            AND h.listing_resource_id IS NOT DISTINCT FROM s.listing_resource_id)
      ON CONFLICT (tx_hash, pack_nft_id) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_ins FROM ins;
  ELSE
    WITH src AS (
      SELECT DISTINCT ON (x->>'uuid')
             'atlas:' || (x->>'uuid') AS tx_hash, x->>'nftId' AS pack_nft_id,
             nullif(x->>'listingResourceId', '') AS listing_resource_id,
             round((x->>'priceCents')::numeric / 100, 2) AS sale_price_usd,
             '0x' || lower(nullif(x->>'buyerAddress', '')) AS buyer_address,
             '0x' || lower(nullif(x->>'sellerAddress', '')) AS storefront_address,
             nullif(nullif(x->'distribution'->>'id', ''), '0') AS dist_id,
             coalesce((x->>'listedAt')::timestamptz, (x->>'completedAt')::timestamptz) AS block_time
        FROM jsonb_array_elements(j->'transactions') x
       WHERE x->>'purchased' = 'true' AND x->>'completedAt' IS NOT NULL
         AND x->>'uuid' IS NOT NULL AND x->>'nftId' ~ '^[1-9][0-9]{0,19}$'
         AND x->>'priceCents' ~ '^[0-9]+$'
    ), ins AS (
      INSERT INTO public.allday_pack_sales_history
             (tx_hash, pack_nft_id, listing_resource_id, sale_price_usd, purchased, buyer_address,
              storefront_address, custom_id, dist_id, nft_status, block_height, block_time)
      SELECT s.tx_hash, s.pack_nft_id, s.listing_resource_id, s.sale_price_usd, true, s.buyer_address,
             s.storefront_address, NULL, s.dist_id, NULL, NULL, s.block_time
        FROM src s
       WHERE NOT EXISTS (SELECT 1 FROM public.allday_pack_sales_history h
                          WHERE h.pack_nft_id = s.pack_nft_id
                            AND h.listing_resource_id IS NOT DISTINCT FROM s.listing_resource_id)
      ON CONFLICT (tx_hash, pack_nft_id) DO NOTHING
      RETURNING 1)
    SELECT count(*) INTO v_ins FROM ins;
  END IF;

  RETURN jsonb_build_object('ok', true, 'rows', v_n, 'sales', v_sales, 'inserted', v_ins,
                            'min_completed_at', v_min);
END
$f$;

CREATE OR REPLACE FUNCTION public.run_atlas_pack_sales_lane()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'net', 'pg_temp'
SET statement_timeout TO '50s' AS $f$
DECLARE
  v_started timestamptz := clock_timestamp();
  s record; h record; res jsonb;
  v_found int := 0; v_ins int := 0; v_pages_ok int := 0; v_retry int := 0; v_hard int := 0;
  v_expired int := 0; v_sent int := 0; v_err text; v_req bigint;
  v_per jsonb := '{}'::jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('run_atlas_pack_sales_lane')) THEN
    RETURN jsonb_build_object('skipped', 'concurrent');
  END IF;

  FOR s IN SELECT * FROM public.atlas_pack_sales_state ORDER BY product FOR UPDATE LOOP
    -- (1) collect the head page
    IF s.head_req IS NOT NULL THEN
      SELECT status_code, content, timed_out INTO h FROM net._http_response WHERE id = s.head_req;
      IF FOUND THEN
        res := public.atlas_pack_sales_ingest(s.product, h.status_code, h.content, h.timed_out);
        IF (res->>'ok')::boolean THEN
          v_pages_ok := v_pages_ok + 1; v_found := v_found + (res->>'sales')::int; v_ins := v_ins + (res->>'inserted')::int;
        ELSIF res->>'kind' = 'challenge' THEN v_retry := v_retry + 1; v_err := res->>'error';
        ELSE v_hard := v_hard + 1; v_err := s.product || ' head: ' || (res->>'error');
        END IF;
        v_per := v_per || jsonb_build_object(s.product || '_head', res);
        UPDATE public.atlas_pack_sales_state SET head_req = NULL WHERE product = s.product;
        s.head_req := NULL;
      ELSIF s.head_sent_at < now() - interval '5 minutes' THEN
        UPDATE public.atlas_pack_sales_state SET head_req = NULL WHERE product = s.product;
        s.head_req := NULL; v_expired := v_expired + 1;
      END IF;
    END IF;

    -- (2) collect the backfill page; advance only on a page that was READ
    IF s.backfill_req IS NOT NULL THEN
      SELECT status_code, content, timed_out INTO h FROM net._http_response WHERE id = s.backfill_req;
      IF FOUND THEN
        res := public.atlas_pack_sales_ingest(s.product, h.status_code, h.content, h.timed_out);
        IF (res->>'ok')::boolean THEN
          v_pages_ok := v_pages_ok + 1; v_found := v_found + (res->>'sales')::int; v_ins := v_ins + (res->>'inserted')::int;
          UPDATE public.atlas_pack_sales_state SET
                 backfill_offset = s.backfill_req_offset + 200,
                 backfill_done = ((res->>'rows')::int = 0
                                  OR (res->>'min_completed_at')::timestamptz < s.backfill_floor),
                 updated_at = now()
           WHERE product = s.product;
        ELSIF res->>'kind' = 'challenge' THEN v_retry := v_retry + 1; v_err := res->>'error';
        ELSE v_hard := v_hard + 1; v_err := s.product || ' backfill: ' || (res->>'error');
        END IF;
        v_per := v_per || jsonb_build_object(s.product || '_backfill', res || jsonb_build_object('offset', s.backfill_req_offset));
        UPDATE public.atlas_pack_sales_state SET backfill_req = NULL WHERE product = s.product;
        s.backfill_req := NULL;
      ELSIF s.backfill_sent_at < now() - interval '5 minutes' THEN
        UPDATE public.atlas_pack_sales_state SET backfill_req = NULL WHERE product = s.product;
        s.backfill_req := NULL; v_expired := v_expired + 1;
      END IF;
    END IF;

    -- (3) dispatch
    IF s.head_req IS NULL THEN
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', s.product, 'entity', 'ENTITY_PACKNFT', 'completed', true, 'purchased', true,
                                   'sortByOption', 'COMPLETED_AT', 'sortByDirection', 'DESC', 'limit', 200, 'offset', 0),
        headers := public.atlas_market_headers(s.product),
        timeout_milliseconds := 20000);
      INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_req, 'pack-sales:' || s.product || ':head')
      ON CONFLICT (request_id) DO NOTHING;
      UPDATE public.atlas_pack_sales_state SET head_req = v_req, head_sent_at = now() WHERE product = s.product;
      v_sent := v_sent + 1;
    END IF;
    SELECT backfill_done, backfill_offset INTO h FROM public.atlas_pack_sales_state WHERE product = s.product;
    IF s.backfill_req IS NULL AND NOT h.backfill_done THEN
      v_req := net.http_post(
        url := 'https://api.production.atlas.dapperlabs.com/public/atlas.v1.MarketplaceService/SearchMarketplaceTransactions',
        body := jsonb_build_object('product', s.product, 'entity', 'ENTITY_PACKNFT', 'completed', true, 'purchased', true,
                                   'sortByOption', 'COMPLETED_AT', 'sortByDirection', 'DESC', 'limit', 200, 'offset', h.backfill_offset),
        headers := public.atlas_market_headers(s.product),
        timeout_milliseconds := 20000);
      INSERT INTO public.atlas_ondemand_requests (request_id, fn) VALUES (v_req, 'pack-sales:' || s.product || ':backfill')
      ON CONFLICT (request_id) DO NOTHING;
      UPDATE public.atlas_pack_sales_state SET backfill_req = v_req, backfill_req_offset = h.backfill_offset,
             backfill_sent_at = now() WHERE product = s.product;
      v_sent := v_sent + 1;
    END IF;
  END LOOP;

  -- ok = no page this tick came back unreadable or unfiltered (a Cloudflare challenge is retried, not
  -- a lane failure). rows_written = rows INSERTED (dedupe skips are not writes).
  PERFORM public.log_pipeline_run('atlas-pack-sales-ingest', v_started, v_found, v_ins, v_found - v_ins,
    (v_hard = 0), v_err, NULL, NULL, NULL,
    jsonb_build_object('pages_ok', v_pages_ok, 'retry', v_retry, 'hard_fail', v_hard, 'expired', v_expired,
                       'dispatched', v_sent, 'pages', v_per,
                       'state', (SELECT jsonb_agg(jsonb_build_object('product', product, 'offset', backfill_offset,
                                   'done', backfill_done, 'floor', backfill_floor)) FROM public.atlas_pack_sales_state)));
  RETURN jsonb_build_object('pages_ok', v_pages_ok, 'sales', v_found, 'inserted', v_ins, 'retry', v_retry,
                            'hard_fail', v_hard, 'expired', v_expired, 'dispatched', v_sent);
END
$f$;

REVOKE ALL ON FUNCTION public.atlas_pack_sales_ingest(text, integer, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_atlas_pack_sales_lane() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atlas_pack_sales_ingest(text, integer, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.run_atlas_pack_sales_lane() TO service_role;

SELECT cron.schedule('rpc-atlas-pack-sales', '* * * * *', 'SELECT public.run_atlas_pack_sales_lane()');
