-- 2026-10-04. Dapper-contract verification (migration 20261004114808): decide WHICH index rows need a
-- chain read once, in a table, instead of inside every page read.
--
-- Why: flowty_index_dapper_unverified_page re-scanned, on every page, every unverified row already in
-- `sales` (85% of the Top Shot storefront rows) and probed all seven `sales` partitions for each, so a page
-- had to wade through thousands of rows to find 500 survivors. With six shards starting cold, every shard's
-- first page hit the 30 s service_role statement_timeout and the run failed (2026-10-04 ~5:31 AM PT, run
-- 37202057914). The candidate set is now built once by flowty_archive.dapper_tx_candidates_build (chunked,
-- driven by a scratch pg_cron tick), and the page reads that table.
--
-- The build also records the near-duplicate test promote_dapper_tx_verified_sales applies (migration
-- 20261004123055): a sale of the same NFT within 10 minutes from ANY source. `atlas` Top Shot rows carry no
-- transaction hash, so those rows are already in `sales` under another key; reading their transactions
-- would spend node calls on sales that are never promoted. They stay in the table (near_dup = true) and
-- are not paged.
--
-- Revert: re-apply flowty_index_dapper_unverified_page from migration 20261004114808;
--         DROP FUNCTION flowty_archive.dapper_tx_candidates_build(text, integer);
--         DROP TABLE flowty_archive.dapper_tx_candidates;

CREATE TABLE IF NOT EXISTS flowty_archive.dapper_tx_candidates (
  doc_id   text PRIMARY KEY,
  near_dup boolean NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);

-- Scans the next p_n unverified Dapper-contract index rows after p_after (doc_id order, via the partial
-- index of 20261004114808) and records the ones that are candidates. Returns the cursor to resume from;
-- 'done' = true once the scan returns fewer rows than asked for.
CREATE OR REPLACE FUNCTION flowty_archive.dapper_tx_candidates_build(p_after text, p_n integer)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE
  v_last text; v_scanned int; v_added int; v_dup int;
BEGIN
  CREATE TEMP TABLE _scan ON COMMIT DROP AS
  SELECT i.doc_id, i.tx_hash, i.nft_id, i.collection_id, i.block_ts, i.payment_vault
    FROM flowty_archive.flowty_index_sales i
   WHERE i.doc_id > p_after
     AND i.verify_status IS NULL
     AND i.chain_event IN ('A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted', 'A.b8ea91944fd51c43.OffersV2.OfferCompleted')
   ORDER BY i.doc_id LIMIT least(greatest(p_n, 1), 20000);
  SELECT max(doc_id), count(*) INTO v_last, v_scanned FROM _scan;

  WITH c AS (
    SELECT s.doc_id,
           EXISTS (SELECT 1 FROM public.sales x WHERE x.collection_id = s.collection_id AND x.nft_id = s.nft_id
                      AND x.sold_at BETWEEN s.block_ts - interval '10 minutes' AND s.block_ts + interval '10 minutes') AS near_dup
      FROM _scan s
     WHERE s.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$'
       AND s.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'dee28451-5d62-409e-a1ad-a83f763ac070',
                               '06248cc4-b85f-47cd-af67-1855d14acd75', '9b4824a8-736d-4a96-b450-8dcc0c46b023')
       AND s.nft_id ~ '^[0-9]{1,18}$'
       AND NOT EXISTS (SELECT 1 FROM public.sales x WHERE x.transaction_hash = s.tx_hash AND x.nft_id = s.nft_id)
  ), ins AS (
    INSERT INTO flowty_archive.dapper_tx_candidates (doc_id, near_dup)
    SELECT doc_id, near_dup FROM c
    ON CONFLICT (doc_id) DO UPDATE SET near_dup = EXCLUDED.near_dup
    RETURNING near_dup
  )
  SELECT count(*), count(*) FILTER (WHERE near_dup) INTO v_added, v_dup FROM ins;

  RETURN jsonb_build_object('after', p_after, 'last_doc', COALESCE(v_last, p_after), 'scanned', v_scanned,
                            'candidates', v_added, 'near_dup', v_dup, 'done', v_scanned < least(greatest(p_n, 1), 20000));
END $f$;
REVOKE ALL ON FUNCTION flowty_archive.dapper_tx_candidates_build(text, integer) FROM PUBLIC, anon, authenticated;

-- Same contract as 20261004114808 (rows still to read, doc_id order), now from the candidate table.
CREATE OR REPLACE FUNCTION public.flowty_index_dapper_unverified_page(p_after_doc text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'doc_id', s.doc_id, 'tx', s.tx_hash, 'kind', CASE WHEN s.chain_event LIKE '%OffersV2%' THEN 'offer' ELSE 'listing' END,
           'listing', s.listing_resource_id, 'nft_id', s.nft_id, 'nft_type', s.nft_type, 'price', s.price,
           'vault', s.payment_vault, 'ts', s.block_ts) ORDER BY s.doc_id), '[]'::jsonb)
    FROM (SELECT i.* FROM flowty_archive.dapper_tx_candidates c
            JOIN flowty_archive.flowty_index_sales i ON i.doc_id = c.doc_id
           WHERE c.doc_id > p_after_doc AND NOT c.near_dup AND i.verify_status IS NULL
           ORDER BY c.doc_id LIMIT least(greatest(p_limit, 1), 2000)) s
$f$;
REVOKE ALL ON FUNCTION public.flowty_index_dapper_unverified_page(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_index_dapper_unverified_page(text, integer) TO service_role;
