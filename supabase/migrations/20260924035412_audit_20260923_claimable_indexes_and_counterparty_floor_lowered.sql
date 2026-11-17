-- audit_20260923_claimable_indexes_and_counterparty_floor_lowered
--
-- known-issues #109, decided 2026-09-23 under Trevor's delegation ("make your own judgements …
-- financially responsible, the long term of RPC, and for our users").
--
-- The three partial indexes were BUILT CONCURRENTLY via execute_sql minutes before this migration
-- (Large compute, 1 active backend, each finished well inside the 60 s client cap) and verified
-- indisvalid = true: 2025 32 kB, 2024 48 kB, 2023 11 MB. The CREATE INDEX IF NOT EXISTS below is
-- therefore a NO-OP in production; it exists so the objects are not fileless and a fresh database
-- gets them. The predicate is spelled IS DISTINCT FROM clause-for-clause as
-- claim_sales_counterparty_batch writes it (structural implication), and topshot_marketplace is
-- deliberately LEFT OUT so the index survives a revert of 20260913173355.
--
-- MEASURED before lowering the floor: the claim body at floor 2023-11-08, cursor 2025-12-31 plans
-- Index Scan using idx_sales_2025_claimable_soldat, 188 buffers, 3.2 ms (the filed exit was
-- < ~1,000 buffers; the 09-13 attempt at the same descent read 61,320 buffers / 13.7 s).
--
-- Then the floor goes back to 2023-11-08 (restoring the ~221 abandoned eligible rows plus anything
-- ts_history_backfill_v1 has added below 2026 since) and exhausted_at is cleared so the lane resumes
-- now rather than after its 2-hour re-arm.
--
-- REVERT: UPDATE public.sales_counterparty_backfill_state SET floor_sold_at = '2026-01-01T00:00:00Z'
--   WHERE id = 1;  (the indexes are harmless to keep; to drop, one statement each:
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_sales_2023_claimable_soldat; …_2024_…; …_2025_…)

CREATE INDEX IF NOT EXISTS idx_sales_2025_claimable_soldat ON public.sales_2025 (sold_at DESC)
  WHERE seller_address IS NULL
    AND source IS DISTINCT FROM 'allday_studio_history_v1'
    AND source IS DISTINCT FROM 'ufc_studio_history_v1';
CREATE INDEX IF NOT EXISTS idx_sales_2024_claimable_soldat ON public.sales_2024 (sold_at DESC)
  WHERE seller_address IS NULL
    AND source IS DISTINCT FROM 'allday_studio_history_v1'
    AND source IS DISTINCT FROM 'ufc_studio_history_v1';
CREATE INDEX IF NOT EXISTS idx_sales_2023_claimable_soldat ON public.sales_2023 (sold_at DESC)
  WHERE seller_address IS NULL
    AND source IS DISTINCT FROM 'allday_studio_history_v1'
    AND source IS DISTINCT FROM 'ufc_studio_history_v1';

UPDATE public.sales_counterparty_backfill_state
   SET floor_sold_at = '2023-11-08T17:00:00Z'::timestamptz,
       exhausted_at  = NULL,
       updated_at    = now()
 WHERE id = 1;

DO $assert$
DECLARE v_bad int; v_floor timestamptz;
BEGIN
  SELECT count(*) INTO v_bad FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE c.relname IN ('idx_sales_2023_claimable_soldat','idx_sales_2024_claimable_soldat','idx_sales_2025_claimable_soldat')
     AND i.indisvalid;
  IF v_bad <> 3 THEN RAISE EXCEPTION 'expected 3 valid claimable indexes, found %', v_bad; END IF;
  SELECT floor_sold_at INTO v_floor FROM public.sales_counterparty_backfill_state WHERE id = 1;
  IF v_floor <> '2023-11-08T17:00:00Z'::timestamptz THEN RAISE EXCEPTION 'floor not lowered: %', v_floor; END IF;
END
$assert$;
