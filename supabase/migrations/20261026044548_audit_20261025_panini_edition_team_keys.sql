-- audit_20261025: Panini edition -> franchise map from three sources, so team hubs see WNBA / NFL / MLB cards the
-- team walk has not reached (Top Shot parity pass, 2026-10-25 evening PT; Trevor: "Keep going and do it all").
--
-- The hubs' Panini panel read only panini_team_listings (cards seen under Panini's marketplace team filter by the
-- laptop's team walk). Measured 10-25 ~9:40 PM PT: WNBA 0 / 3,719 catalogued cards on a team (the walk's WNBA URL
-- was broken — fixed the same night), NFL 1,320 / 11,005, MLB 102 / 735. Two sources were already in the DB:
--   · printed  — panini_editions.nation: the soccer runner stores the grid's `team` field there for EVERY sport
--                (~2,400 non-soccer editions carry a team), resolved through the same panini_resolve_team_keys_for.
--   · sibling  — a card with no own evidence takes the team that EVERY evidenced card of the same player in the
--                same product agrees on. Leave-one-out on the evidenced cards: 10,806 / 10,835 correct (99.7 %);
--                Baseball 89/89, WNBA 518/518, NFL 1,295/1,298, NBA 8,904/8,932 (130 abstain where siblings disagree).
-- panini_edition_team_keys holds one row per catalogued Basketball / Baseball / Football / Womens Basketball
-- edition (listing > printed > sibling > none '{}'); refreshed hourly at :32 (refresh_panini_edition_team_keys,
-- ~2 s, ~24k buffers, logs pipeline_runs 'panini-edition-team-keys'). The three readers (panel, editions page,
-- sitemap list) read it; the panel's coverage counts it and is shown only when the map refreshed ok in 26 h.
-- First run: WNBA 2,421 / 3,719 · NFL 3,307 / 11,005 · NBA 10,898 / 11,085 · MLB 431 / 735; indexable hubs 107.
-- Rows are never deleted (a row that loses its evidence becomes source 'none', keys '{}').
-- Bases: the three reader bodies were md5-checked against the live prosrc before the rewrite (equal).
--
-- Revert: SELECT cron.unschedule('panini-edition-team-keys'); re-apply get_panini_franchise_panel from
--         20261025152625, get_panini_franchise_editions from 20261023060839 and list_indexable_franchise_hubs from
--         20261023073556; then DROP FUNCTION public.refresh_panini_edition_team_keys(); DROP TABLE public.panini_edition_team_keys;

-- anon-exec: revoked (refresh_panini_edition_team_keys) — new SECURITY DEFINER writer; REVOKE FROM PUBLIC, anon, authenticated below.
-- anon-exec: intentional — CREATE OR REPLACE of an existing reader keeps its ACL (postgres + service_role only, read 2026-10-25) (get_panini_franchise_panel)
-- anon-exec: intentional — CREATE OR REPLACE of an existing reader keeps its ACL (postgres + service_role only, read 2026-10-25) (get_panini_franchise_editions)
-- anon-exec: intentional — CREATE OR REPLACE of an existing reader keeps its ACL (postgres + service_role only, read 2026-10-25) (list_indexable_franchise_hubs)

CREATE TABLE IF NOT EXISTS public.panini_edition_team_keys (
  external_id     text        PRIMARY KEY,
  sport           text        NOT NULL,
  franchise_keys  text[]      NOT NULL DEFAULT '{}',
  source          text        NOT NULL CHECK (source IN ('listing', 'printed', 'sibling', 'none')),
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS panini_edition_team_keys_sport_idx ON public.panini_edition_team_keys (sport);
CREATE INDEX IF NOT EXISTS panini_edition_team_keys_keys_gin ON public.panini_edition_team_keys USING gin (franchise_keys);

ALTER TABLE public.panini_edition_team_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_edition_team_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.panini_edition_team_keys TO service_role;

COMMENT ON TABLE public.panini_edition_team_keys IS
  'Panini catalogued edition -> franchise keys (NBA:blazers), one row per catalogued Basketball / Baseball / Football / Womens Basketball edition (audit_20261025). source: listing = the team walk saw it under that team filter (panini_team_listings); printed = the team Panini prints on the card (panini_editions.nation, the grid''s team field), through the same resolver; sibling = no own evidence, and every evidenced edition of the same player in the same product agrees on one key set (leave-one-out 10,806 / 10,835 = 99.7 %, 2026-10-25); none = not placed ({}). Never deleted: a row that loses its evidence becomes none. Refreshed hourly by refresh_panini_edition_team_keys().';

CREATE OR REPLACE FUNCTION public.refresh_panini_edition_team_keys()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started timestamptz := clock_timestamp();
  v_rows    integer := 0;
  v_mapped  integer := 0;
BEGIN
  WITH cat AS MATERIALIZED (
    SELECT pe.external_id, pp.last_grid_sport AS sport, pe.product_set_id,
           nullif(btrim(pe.player_name), '') AS player_name,
           nullif(btrim(pe.nation), '')      AS printed_team,
           substring(pp.name FROM '(?:19|20)[0-9]{2}')::int AS name_year
      FROM public.panini_editions pe
      JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
     WHERE pp.last_grid_sport IN ('Basketball', 'Baseball', 'Football', 'Womens Basketball')
  ), lk AS MATERIALIZED (
    SELECT l.psku AS external_id, array_agg(DISTINCT k ORDER BY k) AS keys
      FROM public.panini_team_listings l
     CROSS JOIN LATERAL unnest(l.franchise_keys) k
     GROUP BY l.psku
  ), yr AS MATERIALIZED (
    -- a card's year for MLB shared-city resolution: the walk's genesis_year for the product, else the product name's year
    SELECT l.set_id, max(l.genesis_year)::int AS y
      FROM public.panini_team_listings l
     WHERE l.genesis_year IS NOT NULL
     GROUP BY l.set_id
  ), c2 AS MATERIALIZED (
    SELECT c.*,
           CASE WHEN c.sport = 'Baseball' THEN c.player_name END                 AS athlete,
           CASE WHEN c.sport = 'Baseball' THEN coalesce(yr.y, c.name_year) END   AS y
      FROM cat c LEFT JOIN yr ON yr.set_id = c.product_set_id::text
  ), pt AS MATERIALIZED (
    SELECT d.sport, d.printed_team, d.athlete, d.y, r.keys
      FROM (SELECT DISTINCT sport, printed_team, athlete, y FROM c2 WHERE printed_team IS NOT NULL) d
     CROSS JOIN LATERAL public.panini_resolve_team_keys_for(d.sport, d.printed_team, d.athlete, d.y) r
  ), own AS MATERIALIZED (
    SELECT c.external_id, c.sport, c.product_set_id, c.player_name,
           CASE WHEN cardinality(lk.keys) > 0 THEN lk.keys WHEN cardinality(pt.keys) > 0 THEN pt.keys END AS keys,
           CASE WHEN cardinality(lk.keys) > 0 THEN 'listing' WHEN cardinality(pt.keys) > 0 THEN 'printed' END AS source
      FROM c2 c
      LEFT JOIN lk ON lk.external_id = c.external_id
      LEFT JOIN pt ON pt.sport = c.sport AND pt.printed_team = c.printed_team
                  AND pt.athlete IS NOT DISTINCT FROM c.athlete AND pt.y IS NOT DISTINCT FROM c.y
  ), grp AS MATERIALIZED (
    SELECT product_set_id, player_name, min(keys::text) AS k, count(DISTINCT keys::text) AS nk
      FROM own
     WHERE keys IS NOT NULL AND player_name IS NOT NULL AND product_set_id IS NOT NULL
     GROUP BY 1, 2
  ), want AS (
    SELECT o.external_id, o.sport,
           coalesce(o.keys, CASE WHEN g.nk = 1 THEN g.k::text[] END, '{}'::text[]) AS keys,
           coalesce(o.source, CASE WHEN g.nk = 1 THEN 'sibling' END, 'none')        AS source
      FROM own o
      LEFT JOIN grp g ON g.product_set_id = o.product_set_id AND g.player_name = o.player_name
  )
  INSERT INTO public.panini_edition_team_keys AS t (external_id, sport, franchise_keys, source, computed_at)
  SELECT external_id, sport, keys, source, v_started FROM want
  ON CONFLICT (external_id) DO UPDATE SET
    sport = EXCLUDED.sport, franchise_keys = EXCLUDED.franchise_keys,
    source = EXCLUDED.source, computed_at = EXCLUDED.computed_at
  WHERE (t.sport, t.franchise_keys, t.source) IS DISTINCT FROM (EXCLUDED.sport, EXCLUDED.franchise_keys, EXCLUDED.source);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*) INTO v_mapped FROM public.panini_edition_team_keys WHERE cardinality(franchise_keys) > 0;

  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, v_mapped, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'changed', v_rows, 'mapped', v_mapped));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.refresh_panini_edition_team_keys() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_panini_edition_team_keys() TO postgres, service_role;

SELECT public.refresh_panini_edition_team_keys();

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

CREATE OR REPLACE FUNCTION public.get_panini_franchise_editions(p_league text, p_team_slug text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
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
    SELECT
      COALESCE(e.external_id, e.id::text)                AS route_slug,
      e.player_name,
      e.name,
      e.set_name,
      CASE WHEN s.external_id LIKE 'panini-%' THEN substring(s.external_id FROM 8) END AS set_slug,
      e.tier::text                                       AS tier,
      CASE e.tier::text
        WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
        WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
        WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
        ELSE 99
      END                                                AS tier_rank,
      e.series::text                                     AS series_label,
      e.series                                           AS series_num,
      e.circulation_count,
      e.thumbnail_url,
      public.entity_rep_nft_id(e.collection_id, e.external_id, e.id) AS rep_nft_id,
      e.video_url,
      e.team_name,
      e.subedition_name,
      e.play_category,
      e.game_date,
      e.play_type,
      fmv.fmv_usd,
      fmv.floor_price_usd                                AS floor_usd,
      fmv.confidence::text                               AS fmv_confidence,
      fmv.computed_at                                    AS fmv_computed_at,
      e.first_minted_at,
      e.id                                               AS edition_id
    FROM public.editions e
    JOIN mapped m ON e.external_id = m.psku
    LEFT JOIN public.sets s ON s.id = e.set_id
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd, confidence, computed_at FROM public.fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
      AND e.thumbnail_url IS NOT NULL
    ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST, e.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 24), 1), 200)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(ed.*) - 'first_minted_at' - 'edition_id'
                            ORDER BY ed.fmv_usd DESC NULLS LAST, ed.first_minted_at DESC NULLS LAST, ed.edition_id),
                  '[]'::jsonb)
  FROM ed;
$function$;

CREATE OR REPLACE FUNCTION public.list_indexable_franchise_hubs()
 RETURNS TABLE(league text, slug text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT tm.league::text, tm.slug::text
  FROM public.teams_master tm
  WHERE tm.active
    AND EXISTS (SELECT 1 FROM public.league_collections lc WHERE lc.league = tm.league AND lc.enabled)
    AND EXISTS (
      SELECT 1
      FROM public.panini_edition_team_keys t
      JOIN public.editions e ON e.external_id = t.external_id
      WHERE e.collection_id = 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b'::uuid
        AND t.franchise_keys @> ARRAY[tm.league::text || ':' || tm.slug]
    )
  ORDER BY tm.league::text, tm.slug;
$function$;

SELECT cron.schedule('panini-edition-team-keys', '32 * * * *', $$SELECT public.refresh_panini_edition_team_keys()$$);
