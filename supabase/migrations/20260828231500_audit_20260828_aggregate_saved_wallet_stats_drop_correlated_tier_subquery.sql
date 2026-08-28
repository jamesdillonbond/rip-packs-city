-- audit_20260828_aggregate_saved_wallet_stats_drop_correlated_tier_subquery
--
-- WHAT IS WRONG. `aggregate_saved_wallet_stats` computes `top_tier` with a
-- CORRELATED SUBQUERY that re-scans `wallet_moments_cache` for the SAME wallet
-- once per collection_id — rows the outer aggregate has already scanned. The
-- 2026-08-13 migration that lowered the reconcile soft deadline named the cost
-- ("the top-tier correlated subquery does a Bitmap Heap Scan + Sort per
-- collection", 16-55 s per wallet under IO saturation) but treated it as a
-- constraint to schedule around rather than a query to fix.
--
-- WHY IT MATTERS NOW. `rpc-reconcile-saved-wallet-stats` (jobid 259, `44 * * * *`)
-- calls `reconcile_all_saved_wallet_stats(10, 40, 360)` — a TEN SECOND soft
-- deadline, checked only BETWEEN wallets. When one wallet costs more than that,
-- the loop does exactly one wallet and exits truncated, so the run logs
-- ok=false / 'soft_deadline_reached_partial_sweep_committed' EVERY TIME. Measured
-- over 48 h to 2026-08-28: 9 ok / 34 failed (79.1%), wallets_done 0-4 out of
-- 11-14 eligible, and `oldest_cache_h` pinned at 12-15.2 h against a
-- `p_min_age_minutes` target of 360 (6 h). This is CLAUDE.md's permanently-red
-- instrument: a pipeline that is always failing is one nobody reads.
--
-- ⚠ THE LEVER IS CUTTING WORK, NOT RAISING THE DEADLINE. Raising p_max_seconds
-- would do strictly MORE IO on an instance whose binding constraint is the
-- SMALL tier's disk-IO budget. This migration leaves the schedule and every
-- argument alone and makes one wallet cheaper instead; whether 10 s is then
-- enough is a MEASUREMENT to take afterwards, not an assumption to ship on.
--
-- ── MEASURED, warm, on wallet 0x4d82b07c10f1fe0f (355 rows, 2 collections) ──
--   before: Buffers shared hit=213 read=302  (total 515)
--           of which SubPlan 1 alone: hit=183 read=178  (361 = 70% of the query)
--   after:  Buffers shared hit=196 read=166  (total 362)
--   => total buffers -30%, and READS -45% (302 -> 166), which is the IO-bound
--      half. Per CLAUDE.md, BUFFERS is the comparison; timings under a
--      saturation spell are confounded in both directions and are not quoted.
--   ⚠ This is ONE wallet with 2 collections. The subquery runs once per
--      collection, so the saving GROWS with collection count (saved_wallets
--      rows go up to 5 per wallet). Do not generalise the 30% to the fleet.
--
-- ── EQUIVALENCE, proved over the population rather than argued ──────────────
-- Old and new were compared for every (wallet, collection) group across all 22
-- saved wallets, split into two halves by abs(hashtext(wallet_addr)) % 2:
--   80 groups compared, 12 disagreements, 0 disagreements OUTSIDE the
--   independently-counted ambiguous set (also 12). The two counts were derived
--   by different queries and agree exactly — that is the positive control.
--
-- 🚨 THE 12 ARE NOT A REGRESSION. THEY ARE A DEFECT THIS FIXES.
-- The old ORDER BY ranks ULTIMATE/LEGENDARY/RARE/FANDOM/COMMON and lumps
-- EVERYTHING ELSE into `ELSE 6` with NO tiebreak, then takes LIMIT 1. Unranked
-- tiers are not rare — UNCOMMON (60,925 rows), STANDARD (33,225), SILVER SPARKLE
-- (7,074), GOLDEN (4,519) and more — so in 12 of 80 groups two or more DISTINCT
-- rank-6 tiers tie and the winner is decided by PHYSICAL ROW ORDER. Those rows
-- are updated constantly (fmv, lock_checked_at), so `cached_top_tier` could
-- change between two runs with no underlying data change. It was already
-- non-deterministic; this adds `, UPPER(tier)` as an explicit secondary sort so
-- it is stable. Ranks 1-5 are untouched and cannot move: every row at a given
-- rank there carries the same string.
-- ⛔ Alphabetical is a STABLE tiebreak, not a claim that GOLDEN outranks
--    UNCOMMON. Ranking the Pinnacle/UFC tier ladders properly is a product
--    decision and is deliberately NOT taken here.
--
-- ⚠ DO NOT "simplify" this to min(rank) mapped back to a name. That is wrong
--    for exactly the rank-6 rows above: the original returns the tier's actual
--    string, and a rank->name table has no entry for 6.
--
-- SAFETY. CREATE OR REPLACE preserves owner (postgres), ACL
-- ({postgres=X/postgres,service_role=X/postgres} — no anon, no authenticated),
-- SECURITY DEFINER, `search_path=public, pg_temp`, volatility and signature.
-- The authz guard, the UPDATE target list and the WHERE clause are byte-identical.
--
-- REVERT: re-run the prior body — restore the correlated subquery form of
-- `top_tier` (it is recorded verbatim in this file's header history and in
-- pg_proc before this migration); nothing else in the function changed.
--
-- EXIT CONDITION: `reconcile-saved-wallet-stats` wallets_done per run rises and
-- extra->>'oldest_cache_h' falls toward 6. FALSIFIER: if wallets_done stays at
-- 1 and oldest_cache_h holds at 12-15 h, the per-wallet cost is NOT dominated by
-- this subquery and the remaining cost is the outer scan — in which case the
-- next lever is an index covering (wallet_address, collection_id) INCLUDE (tier,
-- fmv_usd), NOT raising p_max_seconds.

CREATE OR REPLACE FUNCTION public.aggregate_saved_wallet_stats(p_user_id uuid, p_wallet_addr text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  v_updated integer;
BEGIN
  -- AUTHZ: caller must be the user they claim to be (service_role bypasses)
  IF auth.uid() IS NOT NULL AND auth.uid() <> p_user_id THEN
    RAISE EXCEPTION 'forbidden_cross_user' USING ERRCODE = '42501';
  END IF;

  WITH agg AS (
    SELECT
      wmc.collection_id,
      COUNT(*) AS moment_count,
      COALESCE(SUM(wmc.fmv_usd), 0) AS fmv_sum,
      -- Same ordering key as the correlated subquery this replaces, evaluated
      -- in the scan the outer aggregate is ALREADY doing. The trailing
      -- UPPER(wmc.tier) is the new deterministic tiebreak for the ELSE 6 class;
      -- see the header. FILTER reproduces the old `t.tier IS NOT NULL`, and an
      -- all-NULL group yields NULL[1] = NULL exactly as an empty subquery did.
      (array_agg(UPPER(wmc.tier) ORDER BY
        CASE UPPER(wmc.tier)
          WHEN 'ULTIMATE'  THEN 1
          WHEN 'LEGENDARY' THEN 2
          WHEN 'RARE'      THEN 3
          WHEN 'FANDOM'    THEN 4
          WHEN 'COMMON'    THEN 5
          ELSE 6
        END, UPPER(wmc.tier))
       FILTER (WHERE wmc.tier IS NOT NULL))[1] AS top_tier
    FROM public.wallet_moments_cache wmc
    WHERE wmc.wallet_address = p_wallet_addr
    GROUP BY wmc.collection_id
  )
  UPDATE public.saved_wallets sw
  SET
    cached_moment_count = agg.moment_count,
    cached_fmv_usd      = CASE WHEN agg.fmv_sum > 0 THEN agg.fmv_sum ELSE NULL END,
    cached_top_tier     = agg.top_tier,
    cache_updated_at    = NOW()
  FROM agg
  WHERE sw.user_id       = p_user_id
    AND sw.wallet_addr   = p_wallet_addr
    AND sw.collection_id = agg.collection_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$function$;
