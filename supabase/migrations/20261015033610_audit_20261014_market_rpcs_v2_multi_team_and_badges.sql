-- audit_20261014_market_rpcs_v2_multi_team_and_badges
--
-- The Top Shot / All Day Market RPCs took ONE `p_team`, so /api/market sent
-- teams[0] and a 2-team pick filtered by the first only; and they had no badge
-- filter, so the route filtered badges in memory over their ≤500-row window.
--
-- get_topshot_sniper_deals_v2 / get_allday_market_editions_v2 are the v1 bodies
-- (read LIVE via pg_get_functiondef, spliced at guarded anchors — the form
-- 20260923234631 / 20260926141315 / 20261010085932 used) plus three defaulted
-- arguments:
--   p_teams text[]        btrim(team_name) ILIKE ANY (p_teams) — p_team's own
--                         case-insensitive match, over every selected team
--   p_badges text[]       edition carries ANY of them in market_edition_badges'
--                         latest run
--   p_has_badges boolean  edition carries any badge there
-- New NAMES rather than a re-signature of v1, because replacing v1 needs a DROP
-- (two overloads with defaults make every 10-named-arg call ambiguous) and the
-- MCP held every DROP this session. v1 stays for /api/sniper-feed and
-- /api/cron/warm, unchanged; /api/market moves to v2 in the same push.
--
-- Verified after apply (2026-10-14 ~8:40 PM PT):
--   no-change control — with the new args unset, v2 = v1 on All Day price_asc
--     and discount_desc (500/500, identical hash); on Top Shot price_asc the
--     only differences are rows tied at the cut price ($0.23, 70-way tie),
--     where v1 differs from ITSELF by 3 rows across two calls; every row below
--     the cut matches.
--   positive — p_teams {Portland Fire, Seattle Storm} = 239 = 70 + 169 (each
--     team alone in v1), 2 distinct teams; All Day {Bills, Chiefs} = 353, 2 teams.
--   cost — Top Shot v1 68 ms / v2 37 ms / v2 + badge 124 ms; All Day v1 86 ms /
--     v2 + badge 92 ms (single warm calls).
--
-- anon-exec: revoked (get_topshot_sniper_deals_v2) — new fn; postgres/service_role only, matching v1 (verified has_function_privilege anon=false, authenticated=false).
-- anon-exec: revoked (get_allday_market_editions_v2) — new fn; postgres/service_role only, matching v1 (verified has_function_privilege anon=false, authenticated=false).
-- anon-exec: unchanged (get_topshot_sniper_deals) — v1 is only READ here (its definition text is an anchor string); not created, replaced or re-granted.
-- anon-exec: unchanged (get_allday_market_editions) — v1 is only READ here (its definition text is an anchor string); not created, replaced or re-granted.
--
-- REVERT: point /api/market back at the v1 names (it then sends teams[0] again);
--   DROP FUNCTION public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);
--   DROP FUNCTION public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean);

DO $mig$
DECLARE
  def text;
  anc text;
  n   int;
  hdr_old constant text := E'p_min_price numeric DEFAULT 0)\n RETURNS';
  hdr_new constant text := E'p_min_price numeric DEFAULT 0, p_teams text[] DEFAULT NULL::text[], p_badges text[] DEFAULT NULL::text[], p_has_badges boolean DEFAULT false)\n RETURNS';
  badge_any_ts constant text := E'      AND (COALESCE(cardinality($12), 0) = 0 OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id AND mb.title = ANY ($12)))\n';
  badge_has_ts constant text := E'      AND (NOT COALESCE($13, false) OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id))\n';
BEGIN
  -- ── Top Shot ──
  SELECT pg_get_functiondef('public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_topshot_sniper_deals(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_topshot_sniper_deals_v2(');

  n := (length(def) - length(replace(def, hdr_old, ''))) / length(hdr_old);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot header anchor found % times, want 1', n; END IF;
  def := replace(def, hdr_old, hdr_new);

  anc := E'      AND (COALESCE($4,   ''all'') = ''all'' OR e.team_name ILIKE $4)\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot team anchor found % times, want 1', n; END IF;
  def := replace(def, anc, anc
    || E'      AND (COALESCE(cardinality($11), 0) = 0 OR btrim(e.team_name) ILIKE ANY ($11))\n'
    || badge_any_ts || badge_has_ts);

  anc := 'USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_sets, p_series, p_player, p_min_price;';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'topshot USING anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    'USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_sets, p_series, p_player, p_min_price, p_teams, p_badges, p_has_badges;');

  EXECUTE def;

  -- ── All Day ──
  SELECT pg_get_functiondef('public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric)'::regprocedure)
    INTO def;

  anc := 'CREATE OR REPLACE FUNCTION public.get_allday_market_editions(';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'allday name anchor found % times, want 1', n; END IF;
  def := replace(def, anc, 'CREATE FUNCTION public.get_allday_market_editions_v2(');

  n := (length(def) - length(replace(def, hdr_old, ''))) / length(hdr_old);
  IF n <> 1 THEN RAISE EXCEPTION 'allday header anchor found % times, want 1', n; END IF;
  def := replace(def, hdr_old, hdr_new);

  anc := E'OR e.team_name ILIKE p_team)\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 2 THEN RAISE EXCEPTION 'allday team anchor found % times, want 2', n; END IF;
  def := replace(def, anc, anc
    || E'        AND (COALESCE(cardinality(p_teams), 0) = 0 OR btrim(e.team_name) ILIKE ANY (p_teams))\n'
    || E'        AND (COALESCE(cardinality(p_badges), 0) = 0 OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id AND mb.title = ANY (p_badges)))\n'
    || E'        AND (NOT COALESCE(p_has_badges, false) OR EXISTS (SELECT 1 FROM market_edition_badges mb JOIN market_edition_badges_runs mr ON mr.collection_id = mb.collection_id AND mr.last_run_at = mb.refreshed_at WHERE mb.edition_id = e.id))\n');

  EXECUTE def;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_sniper_deals_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean) TO postgres, service_role;
REVOKE EXECUTE ON FUNCTION public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_market_editions_v2(numeric, numeric, text, text, text, integer, text[], text[], text, numeric, text[], text[], boolean) TO postgres, service_role;
