-- audit_20260809_allday_lock_picker_skipscan
--
-- get_allday_lock_refresh_wallets picked the 60 stalest All Day wallets with a
-- GROUP BY over every All Day wmc row (~396k). The trailing LIMIT removed no
-- work: every wallet's min(lock_checked_at) had to be computed, and the whole
-- set sorted, before the 60 could be named. Under disk-IO saturation that
-- aggregate exceeded the statement timeout, so `allday-lock-refresh` failed
-- 44 of 66 ticks across 2026-08-06..08 with
--   `wallet fetch: canceling statement due to statement timeout`
-- dying on its FIRST statement -- no Cadence call, no on-chain diff, no write.
--
-- This is NOT a missing index: the old plan was already an Index Only Scan.
-- The defect is the shape. There are only 213 distinct All Day wallets behind
-- those ~396k rows, so the work is re-shaped from O(rows) to O(wallets):
-- a recursive skip-scan walks the distinct wallet_address values, then each
-- wallet's min(lock_checked_at) is a single seek that Postgres folds into
-- InitPlan -> Limit -> Index Only Scan against the EXISTING index
-- idx_wmc_lock_wallet_coll (wallet_address, collection_id, lock_checked_at).
-- No new index is required, which also avoids adding a third index over
-- lock_checked_at -- every such index makes each lock stamp a non-HOT update
-- that rewrites all 14 indexes on this table.
--
-- Measured on prod: 300s timeout -> ~0.9s warm / ~4s cold.
--
-- Equivalence proven before shipping: run against candy_mlb (a collection small
-- enough that the original GROUP BY shape completes), the two forms returned
-- identical (wallet_address, oldest_check) sets -- 395 rows each, EXCEPT diff
-- empty in BOTH directions. Completeness on All Day was cross-checked too: the
-- skip-scan's 213 wallets account for exactly 396,498 rows, matching the
-- collection's true row count.
--
-- row_count is DROPPED from the return type. It was the entire remaining cost
-- (counting each wallet's rows takes the query from ~0.9s to ~19.5s, because
-- the 60 stalest wallets are the whales -- they hold 311k of the 396k rows,
-- so restricting the count to the returned page barely helps). The sole caller,
-- app/api/cron/allday-lock-refresh-batch/route.ts, reads only wallet_address,
-- as does its test fixture; no function, view, or cron job in the database
-- referenced this function at all.
--
-- Revert: restore the prior definition, which was
--   SELECT w.wallet_address, min(w.lock_checked_at) AS oldest_check, count(*) AS row_count
--   FROM public.wallet_moments_cache w
--   WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
--   GROUP BY w.wallet_address
--   ORDER BY min(w.lock_checked_at) ASC NULLS FIRST
--   LIMIT GREATEST(1, p_limit);
-- returning TABLE(wallet_address text, oldest_check timestamptz, row_count bigint).

DROP FUNCTION IF EXISTS public.get_allday_lock_refresh_wallets(integer);

CREATE FUNCTION public.get_allday_lock_refresh_wallets(p_limit integer)
RETURNS TABLE(wallet_address text, oldest_check timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE walk AS (
    SELECT (SELECT w.wallet_address
              FROM public.wallet_moments_cache w
             WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
             ORDER BY w.wallet_address
             LIMIT 1) AS wa
    UNION ALL
    SELECT (SELECT w.wallet_address
              FROM public.wallet_moments_cache w
             WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
               AND w.wallet_address > walk.wa
             ORDER BY w.wallet_address
             LIMIT 1)
      FROM walk
     WHERE walk.wa IS NOT NULL
  )
  SELECT walk.wa,
         (SELECT min(w.lock_checked_at)
            FROM public.wallet_moments_cache w
           WHERE w.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
             AND w.wallet_address = walk.wa)
    FROM walk
   WHERE walk.wa IS NOT NULL
   ORDER BY 2 ASC NULLS FIRST
   LIMIT GREATEST(1, p_limit);
$$;

ALTER FUNCTION public.get_allday_lock_refresh_wallets(integer) OWNER TO postgres;

-- Supabase grants EXECUTE to PUBLIC by default on a newly created function, and
-- a REVOKE from anon/authenticated alone leaves that PUBLIC grant standing --
-- so revoke PUBLIC explicitly. Reproduces the prior ACL exactly:
-- postgres=X/postgres | service_role=X/postgres
REVOKE EXECUTE ON FUNCTION public.get_allday_lock_refresh_wallets(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_allday_lock_refresh_wallets(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_lock_refresh_wallets(integer) TO service_role;
