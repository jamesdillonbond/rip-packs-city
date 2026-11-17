-- audit_20260827_revert_get_lock_check_batch_single_scan_measured_worse
--
-- Reverts 20260827151742_audit_20260827_get_lock_check_batch_single_scan_hot_leg.sql,
-- applied ~4 minutes earlier, which measured WORSE in situ than the form it replaced:
--
--   before (lateral-per-wallet, inline)    49,438 buffers    56,421 ms
--   after  (single scan, AS THE FUNCTION) 127,501 buffers    73,486 ms   (run 1)
--                                         127,534 buffers   114,531 ms   (run 2, warm)
--
-- ⭐ Why the rewrite looked like a 213x win and was not: measured INLINE as a CTE with
-- literals it read 232 buffers in 15.3 ms. A PARAMETERISED SQL FUNCTION DOES NOT PLAN
-- LIKE THE SAME TEXT WITH LITERALS INLINE — with `p_collection_slug` and `p_limit` as
-- parameters the planner has no constants to work with and chose a far worse plan.
-- **Measure the FUNCTION, by calling the FUNCTION.** Full account in the 08-27 ledger.
--
-- ── HOW THE REVERT WAS DONE AND VERIFIED ──────────────────────────────────────
-- Surgically, server-side, from `pg_get_functiondef` rather than retyped: locate the
-- single-scan hot branch by its `true AS forced_priority` header, assert the located
-- slice really contains `IN (SELECT hot.addr FROM hot)`, splice the original
-- lateral-per-wallet branch back, EXECUTE, then assert post-state.
--
-- ✅ PROVEN EXACT, not merely structural: the whitespace-collapsed md5 of the live
-- definition after the revert equals the md5 of the definition captured BEFORE the
-- change — **30d615edf9e33b8d1a4fb79869c16dab** on both sides. Structure also re-checked:
-- 2 `CROSS JOIN LATERAL`, per-wallet leg present, single-scan leg absent, 4 `LIMIT
-- p_limit` sites, `ROW_NUMBER() OVER` and `forced_priority` intact.
--
-- ⚠ This restores the SLOW behaviour on purpose. `get_lock_check_batch` remains
-- 51,041 ms mean / 119,631 ms max over 694 calls (9.8 h of DB time), its max clipped at
-- the ~120 s ceiling, and `lock-check-batch` still fails ~9 of 46 ticks a day writing
-- zero rows. **That is a known-and-measured cost, which is strictly better than an
-- unmeasured change that made it worse.**
--
-- REVERT OF THIS REVERT: none is wanted. Re-applying the single-scan form is explicitly
-- warned against in the migration above and guarded by the assertion below.

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'get_lock_check_batch';

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'get_lock_check_batch is absent';
  END IF;
  IF v_src NOT LIKE '%w.wallet_address = h.addr%' THEN
    RAISE EXCEPTION 'per-wallet lateral missing — the revert did not hold';
  END IF;
  IF v_src LIKE '%IN (SELECT hot.addr FROM hot)%' THEN
    RAISE EXCEPTION 'single-scan hot leg present — it measured WORSE; do not re-apply';
  END IF;
  IF v_src NOT LIKE '%ROW_NUMBER() OVER%' OR v_src NOT LIKE '%forced_priority%' THEN
    RAISE EXCEPTION 'ranking/priority logic lost from get_lock_check_batch';
  END IF;
END $$;
