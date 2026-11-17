-- 2026-10-04 (PT). UFC Strike: name a sold NFT from the CHAIN's own set metadata, and promote the
-- chain-verified Flowty / Dapper-contract UFC sales that could not be named before.
--
-- WHY: the Flowty-venue promoters (migrations 20261004025556, 20261004031134, 20261004132142) name a UFC NFT
-- through public.nft_edition_map, or through a setId whose NFTs nft_edition_map names unanimously. That map
-- holds 533 UFC NFTs; only 146 of the 561 on-chain UFC sets had one, so 19,316 chain-verified UFC sales stayed
-- out of `sales` (none was ambiguous — the other 415 sets simply had no mapping).
--
-- THE MAP: UFC_NFT (0x329feb3ab062d289, deployed source read 2026-10-04) keeps per-set metadata at contract
-- level — UFC_NFT.getSetMetadata(setId:) {String: String} and getSetMaxEditions(setId:) — and its
-- MetadataViews.Editions name is the set's "name" field. RPC keys UFC editions by
-- slugifyUfcEdition(name, max) (app/api/cron/ufc-sales-history-backfill/route.ts: upper-case, non-alphanumerics
-- to '-', trimmed, then '-<max>'). public.ufc_chain_set_editions holds that per set, read from the chain for
-- all 561 sets (6 batched pg_net script reads). editions.external_id keeps mixed case ('McGREGOR'), so the
-- match is case-insensitive; no two UFC editions differ only by case (checked: 0).
-- CONTROL: for the 146 sets nft_edition_map already names, the chain slug names the SAME edition 146 / 146.
-- 514 sets resolve to an RPC edition; 47 name editions RPC's catalog does not have (left unresolved).
--
-- THE PROMOTER: flowty_archive.promote_ufc_chain_named_sales(from, to) takes the UFC rows of the three
-- verified lanes that are not yet in `sales` — the chain walk (flowty_chain_listing_completed → source
-- flowty_chain_v1), the mainnet24 per-transaction rows (method 'tx' → flowty_chain_tx_v1) and the
-- Dapper-contract rows (method 'tx_dapper', parties from the chain → dapper_chain_tx_v1, venue rules of
-- 20261004132142) — names each by its latest-spork checkpoint setId through ufc_chain_set_editions, takes the
-- serial from the checkpoint, and inserts with the same dedup as the other promoters (tx + nft, and a
-- same-NFT sale within ±10 min from any source). USD-pegged vaults only.
--
-- Revert:
--   DELETE FROM public.sales WHERE collection_id = '9b4824a8-736d-4a96-b450-8dcc0c46b023'
--     AND (transaction_hash, nft_id) IN (SELECT tx_hash, nft_id FROM flowty_archive.ufc_chain_named_promoted);
--   DROP FUNCTION flowty_archive.promote_ufc_chain_named_sales(timestamptz, timestamptz);
--   DROP TABLE flowty_archive.ufc_chain_named_promoted, public.ufc_chain_set_editions;

CREATE TABLE public.ufc_chain_set_editions (
  set_id              integer PRIMARY KEY,
  set_name            text NOT NULL,
  max_editions        integer,
  slug                text NOT NULL,
  edition_id          uuid,
  edition_external_id text,
  read_at             timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ufc_chain_set_editions IS
  'UFC Strike on-chain setId -> RPC edition, from UFC_NFT.getSetMetadata(setId).name + getSetMaxEditions(setId), slugged as slugifyUfcEdition (case-insensitive match on editions.external_id). Read from the chain 2026-10-04 (migration 20261004180000). edition_id NULL = the slug names no edition RPC has.';
ALTER TABLE public.ufc_chain_set_editions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_chain_set_editions FROM PUBLIC, anon, authenticated;

CREATE TABLE flowty_archive.ufc_chain_named_promoted (
  tx_hash     text NOT NULL,
  nft_id      text NOT NULL,
  source      text NOT NULL,
  edition_id  uuid NOT NULL,
  promoted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, nft_id)
);

CREATE OR REPLACE FUNCTION flowty_archive.promote_ufc_chain_named_sales(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
AS $f$
DECLARE
  c_ufc constant uuid := '9b4824a8-736d-4a96-b450-8dcc0c46b023';
  v jsonb;
BEGIN
  IF p_to <= p_from OR p_to - p_from > interval '45 days' THEN
    RAISE EXCEPTION 'slice % .. % is empty or wider than 45 days', p_from, p_to;
  END IF;

  CREATE TEMP TABLE _u ON COMMIT DROP AS
  SELECT * FROM (
    SELECT c.tx_hash, c.block_height, c.block_ts, c.nft_id, c.price, c.payment_vault,
           lower(c.buyer) AS buyer, lower(c.seller) AS seller, 'flowty_chain_v1'::text AS source, 'flowty'::text AS marketplace
      FROM flowty_archive.flowty_chain_listing_completed c
     WHERE c.nft_type = 'A.329feb3ab062d289.UFC_NFT.NFT' AND c.block_ts >= p_from AND c.block_ts < p_to
    UNION ALL
    SELECT i.tx_hash, NULL::bigint, i.block_ts, i.nft_id, i.price, i.payment_vault,
           lower(i.buyer), lower(i.seller), 'flowty_chain_tx_v1', 'flowty'
      FROM flowty_archive.flowty_index_sales i
     WHERE i.collection_id = c_ufc AND i.block_ts >= p_from AND i.block_ts < p_to
       AND i.event_type = 'STOREFRONT_PURCHASED' AND i.verify_status = 'chain_sealed' AND i.verify_detail->>'method' = 'tx'
    UNION ALL
    SELECT i.tx_hash, NULL::bigint, i.block_ts, i.nft_id, i.price, i.payment_vault,
           lower(i.verify_detail->>'buyer'), lower(i.verify_detail->>'seller'), 'dapper_chain_tx_v1',
           CASE WHEN i.chain_event LIKE '%OffersV2%' OR i.verify_detail->>'custom_id' = 'DAPPER_MARKETPLACE' THEN 'ufcstrike'
                WHEN lower(i.verify_detail->>'custom_id') = 'flowty' THEN 'flowty'
                WHEN i.verify_detail->>'custom_id' = 'flowverse-nft-marketplace' THEN 'flowverse' END
      FROM flowty_archive.flowty_index_sales i
     WHERE i.collection_id = c_ufc AND i.block_ts >= p_from AND i.block_ts < p_to
       AND i.verify_status = 'chain_sealed' AND i.verify_detail->>'method' = 'tx_dapper'
  ) x
  WHERE x.nft_id ~ '^[0-9]{1,18}$';

  CREATE TEMP TABLE _r ON COMMIT DROP AS
  SELECT u.*, m.a AS set_id, NULLIF(m.serial, 0)::int AS serial, se.edition_id,
         u.payment_vault ~ '\.(DapperUtilityCoin|FiatToken|USDCFlow)\.Vault$' AS usd_pegged
    FROM _u u
    LEFT JOIN LATERAL (SELECT * FROM public.checkpoint_nft_meta m0
                        WHERE m0.c = 'ufc' AND m0.nft_id = u.nft_id::bigint ORDER BY m0.spork DESC LIMIT 1) m ON true
    LEFT JOIN public.ufc_chain_set_editions se ON se.set_id = m.a;

  WITH ok AS (
    SELECT r.* FROM _r r
     WHERE r.usd_pegged AND r.price > 0 AND r.edition_id IS NOT NULL AND r.marketplace IS NOT NULL
       AND r.buyer ~ '^0x[0-9a-f]{16}$' AND r.seller ~ '^0x[0-9a-f]{16}$' AND r.buyer <> r.seller
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.transaction_hash = r.tx_hash AND s.nft_id = r.nft_id)
       AND NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.collection_id = c_ufc AND s.nft_id = r.nft_id
                          AND s.sold_at BETWEEN r.block_ts - interval '10 minutes' AND r.block_ts + interval '10 minutes')
  ), ins AS (
    INSERT INTO public.sales (moment_id, edition_id, collection_id, serial_number, price_usd, price_native, currency,
                              seller_address, buyer_address, marketplace, transaction_hash, block_height, sold_at,
                              nft_id, collection, source)
    SELECT NULL, o.edition_id, c_ufc, o.serial, o.price, o.price,
           CASE WHEN o.payment_vault LIKE '%DapperUtilityCoin%' THEN 'DUC' ELSE 'USDC' END,
           o.seller, o.buyer, o.marketplace, o.tx_hash, o.block_height, o.block_ts, o.nft_id, 'ufc_strike', o.source
      FROM ok o
    ON CONFLICT DO NOTHING
    RETURNING transaction_hash, nft_id, source, edition_id
  ), logged AS (
    INSERT INTO flowty_archive.ufc_chain_named_promoted (tx_hash, nft_id, source, edition_id)
    SELECT transaction_hash, nft_id, source, edition_id FROM ins
    ON CONFLICT DO NOTHING
    RETURNING source
  )
  SELECT jsonb_build_object(
    'slice', jsonb_build_array(p_from, p_to),
    'candidates', (SELECT count(*) FROM _r),
    'not_usd_pegged', (SELECT count(*) FROM _r WHERE NOT usd_pegged),
    'no_checkpoint_set', (SELECT count(*) FROM _r WHERE set_id IS NULL),
    'set_without_rpc_edition', (SELECT count(*) FROM _r WHERE set_id IS NOT NULL AND edition_id IS NULL),
    'unknown_venue', (SELECT count(*) FROM _r WHERE marketplace IS NULL),
    'eligible', (SELECT count(*) FROM ok),
    'inserted', (SELECT count(*) FROM logged),
    'inserted_by_source', (SELECT COALESCE(jsonb_object_agg(source, n), '{}'::jsonb) FROM (SELECT source, count(*) n FROM logged GROUP BY 1) x)
  ) INTO v;
  RETURN v;
END $f$;
REVOKE ALL ON FUNCTION flowty_archive.promote_ufc_chain_named_sales(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
