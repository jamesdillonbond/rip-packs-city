-- 2026-10-25 — get_panini_franchise_panel: the league-wide coverage count is
-- computed once an hour, and the FMV total reads edition_fmv_current.
--
-- WHY (nightly 10-25 queue item, measured this morning): one call costs ~1 s warm,
-- in two halves.
--   * ~0.45 s / 10,446 buffers is the `coverage` CTE: a seq scan of all ~239k
--     panini_team_listings rows (unnest + LIKE 'NBA:%') and every Panini edition
--     joined to panini_products. It depends on the LEAGUE only, so every franchise
--     hub in a league recomputed the same two numbers. A crawler/ISR sweep of ~30
--     NBA hubs at 06:32Z ran it ~30× at once and tipped the page's 10 s bound
--     (pg_stat_statements: 709 calls, mean 1,736 ms, max 13,805 ms).
--   * ~0.49 s / 10,151 buffers (726 from disk) is the per-edition
--     `fmv_snapshots ORDER BY computed_at DESC LIMIT 1` lateral (523 probes for
--     the Lakers) — the read edition_fmv_current exists to replace.
--
-- EQUIVALENCE (proved before shipping, not assumed):
--   * edition_fmv_current vs the latest fmv_snapshots row: identical fmv_usd AND
--     computed_at on 1,290 / 1,290 editions of three franchises (Lakers, Bills,
--     Hawks) and on 6,000 / 6,000 randomly sampled Panini editions.
--   * The view's per-league counts use the same predicates as the CTE they
--     replace (split_part(k, ':', 1) = league is `k LIKE league || ':%'`).
--
-- HONESTY: the panel reads the view only while its row is < 26 h old; a missing
-- or stale row falls back to the live computation (the original CTE, unchanged),
-- so a stalled refresh can never freeze or blank the coverage line.
--
-- Revert: cron.unschedule('rpc-panini-league-coverage'); re-apply the
-- get_panini_franchise_panel body from 20261023060839; DROP FUNCTION
-- public.refresh_panini_league_coverage(); DROP MATERIALIZED VIEW
-- public.mv_panini_league_coverage.

CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_panini_league_coverage AS
WITH sport(league, s) AS (
  VALUES ('NBA', 'Basketball'), ('WNBA', 'Womens Basketball'), ('NFL', 'Football'), ('MLB', 'Baseball')
),
lm AS MATERIALIZED (
  SELECT DISTINCT split_part(k, ':', 1) AS league, l.psku
    FROM public.panini_team_listings l, unnest(l.franchise_keys) k
),
cat AS MATERIALIZED (
  SELECT e.external_id, pp.last_grid_sport AS s
    FROM public.editions e
    JOIN public.panini_products pp
      ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
   WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
     AND e.external_id LIKE 'packcard-%'
)
SELECT sp.league,
       sp.s AS sport,
       count(c.external_id)::int AS catalogued,
       count(c.external_id) FILTER (
         WHERE EXISTS (SELECT 1 FROM lm WHERE lm.league = sp.league AND lm.psku = c.external_id)
       )::int AS mapped,
       now() AS computed_at
  FROM sport sp
  LEFT JOIN cat c ON c.s = sp.s
 GROUP BY sp.league, sp.s;

CREATE UNIQUE INDEX IF NOT EXISTS mv_panini_league_coverage_league
  ON public.mv_panini_league_coverage (league);

REVOKE ALL ON public.mv_panini_league_coverage FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.mv_panini_league_coverage TO service_role;

COMMENT ON MATERIALIZED VIEW public.mv_panini_league_coverage IS
  'Per league: Panini packcard editions catalogued for the league''s sport, and how many are mapped to a franchise. The franchise hubs'' Panini coverage line (get_panini_franchise_panel). Refreshed hourly by refresh_panini_league_coverage(). audit_20261025.';

CREATE OR REPLACE FUNCTION public.refresh_panini_league_coverage()
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_panini_league_coverage;
  SELECT count(*) INTO v_rows FROM public.mv_panini_league_coverage;
  PERFORM public.log_pipeline_run('panini-league-coverage', v_started, v_rows, v_rows, 0, v_rows = 4,
    CASE WHEN v_rows = 4 THEN NULL ELSE 'expected 4 league rows, got ' || v_rows END,
    NULL, NULL, NULL, jsonb_build_object('reads', 'get_panini_franchise_panel'));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-league-coverage', v_started, 0, 0, 0, false, SQLERRM,
    NULL, NULL, NULL, jsonb_build_object('sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

-- anon-exec: revoked (refresh_panini_league_coverage) — new maintenance function; postgres + service_role only.
REVOKE EXECUTE ON FUNCTION public.refresh_panini_league_coverage() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_league_coverage() TO postgres, service_role;

-- anon-exec: unchanged (get_panini_franchise_panel) — CREATE OR REPLACE of an existing fn; ACL preserved, verified has_function_privilege(anon)=false on 10-25.
CREATE OR REPLACE FUNCTION public.get_panini_franchise_panel(p_league text, p_team_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH mapped AS (
    SELECT DISTINCT l.psku
    FROM public.panini_team_listings l
    WHERE l.franchise_keys @> ARRAY[upper(btrim(p_league)) || ':' || lower(btrim(p_team_slug))]
  ),
  ed AS (
    SELECT e.id, e.player_id, e.player_name, e.circulation_count
    FROM public.editions e
    JOIN mapped m ON e.external_id = m.psku
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
  ),
  stats AS (
    SELECT count(*)::int AS n,
           count(DISTINCT coalesce(ed.player_id::text, ed.player_name))::int AS players,
           sum(ed.circulation_count)::bigint AS mint,
           sum(fmv.fmv_usd) FILTER (WHERE fmv.fmv_usd > 0) AS fmv_total
    FROM ed
    LEFT JOIN public.edition_fmv_current fmv ON fmv.edition_id = ed.id
  ),
  sport AS (
    SELECT CASE upper(btrim(p_league))
             WHEN 'NBA'  THEN 'Basketball'
             WHEN 'WNBA' THEN 'Womens Basketball'
             WHEN 'NFL'  THEN 'Football'
             WHEN 'MLB'  THEN 'Baseball'
           END AS s
  ),
  cov_mv AS (
    SELECT c.catalogued, c.mapped
    FROM public.mv_panini_league_coverage c
    WHERE c.league = upper(btrim(p_league))
      AND c.computed_at > now() - interval '26 hours'
  ),
  league_mapped AS (
    SELECT DISTINCT l.psku
    FROM public.panini_team_listings l
    WHERE EXISTS (SELECT 1 FROM unnest(l.franchise_keys) k WHERE k LIKE upper(btrim(p_league)) || ':%')
  ),
  cov_live AS (
    SELECT count(*)::int AS catalogued,
           count(*) FILTER (WHERE e.external_id IN (SELECT psku FROM league_mapped))::int AS mapped
    FROM public.editions e
    JOIN public.panini_products pp
      ON pp.set_id::text = split_part(substr(e.external_id, 10), '_', 1)
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.external_id LIKE 'packcard-%'
      AND pp.last_grid_sport = (SELECT s FROM sport)
  ),
  coverage AS (
    SELECT catalogued, mapped FROM cov_mv
    UNION ALL
    SELECT x.catalogued, x.mapped FROM cov_live x WHERE NOT EXISTS (SELECT 1 FROM cov_mv)
  )
  SELECT CASE WHEN st.n = 0 THEN NULL ELSE jsonb_build_object(
    'edition_count',     st.n,
    'player_count',      st.players,
    'total_circulation', st.mint,
    'fmv_total_usd',     st.fmv_total,
    'coverage', jsonb_build_object(
      'sport',      (SELECT s FROM sport),
      'catalogued', CASE WHEN (SELECT s FROM sport) IS NULL THEN NULL ELSE (SELECT catalogued FROM coverage LIMIT 1) END,
      'mapped',     CASE WHEN (SELECT s FROM sport) IS NULL THEN NULL ELSE (SELECT mapped FROM coverage LIMIT 1) END)
  ) END
  FROM stats st;
$function$;

-- Hourly at :27 (no other active job is pinned to that minute, measured 10-25); the refresh is ~2 s.
SELECT cron.schedule('rpc-panini-league-coverage', '27 * * * *',
  $$select public.refresh_panini_league_coverage()$$);
