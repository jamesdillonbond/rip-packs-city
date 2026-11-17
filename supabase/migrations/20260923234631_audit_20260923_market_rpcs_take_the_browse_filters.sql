-- audit_20260923_market_rpcs_take_the_browse_filters
--
-- known-issues #129, Top Shot + All Day half. The Market tab's `Set` / `Series` / `Player` /
-- `Min price` filters are parsed by /api/market and then DROPPED for these two collections,
-- because their arms are RPCs with no parameter to carry them — while `countActiveFilters` still
-- shows the chip as active. Measured on production 09-20: `set=Base Set` on Top Shot returned
-- "WNBA Base Set" and "Archive Set 2014-19". Pinnacle and Candy were fixed at the source that day.
--
-- ⛔ Why not filter in the route: both RPCs return a CAPPED, sort-ordered window (limit 500+).
-- Filtering that window after the fact answers a set whose listings sit outside it with a
-- confident "no listings in this set" — worse than ignoring the filter. The filter must run
-- BEFORE the LIMIT, i.e. inside the RPC. Here it does: Top Shot's `ranked` CTE (pre-LIMIT) and
-- both of All Day's paths (the fast path's pre-LIMIT `top` CTE and the single-phase WHERE).
--
-- FOUR NEW TRAILING PARAMS, all defaulted so every existing by-name caller (/api/market,
-- /api/sniper-feed, /api/cron/warm) is unchanged:
--   p_sets      text[]  — trimmed exact match on editions.set_name (a stored name can carry stray
--                         whitespace while the row this API returns — and the value the UI sends
--                         back — is trimmed; equality on the raw column would match nothing)
--   p_series    text[]  — editions.series::text, the same value the RPC returns as series_name
--   p_player    text    — ILIKE %player%, the legacy arm's semantics
--   p_min_price numeric — floor/low ask >= p_min_price (0 = off)
-- An empty array / NULL / '' / 0 means "no filter".
--
-- 🚨 CREATE OR REPLACE with extra args makes an OVERLOAD (a 6-named-arg PostgREST call then
-- becomes ambiguous, 42725), so each function is DROPPED by its exact 6-arg signature and
-- re-created in the same transaction. The new definition is built from the LIVE
-- pg_get_functiondef() with guarded splices that RAISE unless each anchor appears exactly the
-- expected number of times — the ~5 k-char bodies are never retyped. A fresh CREATE gets the
-- default PUBLIC EXECUTE, so the ACL is restored to what it was (postgres + service_role only).
--
-- REVERT: DROP FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer,
-- text[], text[], text, numeric) and public.get_allday_market_editions(<same>), then re-create each
-- from this migration's inverse splice (remove the four params from the header, the four
-- predicate lines, and — Top Shot — the four extra USING args), then REVOKE ALL … FROM PUBLIC,
-- anon, authenticated; GRANT EXECUTE … TO service_role. Callers need no change: they only pass
-- the new params when a filter is set, and a revert would silently ignore them again (#129's
-- original state), not error.
--
-- anon-exec: revoked (get_topshot_sniper_deals) — re-created from pg_get_functiondef(); REVOKE ALL FROM PUBLIC, anon, authenticated + GRANT to service_role below restore the prior ACL (postgres=X, service_role=X).
-- anon-exec: revoked (get_allday_market_editions) — re-created from pg_get_functiondef(); REVOKE ALL FROM PUBLIC, anon, authenticated + GRANT to service_role below restore the prior ACL (postgres=X, service_role=X).

DO $mig$
DECLARE
  def  text;
  anc  text;
  rep  text;
  n    int;
BEGIN
  ---------------------------------------------------------------------------
  -- Top Shot: get_topshot_sniper_deals (dynamic SQL, positional $1..$6)
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef('public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer)'::regprocedure)
    INTO def;

  anc := 'p_limit integer DEFAULT 50)';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'TS header anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    'p_limit integer DEFAULT 50, p_sets text[] DEFAULT NULL::text[], p_series text[] DEFAULT NULL::text[], p_player text DEFAULT NULL::text, p_min_price numeric DEFAULT 0)');

  anc := E'      AND (COALESCE($2, 0) = 0    OR be.low_ask <= $2)\n';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'TS predicate anchor found % times, want 1', n; END IF;
  rep := anc
    || E'      AND (COALESCE(cardinality($7), 0) = 0 OR btrim(e.set_name) IN (SELECT btrim(x) FROM unnest($7) x))\n'
    || E'      AND (COALESCE(cardinality($8), 0) = 0 OR e.series::text = ANY($8))\n'
    || E'      AND (COALESCE(btrim($9), '''') = '''' OR e.player_name ILIKE ''%'' || btrim($9) || ''%'')\n'
    || E'      AND (COALESCE($10, 0) = 0 OR be.low_ask >= $10)\n';
  def := replace(def, anc, rep);

  anc := '$q$ USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit;';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'TS USING anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    '$q$ USING p_min_discount, p_max_price, p_rarity, p_team, p_sort_by, p_limit, p_sets, p_series, p_player, p_min_price;');

  DROP FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer);
  EXECUTE def;

  ---------------------------------------------------------------------------
  -- All Day: get_allday_market_editions (static SQL, two paths)
  ---------------------------------------------------------------------------
  SELECT pg_get_functiondef('public.get_allday_market_editions(numeric, numeric, text, text, text, integer)'::regprocedure)
    INTO def;

  anc := 'p_limit integer DEFAULT 500)';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 1 THEN RAISE EXCEPTION 'AD header anchor found % times, want 1', n; END IF;
  def := replace(def, anc,
    'p_limit integer DEFAULT 500, p_sets text[] DEFAULT NULL::text[], p_series text[] DEFAULT NULL::text[], p_player text DEFAULT NULL::text, p_min_price numeric DEFAULT 0)');

  -- Once in the fast path's pre-LIMIT `top` CTE, once in the single-phase WHERE.
  anc := 'AND (COALESCE(p_max_price, 0) = 0 OR g.floor_ask <= p_max_price)';
  n := (length(def) - length(replace(def, anc, ''))) / length(anc);
  IF n <> 2 THEN RAISE EXCEPTION 'AD predicate anchor found % times, want 2', n; END IF;
  rep := anc
    || E'\n        AND (COALESCE(cardinality(p_sets), 0) = 0 OR btrim(e.set_name) IN (SELECT btrim(x) FROM unnest(p_sets) x))'
    || E'\n        AND (COALESCE(cardinality(p_series), 0) = 0 OR e.series::text = ANY(p_series))'
    || E'\n        AND (COALESCE(btrim(p_player), '''') = '''' OR e.player_name ILIKE ''%'' || btrim(p_player) || ''%'')'
    || E'\n        AND (COALESCE(p_min_price, 0) = 0 OR g.floor_ask >= p_min_price)';
  def := replace(def, anc, rep);

  DROP FUNCTION public.get_allday_market_editions(numeric, numeric, text, text, text, integer);
  EXECUTE def;
END
$mig$;

REVOKE ALL ON FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer, text[], text[], text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_topshot_sniper_deals(numeric, numeric, text, text, text, integer, text[], text[], text, numeric) TO service_role;
REVOKE ALL ON FUNCTION public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_allday_market_editions(numeric, numeric, text, text, text, integer, text[], text[], text, numeric) TO service_role;
