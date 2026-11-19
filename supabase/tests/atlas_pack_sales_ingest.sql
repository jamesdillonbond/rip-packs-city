-- DB invariant: public.atlas_pack_sales_ingest — one Atlas SearchMarketplaceTransactions page
-- (entity ENTITY_PACKNFT) into topshot/allday_pack_sales_history (2026-11-18, #218).
--   * a page holding ANY non-pack row writes NOTHING (Atlas silently ignores unknown fields, so a
--     dropped `entity` filter returns moments with a 200)
--   * a sale Studio already holds (same pack_nft_id + listing_resource_id) is skipped, not duplicated
--   * rows map: tx_hash 'atlas:'||uuid, price cents/100, 0x-prefixed lower addresses, block_time = listedAt
--   * non-200 / challenge / malformed answers are reported, never raised, never written
-- Function body below is VERBATIM from
-- supabase/migrations/20261119070000_audit_20261118_atlas_pack_sales_lane_for_topshot_and_allday.sql.
BEGIN;
SET LOCAL client_min_messages = warning;

CREATE TABLE public.topshot_pack_sales_history (
  tx_hash text NOT NULL, pack_nft_id text NOT NULL, listing_resource_id text, sale_price_usd numeric,
  purchased boolean, buyer_address text, storefront_address text, custom_id text, dist_id text,
  nft_status text, block_height bigint, block_time timestamptz, ingested_at timestamptz DEFAULT now(),
  PRIMARY KEY (tx_hash, pack_nft_id));
CREATE TABLE public.allday_pack_sales_history (LIKE public.topshot_pack_sales_history INCLUDING ALL);

-- Studio already holds this sale (real tx hash).
INSERT INTO public.topshot_pack_sales_history (tx_hash, pack_nft_id, listing_resource_id, sale_price_usd, purchased, block_time)
VALUES ('e286f76d80a98bcb', '213305258574175', '269380351602201', 13.69, true, '2026-10-29T14:50:30.748Z');

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

DO $$
DECLARE r jsonb;
  page text := '{"transactions":[' ||
    -- duplicate of the Studio row above
    '{"uuid":"252d9e55-bd4b-5de8-8c44-f9ee84bea041","nftId":"213305258574175","listingResourceId":"269380351602201","nftType":"A.0b2a3299cc857e29.PackNFT.NFT","priceCents":"1369","purchased":true,"completed":true,"listedAt":"2026-10-29T14:50:32.919923Z","completedAt":"2026-10-29T14:53:10.047840Z","buyerAddress":"70597013b85e6443","sellerAddress":"2cad71c44ba127a7","distribution":{"id":"8907"}},' ||
    -- a new sale
    '{"uuid":"7545710c-6b15-5b12-98c1-7ded28cd6019","nftId":"32985351629422","listingResourceId":"111","nftType":"A.0b2a3299cc857e29.PackNFT.NFT","priceCents":"4899","purchased":true,"completed":true,"listedAt":"2026-11-19T05:40:00Z","completedAt":"2026-11-19T05:41:35.071291Z","buyerAddress":"AABBCCDDEEFF0011","sellerAddress":"1122334455667788","distribution":{"id":"8919"}},' ||
    -- a cancelled listing (not a sale)
    '{"uuid":"aaaaaaaa-0000-0000-0000-000000000001","nftId":"999","listingResourceId":"222","nftType":"A.0b2a3299cc857e29.PackNFT.NFT","priceCents":"100","purchased":false,"completed":true,"listedAt":"2026-11-18T00:00:00Z","completedAt":"2026-11-18T01:00:00Z","distribution":{"id":"1"}}' ||
    ']}';
BEGIN
  r := public.atlas_pack_sales_ingest('nba', 200, page, false);
  PERFORM _assert((r->>'ok')::boolean, 'a clean pack page reads ok');
  PERFORM _assert_eq(r->>'rows', '3', 'rows seen');
  PERFORM _assert_eq(r->>'sales', '2', 'only purchased rows are sales');
  PERFORM _assert_eq(r->>'inserted', '1', 'the Studio-held sale is skipped, the new one written');
  PERFORM _assert_eq((SELECT count(*) FROM public.topshot_pack_sales_history WHERE pack_nft_id = '213305258574175')::text, '1',
    'no duplicate of a sale Studio already holds');
  PERFORM _assert_eq((SELECT tx_hash || '|' || sale_price_usd || '|' || buyer_address || '|' || storefront_address || '|' || dist_id || '|' || block_time
                        FROM public.topshot_pack_sales_history WHERE pack_nft_id = '32985351629422'),
    'atlas:7545710c-6b15-5b12-98c1-7ded28cd6019|48.99|0xaabbccddeeff0011|0x1122334455667788|8919|2026-11-19 05:40:00+00',
    'row mapping: atlas: key, dollars, 0x-lower addresses, block_time = listedAt');
  PERFORM _assert_eq((SELECT count(*) FROM public.topshot_pack_sales_history WHERE pack_nft_id = '999')::text, '0', 'a non-sale is not written');

  -- re-reading the same page writes nothing more
  r := public.atlas_pack_sales_ingest('nba', 200, page, false);
  PERFORM _assert_eq(r->>'inserted', '0', 're-ingest is idempotent');

  -- a page whose filter was dropped: one moment row poisons the whole page
  r := public.atlas_pack_sales_ingest('nba', 200,
    '{"transactions":[{"uuid":"bbbbbbbb-0000-0000-0000-000000000002","nftId":"51269607","nftType":"A.0b2a3299cc857e29.TopShot.NFT","priceCents":"65","purchased":true,"completedAt":"2026-11-19T05:00:00Z"},' ||
    '{"uuid":"bbbbbbbb-0000-0000-0000-000000000003","nftId":"555","nftType":"A.0b2a3299cc857e29.PackNFT.NFT","priceCents":"500","purchased":true,"completedAt":"2026-11-19T05:00:00Z"}]}', false);
  PERFORM _assert(NOT (r->>'ok')::boolean, 'an unfiltered page is refused');
  PERFORM _assert_eq(r->>'kind', 'filter_not_applied', 'and says why');
  PERFORM _assert_eq((SELECT count(*) FROM public.topshot_pack_sales_history WHERE pack_nft_id IN ('51269607', '555'))::text, '0',
    'nothing from an unfiltered page is written -- not even its pack row');

  -- an All Day pack type on the nba product is also refused (wrong contract)
  r := public.atlas_pack_sales_ingest('nba', 200,
    '{"transactions":[{"uuid":"cccccccc-0000-0000-0000-000000000004","nftId":"777","nftType":"A.e4cf4bdc1751c65d.PackNFT.NFT","priceCents":"500","purchased":true,"completedAt":"2026-11-19T05:00:00Z"}]}', false);
  PERFORM _assert_eq(r->>'kind', 'filter_not_applied', 'another collection''s pack type is refused');

  -- the same rows on nfl land in the All Day table only
  r := public.atlas_pack_sales_ingest('nfl', 200,
    '{"transactions":[{"uuid":"cccccccc-0000-0000-0000-000000000004","nftId":"777","listingResourceId":"333","nftType":"A.e4cf4bdc1751c65d.PackNFT.NFT","priceCents":"248","purchased":true,"listedAt":"2026-10-26T16:09:16Z","completedAt":"2026-10-26T16:43:30Z","buyerAddress":"ab","sellerAddress":"cd","distribution":{"id":"6367"}}]}', false);
  PERFORM _assert_eq(r->>'inserted', '1', 'nfl writes');
  PERFORM _assert_eq((SELECT count(*) FROM public.allday_pack_sales_history)::text, '1', 'into the All Day table');
  PERFORM _assert_eq((SELECT count(*) FROM public.topshot_pack_sales_history WHERE pack_nft_id = '777')::text, '0', 'not the Top Shot table');

  -- failures are reported, never raised, never written
  r := public.atlas_pack_sales_ingest('nba', 403, '<!DOCTYPE html>Just a moment', false);
  PERFORM _assert_eq(r->>'kind', 'challenge', 'a Cloudflare 403 is a retryable challenge');
  r := public.atlas_pack_sales_ingest('nba', 200, '{"pagination":{}}', false);
  PERFORM _assert_eq(r->>'kind', 'malformed', 'a 200 with no transactions array is not "no sales"');
  r := public.atlas_pack_sales_ingest('nba', 200, '{"transactions":[]}', false);
  PERFORM _assert((r->>'ok')::boolean AND r->>'rows' = '0', 'an empty page is ok with 0 rows (ends the backfill)');
  RAISE NOTICE '✓ atlas_pack_sales_ingest';
END $$;

ROLLBACK;
