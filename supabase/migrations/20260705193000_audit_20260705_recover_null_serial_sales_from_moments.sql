-- audit_20260705_recover_null_serial_sales_from_moments
--
-- Root cause (2026-07-05): TopShot `offer_fill` sales were landing with
-- serial_number = NULL and accumulating (147 rows on Jul 5, starting ~03:00Z /
-- 8pm PT Jul 4). The OfferCompleted (Dapper OffersV2) event carries NO serial —
-- only nftId — so the offer-fill indexer resolves the serial from the DB
-- (moments -> wmc -> offers) at ingest. A freshly-traded moment often is not yet
-- hydrated into `moments`/`wmc` when the fill is indexed (verified: all 41 of the
-- currently-recoverable NULL rows had their `moments.serial_number` populated
-- AFTER the sale's ingested_at, by the hourly moments hydrator), so the sale
-- correctly lands with a NULL serial and MUST be recovered once the serial exists.
--
-- This race pre-dates today; before commit 5c1b0db an unresolved serial was
-- written as a phantom `0` and healed later. 5c1b0db flipped the sentinel 0->NULL
-- (correct — Flow serials start at 1), so the honest-NULL rows now sit in the
-- serial-recovery queue. The GQL `sales-serial-backfill` edge fn drains that queue
-- oldest-first, so the freshest offer_fill rows lag behind the backlog.
--
-- Fix: a cheap DB-side sweep that copies the authoritative serial straight from
-- `moments` (and `wallet_moments_cache` as a fallback) onto NULL-serial sales,
-- keyed on nft_id. The serial is an invariant of the nft (independent of edition
-- attribution / current holder), so copying by nft_id is always correct. This
-- closes the common case with no GraphQL cost and complements the GQL edge fn,
-- which still handles the never-hydrated tail. Scheduled every 15 min via pg_cron.
--
-- Revert:
--   SELECT cron.unschedule('rpc-recover-null-serial-sales');
--   DROP FUNCTION IF EXISTS public.backfill_null_serial_sales_from_moments(integer);

CREATE OR REPLACE FUNCTION public.backfill_null_serial_sales_from_moments(p_max_age_days integer DEFAULT 45)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
SET statement_timeout TO '60s'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  WITH cand AS (
    SELECT
      s.id AS sale_id,
      COALESCE(
        (SELECT m.serial_number
           FROM moments m
          WHERE m.nft_id = s.nft_id
            AND m.serial_number > 0
          LIMIT 1),
        (SELECT w.serial_number
           FROM wallet_moments_cache w
          WHERE w.collection_id = s.collection_id
            AND w.moment_id = s.nft_id
            AND w.serial_number > 0
          LIMIT 1)
      ) AS serial_number
    FROM sales s
    WHERE s.serial_number IS NULL
      AND s.nft_id IS NOT NULL
      AND s.nft_id <> ''
      AND s.sold_at > now() - make_interval(days => p_max_age_days)
  )
  UPDATE sales s
     SET serial_number = c.serial_number
    FROM cand c
   WHERE s.id = c.sale_id
     AND c.serial_number IS NOT NULL
     AND s.serial_number IS NULL;   -- idempotent: never clobber a resolved serial

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;

REVOKE ALL ON FUNCTION public.backfill_null_serial_sales_from_moments(integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_null_serial_sales_from_moments(integer) TO service_role;

-- Recurring DB-side drain (idempotent upsert by job name).
SELECT cron.schedule(
  'rpc-recover-null-serial-sales',
  '*/15 * * * *',
  $$SELECT public.backfill_null_serial_sales_from_moments();$$
);
