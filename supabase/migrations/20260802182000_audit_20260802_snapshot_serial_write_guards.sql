-- Snapshot migration: the two sales serial-number write guards
--   public.update_sale_serial(uuid, integer)          → boolean
--   public.update_topshot_sale_serial(text, integer)  → integer
--
-- Both were applied to prod via the Supabase MCP with no committed migration,
-- making them UNPINNABLE. This commits the CURRENT LIVE bodies verbatim (pulled
-- via pg_get_functiondef 2026-08-02) so each can carry a drift-guarded pinned
-- invariant test. Applying it is a no-op vs prod (byte-identical to live).
--
-- Why they matter: these are the ONLY writers that fill a sale's serial_number
-- during serial backfill/enrichment. The shared invariant is "only overwrite an
-- UNKNOWN serial (NULL or legacy 0) with a POSITIVE integer, idempotently" — a
-- regression that overwrote a resolved serial would corrupt every serial-keyed
-- FMV multiplier, special-serial board, and #1/jersey-match premium computed off
-- that sale, silently. update_topshot_sale_serial additionally scopes writes to
-- Top Shot on-chain rows only.
--
-- Pinned by supabase/tests/update_sale_serial.sql + update_topshot_sale_serial.sql.

CREATE OR REPLACE FUNCTION public.update_sale_serial(p_sale_id uuid, p_serial_number integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_updated int;
BEGIN
  IF p_serial_number IS NULL OR p_serial_number < 1 THEN
    RETURN false;
  END IF;

  -- Update only if currently unknown (NULL or legacy 0) — idempotent, won't clobber resolved rows
  UPDATE sales
  SET serial_number = p_serial_number
  WHERE id = p_sale_id
    AND (serial_number IS NULL OR serial_number = 0);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- If we updated, also clear any failure row for this sale (success after prior failure)
  IF v_updated > 0 THEN
    DELETE FROM sales_serial_backfill_failures WHERE sale_id = p_sale_id;
  END IF;

  RETURN v_updated > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_topshot_sale_serial(p_nft_id text, p_serial_number integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  rows_updated int;
BEGIN
  -- Sanity: serial must be positive integer
  IF p_serial_number IS NULL OR p_serial_number <= 0 THEN
    RAISE EXCEPTION 'update_topshot_sale_serial: serial_number must be > 0, got %', p_serial_number;
  END IF;

  UPDATE sales
  SET serial_number = p_serial_number,
      ingested_at   = NOW()  -- mark as freshly enriched
  WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND source = 'onchain'
    AND nft_id = p_nft_id
    AND (serial_number IS NULL OR serial_number = 0);  -- only update unknown rows, idempotent

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated;
END;
$function$;
