-- 2026-10-03 (PT) — Flowty-venue sales of the mainnet24 era (2023-11-08 .. 2024-09-04): verified
-- per TRANSACTION, promoted as sales source 'flowty_chain_tx_v1'.
--
-- WHY. The block-range walk (flowty_chain_listing_completed) is the verifier for mainnet25..27,
-- but mainnet24's history node answers /v1/events in ~60 s (0.4 windows/s with two jobs: ~57 h for
-- its 82,867 windows), while it answers /v1/transaction_results/{id} in < 0.5 s (measured
-- 2026-10-03). So for that era every index row is checked against ITS OWN transaction
-- (.github/workflows/flowty-tx-verify.yml, scripts/flowty-export/chain_verify_tx_gha.py): Sealed,
-- no error, and a A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted(purchased=true) event with
-- this listing id and the same nftID, salePrice, buyer, storefrontAddress and vault. The slow
-- range walk keeps running there as a RECALL sample (sales the index never recorded).
--   flowty_index_unverified_page()  — the rows to check, as one jsonb array (PostgREST row cap)
--   ingest_flowty_tx_verdicts()     — writes 'chain_sealed' / 'chain_mismatch', method = 'tx'
--   promote_flowty_tx_verified_sales(from, to) — the promotion of 20261004025556 over those rows
-- sold_at = Flowty's blockTimestamp: on the fully walked span 85,981,135..87,141,134 it equalled
-- the BLOCK's timestamp to the second for 30,395/30,395 sales. block_height is NULL (the result
-- names the block id, not its height; the id is kept in verify_detail).
--
-- Revert: DELETE FROM public.sales WHERE source = 'flowty_chain_tx_v1';
--         DROP FUNCTION flowty_archive.promote_flowty_tx_verified_sales(timestamptz, timestamptz),
--           public.ingest_flowty_tx_verdicts(jsonb), public.flowty_index_unverified_page(text, integer);

CREATE OR REPLACE FUNCTION public.flowty_index_unverified_page(p_after_doc text, p_limit integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'doc_id', s.doc_id, 'tx', s.tx_hash, 'listing', s.listing_resource_id, 'nft_id', s.nft_id,
           'price', s.price, 'buyer', s.buyer, 'seller', s.seller, 'vault', s.payment_vault) ORDER BY s.doc_id), '[]'::jsonb)
    FROM (SELECT i.* FROM flowty_archive.flowty_index_sales i
           WHERE i.doc_id > p_after_doc
             AND i.event_type = 'STOREFRONT_PURCHASED'
             AND i.chain_event = 'A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted'
             AND i.block_ts >= '2023-11-08 16:07:03+00' AND i.block_ts < '2024-09-04 12:02:35+00'
             AND i.verify_status IS NULL
           ORDER BY i.doc_id LIMIT least(greatest(p_limit, 1), 5000)) s
$f$;
REVOKE ALL ON FUNCTION public.flowty_index_unverified_page(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flowty_index_unverified_page(text, integer) TO service_role;

-- p_rows: [{doc_id, ok (bool), detail (object: block_id, status, mismatch fields)}]. Only rows still
-- unverified are written; returns the number written (a replay writes 0).
CREATE OR REPLACE FUNCTION public.ingest_flowty_tx_verdicts(p_rows jsonb)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
  WITH u AS (
    UPDATE flowty_archive.flowty_index_sales i
       SET verify_status = CASE WHEN (r->>'ok')::boolean THEN 'chain_sealed' ELSE 'chain_mismatch' END,
           verified_at = now(),
           verify_detail = COALESCE(r->'detail', '{}'::jsonb) || jsonb_build_object('method', 'tx')
      FROM jsonb_array_elements(p_rows) r
     WHERE i.doc_id = r->>'doc_id' AND i.verify_status IS NULL
    RETURNING 1)
  SELECT count(*)::integer FROM u
$f$;
REVOKE ALL ON FUNCTION public.ingest_flowty_tx_verdicts(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_flowty_tx_verdicts(jsonb) TO service_role;

CREATE OR REPLACE FUNCTION flowty_archive.promote_flowty_tx_verified_sales(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE
  c_ts  constant uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  c_ad  constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  c_gz  constant uuid := '06248cc4-b85f-47cd-af67-1855d14acd75';
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  v jsonb;
BEGIN
  IF p_to <= p_from OR p_to - p_from > interval '7 days'
     OR p_from < '2023-11-08 16:07:03+00' OR p_to > '2024-09-04 12:02:35+00' THEN
    RAISE EXCEPTION 'slice % .. % is empty, wider than 7 days, or outside the mainnet24 era', p_from, p_to;
  END IF;

  -- Index rows whose OWN transaction was re-read on the mainnet24 node and carried this exact
  -- ListingCompleted(purchased=true): verify_status 'chain_sealed' with verify_detail.method = 'tx'
  -- (written only by ingest_flowty_tx_verdicts). Shaped like flowty_chain_listing_completed.
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT i.tx_hash, NULL::bigint AS block_height, i.block_ts, i.nft_id, i.collection_id, i.price,
         i.payment_vault, i.buyer, i.seller,
         i.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AS usd_pegged,
         CASE i.collection_id WHEN c_ts THEN 'ts' WHEN c_ad THEN 'ad' WHEN c_gz THEN 'gz' WHEN c_ufc THEN 'ufc' END AS kind
    FROM flowty_archive.flowty_index_sales i
   WHERE i.block_ts >= p_from AND i.block_ts < p_to
     AND i.event_type = 'STOREFRONT_PURCHASED'
     AND i.verify_status = 'chain_sealed' AND i.verify_detail->>'method' = 'tx'
     AND i.collection_id IN (c_ts, c_ad, c_gz, c_ufc)
     AND i.nft_id ~ '^[0-9]{1,18}$';

  CREATE TEMP TABLE _ufc_map ON COMMIT DROP AS
  SELECT m.a AS set_id, min(n.edition_external_id) AS ext
    FROM public.checkpoint_nft_meta m
    JOIN public.nft_edition_map n ON n.collection_id = c_ufc AND n.nft_id = m.nft_id::text
   WHERE m.c = 'ufc'
   GROUP BY m.a HAVING count(DISTINCT n.edition_external_id) = 1;

  CREATE TEMP TABLE _res ON COMMIT DROP AS
  SELECT k.*,
         (SELECT e.id FROM public.editions e WHERE e.collection_id = k.collection_id AND e.external_id = k.ckpt_ext) AS ckpt_edition,
         (SELECT e.id FROM public.editions e WHERE e.collection_id = k.collection_id AND e.external_id = k.local_ext) AS local_edition
    FROM (
      SELECT c.*,
             CASE c.kind
               WHEN 'ts' THEN m.a || ':' || m.b || CASE WHEN COALESCE(sub.a, 0) > 0 THEN '::' || sub.a ELSE '' END
               WHEN 'ad' THEN m.a::text
               WHEN 'gz' THEN m.a::text
               WHEN 'ufc' THEN (SELECT u.ext FROM _ufc_map u WHERE u.set_id = m.a)
             END AS ckpt_ext,
             m.serial AS ckpt_serial,
             (m.nft_id IS NOT NULL) AS in_ckpt,
             CASE c.kind
               WHEN 'ts' THEN COALESCE(
                 (SELECT r.set_id || ':' || r.play_id || CASE WHEN COALESCE(r.subedition_id, 0) > 0 THEN '::' || r.subedition_id ELSE '' END
                    FROM public.topshot_chain_moment_reads r WHERE r.nft_id = c.nft_id::bigint AND r.subedition_id IS NOT NULL LIMIT 1),
                 (SELECT x.base_external_id || CASE WHEN x.subedition_id > 0 THEN '::' || x.subedition_id ELSE '' END
                    FROM public.topshot_moment_subeditions x WHERE x.nft_id = c.nft_id AND x.subedition_id IS NOT NULL))
               ELSE (SELECT n.edition_external_id FROM public.nft_edition_map n WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id)
             END AS local_ext,
             (SELECT n.serial_number FROM public.nft_edition_map n
               WHERE n.collection_id = c.collection_id AND n.nft_id = c.nft_id AND n.serial_number > 0) AS local_serial
        FROM _cand c
        LEFT JOIN LATERAL (SELECT * FROM public.checkpoint_nft_meta m0
                            WHERE m0.c = c.kind AND m0.nft_id = c.nft_id::bigint
                            ORDER BY m0.spork DESC LIMIT 1) m ON true
        LEFT JOIN public.checkpoint_nft_meta sub ON c.kind = 'ts' AND sub.c = 'tssub' AND sub.nft_id = c.nft_id::bigint AND sub.spork = m.spork
    ) k;

  WITH ok AS (
    SELECT r.*, CASE WHEN r.in_ckpt AND r.kind = 'ts' THEN r.ckpt_edition ELSE COALESCE(r.ckpt_edition, r.local_edition) END AS edition_id,
           COALESCE(NULLIF(r.ckpt_serial, 0), NULLIF(r.local_serial, 0))::int AS serial
      FROM _res r
     WHERE r.usd_pegged AND r.price > 0
       AND CASE WHEN r.in_ckpt AND r.kind = 'ts' THEN r.ckpt_edition ELSE COALESCE(r.ckpt_edition, r.local_edition) END IS NOT NULL
       AND NOT (r.ckpt_ext IS NOT NULL AND r.local_ext IS NOT NULL
                AND split_part(r.ckpt_ext, '::', 1) <> split_part(r.local_ext, '::', 1))
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)
  ), ins AS (
    INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                              seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                              nft_id, collection, source)
    SELECT NULL, o.edition_id, o.collection_id, o.serial, o.price, o.price,
           CASE WHEN o.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
           o.seller, o.buyer, 'flowty', o.tx_hash, o.block_height, o.block_ts, o.nft_id,
           (SELECT slug FROM public.collections WHERE id = o.collection_id), 'flowty_chain_tx_v1'
      FROM ok o
    ON CONFLICT DO NOTHING
    RETURNING collection
  )
  SELECT jsonb_build_object(
    'slice', jsonb_build_array(p_from, p_to), 'source', 'flowty_chain_tx_v1',
    'candidates', (SELECT count(*) FROM _res),
    'not_usd_pegged', (SELECT count(*) FROM _res WHERE NOT usd_pegged),
    'unresolved_edition', (SELECT count(*) FROM _res WHERE usd_pegged AND CASE WHEN in_ckpt AND kind = 'ts' THEN ckpt_edition ELSE COALESCE(ckpt_edition, local_edition) END IS NULL),
    'unresolved_in_ckpt_edition_missing', (SELECT count(*) FROM _res WHERE usd_pegged AND in_ckpt AND kind = 'ts' AND ckpt_edition IS NULL),
    'edition_conflict', (SELECT count(*) FROM _res WHERE ckpt_ext IS NOT NULL AND local_ext IS NOT NULL AND split_part(ckpt_ext, '::', 1) <> split_part(local_ext, '::', 1)),
    'subedition_differs_from_local', (SELECT count(*) FROM _res WHERE ckpt_ext IS NOT NULL AND local_ext IS NOT NULL AND ckpt_ext <> local_ext AND split_part(ckpt_ext, '::', 1) = split_part(local_ext, '::', 1)),
    'resolved_by_checkpoint', (SELECT count(*) FROM _res WHERE in_ckpt AND ckpt_edition IS NOT NULL),
    'resolved_by_local', (SELECT count(*) FROM _res WHERE ckpt_edition IS NULL AND local_edition IS NOT NULL AND NOT (in_ckpt AND kind = 'ts')),
    'already_in_sales', (SELECT count(*) FROM _res r WHERE EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)),
    'eligible', (SELECT count(*) FROM ok),
    'inserted', (SELECT count(*) FROM ins),
    'inserted_by_collection', (SELECT COALESCE(jsonb_object_agg(collection, n), '{}'::jsonb) FROM (SELECT collection, count(*) n FROM ins GROUP BY 1) x)
  ) INTO v;
  RETURN v;
END $f$;

REVOKE ALL ON FUNCTION flowty_archive.promote_flowty_tx_verified_sales(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
