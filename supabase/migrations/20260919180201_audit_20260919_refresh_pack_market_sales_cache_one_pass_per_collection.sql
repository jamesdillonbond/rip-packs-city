-- audit_20260919_refresh_pack_market_sales_cache_one_pass_per_collection
--
-- ⛔ SUPERSEDED THREE MINUTES AFTER IT WAS APPLIED, by `20260919180521`. This
-- file records that it existed and WHY it was wrong, because the reasoning is
-- the reusable part; its body is not reproduced, since no version of it ever
-- served a read and `20260919180521` replaced the function wholesale.
--
-- WHAT IT DID: `refresh_pack_market_sales_cache(p_collection_id uuid)` rebuilt
-- the whole cache with ONE `INSERT ... SELECT ... GROUP BY dist_id ... ON
-- CONFLICT DO UPDATE` per collection.
--
-- ⛔ WHY IT WAS REJECTED - two measured reasons, either one fatal:
--
--   1. IT DID NOT FINISH. The All Day arm alone (141 MB / 552k rows) was still
--      on `IO / DataFileRead` at 1 m 38 s and was rolled back when its client
--      disconnected, having written 0 rows and logged no `pipeline_runs` row.
--      Top Shot is larger (168 MB / 592k rows), so a full pass cannot fit
--      pg_cron's 120 s budget.
--   2. EVEN IF IT FIT, IT WOULD HOLD A MULTI-MINUTE TRANSACTION - and that is
--      precisely the mechanism register R109 blames for `wallet_moments_cache`
--      never holding a visibility map (a page with a recently-updated tuple
--      cannot be marked all-visible while any older snapshot is open). A
--      refresh built to cut reads would have worsened the estate's worst read
--      problem.
--
-- ⭐ THE COST DRIVER, worth keeping: TWO ordered aggregates per group -
-- `percentile_cont(...) WITHIN GROUP (ORDER BY ...)` and
-- `array_agg(... ORDER BY block_time DESC)` - each sort every group, so a
-- whole-table GROUP BY sorts the whole table twice over.
--
-- REVERT: nothing to revert - `20260919180521` dropped this signature
-- (`DROP FUNCTION IF EXISTS public.refresh_pack_market_sales_cache(uuid)`).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'refresh_pack_market_sales_cache'
      AND pg_get_function_identity_arguments(p.oid) = 'uuid'
  ) THEN
    RAISE WARNING 'the superseded uuid-arg overload of refresh_pack_market_sales_cache still exists - 20260919180521 was expected to drop it';
  END IF;
END $$;
