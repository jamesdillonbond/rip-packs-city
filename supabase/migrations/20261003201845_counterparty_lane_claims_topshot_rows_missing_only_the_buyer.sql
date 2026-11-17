-- counterparty_lane_claims_topshot_rows_missing_only_the_buyer
-- anon-exec: unchanged (claim_sales_counterparty_batch) — CREATE OR REPLACE of an existing fn, same signature; ACL preserved (postgres, service_role only), verified before applying.
--
-- 2026-10-03 (found measuring #167). `sales` holds ~143k rows with a SELLER but no BUYER across
-- Top Shot / All Day / UFC; the sales-counterparty-backfill lane never touched them because its
-- claim reads `seller_address IS NULL` only. For All Day / UFC that is right — their sale tx
-- deposits to a Dapper custodian, so the buyer is not in-tx and the worker deliberately leaves it
-- NULL. For TOP SHOT it is not: `TopShot.Deposit.to` IS the buyer, the worker already decodes it,
-- and apply_sales_counterparty already fills a NULL buyer (COALESCE, fill-only, audited in
-- sales_counterparty_recovered). The rows were simply never CLAIMED.
--
-- POPULATION (Top Shot, seller set, buyer NULL, 64-hex tx, >= the 2023-11-08 floor):
--   ts_history_backfill_v1 97,055 (2025-01-01 .. 2025-12-22) · dune_settlement_ingest 7,897
--   (2025-06 .. 2025-11) · onchain 174 (2026-09-18 ..) · topshot_marketplace 28 (excluded: known
--   undecodable). None before 2025.
-- YIELD, sampled before shipping: 16 random 2025-08 rows decoded 16/16 from rest-mainnet (each tx
--   one TopShot.Withdraw + one TopShot.Deposit, so the worker's multi-moment guard passes); 4 of
--   the 16 buyers were Dapper's buy-back wallet 0xe1f2a091f7bb5245 — part of #167's 2025 sell-back
--   gap is present but unattributed, and this recovers it.
-- COST, measured on prod (EXPLAIN ANALYZE at the live cursor 2026-01-19): Merge Append of two
--   ordered index scans, 126 buffers, 7 ms. The 2025 leg is served by the pre-existing
--   idx_sales_2025_null_buyer_coll_sold; `sold_at >= 2025-01-01` is a constant so 2020-2024 are
--   pruned at plan time.
-- INDEXES: idx_sales_202{5,6,7}_ts_nullbuyer_soldat were built CONCURRENTLY via execute_sql
--   before the plan check (all valid, 2.3 MB / 168 kB / 8 kB). The planner prefers the 2026 one;
--   the 2025 one turned out redundant with idx_sales_2025_null_buyer_coll_sold (a DROP INDEX
--   CONCURRENTLY was held by the tool and did not run) — harmless, safe to drop. Declared below
--   for repo parity, as 20260724150000 / 20260913134605 did.
-- THROUGHPUT: ~105k rows at the worker's 120/tick, 5-min ticks ≈ 73 h, plus normal NULL-seller work.
--
-- REVERT: re-apply claim_sales_counterparty_batch from
--   supabase/migrations/20260913173355_audit_20260913_claim_excludes_topshot_marketplace_because_the_rearm_dissolved_its_bounded_argument.sql
--   Filled buyers are fill-only and mirrored in sales_counterparty_recovered (sale_id, buyer_address).

CREATE INDEX IF NOT EXISTS idx_sales_2025_ts_nullbuyer_soldat ON public.sales_2025 (sold_at DESC)
  WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND seller_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2026_ts_nullbuyer_soldat ON public.sales_2026 (sold_at DESC)
  WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND seller_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_2027_ts_nullbuyer_soldat ON public.sales_2027 (sold_at DESC)
  WHERE collection = 'nba_top_shot' AND buyer_address IS NULL AND seller_address IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_sales_counterparty_batch(p_limit integer DEFAULT 100)
 RETURNS TABLE(sale_id uuid, tx_hash text, sold_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '60s'
AS $function$
#variable_conflict use_column
DECLARE
  v_cursor    timestamptz;
  v_floor     timestamptz;
  v_exhausted timestamptz;
  v_rearm     interval;
  v_limit     integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_found     integer := 0;
BEGIN
  SELECT st.cursor_sold_at, st.floor_sold_at, st.exhausted_at, st.rearm_after
    INTO v_cursor, v_floor, v_exhausted, v_rearm
  FROM public.sales_counterparty_backfill_state st
  ORDER BY st.id
  LIMIT 1;

  v_floor := COALESCE(v_floor, '2023-11-08T17:00:00Z'::timestamptz);
  v_rearm := COALESCE(v_rearm, interval '2 hours');

  -- EXHAUSTED + INSIDE THE COOLDOWN: return empty WITHOUT SCANNING. This is the branch that
  -- exists to be taken most of the time; every tick that lands here is a 195,564-buffer scan
  -- that did not happen.
  IF v_exhausted IS NOT NULL AND now() - v_exhausted < v_rearm THEN
    RETURN;
  END IF;

  -- RE-ARM: the cooldown has elapsed, so sweep from the newest row again. New sales arrive at
  -- the TOP and the cursor only ever descends, so this is the only way the lane can ever see
  -- them. Clearing the stamp here (not after the scan) means a scan that finds nothing will
  -- simply set it again below.
  IF v_exhausted IS NOT NULL THEN
    UPDATE public.sales_counterparty_backfill_state
       SET cursor_sold_at = NULL, exhausted_at = NULL, updated_at = now()
     WHERE id = 1;
    v_cursor := NULL;
  END IF;

  -- SELF-HEAL: a cursor STRICTLY BELOW the floor is invalid state, not a position (migration
  -- 20260902042214). Left alone it returns an empty range on every tick, forever, at ok=true.
  IF v_cursor IS NOT NULL AND v_cursor < v_floor THEN
    v_cursor := NULL;
  END IF;

  -- TWO LEGS (2026-10-03), each its own ordered index scan, merged newest-first:
  --   1. NULL-seller rows, as before (idx_sales_<year>_nullseller_soldat).
  --   2. BUYER-ONLY Top Shot rows: seller known, buyer NULL (idx_sales_<year>_ts_nullbuyer_soldat).
  --      Top Shot is the one collection whose buyer is in the sale tx (TopShot.Deposit.to); the
  --      worker already decodes it and apply_sales_counterparty already fills a NULL buyer, but
  --      leg 1's `seller_address IS NULL` meant these rows were never CLAIMED — 105k Top Shot
  --      sales, nearly all 2025 (ts_history_backfill_v1 97k, dune_settlement_ingest 7.9k), sat
  --      buyer-less for good; a 16-row sample decoded 16/16 (1 withdraw + 1 deposit each), 4 of
  --      them sell-backs to Dapper (#167). `sold_at >= 2025-01-01` is a CONSTANT so the planner
  --      prunes 2020–2024 (which hold none of these rows and have no index for this leg).
  IF v_cursor IS NULL THEN
    RETURN QUERY
      SELECT u.sid, u.tx, u.sat FROM (
        (SELECT s.id AS sid, s.transaction_hash::text AS tx, s.sold_at AS sat
           FROM public.sales s
          WHERE s.seller_address IS NULL
            AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= v_floor
            -- NULL-SAFE: `NOT IN` yields NULL for a NULL source, which EXCLUDES the row. IS DISTINCT FROM
            -- yields TRUE, so an unlabelled row is ATTEMPTED. Attempt-unless-known-undecodable is the
            -- right default; the other way a new writer that forgets `source` disappears silently.
            AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
            AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
            -- KNOWN-UNDECODABLE (20260913): 4,959 rows, 0.00% conversion measured as a WHOLE
            -- POPULATION over 11 days and at least two full walks. Excluded because the re-arm made
            -- the walk cyclic.
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
        UNION ALL
        (SELECT s.id, s.transaction_hash::text, s.sold_at
           FROM public.sales s
          WHERE s.collection = 'nba_top_shot'
            AND s.buyer_address IS NULL
            AND s.seller_address IS NOT NULL
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= '2025-01-01T00:00:00Z'::timestamptz
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
      ) u
      ORDER BY u.sat DESC
      LIMIT v_limit;
  ELSE
    RETURN QUERY
      SELECT u.sid, u.tx, u.sat FROM (
        (SELECT s.id AS sid, s.transaction_hash::text AS tx, s.sold_at AS sat
           FROM public.sales s
          WHERE s.seller_address IS NULL
            AND s.collection IN ('nba_top_shot', 'nfl_all_day', 'ufc_strike')
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at < v_cursor
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'allday_studio_history_v1'
            AND s.source IS DISTINCT FROM 'ufc_studio_history_v1'
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
        UNION ALL
        (SELECT s.id, s.transaction_hash::text, s.sold_at
           FROM public.sales s
          WHERE s.collection = 'nba_top_shot'
            AND s.buyer_address IS NULL
            AND s.seller_address IS NOT NULL
            AND s.transaction_hash ~ '^[0-9a-f]{64}$'
            AND s.sold_at >= '2025-01-01T00:00:00Z'::timestamptz
            AND s.sold_at < v_cursor
            AND s.sold_at >= v_floor
            AND s.source IS DISTINCT FROM 'topshot_marketplace'
          ORDER BY s.sold_at DESC
          LIMIT v_limit)
      ) u
      ORDER BY u.sat DESC
      LIMIT v_limit;
  END IF;

  -- GET DIAGNOSTICS AFTER `RETURN QUERY` REPORTS THE ROWS THAT QUERY ADDED TO THE RESULT SET,
  -- which is exactly what "did this scan find anything" means here. Verified on PG 16 before
  -- shipping (3 rows -> 3, empty -> 0). A zero is the drained signal - record it, so the NEXT
  -- tick takes the free branch above instead of paying for the same discovery again.
  GET DIAGNOSTICS v_found = ROW_COUNT;
  IF v_found = 0 THEN
    UPDATE public.sales_counterparty_backfill_state
       SET exhausted_at = now(), updated_at = now()
     WHERE id = 1;
  END IF;
END;
$function$;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.claim_sales_counterparty_batch(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_sales_counterparty_batch must not be executable by anon/authenticated';
  END IF;
END
$$;
