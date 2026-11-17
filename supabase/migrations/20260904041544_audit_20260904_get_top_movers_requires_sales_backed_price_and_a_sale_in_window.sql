-- audit_20260904_get_top_movers_requires_sales_backed_price_and_a_sale_in_window
-- Applied to prod via MCP apply_migration 2026-09-04 04:15Z (version 20260904041544).
--
-- Second cut of the same finding (20260904041433 excluded STALE/NO_DATA). Re-read after that ship:
-- the new "gainers" were ASK_ONLY / LOW prices with ZERO sales in 14 days — Billy Cunningham
-- $290 -> $900 (+210%) is a seller's ask, not a trade. A "mover" is an edition whose market moved,
-- so the honest population is: current price sales-backed (HIGH/MEDIUM/LOW/SALES_ONLY) AND at least
-- one sale inside the window. Measured on the founder's 19,403-moment wallet: 3,110 of 8,596 owned
-- editions qualify; top gainer LeBron Base Set +$21.51 HIGH (4 sales), top loser LeBron First Round
-- -$357 MEDIUM (6 sales). Cost: the EXISTS semi-join runs BEFORE the fmv_snapshots lateral and cuts
-- its loops 8,601 -> 3,115; EXPLAIN (ANALYZE, BUFFERS) 68,274 buffers / 198 ms warm — not more than
-- the pre-change shape (ledger 2026-09-02: 58,300 buffers). Empty-wallet control: [] / [].
-- anon-exec: unchanged (get_top_movers) — splice, same signature; anon/authenticated EXECUTE stand as before.
--
-- REVERT: same block with v_old/v_new swapped (both literals are in this file).
DO $mig$
DECLARE v_def text; v_def2 text; v_hits int;
  v_old text := $old$WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL
      -- 2026-09-04: a STALE/NO_DATA current price is not a market move (see migration header)
      AND l.confidence NOT IN ('STALE','NO_DATA')$old$;
  v_new text := $new$WHERE l.fmv_usd IS NOT NULL AND p.fmv_usd IS NOT NULL
      -- 2026-09-04: a mover is an edition whose MARKET moved. The current price must be
      -- sales-backed (not STALE / NO_DATA / ASK_ONLY) and the edition must have traded inside
      -- the window; otherwise the "delta" is an algorithm re-pricing or a seller's ask.
      AND l.confidence IN ('HIGH','MEDIUM','LOW','SALES_ONLY')
      AND EXISTS (SELECT 1 FROM sales s
                   WHERE s.edition_id = o.edition_id AND s.sold_at > v_threshold)$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='get_top_movers';
  IF v_def IS NULL THEN RAISE EXCEPTION 'get_top_movers not found'; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'expected 1 anchor occurrence, found %', v_hits; END IF;
  v_def2 := replace(v_def, v_old, v_new);
  IF v_def2 = v_def THEN RAISE EXCEPTION 'replacement was a no-op'; END IF;
  EXECUTE v_def2;
END $mig$;
