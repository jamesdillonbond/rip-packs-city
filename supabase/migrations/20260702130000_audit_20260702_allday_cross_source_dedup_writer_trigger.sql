-- P2: durable writer-side fix for AllDay cross-source duplicate sales.
--
-- The allday_studio_history_v1 backfill and the onchain/onchain_dapper_v1/v2
-- indexers ingest the same economic sale under different tx representations,
-- so per-tx_hash dedup misses them and the hourly dedup_allday_cross_source_sales()
-- sweeper has to keep collapsing ~25/backfill-burst after the fact. This
-- BEFORE INSERT trigger stops the writer from producing them in the first
-- place, using the sweeper's exact economic key (nft_id + rounded price + day)
-- restricted to a DIFFERENT source.
--
-- Keep-richer, no-delete design: when an incoming AllDay sale matches an
-- existing cross-source economic twin, we merge the field-wise best
-- buyer/seller/serial into the surviving twin and SKIP the incoming insert
-- (RETURN NULL). Net row count and downstream data (FMV reads price/edition;
-- buyer-resolution reads buyer_address; serial completeness) are identical to
-- the sweeper's keep-richer-row result — the only immaterial difference is the
-- surviving row keeps the earlier row's source label. Avoids DELETE/recursion
-- on the ingest hot path. The hourly sweeper stays as the backstop for any
-- intra-batch races the trigger can't see. INSERT-only (never UPDATE), so the
-- internal UPDATE cannot recurse into this trigger.
--
-- Applied live via MCP apply_migration 2026-07-02; repo-sync record.
-- Verified: 5-scenario self-rolling-back test (cross-source collapse+union,
-- same-source kept, diff-price kept, non-AllDay kept); trigger propagated to
-- all sales_YYYY partitions; check_public_security_invariants()=[] / secdef=[].
-- Revert:
--   DROP TRIGGER IF EXISTS trg_zzz_allday_cross_source_dedup ON public.sales;
--   DROP FUNCTION IF EXISTS public.allday_sales_cross_source_dedup();

CREATE OR REPLACE FUNCTION public.allday_sales_cross_source_dedup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $body$
DECLARE
  ad_id constant uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  twin  record;
BEGIN
  -- Only AllDay rows carrying the fields the economic key needs.
  IF NEW.collection_id IS DISTINCT FROM ad_id
     OR NEW.nft_id IS NULL
     OR NEW.price_usd IS NULL
     OR NEW.sold_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Richest existing cross-source twin (same nft, rounded price, calendar day).
  SELECT s.id INTO twin
  FROM sales s
  WHERE s.collection_id = ad_id
    AND s.nft_id = NEW.nft_id
    AND date_trunc('day', s.sold_at) = date_trunc('day', NEW.sold_at)
    AND round(s.price_usd::numeric, 2) = round(NEW.price_usd::numeric, 2)
    AND s.source IS DISTINCT FROM NEW.source
  ORDER BY (CASE WHEN s.buyer_address  IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN s.seller_address IS NOT NULL THEN 1 ELSE 0 END
          + CASE WHEN COALESCE(s.serial_number, 0) > 0 THEN 1 ELSE 0 END) DESC,
           s.ingested_at ASC NULLS LAST, s.id ASC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;  -- no cross-source twin; normal insert
  END IF;

  -- Collapse to one row: fill the surviving twin's gaps from the incoming row,
  -- then suppress the incoming insert.
  UPDATE sales s
  SET buyer_address  = COALESCE(s.buyer_address,  NEW.buyer_address),
      seller_address = COALESCE(s.seller_address, NEW.seller_address),
      serial_number  = COALESCE(NULLIF(s.serial_number, 0), NULLIF(NEW.serial_number, 0), s.serial_number)
  WHERE s.id = twin.id;

  RETURN NULL;
END
$body$;

COMMENT ON FUNCTION public.allday_sales_cross_source_dedup() IS
  'P2 (audit_20260702): BEFORE INSERT ON sales dedup for AllDay cross-source economic twins (nft_id+rounded price+day, different source). Merges best buyer/seller/serial into the existing twin and suppresses the duplicate insert. Backstopped by hourly dedup_allday_cross_source_sales().';

REVOKE EXECUTE ON FUNCTION public.allday_sales_cross_source_dedup() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.allday_sales_cross_source_dedup() FROM anon;
REVOKE EXECUTE ON FUNCTION public.allday_sales_cross_source_dedup() FROM authenticated;

-- Name sorts after trg_normalize_marketplace so normalization runs first.
DROP TRIGGER IF EXISTS trg_zzz_allday_cross_source_dedup ON public.sales;
CREATE TRIGGER trg_zzz_allday_cross_source_dedup
BEFORE INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.allday_sales_cross_source_dedup();
