-- audit_20260925_topshot_market_recent_sort_orders_by_listing_time
--
-- known-issues #146 (1). The Market tab's DEFAULT sort, "Recently listed", maps to
-- p_sort_by='listed_desc' for Top Shot, and get_topshot_sniper_deals has no branch for
-- it: its ORDER BY falls through to discount DESC, so the RPC returned the ~500
-- DEEPEST-DISCOUNT editions and /api/market re-sorted THAT window by listed_at.
-- "Recently listed" on Top Shot was "the deepest discounts, in date order".
--
-- FIX: a NEW sort key, 'recent_desc', ordering by badge_editions.updated_at (the
-- value the RPC already returns as listed_at) in both the pre-LIMIT `ranked` CTE and
-- the outer ORDER BY. 'listed_desc' is deliberately left as it is: /api/sniper-feed's
-- sparse-pool augmentation and /api/cron/warm also send it, and changing what that
-- key means would silently change the Sniper. /api/market (and the warmer that
-- mirrors it) switch to 'recent_desc' in the same push.
--
-- SHAPE: body-only CREATE OR REPLACE from the LIVE pg_get_functiondef() with guarded
-- splices that RAISE unless each anchor appears exactly once. Same signature, so the
-- ACL is preserved (verified before: anon=false, authenticated=false).
-- anon-exec: unchanged (get_topshot_sniper_deals) — body-only CREATE OR REPLACE of an existing fn; ACL preserved, has_function_privilege anon=false verified 2026-09-25.
--
-- REVERT: re-apply the inverse splice (remove the two `recent_desc` CASE lines), or
-- simply stop sending 'recent_desc' (an unknown key falls through to discount DESC,
-- the pre-migration behaviour).

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
BEGIN
  SELECT pg_get_functiondef('public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := E'      CASE WHEN $5 = ''fmv_desc''   THEN COALESCE(CASE WHEN efc.computed_at > now() - interval ''90 days'' THEN efc.fmv_usd END, lf.fmv_usd) END DESC NULLS LAST,\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'ranked ORDER BY anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc || E'      CASE WHEN $5 = ''recent_desc'' THEN be.updated_at END DESC NULLS LAST,\n');

  anc := E'    CASE WHEN $5 = ''fmv_desc''   THEN l.live_fmv END DESC NULLS LAST,\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'outer ORDER BY anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc || E'    CASE WHEN $5 = ''recent_desc'' THEN l.updated_at END DESC NULLS LAST,\n');

  EXECUTE def;
END
$mig$;
