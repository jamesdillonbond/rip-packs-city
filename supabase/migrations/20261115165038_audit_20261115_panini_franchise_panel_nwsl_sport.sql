-- 2026-11-15: NWSL hubs read Panini coverage from sport 'Womens Soccer' (drop #1065). Only change: one CASE arm.
-- anon-exec: unchanged (get_panini_franchise_panel) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
-- Revert: re-run without the NWSL arm (previous body identical otherwise).
CREATE OR REPLACE FUNCTION public.get_panini_franchise_panel(p_league text, p_team_slug text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH mapped AS (
    -- 2026-10-25: the per-edition team map (walk listing → printed team → sibling), not the raw walk listings.
    SELECT t.external_id AS psku
    FROM public.panini_edition_team_keys t
    WHERE t.franchise_keys @> ARRAY[upper(btrim(p_league)) || ':' || lower(btrim(p_team_slug))]
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
             WHEN 'NWSL' THEN 'Womens Soccer'
           END AS s
  ),
  -- 2026-10-25: coverage from the same map the panel reads — every catalogued edition of the
  -- sport has a row (franchise_keys '{}' = not placed on a team), refreshed hourly.
  coverage AS (
    SELECT count(*)::int AS catalogued,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unnest(t.franchise_keys) k
                                          WHERE k LIKE upper(btrim(p_league)) || ':%'))::int AS mapped
    FROM public.panini_edition_team_keys t
    WHERE t.sport = (SELECT s FROM sport)
    -- no coverage claim from a map that has not refreshed: no row → coverage NULL, never "0 of 0"
    HAVING EXISTS (SELECT 1 FROM public.pipeline_runs r
                    WHERE r.pipeline = 'panini-edition-team-keys' AND r.ok
                      AND r.finished_at > now() - interval '26 hours')
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
