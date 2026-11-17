-- 2026-11-17 (Claude Code, Trevor's laptop, ~1:51 PM PT; Trevor: "Address as much of this as possible",
-- on the 11-17 daytime-audit handoff item 4 — the binder showing a subset larger than the whole).
--
-- The Collection tab headlines Wallet FMV = wallet_fmv − stale_fmv (STALE-priced moments shown apart,
-- #209), but get_wallet_summary's cost-basis aggregates (cost_basis, current_fmv, pnl,
-- moments_with_cost) summed every moment with a cost and a price, STALE ones included. So on
-- 0xbd94cade097e50ac (Top Shot) the P&L line read "Current FMV $46,311.15" for 15,470 moments under a
-- headline of $44,501.00 for the whole wallet — a subset larger than the whole.
--
-- Decision (delegated): P&L uses the headline's rule. A STALE price is not a current value, so a
-- STALE-priced moment leaves the P&L set entirely (its cost too, the same way an unpriced moment left
-- it on 11-14, 20261114201139). Given up: those moments' cost no longer appears in Cost Basis.
-- Disclosed instead: new field stale_with_cost_count (moments with a cost left out because their
-- price is STALE), which the binder prints beside the count.
-- Falsifier: a collector reading a P&L that moved without a sale — expected here, once, at deploy.
--
-- Catalog splice, md5-asserted: base md5(prosrc) 3da406da27a569551a98ee6afc2aaa2e, exactly 4
-- occurrences of the cost filter, rewritten through pg_get_functiondef (header, search_path and
-- volatility carried verbatim; CREATE OR REPLACE keeps the ACL).
-- anon-exec: unchanged (get_wallet_summary) — CREATE OR REPLACE of an existing fn; ACL preserved (the public Collection tab's wallet summary).
--
-- Read back after apply (20261117215147): md5(prosrc) cc08e0e8f3a1a07b6510bf7df4efb4bc, anon EXECUTE still true.
-- 0xbd94cade097e50ac Top Shot: current_fmv 46311.15 -> 41261.65 (headline 44501.00), cost_basis 124448.75 -> 119663.75,
-- moments_with_cost 15470 -> 15463, stale_with_cost_count 7; All Day 1973.36 -> 1545.83 (13 stale). No-change control:
-- 0x5813c7fd815463ba (0 stale with cost) identical on Top Shot, All Day and Pinnacle.
--
-- Revert: inverse splice — remove the stale_with_cost_count line, then replace
-- 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL AND confidence IS DISTINCT FROM ''STALE'''
-- with 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL' (4 occurrences) and EXECUTE.
DO $$
DECLARE
  v_oid    oid  := 'public.get_wallet_summary(text,uuid)'::regprocedure;
  v_old    text := 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL';
  v_new    text := 'FROM moment_data WHERE buy_price IS NOT NULL AND fmv_usd IS NOT NULL AND confidence IS DISTINCT FROM ''STALE''';
  v_anchor text := E'    ''acquisition_breakdown'', (\n';
  v_add    text := E'    ''stale_with_cost_count'', (SELECT COUNT(*) FROM moment_data WHERE confidence = ''STALE'' AND buy_price IS NOT NULL AND fmv_usd IS NOT NULL),\n';
  v_src    text;
  v_def    text;
  v_n      int;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF md5(v_src) <> '3da406da27a569551a98ee6afc2aaa2e' THEN
    RAISE EXCEPTION 'get_wallet_summary base drifted: md5 %', md5(v_src);
  END IF;
  v_n := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  IF v_n <> 4 THEN RAISE EXCEPTION 'expected 4 cost filters, found %', v_n; END IF;
  v_n := (length(v_src) - length(replace(v_src, v_anchor, ''))) / length(v_anchor);
  IF v_n <> 1 THEN RAISE EXCEPTION 'acquisition_breakdown anchor found % times', v_n; END IF;
  v_def := pg_get_functiondef(v_oid);
  v_def := replace(v_def, v_old, v_new);
  v_def := replace(v_def, v_anchor, v_add || v_anchor);
  EXECUTE v_def;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF (length(v_src) - length(replace(v_src, v_new, ''))) / length(v_new) <> 4 THEN
    RAISE EXCEPTION 'splice did not land 4 times';
  END IF;
  IF position('stale_with_cost_count' IN v_src) = 0 THEN
    RAISE EXCEPTION 'stale_with_cost_count did not land';
  END IF;
END $$;
