-- Snapshot migration: public.record_serial_backfill_failure(uuid, uuid, text, text, text).
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-02) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical).
--
-- The failure-side companion to the serial-write guards: when a serial can't be
-- resolved for a sale, this records/updates one failure row per sale. The
-- invariant is the idempotent ON CONFLICT (sale_id) upsert — a first failure
-- inserts retry_count=1; every subsequent failure INCREMENTS retry_count and
-- refreshes reason/detail/last_failed_at while PRESERVING first_failed_at. A
-- regression that reset retry_count or first_failed_at would corrupt the backoff
-- accounting the backfill uses to give up on permanently-unresolvable sales.
--
-- Pinned by supabase/tests/record_serial_backfill_failure.sql.

CREATE OR REPLACE FUNCTION public.record_serial_backfill_failure(p_sale_id uuid, p_collection_id uuid, p_nft_id text, p_reason text, p_detail text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '3s'
AS $function$
  INSERT INTO sales_serial_backfill_failures (
    sale_id, collection_id, nft_id, failure_reason, failure_detail,
    retry_count, first_failed_at, last_failed_at
  )
  VALUES (
    p_sale_id, p_collection_id, p_nft_id, p_reason, p_detail,
    1, NOW(), NOW()
  )
  ON CONFLICT (sale_id) DO UPDATE
    SET retry_count    = sales_serial_backfill_failures.retry_count + 1,
        failure_reason = EXCLUDED.failure_reason,
        failure_detail = EXCLUDED.failure_detail,
        last_failed_at = NOW();
$function$;
