-- audit_20261015_market_rpcs_v3_owned_filter
--
-- 2026-10-15 (Claude Code cloud; Trevor: "Take care of all of this"). The
-- Market's Owned / Not owned filter ran in the browser over the 50 listings on
-- the page, so "Owned" showed the few owned editions that happened to be on
-- page 1, not every owned edition on the market.
--
-- get_topshot_sniper_deals_v3 / get_allday_market_editions_v3 = v2
-- (20261015033610), read LIVE via pg_get_functiondef and spliced at guarded
-- anchors, plus:
--   p_wallet text, p_owned text ('owned' | 'not_owned')
--   owned     = EXISTS     a wallet_moments_cache row (wallet, this collection,
--   not_owned = NOT EXISTS   edition_key = e.external_id)
-- Probed on idx_wmc_wallet_coll_ek_fmv_tier (wallet_address, collection_id,
-- edition_key). wallet_moments_cache.edition_key = editions.external_id exactly
-- for both collections (20,000-row samples each, 20,000/20,000 match), Top Shot
-- parallels included ("257:8869::17") — the browser filter joined Top Shot on the
-- set:play form, which mismatched parallels. New NAMES rather than a re-signature,
-- because replacing needs CREATE OR REPLACE / DROP, which the MCP holds in this
-- headless session.
--
-- Verified after apply (2026-10-15):
--   Top Shot, wallet with 526 listed owned editions: owned 526 + not_owned 13,241
--     = all 13,767; owned = an independent EXISTS count over the unfiltered set
--     (526); 128–386 ms.
--   All Day: owned 217 + not_owned 4,180 = all 4,397; the fmv-sort path agrees
--     (217); v3 = v2 at default arguments (identical hash, 500 rows).
--
-- anon-exec: revoked (get_topshot_sniper_deals_v3) — new fn; postgres/service_role only, matching v2 (verified has_function_privilege anon=false).
-- anon-exec: revoked (get_allday_market_editions_v3) — new fn; postgres/service_role only, matching v2 (verified has_function_privilege anon=false).
-- anon-exec: unchanged (get_topshot_sniper_deals_v2) — only READ here (anchor text); not created, replaced or re-granted.
-- anon-exec: unchanged (get_allday_market_editions_v2) — only READ here (anchor text); not created, replaced or re-granted.
--
-- REVERT: point /api/market back at the _v2 names;
--   DROP FUNCTION public.get_topshot_sniper_deals_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text);
--   DROP FUNCTION public.get_allday_market_editions_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text);

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
  hdr_old constant text := E'p_has_badges boolean DEFAULT false)\n RETURNS';
  hdr_new constant text := E'p_has_badges boolean DEFAULT false, p_wallet text DEFAULT NULL::text, p_owned text DEFAULT NULL::text)\n RETURNS';
BEGIN
  -- ── Top Shot (dynamic SQL: the new args are $14 $15) ──
  SELECT pg_get_functiondef('public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_topshot_sniper_deals_v2(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_topshot_sniper_deals_v3(');

  n := (length(def) - length(replace(def, hdr_old, ''))) / length(hdr_old);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot header anchor found % times, want 1', n; END IF;
  def := replace(def, hdr_old, hdr_new);

  anc := E'      AND (NOT COALESCE($13, false) OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id))\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot has-badges anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc
    || E'      AND ($15 IS NULL OR $14 IS NULL\n'
    || E'           OR ($15 = ''owned''     AND     EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = $14 AND w.collection_id = e.collection_id AND w.edition_key = e.external_id))\n'
    || E'           OR ($15 = ''not_owned'' AND NOT EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = $14 AND w.collection_id = e.collection_id AND w.edition_key = e.external_id)))\n');

  anc := 'USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_sets, p_series, p_player, p_min_price, p_teams, p_badges, p_has_badges;';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot USING anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    'USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_sets, p_series, p_player, p_min_price, p_teams, p_badges, p_has_badges, p_wallet, p_owned;');

  EXECUTE def;

  -- ── All Day (two filter blocks) ──
  SELECT pg_get_functiondef('public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_allday_market_editions_v2(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_allday_market_editions_v3(');

  n := (length(def) - length(replace(def, hdr_old, ''))) / length(hdr_old);
  IF n <> 1 THEN RAISE EXCEPTION 'allday header anchor found % times, want 1', n; END IF;
  def := replace(def, hdr_old, hdr_new);

  anc := E'        AND (NOT COALESCE(p_has_badges, false) OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id))\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 2 THEN RAISE EXCEPTION 'allday has-badges anchor found % times, want 2', n; END IF;
  def := replace(def, anc, anc
    || E'        AND (p_owned IS NULL OR p_wallet IS NULL\n'
    || E'             OR (p_owned = ''owned''     AND     EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p_wallet AND w.collection_id = e.collection_id AND w.edition_key = e.external_id))\n'
    || E'             OR (p_owned = ''not_owned'' AND NOT EXISTS (SELECT 1 FROM wallet_moments_cache w WHERE w.wallet_address = p_wallet AND w.collection_id = e.collection_id AND w.edition_key = e.external_id)))\n');

  EXECUTE def;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.get_topshot_sniper_deals_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_sniper_deals_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.get_allday_market_editions_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_market_editions_v3(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean, text, text) TO postgres, service_role;
