-- audit_20260817_unmapped_resolver_targets_rotate_and_priced_only
--
-- WHAT: get_unmapped_resolver_targets — two changes inside the candidates CTE.
--   1. ADD  `AND us.price_usd > 0`
--   2. ORDER BY `us.sold_at ASC`  ->  `us.last_onchain_attempt_at ASC NULLS FIRST, us.sold_at DESC`
-- Signature, return type, STABLE/SECURITY DEFINER, search_path and the 300s statement_timeout
-- are all UNCHANGED, so no new overload is created and the existing ACL survives.
--
-- ⛔ WHY — the resolver was pinned to 2025-12-29 and 82% of its window was unworkable
--
-- `ORDER BY us.sold_at ASC LIMIT 2000` made the candidate window a fixed slice of the OLDEST
-- open sales. Measured 2026-08-17, that window was **2,000 rows all dated 2025-12-29**, and
-- splitting it by class:
--
--   | class            | rows  | ever attempted |
--   |------------------|------:|---------------:|
--   | actionable       |   356 |      **61.8%** |
--   | frozen-by-design | 1,644 |       **1.3%** |
--
-- Frozen-by-design = multi-NFT tx whose single gross price cannot be split per-NFT. They occupied
-- **82% of every window** and were acted on **1.3%** of the time: returned as targets, then
-- silently skipped downstream. So the resolver re-scanned the same December slice every 30 min,
-- offering ~356 usable candidates out of 2,000, while live inflow (~231-240/24h) outpaced
-- outflow (~212-223/24h) and the actionable backlog grew.
--
-- ⚠⚠ TWO PRIOR RECOMMENDATIONS ARE REFUTED HERE — do not re-propose either:
--
-- (a) "Rotate on last_onchain_attempt_at; it forfeits nothing" — **does not work alone.** The
--     December head is **88% never-attempted** (241 of 2,000 stamped), so `NULLS FIRST` puts those
--     exact rows straight back at the head. Ordering without a predicate reproduces the pin.
--
-- (b) "Excluding frozen rows costs 30,332 NFT mappings" — **overstated to the point of being
--     wrong.** That figure assumed those NFTs would otherwise be mapped by this path. At a **1.3%
--     attempt rate** they were not being mapped anyway. The exclusion forfeits ~nothing real; the
--     status quo already forfeits them, just expensively.
--
-- 💡 WHY `price_usd > 0` RATHER THAN A HAND-BUILT "frozen" PREDICATE
-- This is not invented here. A purpose-built partial index already exists:
--   idx_unmapped_sales_tail_resolver_targets
--     (collection_id, last_onchain_attempt_at NULLS FIRST, sold_at DESC)
--     WHERE resolved_at IS NULL AND price_usd > 0
-- i.e. the codebase had already chosen this exact predicate + rotation key for the TAIL resolver
-- (which queries unmapped_sales directly via PostgREST — no SQL function orders by
-- last_onchain_attempt_at; only `stamp_unmapped_onchain_attempt` writes it). This migration brings
-- the MAIN resolver onto the pattern the tail resolver already runs, and onto the index built for it.
--
-- ⚠ `price_usd > 0` is a SUPERSET of "frozen": it also drops unpriced SINGLE-NFT rows (204 of the
-- 2,000-row head). Accepted deliberately — an unpriced sale contributes nothing to FMV, which is
-- the accuracy gate, and this matches the tail resolver's existing target definition.
--
-- MEASURED COST — the new form is CHEAPER than what it replaces
--   new predicate + ordering : **8.19 s**, uses idx_unmapped_sales_tail_resolver_targets,
--                              buffers hit=6533 read=1012, no temp spill, returns a full 2,000.
--   a hand-built multi-NFT   : 17.85 s, forced a 106,009-row Seq Scan + HashAggregate spilling to
--     aggregate alternative    disk (read=9745 written=1742, temp 150/312). Rejected.
--   the CURRENT predicate    : an equivalent probe **timed out at 25 s** earlier the same session.
-- So this is ~2.2x cheaper than the obvious alternative and faster than the status quo, on an
-- instance whose binding constraint is I/O. Density of usable candidates: 356/2000 -> 2000/2000.
--
-- ⚠ ORDERING POLICY CHANGE, stated explicitly: within never-attempted rows the tiebreak is now
-- `sold_at DESC` (newest first) instead of oldest-first. This is deliberate and user-facing —
-- FMV weights recency, so a sale from this week matters more than one from 2025-12-29. The
-- December tail is still reached, after fresh arrivals, and rows that HAVE been attempted rotate
-- to the back instead of being rescanned forever. `sold_at DESC` also matches the index.
--
-- NOT CHANGED: the dedup CTE (`DISTINCT ON (collection_id, nft_id) … sold_at ASC` still reports the
-- OLDEST sale per nft_id), the final `ORDER BY d.oldest_unmapped ASC`, the occurrences subquery,
-- the two NOT EXISTS guards, and the retry_count>=5 / >=3-within-24h failure exclusion.
--
-- REVERT (safe at any time — read-only function, no data written):
--   re-apply with `AND us.price_usd > 0` removed and the candidates ORDER BY restored to
--   `ORDER BY us.sold_at ASC`. Reverting cannot lose data; it only restores the old candidate
--   window. ⚠ If you revert, expect the December pin to return.
--
-- ⚠ WATCH (the refutation condition): resolver OUTFLOW should rise above the ~212-223/24h it has
-- been stuck at, and `unmapped-sales-nfl_all_day` actionable rows should stop growing. If outflow
-- does NOT rise within ~24 h, this change did not help and should be revisited rather than
-- assumed — the downstream resolver may be rate-limited by its upstream
-- (`resolve:upstream request timeout` is its current top error), in which case candidate quality
-- was never the binding constraint.
-- -----------------------------------------------------------------------------

DO $guard$
DECLARE v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_unmapped_resolver_targets';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_unmapped_resolver_targets not found -- aborting';
  END IF;
  IF position('ORDER BY us.sold_at ASC' in v_src) = 0 THEN
    RAISE EXCEPTION 'anchor "ORDER BY us.sold_at ASC" not found -- drifted or already applied, aborting';
  END IF;
  IF position('price_usd' in v_src) <> 0 THEN
    RAISE EXCEPTION 'price_usd already referenced -- appears already applied, aborting';
  END IF;
  -- the index this migration relies on must exist, or the new ordering has no support
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public' AND tablename='unmapped_sales'
                    AND indexname='idx_unmapped_sales_tail_resolver_targets') THEN
    RAISE EXCEPTION 'idx_unmapped_sales_tail_resolver_targets missing -- aborting (the new ORDER BY would seq-scan)';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.get_unmapped_resolver_targets(p_collection_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS TABLE(collection_id uuid, nft_id text, oldest_unmapped timestamp with time zone, occurrences integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
  WITH candidates AS (
    SELECT us.collection_id, us.nft_id, us.sold_at
    FROM unmapped_sales us
    WHERE us.resolved_at IS NULL
      AND us.nft_id IS NOT NULL AND us.nft_id <> ''
      AND (p_collection_id IS NULL OR us.collection_id = p_collection_id)
      -- Only PRICED rows. An unpriced row is overwhelmingly a multi-NFT tx whose single gross
      -- price cannot be attributed per-NFT; those made up 82% of every window and were acted on
      -- 1.3% of the time. They contribute nothing to FMV either way. This matches the predicate
      -- the tail resolver already uses and the partial index built for it.
      AND us.price_usd > 0
      AND NOT EXISTS (
        SELECT 1 FROM nft_edition_map nem
        WHERE nem.collection_id = us.collection_id
          AND nem.nft_id        = us.nft_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM unmapped_sales_resolution_failures usrf
        WHERE usrf.collection_id = us.collection_id
          AND usrf.nft_id        = us.nft_id
          AND (
            usrf.retry_count >= 5
            OR (usrf.retry_count >= 3 AND usrf.last_failed_at > NOW() - INTERVAL '24 hours')
          )
      )
    -- ROTATION, not a fixed head. Never-attempted first (NULLS FIRST), then least-recently
    -- attempted, so a row that has been tried moves to the BACK instead of being rescanned
    -- forever. sold_at DESC breaks ties toward RECENT sales, which is what FMV weights.
    -- Served by idx_unmapped_sales_tail_resolver_targets.
    ORDER BY us.last_onchain_attempt_at ASC NULLS FIRST, us.sold_at DESC
    LIMIT GREATEST(p_limit * 10, 2000)
  ),
  dedup AS (
    SELECT DISTINCT ON (collection_id, nft_id)
           collection_id, nft_id, sold_at AS oldest_unmapped
    FROM candidates
    ORDER BY collection_id, nft_id, sold_at ASC
  )
  SELECT
    d.collection_id,
    d.nft_id::text,
    d.oldest_unmapped,
    (SELECT count(*)::int FROM unmapped_sales us2
      WHERE us2.collection_id = d.collection_id
        AND us2.nft_id        = d.nft_id
        AND us2.resolved_at IS NULL) AS occurrences
  FROM dedup d
  ORDER BY d.oldest_unmapped ASC
  LIMIT p_limit
  OFFSET p_offset;
$function$;
