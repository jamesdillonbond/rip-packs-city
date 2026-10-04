-- 2026-10-04. promote_dapper_tx_verified_sales (migrations 20261004114808 / 20261004123055): promote the
-- Flowverse venue too.
--
-- Dapper's NFTStorefrontV2 carries a third venue's sales: customID 'flowverse-nft-marketplace' (Flowverse).
-- 2,863 of the first 31.6k verdicts, ~3,067 USD-pegged sealed rows Nov 2023 – Feb 2025 across TS / AD /
-- GZ / UFC. They are verified exactly like the rest (own transaction, parties from the NFT's
-- Withdraw / Deposit; 2,983 / 2,983 equal Flowty's independent buyer + seller fields), and were left out
-- only because the venue was unknown. `sales.marketplace` is free text with no CHECK, and the surfaces
-- render it as-is ("Sale: $X on flowverse"), so the new value needs no consumer change.
--
-- Revert: re-apply the function body of migration 20261004123055;
--         DELETE FROM public.sales WHERE source = 'dapper_chain_tx_v1' AND marketplace = 'flowverse';

-- The edition resolution is promote_flowty_tx_verified_sales' (20261004031134), unchanged: for Top Shot
-- in the checkpoint the checkpoint decides the printing; never topshot_moment_id_editions (#171).
CREATE OR REPLACE FUNCTION flowty_archive.promote_dapper_tx_verified_sales(p_from timestamptz, p_to timestamptz)
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
  IF p_to <= p_from OR p_to - p_from > interval '7 days' OR p_from < '2023-11-08 16:07:03+00' THEN
    RAISE EXCEPTION 'slice % .. % is empty, wider than 7 days, or before the mainnet24 root', p_from, p_to;
  END IF;

  -- Rows whose OWN transaction carried the event, with the parties read from the chain
  -- (verify_detail.buyer / .seller, written only by ingest_dapper_tx_verdicts).
  CREATE TEMP TABLE _cand ON COMMIT DROP AS
  SELECT i.tx_hash, NULL::bigint AS block_height, i.block_ts, i.nft_id, i.collection_id, i.price,
         i.payment_vault, lower(i.verify_detail->>'buyer') AS buyer, lower(i.verify_detail->>'seller') AS seller,
         i.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AS usd_pegged,
         CASE WHEN i.chain_event LIKE '%OffersV2%' THEN 'native'
              WHEN i.verify_detail->>'custom_id' = 'DAPPER_MARKETPLACE' THEN 'native'
              WHEN lower(i.verify_detail->>'custom_id') = 'flowty' THEN 'flowty'
              WHEN i.verify_detail->>'custom_id' = 'flowverse-nft-marketplace' THEN 'flowverse' END AS venue,
         CASE i.collection_id WHEN c_ts THEN 'ts' WHEN c_ad THEN 'ad' WHEN c_gz THEN 'gz' WHEN c_ufc THEN 'ufc' END AS kind
    FROM flowty_archive.flowty_index_sales i
   WHERE i.block_ts >= p_from AND i.block_ts < p_to
     AND i.verify_status = 'chain_sealed' AND i.verify_detail->>'method' = 'tx_dapper'
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
     WHERE r.usd_pegged AND r.price > 0 AND r.venue IS NOT NULL
       AND r.buyer ~ '^0x[0-9a-f]{16}$' AND r.seller ~ '^0x[0-9a-f]{16}$' AND r.buyer <> r.seller
       AND CASE WHEN r.in_ckpt AND r.kind = 'ts' THEN r.ckpt_edition ELSE COALESCE(r.ckpt_edition, r.local_edition) END IS NOT NULL
       AND NOT (r.ckpt_ext IS NOT NULL AND r.local_ext IS NOT NULL
                AND split_part(r.ckpt_ext, '::', 1) <> split_part(r.local_ext, '::', 1))
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.collection_id = r.collection_id AND s.nft_id = r.nft_id
                          AND s.sold_at BETWEEN r.block_ts - interval '10 minutes' AND r.block_ts + interval '10 minutes')
  ), ins AS (
    INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                              seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                              nft_id, collection, source)
    SELECT NULL, o.edition_id, o.collection_id, o.serial, o.price, o.price,
           CASE WHEN o.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
           o.seller, o.buyer,
           CASE WHEN o.venue IN ('flowty', 'flowverse') THEN o.venue
                ELSE CASE o.kind WHEN 'ts' THEN 'topshot' WHEN 'ad' THEN 'nflallday' WHEN 'gz' THEN 'laligagolazos' WHEN 'ufc' THEN 'ufcstrike' END END,
           o.tx_hash, o.block_height, o.block_ts, o.nft_id,
           (SELECT slug FROM public.collections WHERE id = o.collection_id), 'dapper_chain_tx_v1'
      FROM ok o
    ON CONFLICT DO NOTHING
    RETURNING collection
  )
  SELECT jsonb_build_object(
    'slice', jsonb_build_array(p_from, p_to), 'source', 'dapper_chain_tx_v1',
    'candidates', (SELECT count(*) FROM _res),
    'not_usd_pegged', (SELECT count(*) FROM _res WHERE NOT usd_pegged),
    'unknown_venue', (SELECT count(*) FROM _res WHERE venue IS NULL),
    'bad_parties', (SELECT count(*) FROM _res WHERE NOT (COALESCE(buyer ~ '^0x[0-9a-f]{16}$' AND seller ~ '^0x[0-9a-f]{16}$' AND buyer <> seller, false))),
    'unresolved_edition', (SELECT count(*) FROM _res WHERE usd_pegged AND CASE WHEN in_ckpt AND kind = 'ts' THEN ckpt_edition ELSE COALESCE(ckpt_edition, local_edition) END IS NULL),
    'unresolved_in_ckpt_edition_missing', (SELECT count(*) FROM _res WHERE usd_pegged AND in_ckpt AND kind = 'ts' AND ckpt_edition IS NULL),
    'edition_conflict', (SELECT count(*) FROM _res WHERE ckpt_ext IS NOT NULL AND local_ext IS NOT NULL AND split_part(ckpt_ext, '::', 1) <> split_part(local_ext, '::', 1)),
    'resolved_by_checkpoint', (SELECT count(*) FROM _res WHERE in_ckpt AND ckpt_edition IS NOT NULL),
    'resolved_by_local', (SELECT count(*) FROM _res WHERE ckpt_edition IS NULL AND local_edition IS NOT NULL AND NOT (in_ckpt AND kind = 'ts')),
    'already_in_sales', (SELECT count(*) FROM _res r WHERE EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)),
    'near_duplicate', (SELECT count(*) FROM _res r WHERE EXISTS (SELECT 1 FROM public.sales s WHERE s.collection_id = r.collection_id AND s.nft_id = r.nft_id
                          AND s.sold_at BETWEEN r.block_ts - interval '10 minutes' AND r.block_ts + interval '10 minutes')),
    'eligible', (SELECT count(*) FROM ok),
    'inserted', (SELECT count(*) FROM ins),
    'inserted_by_collection', (SELECT COALESCE(jsonb_object_agg(collection, n), '{}'::jsonb) FROM (SELECT collection, count(*) n FROM ins GROUP BY 1) x)
  ) INTO v;
  RETURN v;
END $f$;

REVOKE ALL ON FUNCTION flowty_archive.promote_dapper_tx_verified_sales(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
