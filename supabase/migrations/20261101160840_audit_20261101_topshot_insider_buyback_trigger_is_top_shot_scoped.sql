-- tg_capture_topshot_insider_marketplace_buyback is TOP-SHOT-scoped (2026-11-01, #142).
--
-- The trigger is AFTER INSERT on sales_2026, which holds EVERY collection
-- (2026 rows: Top Shot 1,151,690 · All Day 251,030 · Candy 8,633 · UFC 2,315 ·
-- Golazos 839), and it had no collection gate: a sale of ANY collection to a
-- `signal_source` wallet would land in topshot_insider_buybacks as a Top Shot
-- marketplace buyback and feed /api/analytics/insider/signals and the
-- detect-patterns lane. Its edition lookup also read wallet_moments_cache by
-- moment_id ALONE (no wallet, no collection), so where a Top Shot id collides
-- with an All Day one, LIMIT 1 could take the All Day row and lose the edition.
--
-- Measured 2026-11-01 — LATENT, no repair needed: all 3,255 trigger-written rows
-- are Top Shot sales; 10 collide with an All Day cache row, and on every one
-- the stored edition is a genuine Top Shot `set:play` edition or NULL. An All
-- Day key ("3465") can never equal a Top Shot external_id, so the collision can
-- only LOSE an edition, never assign a wrong one.
--
-- Fix: return early unless NEW.collection_id is Top Shot, and scope the cache
-- lookup to Top Shot. Nothing else changes.
--
-- anon-exec: not granted, unchanged — a trigger function; ACL read before apply: postgres, service_role (tg_capture_topshot_insider_marketplace_buyback)
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

  -- sales_2026 holds every collection; this table is Top Shot's (#142).
  IF NEW.collection_id IS DISTINCT FROM '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid THEN
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
        WHERE wmc.moment_id = NEW.nft_id
          AND wmc.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
        LIMIT 1
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
