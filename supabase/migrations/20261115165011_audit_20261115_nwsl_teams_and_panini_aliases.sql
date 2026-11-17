-- audit_20261115_nwsl_teams_and_panini_aliases
-- 2026-11-15 (Trevor: "do what makes sense" re NWSL coverage / Thorns hub ahead of Panini Blockchain drop #1065,
-- 2026 Prizm Black NWSL Soccer, Nov 20 8 AM PT). Companion to audit_20261115_league_t_add_nwsl (enum value NWSL).
--  1. panini_team_aliases_sport_check widened to 'Womens Soccer' (the drop's sport label).
--  2. The 16 2026 NWSL clubs in teams_master (league NWSL). Colours / external_id deliberately NULL (not guessed).
--  3. Panini team-string aliases → NWSL:<slug>. Strings from the pack page's team filter (lower-cased there); RPC
--     stores Panini strings Title Case, so both "FC" and "Fc" spellings are aliased. Dual cards ("x | x") are split
--     by panini_resolve_team_keys already.
--  4. refresh_panini_edition_team_keys: 'Womens Soccer' added to the catalogue sport whitelist — the ONLY change;
--     body otherwise byte-identical to the pin (pin md5 == live md5 00c969fd… verified before applying).
-- anon-exec: unchanged (refresh_panini_edition_team_keys) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false, authenticated=false.
-- Revert:
--   CREATE OR REPLACE the function from 20261026225742_audit_20261026_panini_team_keys_flow_moments.sql;
--   DELETE FROM panini_edition_team_keys WHERE sport = 'Womens Soccer';
--   DELETE FROM panini_team_aliases WHERE league = 'NWSL'; DELETE FROM teams_master WHERE league = 'NWSL';
--   restore panini_team_aliases_sport_check to the four sports.

ALTER TABLE public.panini_team_aliases DROP CONSTRAINT panini_team_aliases_sport_check;
ALTER TABLE public.panini_team_aliases ADD CONSTRAINT panini_team_aliases_sport_check
  CHECK (sport = ANY (ARRAY['Basketball'::text, 'Baseball'::text, 'Football'::text, 'Womens Basketball'::text, 'Womens Soccer'::text]));

WITH t(ord, slug, team_name, abbr) AS (VALUES
  (1,  'angel-city', 'Angel City FC',          'LA'),
  (2,  'bay-fc',     'Bay FC',                 'BAY'),
  (3,  'legacy',     'Boston Legacy FC',       'BOS'),
  (4,  'stars',      'Chicago Stars FC',       'CHI'),
  (5,  'summit',     'Denver Summit FC',       'DEN'),
  (6,  'gotham',     'Gotham FC',              'NJY'),
  (7,  'dash',       'Houston Dash',           'HOU'),
  (8,  'current',    'Kansas City Current',    'KC'),
  (9,  'courage',    'North Carolina Courage', 'NC'),
  (10, 'pride',      'Orlando Pride',          'ORL'),
  (11, 'thorns',     'Portland Thorns FC',     'POR'),
  (12, 'racing',     'Racing Louisville FC',   'LOU'),
  (13, 'wave',       'San Diego Wave FC',      'SD'),
  (14, 'reign',      'Seattle Reign FC',       'SEA'),
  (15, 'royals',     'Utah Royals FC',         'UTA'),
  (16, 'spirit',     'Washington Spirit',      'WAS')
)
INSERT INTO public.teams_master (league, slug, team_name, abbreviation, display_order, active)
SELECT 'NWSL'::public.league_t, slug, team_name, abbr, ord, true FROM t
ON CONFLICT (league, slug) DO NOTHING;

INSERT INTO public.panini_team_aliases (sport, raw_team, league, team_slug, note)
SELECT 'Womens Soccer', a.raw, 'NWSL'::public.league_t, a.slug, 'audit_20261115 NWSL drop #1065'
FROM (VALUES
  ('Angel City FC','angel-city'), ('Angel City Fc','angel-city'),
  ('Bay FC','bay-fc'), ('Bay Fc','bay-fc'),
  ('Boston Legacy FC','legacy'), ('Boston Legacy Fc','legacy'),
  ('Chicago Stars FC','stars'), ('Chicago Stars Fc','stars'),
  ('Denver Summit FC','summit'), ('Denver Summit Fc','summit'),
  ('Gotham FC','gotham'), ('Gotham Fc','gotham'), ('NJ/NY Gotham FC','gotham'),
  ('Houston Dash','dash'),
  ('Kansas City Current','current'),
  ('North Carolina Courage','courage'),
  ('Orlando Pride','pride'),
  ('Portland Thorns FC','thorns'), ('Portland Thorns Fc','thorns'),
  ('Racing Louisville FC','racing'), ('Racing Louisville Fc','racing'),
  ('San Diego Wave FC','wave'), ('San Diego Wave Fc','wave'),
  ('Seattle Reign FC','reign'), ('Seattle Reign Fc','reign'),
  ('Utah Royals','royals'), ('Utah Royals FC','royals'), ('Utah Royals Fc','royals'),
  ('Washington Spirit','spirit')
) AS a(raw, slug)
ON CONFLICT (sport, raw_team) DO NOTHING;

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
           substring(pp.name FROM '(?:19|20)[0-9]{2}')::int AS name_year,
           -- the product's season label ("2024", "2021-22") for the same-season rule (audit_20261026)
           substring(pp.name FROM '^((?:19|20)[0-9]{2}(?:-[0-9]{2})?)') AS season
      FROM public.panini_editions pe
      JOIN public.panini_products pp ON pp.set_id = pe.product_set_id
     WHERE pp.last_grid_sport IN ('Basketball', 'Baseball', 'Football', 'Womens Basketball', 'Womens Soccer')
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
    SELECT c.external_id, c.sport, c.product_set_id, c.player_name, c.season,
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
  ), sea AS MATERIALIZED (
    -- audit_20261026: the same player's DIRECTLY evidenced (listing / printed, one team) cards in the same sport and
    -- SEASON. Football and Baseball only (held out 10-26: NFL 1,411 / 1,418 = 99.5 %, MLB 73 / 74; NBA 96.5 % —
    -- trades and mixed season labels — and WNBA untestable, so not used). Never a two-player card.
    SELECT o.sport, o.season, o.player_name, min(o.keys[1]) AS k, count(DISTINCT o.keys[1]) AS nk
      FROM own o
     WHERE o.source IN ('listing', 'printed') AND cardinality(o.keys) = 1
       AND o.sport IN ('Football', 'Baseball') AND o.season IS NOT NULL
       AND o.player_name IS NOT NULL AND o.player_name NOT LIKE '%|%'
     GROUP BY 1, 2, 3
  ), mom AS MATERIALIZED (
    -- audit_20261026 (2): the player's team in that season from RPC's OWN Flow moments — Top Shot WNBA moments
    -- (game_date May–Oct = that year's season) and NFL All Day moments (Aug–Feb = the season starting that year),
    -- team_name resolved through teams_master. Held out 10-26 (cards with a listing / printed team, unanimous
    -- moments): WNBA 617 / 622 (99.2 %), NFL 1,428 / 1,435 (99.5 %).
    SELECT 'Womens Basketball'::text AS sport, 'topshot_moments'::text AS via, lower(e.player_name) AS pn,
           extract(year FROM e.game_date)::int AS sy, min('WNBA:' || tm.slug) AS k, count(DISTINCT tm.slug) AS nk
      FROM public.editions e
      JOIN public.teams_master tm ON tm.league = 'WNBA' AND tm.team_name = e.team_name
     WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
       AND e.game_date IS NOT NULL AND e.player_name IS NOT NULL
       AND extract(month FROM e.game_date) BETWEEN 5 AND 10
     GROUP BY 1, 2, 3, 4
    UNION ALL
    SELECT 'Football'::text, 'allday_moments'::text, lower(e.player_name),
           (CASE WHEN extract(month FROM e.game_date) >= 8 THEN extract(year FROM e.game_date)
                 ELSE extract(year FROM e.game_date) - 1 END)::int,
           min('NFL:' || tm.slug), count(DISTINCT tm.slug)
      FROM public.editions e
      JOIN public.teams_master tm ON tm.league = 'NFL' AND tm.active AND tm.team_name = e.team_name
     WHERE e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
       AND e.game_date IS NOT NULL AND e.player_name IS NOT NULL
       AND (extract(month FROM e.game_date) >= 8 OR extract(month FROM e.game_date) <= 2)
     GROUP BY 1, 2, 3, 4
  ), want AS (
    -- Priority: listing > printed > unanimous same-product sibling > unanimous same-season other product > none.
    -- The season rule applies only when the card's OWN product has no evidence for the player (g IS NULL), so its
    -- evidence is necessarily from other products, and a same-product conflict is never overridden.
    -- A season placement is source 'sibling' (the same player's other evidenced cards) with basis 'same_season';
    -- a same-product one keeps basis 'same_product'. basis is NULL for listing / printed / none.
    -- audit_20261026 (2): after those, a unanimous team from the player's Flow moments in the product's season
    -- (WNBA from Top Shot, NFL from All Day) — only when NO Panini evidence for the player exists in the product or
    -- the season (g and s both absent), never for a two-player card. source 'sibling' then means "inferred from the
    -- same player's other evidence"; inferred_from names which: same_product / same_season / topshot_moments /
    -- allday_moments (NULL for listing / printed / none).
    SELECT o.external_id, o.sport,
           coalesce(o.keys, CASE WHEN g.nk = 1 THEN g.k::text[] END,
                    CASE WHEN g.product_set_id IS NULL AND s.nk = 1 THEN ARRAY[s.k] END,
                    CASE WHEN g.product_set_id IS NULL AND s.sport IS NULL AND m.nk = 1 THEN ARRAY[m.k] END, '{}'::text[]) AS keys,
           coalesce(o.source, CASE WHEN g.nk = 1 THEN 'sibling' END,
                    CASE WHEN g.product_set_id IS NULL AND s.nk = 1 THEN 'sibling' END,
                    CASE WHEN g.product_set_id IS NULL AND s.sport IS NULL AND m.nk = 1 THEN 'sibling' END, 'none') AS source,
           CASE WHEN o.keys IS NOT NULL THEN NULL
                WHEN g.nk = 1 THEN 'same_product'
                WHEN g.product_set_id IS NULL AND s.nk = 1 THEN 'same_season' END                  AS basis,
           CASE WHEN o.keys IS NOT NULL THEN NULL
                WHEN g.nk = 1 THEN 'same_product'
                WHEN g.product_set_id IS NULL AND s.nk = 1 THEN 'same_season'
                WHEN g.product_set_id IS NULL AND s.sport IS NULL AND m.nk = 1 THEN m.via END       AS inferred_from
      FROM own o
      LEFT JOIN grp g ON g.product_set_id = o.product_set_id AND g.player_name = o.player_name
      LEFT JOIN sea s ON s.sport = o.sport AND s.season = o.season AND s.player_name = o.player_name
      LEFT JOIN mom m ON m.sport = o.sport AND m.sy = left(o.season, 4)::int AND m.pn = lower(o.player_name)
                     AND o.player_name NOT LIKE '%|%'
  )
  INSERT INTO public.panini_edition_team_keys AS t (external_id, sport, franchise_keys, source, basis, inferred_from, computed_at)
  SELECT external_id, sport, keys, source, basis, inferred_from, v_started FROM want
  ON CONFLICT (external_id) DO UPDATE SET
    sport = EXCLUDED.sport, franchise_keys = EXCLUDED.franchise_keys,
    source = EXCLUDED.source, basis = EXCLUDED.basis, inferred_from = EXCLUDED.inferred_from, computed_at = EXCLUDED.computed_at
  WHERE (t.sport, t.franchise_keys, t.source, t.basis, t.inferred_from)
        IS DISTINCT FROM (EXCLUDED.sport, EXCLUDED.franchise_keys, EXCLUDED.source, EXCLUDED.basis, EXCLUDED.inferred_from);
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  SELECT count(*) INTO v_mapped FROM public.panini_edition_team_keys WHERE cardinality(franchise_keys) > 0;

  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, v_mapped, v_rows, 0, true, NULL,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261026', 'changed', v_rows, 'mapped', v_mapped));
  RETURN v_rows;
EXCEPTION WHEN query_canceled OR OTHERS THEN
  PERFORM public.log_pipeline_run('panini-edition-team-keys', v_started, 0, 0, 0, false, SQLERRM,
    'panini_blockchain', NULL, NULL, jsonb_build_object('source', 'audit_20261025', 'sqlstate', SQLSTATE));
  RETURN -1;
END;
$function$;
