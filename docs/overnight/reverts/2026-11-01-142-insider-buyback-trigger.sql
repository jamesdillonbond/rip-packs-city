-- REVERT for 20261101160652 (#142): restores the pre-change trigger function
-- body exactly (md5 6640a496d04f558507e2ea9738cc04fc, verified against live
-- prosrc immediately before the change). The trigger itself is untouched.

CREATE OR REPLACE FUNCTION public.tg_capture_topshot_insider_marketplace_buyback()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_is_signal_source boolean;
  v_edition_id uuid;
BEGIN
  IF NEW.buyer_address IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM seeded_wallets sw
    WHERE lower(sw.wallet_address) = lower(NEW.buyer_address)
      AND 'signal_source' = ANY(sw.tags)
  ) INTO v_is_signal_source;

  IF NOT v_is_signal_source THEN
    RETURN NEW;
  END IF;

  -- Resolve edition_id by joining wallet_moments_cache → editions.
  -- Best-effort; NULL is fine on no-match (the pattern detector still
  -- works with missing edition refs).
  SELECT e.id INTO v_edition_id
  FROM editions e
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
    AND (
      e.external_id = (
        SELECT wmc.edition_key FROM wallet_moments_cache wmc
        WHERE wmc.moment_id = NEW.nft_id LIMIT 1
      )
    )
  LIMIT 1;

  -- Skip dedup if a snapshot-diff already captured this same arrival
  -- on the same day (avoid double-counting when both detection paths
  -- agree).
  IF EXISTS (
    SELECT 1 FROM topshot_insider_buybacks b
    WHERE b.buyer_address = lower(NEW.buyer_address)
      AND b.moment_id = NEW.nft_id
      AND (b.sold_at AT TIME ZONE 'UTC')::date = (NEW.sold_at AT TIME ZONE 'UTC')::date
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO topshot_insider_buybacks (
    sale_id, acquisition_method, buyer_address, seller_address,
    edition_id, moment_id, serial_number, price_usd, sold_at, metadata
  ) VALUES (
    NEW.id,
    'marketplace',
    lower(NEW.buyer_address),
    lower(COALESCE(NEW.seller_address, '')),
    v_edition_id,
    NEW.nft_id,
    NULL,
    NEW.price_usd,
    NEW.sold_at,
    jsonb_build_object(
      'detected_via', 'sales_2026_trigger',
      'transaction_hash', NEW.transaction_hash,
      'marketplace', NEW.marketplace
    )
  );

  RETURN NEW;
END;
$function$;
