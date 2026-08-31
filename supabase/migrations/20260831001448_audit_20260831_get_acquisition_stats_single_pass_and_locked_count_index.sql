-- audit_20260831_get_acquisition_stats_single_pass_and_locked_count_index
-- anon-exec: get_acquisition_stats — intentionally anon-callable app-facing read RPC (ACL measured 2026-08-31: anon=X, authenticated=X, service_role=X); CREATE OR REPLACE preserves that ACL, this migration changes only the function body.
--
-- WHY (#52 sub-item a, measured 2026-08-31): get_acquisition_stats was the last un-measured hot RPC in the pack-ev/#52
-- sweep: 3,313 calls / 3,247 ms mean / 113 GB shared buffers since the 08-12 stats reset. EXPLAIN on the reference
-- wallet (0xbd94cade097e50ac, 14,587 rows) split the cost two ways:
--   1. The locked_count probe on wallet_moments_cache was the monster: 11,601 buffers, 11,485 SCATTERED heap pages
--      (one page per row — is_locked is in no index, so the bitmap scan visited the heap for all 15,326 candidate
--      rows; ~90 MB of reads per call). Fixed by idx_wmc_locked_count below (built CONCURRENTLY 2026-08-31 ~00:15Z,
--      2.6 MB — only 353k of 2.5M wmc rows are locked): the count became an index-only scan, measured 11,601 buffers
--      -> 3,190 all-hit / 2,235 ms -> 11.8 ms on the same probe.
--   2. The function scanned moment_acquisitions THREE times with the identical (wallet, collection_id) predicate —
--      breakdown, total_moments, total_spent — where the breakdown GROUP BY already contains everything the totals
--      need (~830 buffers per scan, x3). The body below folds them into one scan via a CTE (referenced 3x =>
--      materialized once on PG 17).
--
-- EXACTNESS: buy_price is numeric (exact decimal), so summing per-method raw sums equals the original global
-- SUM(COALESCE(buy_price,0)) exactly; ROUND is applied at the same places as before (per-method display, and once on
-- the raw total), so output is byte-identical incl. the empty-wallet shape
-- {"breakdown": [], "total_moments": 0, "total_spent": null, "locked_count": 0} (verified pre/post on the reference
-- wallet, a pack_pull-only wallet, and a nonexistent wallet).
--
-- Also: moment_acquisitions (938k rows, 237 MB) had NEVER been autovacuumed — same append-mostly class as
-- pack_ev_history (upd 4,266 / del 34 lifetime; default insert threshold 1000 + 0.2*938k = ~188k rows fires rarely).
-- Manual VACUUM (ANALYZE) run 2026-08-31 alongside this migration; the storage parameter keeps the visibility map
-- fresh from here on.
--
-- REVERT: CREATE OR REPLACE FUNCTION public.get_acquisition_stats(...) with the pre-2026-08-31 four-subquery body
--         (in git history); DROP INDEX CONCURRENTLY public.idx_wmc_locked_count;
--         ALTER TABLE public.moment_acquisitions RESET (autovacuum_vacuum_insert_threshold, autovacuum_vacuum_insert_scale_factor);

-- Built CONCURRENTLY out-of-band (a transactional migration cannot); IF NOT EXISTS makes this a stamped no-op that
-- keeps schema parity for fresh environments.
CREATE INDEX IF NOT EXISTS idx_wmc_locked_count
ON public.wallet_moments_cache (wallet_address, collection_id)
WHERE is_locked;

CREATE OR REPLACE FUNCTION public.get_acquisition_stats(p_wallet text, p_collection_id uuid DEFAULT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid)
RETURNS json
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH sub AS (
    SELECT
      acquisition_method,
      COUNT(*) AS cnt,
      SUM(COALESCE(buy_price, 0))::numeric AS raw_spent
    FROM moment_acquisitions
    WHERE wallet = p_wallet
      AND collection_id = p_collection_id
    GROUP BY acquisition_method
  )
  SELECT json_build_object(
    'breakdown', COALESCE((
      SELECT json_agg(json_build_object(
        'method', acquisition_method,
        'count', cnt,
        'total_spent', ROUND(raw_spent, 2)
      ) ORDER BY cnt DESC)
      FROM sub
    ), '[]'::json),
    'total_moments', COALESCE((SELECT SUM(cnt) FROM sub), 0),
    'total_spent', (SELECT ROUND(SUM(raw_spent)::numeric, 2) FROM sub),
    'locked_count', (
      SELECT COUNT(*) FROM wallet_moments_cache
      WHERE wallet_address = p_wallet
        AND collection_id = p_collection_id
        AND is_locked = true
    )
  );
$function$;

-- Keep the visibility map fresh on this append-mostly table (same rationale and numbers class as pack_ev_history's
-- 20260830222057 change).
ALTER TABLE public.moment_acquisitions SET (autovacuum_vacuum_insert_threshold = 5000, autovacuum_vacuum_insert_scale_factor = 0.0);

DO $mig$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = 'public.idx_wmc_locked_count'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: idx_wmc_locked_count missing or invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'get_acquisition_stats'
      AND pg_get_functiondef(p.oid) LIKE '%WITH sub AS%'
  ) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: get_acquisition_stats does not carry the single-pass body';
  END IF;
END
$mig$;
