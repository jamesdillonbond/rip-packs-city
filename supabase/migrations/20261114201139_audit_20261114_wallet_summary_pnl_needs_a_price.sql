-- 2026-11-14 (Claude Code cloud, ~12:15 PM PT) — fresh-eyes review of the wallet portfolio.
--
-- get_wallet_summary's cost-basis aggregates (cost_basis, current_fmv, pnl, moments_with_cost)
-- filtered on `buy_price IS NOT NULL` only. SUM(fmv_usd) skips a NULL price while SUM(buy_price)
-- does not, so a moment bought for $500 with no FMV added a $500 LOSS to the wallet's P&L, and
-- the client's own per-row fallback (lib/portfolio-summary-compute.ts) — which requires a price —
-- disagreed with the server for the same wallet. Splice: every one of the four aggregates now also
-- requires `fmv_usd IS NOT NULL` (an unpriced moment has no knowable P&L, so it leaves the P&L
-- set entirely: its cost too). Nothing else changes (zero-cost rows behave as before).
--
-- Catalog splice, md5-asserted: base md5(prosrc) 3ead3d7bd21e532cbecccac380953ab0, exactly 4
-- occurrences of the filter, rewritten through pg_get_functiondef so the header, search_path and
-- volatility are carried verbatim. CREATE OR REPLACE keeps the ACL.
-- anon-exec: unchanged (get_wallet_summary) — CREATE OR REPLACE of an existing fn; ACL preserved, read 2026-11-14 ~12:15 PM PT has_function_privilege('anon', …, 'EXECUTE') = true (the public Collection tab's wallet summary, unchanged).
--
-- Read back after apply (20261114201139): md5(prosrc) 9b152cae25f05537cd7e8f354c3c9bc0, anon EXECUTE still true.
-- Control wallet 0x5813c7fd815463ba (Disney Pinnacle): pnl 44.05 -> 350.05, cost_basis 8166.05 -> 7860.05,
-- moments_with_cost 1552 -> 1529 (23 unpriced moments, $306 of phantom loss, left the set); current_fmv
-- 8210.10 and wallet_fmv 16891.35 unchanged (the no-change control: those rows carried no price).
--
-- Revert: the inverse splice — replace 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL'
-- with 'FROM moment_data WHERE buy_price IS NOT NULL' (4 occurrences) in pg_get_functiondef and EXECUTE.
DO $$
DECLARE
  v_oid  oid := 'public.get_wallet_summary(text,uuid)'::regprocedure;
  v_old  text := 'FROM moment_data WHERE buy_price IS NOT NULL';
  v_new  text := 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL';
  v_src  text;
  v_def  text;
  v_n    int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '3ead3d7bd21e532cbecccac380953ab0' THEN
    RAISE EXCEPTION 'get_wallet_summary base drifted: md5 %', md5(v_src);
  END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 cost filters, found %', v_n; END IF;
  v_def := replace(pg_get_functiondef(v_oid), v_old, v_new);
  EXECUTE v_def;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF (length(v_src) - length(replace(v_src, v_new, ''))) / length(v_new) <> 4 THEN
    RAISE EXCEPTION 'splice did not land 4 times';
  END IF;
END $$;
