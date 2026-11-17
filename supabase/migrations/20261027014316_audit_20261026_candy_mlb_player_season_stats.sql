-- audit_20261026: Candy MLB player SEASON STATS (Candy <-> Top Shot parity, fourth pass).
--
-- Top Shot and All Day player pages carry ESPN season lines through the league-id crosswalk
-- (player_identities -> player_season_stats, fed by the player-stats-sync GitHub runner). Candy's player
-- pages had none: the crosswalk only knew 'nba' and 'nfl'. ESPN serves MLB on the same two endpoints
-- (search/v2 and common/v3/sports/baseball/mlb/athletes/<id>/stats), in the shape parseEspnStats already
-- reads — measured 2026-10-26 from the cloud sandbox for all 100 Candy players.
--
-- This migration:
--   · widens the league CHECKs (player_identities.league / espn_league, player_season_stats.league) to 'mlb';
--   · seeds one 'mlb' identity per Candy player (no MLB id feed exists, so league_player_id is the RPC player
--     row id and the identity is linked to that row directly — matched_by 'candy_player');
--   · records the ESPN ids resolved from the sandbox: 99 of 100 by the runner's own unique-name rule
--     (matchEspnSearch); Will Smith is ambiguous on ESPN (a Dodgers catcher and a Royals pitcher) and is
--     hand-linked to the Dodgers id, the team every Candy Will Smith edition carries;
--   · lets upsert_player_season_stats / set_player_identity_espn_ids take 'mlb' (a resolved id with no league
--     now defaults to the identity's own league for mlb, not 'nba').
-- match_player_identities / upsert_player_identities stay nba/nfl only: there is no MLB identity feed.
--
-- Revert: DELETE FROM public.player_season_stats WHERE league = 'mlb';
--         DELETE FROM public.player_identities WHERE league = 'mlb';
--         re-apply upsert_player_season_stats / set_player_identity_espn_ids from
--         20260926012607_audit_20260925_stats_feed_reaches_retired_players_and_the_wnba.sql (or the latest
--         file that defines each), then restore the three CHECKs without 'mlb'.

ALTER TABLE public.player_identities DROP CONSTRAINT player_identities_league_check;
ALTER TABLE public.player_identities ADD CONSTRAINT player_identities_league_check
  CHECK (league = ANY (ARRAY['nba'::text, 'nfl'::text, 'mlb'::text]));
ALTER TABLE public.player_identities DROP CONSTRAINT player_identities_espn_league_check;
ALTER TABLE public.player_identities ADD CONSTRAINT player_identities_espn_league_check
  CHECK (espn_league = ANY (ARRAY['nba'::text, 'wnba'::text, 'nfl'::text, 'mlb'::text]));
ALTER TABLE public.player_season_stats DROP CONSTRAINT player_season_stats_league_check;
ALTER TABLE public.player_season_stats ADD CONSTRAINT player_season_stats_league_check
  CHECK (league = ANY (ARRAY['nba'::text, 'nfl'::text, 'mlb'::text]));

-- one identity per Candy player, linked to its own row
INSERT INTO public.player_identities
  (league, league_player_id, collection_id, player_id, matched_by, matched_at, name_slug, display_name, source, refreshed_at)
SELECT 'mlb', p.id::text, p.collection_id, p.id, 'candy_player', now(),
       regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g'),
       trim(p.name), 'players.candy', now()
  FROM public.players p
 WHERE p.collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'
   AND NOT EXISTS (SELECT 1 FROM public.player_identities x WHERE x.player_id = p.id)
ON CONFLICT (league, league_player_id) DO NOTHING;

-- ESPN ids resolved 2026-10-26 (sandbox run of the runner's matchEspnSearch over search/v2)
UPDATE public.player_identities i
   SET espn_id = v.espn_id, espn_league = 'mlb', espn_id_matched_by = v.matched_by
  FROM (VALUES
    ('Aaron Judge', '33192', 'espn-search:name'),
    ('Adley Rutschman', '42178', 'espn-search:name'),
    ('Alex Bregman', '34886', 'espn-search:name'),
    ('Andy Pages', '42468', 'espn-search:name'),
    ('Ben Rice', '5016968', 'espn-search:name'),
    ('Bo Bichette', '38904', 'espn-search:name'),
    ('Bobby Witt Jr.', '42403', 'espn-search:name'),
    ('Brent Rooker', '40926', 'espn-search:name'),
    ('Brice Turang', '41179', 'espn-search:name'),
    ('Bryan Woo', '4629089', 'espn-search:name'),
    ('Bryce Eldridge', '5149064', 'espn-search:name'),
    ('Bryce Harper', '30951', 'espn-search:name'),
    ('Byron Buxton', '32655', 'espn-search:name'),
    ('CJ Abrams', '42402', 'espn-search:name'),
    ('Cal Raleigh', '41292', 'espn-search:name'),
    ('Chase Burns', '4927516', 'espn-search:name'),
    ('Chase DeLauter', '4619649', 'espn-search:name'),
    ('Chris Sale', '30948', 'espn-search:name'),
    ('Christian Yelich', '31283', 'espn-search:name'),
    ('Cody Bellinger', '33912', 'espn-search:name'),
    ('Colson Montgomery', '4872685', 'espn-search:name'),
    ('Corbin Carroll', '42404', 'espn-search:name'),
    ('Corey Seager', '32691', 'espn-search:name'),
    ('Cristopher Sánchez', '42359', 'espn-search:name'),
    ('Drake Baldwin', '4810190', 'espn-search:name'),
    ('Elly De La Cruz', '4917694', 'espn-search:name'),
    ('Eugenio Suárez', '32367', 'espn-search:name'),
    ('Fernando Tatis Jr.', '35983', 'espn-search:name'),
    ('Framber Valdez', '36581', 'espn-search:name'),
    ('Francisco Lindor', '32129', 'espn-search:name'),
    ('Freddie Freeman', '30193', 'espn-search:name'),
    ('Garrett Crochet', '4297835', 'espn-search:name'),
    ('George Springer', '32078', 'espn-search:name'),
    ('Gerrit Cole', '32081', 'espn-search:name'),
    ('Gunnar Henderson', '42507', 'espn-search:name'),
    ('Hunter Brown', '4717803', 'espn-search:name'),
    ('Hunter Greene', '39635', 'espn-search:name'),
    ('Jac Caglianone', '4926296', 'espn-search:name'),
    ('Jackson Chourio', '4917869', 'espn-search:name'),
    ('Jackson Merrill', '4872691', 'espn-search:name'),
    ('Jacob Misiorowski', '5080761', 'espn-search:name'),
    ('Jacob Wilson', '4719300', 'espn-search:name'),
    ('Jacob deGrom', '32796', 'espn-search:name'),
    ('James Wood', '4918256', 'espn-search:name'),
    ('Jarren Duran', '41610', 'espn-search:name'),
    ('Jasson Domínguez', '42401', 'espn-search:name'),
    ('Jazz Chisholm Jr.', '41433', 'espn-search:name'),
    ('Joe Ryan', '42450', 'espn-search:name'),
    ('Jordan Walker', '4684778', 'espn-search:name'),
    ('Jose Altuve', '31662', 'espn-search:name'),
    ('José Ramírez', '32801', 'espn-search:name'),
    ('José Soriano', '40973', 'espn-search:name'),
    ('Juan Soto', '36969', 'espn-search:name'),
    ('Jung Hoo Lee', '5134621', 'espn-search:name'),
    ('Junior Caminero', '4905921', 'espn-search:name'),
    ('Kazuma Okamoto', '5134636', 'espn-search:name'),
    ('Kevin McGonigle', '5149072', 'espn-search:name'),
    ('Kyle Schwarber', '33712', 'espn-search:name'),
    ('Kyle Stowers', '42796', 'espn-search:name'),
    ('Kyle Tucker', '34967', 'espn-search:name'),
    ('Logan Gilbert', '41221', 'espn-search:name'),
    ('Logan Webb', '41216', 'espn-search:name'),
    ('Manny Machado', '31097', 'espn-search:name'),
    ('Mason Miller', '4730225', 'espn-search:name'),
    ('Matt Olson', '32767', 'espn-search:name'),
    ('Max Fried', '32685', 'espn-search:name'),
    ('Mickey Moniak', '36181', 'espn-search:name'),
    ('Mike Trout', '30836', 'espn-search:name'),
    ('Mookie Betts', '33039', 'espn-search:name'),
    ('Munetaka Murakami', '4872595', 'espn-search:name'),
    ('Nick Kurtz', '4966637', 'espn-search:name'),
    ('Nico Hoerner', '41219', 'espn-search:name'),
    ('Oneil Cruz', '39712', 'espn-search:name'),
    ('Otto Lopez', '41917', 'espn-search:name'),
    ('Ozzie Albies', '33783', 'espn-search:name'),
    ('Paul Skenes', '4719507', 'espn-search:name'),
    ('Pete Alonso', '37498', 'espn-search:name'),
    ('Pete Crow-Armstrong', '4717833', 'espn-search:name'),
    ('Rafael Devers', '33859', 'espn-search:name'),
    ('Ranger Suárez', '39817', 'espn-search:name'),
    ('Riley Greene', '42179', 'espn-search:name'),
    ('Roman Anthony', '5080767', 'espn-search:name'),
    ('Ronald Acuña Jr.', '36185', 'espn-search:name'),
    ('Salvador Perez', '31127', 'espn-search:name'),
    ('Sandy Alcantara', '35241', 'espn-search:name'),
    ('Seiya Suzuki', '4142424', 'espn-search:name'),
    ('Shea Langeliers', '42598', 'espn-search:name'),
    ('Shohei Ohtani', '39832', 'espn-search:name'),
    ('Steven Kwan', '41996', 'espn-search:name'),
    ('Tarik Skubal', '42409', 'espn-search:name'),
    ('Vinnie Pasquantino', '4109109', 'espn-search:name'),
    ('Vladimir Guerrero Jr.', '35002', 'espn-search:name'),
    ('Will Smith', '38309', 'hand:2026-10-26:team-dodgers'),
    ('William Contreras', '39895', 'espn-search:name'),
    ('Wyatt Langford', '4719324', 'espn-search:name'),
    ('Yandy Díaz', '33481', 'espn-search:name'),
    ('Yordan Alvarez', '36018', 'espn-search:name'),
    ('Yoshinobu Yamamoto', '4872587', 'espn-search:name'),
    ('Zach Neto', '4666100', 'espn-search:name'),
    ('Zack Wheeler', '31267', 'espn-search:name')
  ) v(name, espn_id, matched_by)
 WHERE i.league = 'mlb' AND i.display_name = v.name AND i.espn_id IS NULL;

CREATE OR REPLACE FUNCTION public.set_player_identity_espn_ids(p_league text, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  WITH r AS (
    SELECT * FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
             AS x(identity_id uuid, espn_id text, matched_by text, espn_league text)
  ),
  upd AS (
    UPDATE public.player_identities i
       SET espn_id = CASE WHEN r.espn_id IS NOT NULL AND trim(r.espn_id) <> '' THEN trim(r.espn_id) ELSE i.espn_id END,
           espn_id_matched_by = COALESCE(nullif(trim(r.matched_by), ''), i.espn_id_matched_by),
           -- 2026-09-25: the ESPN league the id lives in; a resolved id without
           -- one is the collection's league (Top Shot's WNBA players say 'wnba')
           -- 2026-10-26: mlb defaults to mlb (was folded to 'nba')
           espn_league = CASE WHEN r.espn_id IS NOT NULL AND trim(r.espn_id) <> ''
                              THEN COALESCE(nullif(lower(trim(r.espn_league)), ''), CASE p_league WHEN 'nfl' THEN 'nfl' WHEN 'mlb' THEN 'mlb' ELSE 'nba' END)
                              ELSE i.espn_league END
      FROM r
     WHERE i.id = r.identity_id AND i.league = p_league
       AND i.espn_id IS NULL
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM upd;
  RETURN v_n;
END
$function$;

CREATE OR REPLACE FUNCTION public.upsert_player_season_stats(p_league text, p_rows jsonb, p_touched text[] DEFAULT NULL::text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_n int;
BEGIN
  -- 2026-10-26: 'mlb' (Candy MLB's ESPN lines)
  IF p_league NOT IN ('nba', 'nfl', 'mlb') THEN
    RAISE EXCEPTION 'upsert_player_season_stats: unknown league %', p_league;
  END IF;
  WITH r AS (
    SELECT DISTINCT ON (x.espn_id, x.season, COALESCE(x.season_type, 2), x.category, COALESCE(nullif(trim(x.team_slug), ''), ''))
           x.*
      FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::jsonb))
             AS x(espn_id text, season int, season_type int, category text, display_name text,
                  team_slug text, is_total boolean, labels text[], names text[], "values" text[])
     ORDER BY x.espn_id, x.season, COALESCE(x.season_type, 2), x.category, COALESCE(nullif(trim(x.team_slug), ''), '')
  ),
  ins AS (
    INSERT INTO public.player_season_stats
      (league, espn_id, season, season_type, category, display_name, team_slug, is_total, labels, names, "values", source, refreshed_at)
    SELECT p_league, trim(r.espn_id), r.season, COALESCE(r.season_type, 2), trim(r.category),
           nullif(trim(r.display_name), ''), COALESCE(nullif(trim(r.team_slug), ''), ''), COALESCE(r.is_total, false),
           r.labels, r.names, r."values", 'espn', now()
      FROM r
     WHERE r.espn_id IS NOT NULL AND trim(r.espn_id) <> ''
       AND r.season IS NOT NULL AND r.category IS NOT NULL AND trim(r.category) <> ''
       AND r.labels IS NOT NULL AND r.names IS NOT NULL AND r."values" IS NOT NULL
       AND array_length(r.labels, 1) = array_length(r."values", 1)
    ON CONFLICT (league, espn_id, season, season_type, category, team_slug) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      is_total     = EXCLUDED.is_total,
      labels       = EXCLUDED.labels,
      names        = EXCLUDED.names,
      "values"     = EXCLUDED."values",
      source       = EXCLUDED.source,
      refreshed_at = now()
    RETURNING 1
  )
  SELECT count(*)::int INTO v_n FROM ins;

  IF p_touched IS NOT NULL AND array_length(p_touched, 1) > 0 THEN
    UPDATE public.player_identities i
       SET stats_refreshed_at = now()
     WHERE i.league = p_league AND i.espn_id = ANY (p_touched);

    -- 2026-09-25: an identity no league feed describes (the NBA half, seeded
    -- from ids) takes its seasons and latest team from its own stat lines;
    -- a feed-described one (nflverse) keeps the feed's values.
    UPDATE public.player_identities i
       SET rookie_season = d.rookie,
           last_season   = d.last,
           latest_team   = COALESCE(d.abbr, i.latest_team)
      FROM (
        SELECT s.espn_id, min(s.season) AS rookie, max(s.season) AS last,
               (SELECT t.abbr
                  FROM public.league_team_abbr(p_league) t
                 WHERE regexp_replace(lower(t.team_name), '[^a-z0-9]+', '-', 'g') = (
                         SELECT s2.team_slug FROM public.player_season_stats s2
                          WHERE s2.league = p_league AND s2.espn_id = s.espn_id
                            AND s2.season_type = 2 AND s2.team_slug <> ''
                          ORDER BY s2.season DESC LIMIT 1)
                 LIMIT 1) AS abbr
          FROM public.player_season_stats s
         WHERE s.league = p_league AND s.season_type = 2 AND s.espn_id = ANY (p_touched)
         GROUP BY s.espn_id
      ) d
     WHERE i.league = p_league AND i.espn_id = d.espn_id AND i.source <> 'nflverse';
  END IF;
  RETURN v_n;
END
$function$;

-- anon-exec: revoked (set_player_identity_espn_ids, upsert_player_season_stats) — service-role writers, unchanged ACL.
REVOKE ALL ON FUNCTION public.set_player_identity_espn_ids(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_player_season_stats(text, jsonb, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_player_identity_espn_ids(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_player_season_stats(text, jsonb, text[]) TO service_role;
