-- audit_20260926_market_rpcs_take_fmv_asc_and_discount_asc
--
-- known-issues #146 (1), the half that is NOT a product question. The Market tab's
-- "FMV ↑" and "Discount ↑" sorts had no branch in either edition RPC, so
-- /api/market mapped them to 'listed_desc': the RPC returned the 500 most-recently
-- listed All Day editions (of 4,322 measured 2026-09-26) — or, on Top Shot, where
-- 'listed_desc' has no branch either, the 500 DEEPEST-discount editions (of
-- 13,661) — and the route re-sorted THAT window ascending. "FMV ↑" showed the
-- lowest FMV among the deepest discounts, not the lowest FMV on the market.
--
-- FIX: real ORDER BY branches for 'fmv_asc' and 'discount_asc' in both functions
-- (Top Shot: the pre-LIMIT `ranked` CTE and the outer ORDER BY; All Day: the
-- fmv-dependent ELSE branch, the only one those keys reach — the fast path is
-- price-only). /api/market maps the two keys 1:1 in the same push. Every other
-- key's order is unchanged: each new CASE is NULL unless its own key is sent.
--
-- SHAPE: body-only CREATE OR REPLACE from the LIVE pg_get_functiondef() with guarded
-- splices that RAISE unless each anchor appears exactly once. Same signatures, so
-- the ACLs are preserved.
-- anon-exec: unchanged (get_topshot_sniper_deals) — body-only CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false verified 2026-09-26.
-- anon-exec: unchanged (get_allday_market_editions) — body-only CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false verified 2026-09-26.
--
-- REVERT: re-apply the inverse splice (remove the new `fmv_asc` / `discount_asc`
-- CASE lines), or simply stop sending the two keys (an unknown key falls through to
-- each function's default order, the pre-migration behaviour).

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
BEGIN
  -- ── Top Shot ──────────────────────────────────────────────────────────────
  SELECT pg_get_functiondef('public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := E'      CASE WHEN $5 = ''recent_desc'' THEN be.updated_at END DESC NULLS LAST,\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot ranked ORDER BY anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc
    || E'      CASE WHEN $5 = ''fmv_asc''    THEN COALESCE(CASE WHEN efc.computed_at > now() - interval ''90 days'' THEN efc.fmv_usd END, lf.fmv_usd) END ASC NULLS LAST,\n'
    || E'      CASE WHEN $5 = ''discount_asc'' THEN ROUND(((COALESCE(CASE WHEN efc.computed_at > now() - interval ''90 days'' THEN efc.fmv_usd END, lf.fmv_usd) - be.low_ask)\n'
    || E'             / NULLIF(COALESCE(CASE WHEN efc.computed_at > now() - interval ''90 days'' THEN efc.fmv_usd END, lf.fmv_usd), 0)) * 100, 1) END ASC NULLS LAST,\n');

  anc := E'    CASE WHEN $5 = ''recent_desc'' THEN l.updated_at END DESC NULLS LAST,\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot outer ORDER BY anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc
    || E'    CASE WHEN $5 = ''fmv_asc''    THEN l.live_fmv END ASC NULLS LAST,\n'
    || E'    CASE WHEN $5 = ''discount_asc'' THEN l.live_discount END ASC NULLS LAST,\n');

  EXECUTE def;

  -- ── All Day ───────────────────────────────────────────────────────────────
  SELECT pg_get_functiondef('public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := E'      g.last_listed_at DESC NULLS LAST\n    LIMIT COALESCE(p_limit, 500);\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday ELSE ORDER BY anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
       E'      CASE WHEN p_sort_by = ''fmv_asc''    THEN fs.fmv_usd  END ASC NULLS LAST,\n'
    || E'      CASE WHEN p_sort_by = ''discount_asc'' THEN\n'
    || E'        (CASE WHEN fs.fmv_usd IS NOT NULL AND fs.fmv_usd > 0\n'
    || E'              THEN ((fs.fmv_usd - g.floor_ask) / fs.fmv_usd) END)\n'
    || E'      END ASC NULLS LAST,\n'
    || anc);

  EXECUTE def;
END
$mig$;
