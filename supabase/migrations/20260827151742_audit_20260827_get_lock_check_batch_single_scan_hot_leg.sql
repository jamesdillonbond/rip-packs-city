-- audit_20260827_get_lock_check_batch_single_scan_hot_leg
--
-- ⛔⛔ THIS MIGRATION MADE PRODUCTION WORSE AND WAS REVERTED ~4 MINUTES LATER BY
-- 20260827152136_audit_20260827_revert_get_lock_check_batch_single_scan_measured_worse.sql.
-- It is committed ONLY because it was applied to prod and migration-parity matches on NAME.
-- ⛔ DO NOT RE-APPLY. The idea is not merely unproven — it is MEASURED WORSE in situ.
--
-- ── WHAT IT DID ───────────────────────────────────────────────────────────────
-- `get_lock_check_batch` picks lock-check candidates. Its hot-wallet branch is a
-- CROSS JOIN LATERAL *per hot wallet*, each with its own `LIMIT p_limit`, so with 574
-- hot wallets and p_limit=200 it fetches up to 574x200 rows to return 200. The plan
-- confirms it exactly: `Limit (actual rows=81 loops=574)` = 46,320 rows read to keep 200.
-- This migration replaced that branch with ONE scan filtered by `wallet_address IN (hot)`.
--
-- ── WHY IT LOOKED RIGHT (and this is the part worth keeping) ──────────────────
-- Measured INLINE, as a CTE with the slug and limit written as literals, warm-vs-warm
-- in the same session:
--
--   current (lateral-per-wallet)   49,438 buffers   56,421 ms
--   rewrite (single scan)             232 buffers      15.3 ms      213x / ~3,700x
--
-- The inline old-form number (56,421 ms) reproduced the production mean (51,041 ms over
-- 694 calls), so the baseline was sound and the comparison looked airtight.
--
-- ⛔ IT WAS NOT. Called as the actual FUNCTION, the rewrite measured:
--
--   run 1   127,501 buffers    73,486 ms
--   run 2   127,534 buffers   114,531 ms     (warm — so not a cold-cache artifact)
--
-- i.e. ~2.6x the buffers of the form it replaced, and slower.
--
-- ⭐ THE LESSON: A PARAMETERISED SQL FUNCTION DOES NOT PLAN LIKE THE SAME TEXT WITH
-- LITERALS INLINE. `IN (SELECT hot.addr FROM hot)` against a literal collection_id plans
-- as a cheap index scan + hash semi-join; inside a function whose `p_collection_slug`
-- and `p_limit` are parameters, the planner has no such constants and chose something
-- far worse. **An inline CTE is not a measurement of the callable** — the same family as
-- this repo's "the PROJECTION can change the PLAN" and "a plan measured against a
-- guessed UUID is not the real plan". **Measure the FUNCTION, by calling the FUNCTION.**
--
-- ── WHAT REMAINS TRUE ─────────────────────────────────────────────────────────
-- The diagnosis stands even though the fix did not: the hot leg really is
-- O(hot_wallets x p_limit), it really does read 46,320 rows to return 200, and
-- `get_lock_check_batch` really is 51,041 ms mean / 119,631 ms max over 694 calls
-- (35,422 s = 9.8 h of DB time), with its max CLIPPED at the ~120 s ceiling. The route
-- fails 9 of 46 ticks a day, and a failed tick writes ZERO rows after burning ~246 s.
-- ⚠ Equivalence was never the problem and was argued soundly: any row in the global
-- top-p_limit is necessarily inside its own wallet's top-p_limit, so both forms select
-- a valid global top-p_limit, differing only in tie-breaking (which both already do
-- arbitrarily across ~1.4M NULL `lock_checked_at` rows).
--
-- 👉 A future attempt must be measured THROUGH THE FUNCTION, and should consider
-- forcing a stable plan (e.g. splitting the hot set into a materialised CTE, or
-- `PARALLEL SAFE`/`STABLE` hints) rather than assuming the inline plan transfers.

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_lock_check_batch';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_lock_check_batch is absent';
  END IF;

  -- Assert the REVERTED (correct) state, not this migration's state: the per-wallet
  -- lateral must be present and the single-scan leg must NOT be.
  IF v_src NOT LIKE '%w.wallet_address = h.addr%' THEN
    RAISE EXCEPTION 'get_lock_check_batch is missing its per-wallet lateral — the '
                    '2026-08-27 single-scan rewrite was measured WORSE and must stay reverted';
  END IF;
  IF v_src LIKE '%IN (SELECT hot.addr FROM hot)%' THEN
    RAISE EXCEPTION 'the reverted single-scan hot leg is back in get_lock_check_batch — '
                    'it measured 127k buffers / 114 s against 49k / 56 s. Do not re-apply.';
  END IF;
END $$;
