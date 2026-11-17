-- audit_20261026: RECORD-ONLY. idx_panini_serials_owner_lower_sku was built with CREATE INDEX CONCURRENTLY from a
-- one-off pg_cron job (2026-10-26 ~7:37 PM PT), under a temporarily raised postgres statement_timeout that was RESET
-- straight after (the one-off job unscheduled). In prod this file is a no-op that asserts the index is valid.
--
-- Why: panini_collection_export's "seen" arm filters lower(owner) = <username> and keyset-pages ORDER BY sku > after.
-- The only owner index was (lower(owner)) INCLUDE (owner), so EVERY 1,000-card page fetched and sorted the owner's
-- whole holding: 'ezgolf' (89k cards) cost 28.5 s / ~85k blocks for ONE page, so /api/panini-collection/export hit
-- its 8 s bound on page 1 and answered a 503 (two RPC_READ_TIMEOUT on 10-26) — never even reaching the honest 413.
-- With (lower(owner), sku) the arm is an ordered range scan that stops after 1,000 rows.
--
-- Revert: DROP INDEX CONCURRENTLY public.idx_panini_serials_owner_lower_sku;  (from a one-off pg_cron job or the SQL editor)

CREATE INDEX IF NOT EXISTS idx_panini_serials_owner_lower_sku ON public.panini_card_serials (lower(owner), sku) WHERE owner <> '';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'idx_panini_serials_owner_lower_sku' AND i.indisvalid AND i.indisready
  ) THEN
    RAISE EXCEPTION 'idx_panini_serials_owner_lower_sku is missing or not valid';
  END IF;
END $$;
