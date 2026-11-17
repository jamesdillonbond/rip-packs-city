-- ─────────────────────────────────────────────────────────────────────
-- 1) marketplace_offers (partitioned monthly on event_timestamp)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.marketplace_offers (
  id                  bigserial   NOT NULL,
  collection_id       uuid        NOT NULL REFERENCES public.collections(id),
  edition_id          uuid        NULL REFERENCES public.editions(id),
  nft_id              text        NOT NULL,
  nft_type            text        NOT NULL,
  offeror_address     text        NOT NULL,
  offer_price         numeric     NOT NULL,
  currency            text        NOT NULL DEFAULT 'USDC',
  listing_resource_id text        NULL,
  storefront_address  text        NULL,
  offer_state         text        NOT NULL CHECK (offer_state IN ('LISTED','CANCELLED','PURCHASED','EXPIRED')),
  event_timestamp     timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, event_timestamp)
) PARTITION BY RANGE (event_timestamp);

DO $$
DECLARE
  v_start date;
  v_end   date;
  v_name  text;
BEGIN
  FOR m IN 1..12 LOOP
    v_start := make_date(2026, m, 1);
    IF m = 12 THEN
      v_end := make_date(2027, 1, 1);
    ELSE
      v_end := make_date(2026, m + 1, 1);
    END IF;
    v_name := format('marketplace_offers_2026_%s', lpad(m::text, 2, '0'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.marketplace_offers FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS marketplace_offers_natural_key_idx
  ON public.marketplace_offers (listing_resource_id, offeror_address, offer_state, event_timestamp);

CREATE INDEX IF NOT EXISTS marketplace_offers_collection_ts_idx
  ON public.marketplace_offers (collection_id, event_timestamp DESC);

CREATE INDEX IF NOT EXISTS marketplace_offers_offeror_ts_idx
  ON public.marketplace_offers (offeror_address, event_timestamp DESC);

ALTER TABLE public.marketplace_offers ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────
-- 2) api_harvest extraction tracking
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE flowty_archive.api_harvest_20260512
  ADD COLUMN IF NOT EXISTS extracted_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS api_harvest_20260512_unextracted_endpoint_idx
  ON flowty_archive.api_harvest_20260512 (endpoint, collected_at)
  WHERE extracted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3) Collection mapping helper
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.flowty_collection_id_from_nft_type(p_nft_type text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN p_nft_type LIKE '%TopShot.NFT' THEN '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    WHEN p_nft_type LIKE '%AllDay.NFT'  THEN 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
    WHEN p_nft_type LIKE '%Golazos.NFT' THEN '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
    WHEN p_nft_type LIKE '%UFC_NFT.NFT' OR p_nft_type LIKE '%UFCStrike%' THEN '9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid
    WHEN p_nft_type LIKE '%Pinnacle.NFT' THEN '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid
    ELSE NULL
  END;
$function$;

REVOKE ALL ON FUNCTION public.flowty_collection_id_from_nft_type(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.flowty_collection_id_from_nft_type(text) TO postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 4) extract_flowty_purchases — writes to unmapped_sales staging
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.extract_flowty_purchases(p_batch_size int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_harvest_rows int := 0;
  v_events int := 0;
  v_inserted int := 0;
  v_skipped_unmapped int := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN p_batch_size := 100; END IF;

  CREATE TEMP TABLE _src ON COMMIT DROP AS
  SELECT h.id AS harvest_id, jsonb_array_elements(h.response_payload) AS event
  FROM flowty_archive.api_harvest_20260512 h
  WHERE h.endpoint = 'firestore:STOREFRONT_PURCHASED'
    AND h.extracted_at IS NULL
    AND h.id IN (
      SELECT id FROM flowty_archive.api_harvest_20260512
      WHERE endpoint = 'firestore:STOREFRONT_PURCHASED' AND extracted_at IS NULL
      ORDER BY collected_at
      LIMIT p_batch_size
    );

  SELECT COUNT(DISTINCT harvest_id), COUNT(*) INTO v_harvest_rows, v_events FROM _src;

  CREATE TEMP TABLE _parsed ON COMMIT DROP AS
  SELECT
    s.harvest_id,
    e->'document'->'fields'->'data'->'mapValue'->'fields' AS data_fields,
    (e->'document'->'fields'->'transactionId'->>'stringValue')           AS tx_hash,
    ((e->'document'->'fields'->'blockTimestamp'->>'timestampValue')::timestamptz) AS sold_at
  FROM _src s, LATERAL (SELECT s.event AS e) ev;

  CREATE TEMP TABLE _mapped ON COMMIT DROP AS
  SELECT
    p.harvest_id,
    p.tx_hash,
    p.sold_at,
    (p.data_fields->'nftType'->>'stringValue')           AS nft_type,
    (p.data_fields->'nftID'->>'stringValue')             AS nft_id,
    (p.data_fields->'buyer'->>'stringValue')             AS buyer_address,
    (p.data_fields->'storefrontAddress'->>'stringValue') AS seller_address,
    NULLIF(p.data_fields->'salePrice'->>'doubleValue','')::numeric AS sale_price,
    public.flowty_collection_id_from_nft_type(p.data_fields->'nftType'->>'stringValue') AS collection_id
  FROM _parsed p;

  WITH inserted AS (
    INSERT INTO public.unmapped_sales (
      collection_id, nft_id, serial_number, price_usd, currency,
      seller_address, buyer_address, marketplace, transaction_hash,
      sold_at, source, resolution_hint
    )
    SELECT
      m.collection_id,
      m.nft_id,
      NULL::int,
      m.sale_price,
      'USDC',
      m.seller_address,
      m.buyer_address,
      'flowty',
      m.tx_hash,
      m.sold_at,
      'flowty_archive_extractor',
      jsonb_build_object('nft_type', m.nft_type, 'harvest_id', m.harvest_id)
    FROM _mapped m
    WHERE m.collection_id IS NOT NULL
      AND m.tx_hash IS NOT NULL
      AND m.sold_at IS NOT NULL
      AND m.sale_price IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.unmapped_sales us
        WHERE us.transaction_hash = m.tx_hash
          AND us.nft_id = m.nft_id
          AND us.collection_id = m.collection_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.sales s
        WHERE s.transaction_hash = m.tx_hash
          AND s.nft_id = m.nft_id
      )
    RETURNING id
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  SELECT COUNT(*) INTO v_skipped_unmapped FROM _mapped WHERE collection_id IS NULL;

  UPDATE flowty_archive.api_harvest_20260512 h
     SET extracted_at = now()
   WHERE h.id IN (SELECT DISTINCT harvest_id FROM _src);

  RETURN jsonb_build_object(
    'ok', true,
    'harvest_rows_processed', v_harvest_rows,
    'events_processed', v_events,
    'inserted_unmapped_sales', v_inserted,
    'skipped_unmapped_collection', v_skipped_unmapped,
    'batch_size', p_batch_size,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.extract_flowty_purchases(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.extract_flowty_purchases(int) FROM anon;
REVOKE ALL ON FUNCTION public.extract_flowty_purchases(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.extract_flowty_purchases(int) TO postgres, service_role;

-- ─────────────────────────────────────────────────────────────────────
-- 5) extract_flowty_offers — writes to marketplace_offers
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.extract_flowty_offers(p_batch_size int DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'flowty_archive', 'pg_temp'
SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_harvest_rows int := 0;
  v_events int := 0;
  v_inserted int := 0;
  v_skipped_unmapped int := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 THEN p_batch_size := 100; END IF;

  CREATE TEMP TABLE _src ON COMMIT DROP AS
  SELECT h.id AS harvest_id, h.endpoint, jsonb_array_elements(h.response_payload) AS event
  FROM flowty_archive.api_harvest_20260512 h
  WHERE h.endpoint IN ('firestore:STOREFRONT_OFFER_CREATED', 'firestore:STOREFRONT_OFFER_CANCELLED')
    AND h.extracted_at IS NULL
    AND h.id IN (
      SELECT id FROM flowty_archive.api_harvest_20260512
      WHERE endpoint IN ('firestore:STOREFRONT_OFFER_CREATED', 'firestore:STOREFRONT_OFFER_CANCELLED')
        AND extracted_at IS NULL
      ORDER BY collected_at
      LIMIT p_batch_size
    );

  SELECT COUNT(DISTINCT harvest_id), COUNT(*) INTO v_harvest_rows, v_events FROM _src;

  CREATE TEMP TABLE _parsed ON COMMIT DROP AS
  SELECT
    s.harvest_id,
    s.endpoint,
    e->'document'->'fields'->'data'->'mapValue'->'fields' AS data_fields,
    (e->'document'->'fields'->'transactionId'->>'stringValue') AS tx_hash,
    ((e->'document'->'fields'->'blockTimestamp'->>'timestampValue')::timestamptz) AS event_ts
  FROM _src s, LATERAL (SELECT s.event AS e) ev;

  CREATE TEMP TABLE _mapped ON COMMIT DROP AS
  SELECT
    p.harvest_id,
    p.tx_hash,
    p.event_ts,
    (p.data_fields->'nftType'->>'stringValue')             AS nft_type,
    COALESCE(
      p.data_fields->'typeAndIDOffer'->'mapValue'->'fields'->'nftID'->>'stringValue',
      p.data_fields->'nftID'->>'stringValue'
    ) AS nft_id,
    (p.data_fields->'offerAddress'->>'stringValue')        AS offeror_address,
    NULLIF(p.data_fields->'amount'->>'doubleValue','')::numeric AS offer_price,
    (p.data_fields->'paymentTokenName'->>'stringValue')    AS currency,
    (p.data_fields->'offerResourceID'->>'stringValue')     AS listing_resource_id,
    (p.data_fields->'storefrontAddress'->>'stringValue')   AS storefront_address,
    CASE
      WHEN p.endpoint = 'firestore:STOREFRONT_OFFER_CREATED'   THEN 'LISTED'
      WHEN p.endpoint = 'firestore:STOREFRONT_OFFER_CANCELLED' THEN 'CANCELLED'
    END AS offer_state,
    public.flowty_collection_id_from_nft_type(p.data_fields->'nftType'->>'stringValue') AS collection_id
  FROM _parsed p;

  WITH inserted AS (
    INSERT INTO public.marketplace_offers (
      collection_id, nft_id, nft_type, offeror_address, offer_price,
      currency, listing_resource_id, storefront_address, offer_state,
      event_timestamp
    )
    SELECT
      m.collection_id,
      m.nft_id,
      m.nft_type,
      m.offeror_address,
      m.offer_price,
      COALESCE(m.currency, 'USDC'),
      m.listing_resource_id,
      m.storefront_address,
      m.offer_state,
      m.event_ts
    FROM _mapped m
    WHERE m.collection_id IS NOT NULL
      AND m.nft_id IS NOT NULL
      AND m.offeror_address IS NOT NULL
      AND m.offer_price IS NOT NULL
      AND m.offer_state IS NOT NULL
      AND m.event_ts IS NOT NULL
    ON CONFLICT (listing_resource_id, offeror_address, offer_state, event_timestamp) DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*) INTO v_inserted FROM inserted;

  SELECT COUNT(*) INTO v_skipped_unmapped FROM _mapped WHERE collection_id IS NULL;

  UPDATE flowty_archive.api_harvest_20260512 h
     SET extracted_at = now()
   WHERE h.id IN (SELECT DISTINCT harvest_id FROM _src);

  RETURN jsonb_build_object(
    'ok', true,
    'harvest_rows_processed', v_harvest_rows,
    'events_processed', v_events,
    'inserted_offers', v_inserted,
    'skipped_unmapped_collection', v_skipped_unmapped,
    'batch_size', p_batch_size,
    'duration_ms', EXTRACT(milliseconds FROM (clock_timestamp() - v_started))::int
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.extract_flowty_offers(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.extract_flowty_offers(int) FROM anon;
REVOKE ALL ON FUNCTION public.extract_flowty_offers(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.extract_flowty_offers(int) TO postgres, service_role;
