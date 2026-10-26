-- DB invariant: public.refresh_panini_edition_team_keys — the per-edition Panini team map behind the franchise
-- hubs, the edition-page team chip, player-page teams and the concierge (migration
-- 20261026044548_audit_20261025_panini_edition_team_keys.sql; the season rule 20261026220929, Flow moments 20261026225742). Claims:
--   1. a card the team walk saw under a team filter takes THAT team (source listing), even when another team is
--      printed on it;
--   2. a card with no listing takes the team printed on it (panini_editions.nation) through the resolver (printed);
--   3. a card with neither takes the team its evidenced SIBLINGS — same product, same player — agree on (sibling);
--   4. siblings that disagree decide nothing (none), and a sibling in ANOTHER product is never evidence;
--   5. only Basketball / Baseball / Football / Womens Basketball products are mapped (soccer is not a team sport here);
--   6. rows are NEVER deleted: a card that loses its evidence becomes source none with keys '{}';
--   7. a second run with nothing changed writes 0 rows (the IS DISTINCT FROM guard), and every run is logged;
--   8. (2026-10-26) a Football / Baseball card with no evidence in its own product takes the team the same player's
--      directly evidenced cards in OTHER products of the same SEASON agree on (source sibling, basis same_season;
--      a same-product sibling is basis same_product, a listing / printed / none row NULL) — never across seasons,
--      never when those products disagree, never for a two-player card, never for Basketball;
--   9. (2026-10-26) with NO Panini evidence for the player in the product or season, a WNBA card takes the team the
--      player's Top Shot WNBA moments that season agree on, an NFL card the team of their All Day moments that season
--      (Aug–Feb, so a January game belongs to the previous season) — inferred_from topshot_moments / allday_moments;
--      moments that disagree, or from another season, decide nothing; Panini season evidence wins over moments, and
--      a Panini same-season conflict is never overridden by moments.
--
-- The function DDL below is VERBATIM from the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.panini_products (set_id integer PRIMARY KEY, name text, last_grid_sport text);
CREATE TABLE public.panini_editions (external_id text PRIMARY KEY, player_name text, product_set_id integer, nation text);
CREATE TABLE public.panini_team_listings (sku text PRIMARY KEY, psku text, franchise_keys text[], set_id text, genesis_year integer);
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_found integer, rows_written integer, error text);
CREATE TABLE public.editions (collection_id uuid, external_id text, player_name text, team_name text, game_date date);
CREATE TABLE public.teams_master (league text, slug text, team_name text, active boolean);

-- the resolver: a fixed map of printed team names (the real one reads aliases + teams_master)
CREATE FUNCTION public.panini_resolve_team_keys_for(p_sport text, p_team text, p_athlete text, p_year integer)
RETURNS TABLE(keys text[], unmapped text[]) LANGUAGE sql AS $$
  SELECT CASE p_team WHEN 'Boston Celtics' THEN ARRAY['NBA:celtics'] WHEN 'Indiana Fever' THEN ARRAY['WNBA:fever'] ELSE '{}'::text[] END,
         CASE WHEN p_team IN ('Boston Celtics', 'Indiana Fever') THEN '{}'::text[] ELSE ARRAY[p_team] END
$$;
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO public.pipeline_runs_stub VALUES (p_pipeline, p_ok, p_rows_found, p_rows_written, p_error) RETURNING 1::bigint
$$;

CREATE TABLE IF NOT EXISTS public.panini_edition_team_keys (
  external_id     text        PRIMARY KEY,
  sport           text        NOT NULL,
  franchise_keys  text[]      NOT NULL DEFAULT '{}',
  source          text        NOT NULL CHECK (source IN ('listing', 'printed', 'sibling', 'none')),
  basis           text        CHECK (basis IS NULL OR basis IN ('same_product', 'same_season')),
  inferred_from   text,
  computed_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.panini_products VALUES
  (10, '2023 Panini NFT Prizm Basketball', 'Basketball'),
  (20, '2024 Panini NFT Prizm Basketball', 'Basketball'),
  (30, '2026 Panini NFT Prizm WNBA', 'Womens Basketball'),
  (99, '2026 Panini Prizm World Cup', 'Soccer'),
  (21, '2024 Panini NFT Hoops Basketball', 'Basketball'),
  (40, '2024 Panini NFT Prizm Football', 'Football'),
  (41, '2024 Panini NFT Select Football', 'Football'),
  (42, '2023 Panini NFT Prizm Football', 'Football'),
  (43, '2024 Panini NFT Obsidian Football', 'Football'),
  (31, '2024 Panini NFT Prizm WNBA', 'Womens Basketball'),
  (44, '2022 Panini NFT Prizm Football', 'Football');

INSERT INTO public.panini_editions VALUES
  ('packcard-10_1_1_1', 'Listed Guy',   10, 'Boston Celtics'),  -- claim 1: listing (lakers) beats printed (celtics)
  ('packcard-10_1_1_2', 'Printed Guy',  10, 'Boston Celtics'),  -- claim 2: printed
  ('packcard-10_1_1_3', 'Sib Player',   10, NULL),              -- claim 3: evidenced sibling (bulls listing)
  ('packcard-10_1_1_4', 'Sib Player',   10, NULL),              --          unevidenced sibling → bulls
  ('packcard-10_1_1_5', 'Split Player', 10, NULL),              -- claim 4: siblings disagree (heat / knicks)
  ('packcard-10_1_1_6', 'Split Player', 10, NULL),
  ('packcard-10_1_1_7', 'Split Player', 10, NULL),              --          → none
  ('packcard-20_1_1_8', 'Sib Player',   20, NULL),              --          another product → none
  ('packcard-30_1_1_9', 'Clark',        30, 'Indiana Fever'),   -- WNBA printed
  ('packcard-99_1_1_1', 'Messi',        99, 'Argentina'),       -- claim 5: soccer → no row
  ('packcard-40_1_1_1', 'Season Guy',   40, NULL),              -- claim 8: listed chiefs in 2024 Prizm
  ('packcard-41_1_1_1', 'Season Guy',   41, NULL),              --          2024 Select, no evidence → chiefs (season)
  ('packcard-42_1_1_1', 'Season Guy',   42, NULL),              --          2023: another season → none
  ('packcard-40_1_1_2', 'Traded Guy',   40, NULL),              --          bills in 2024 Prizm …
  ('packcard-43_1_1_2', 'Traded Guy',   43, NULL),              --          … jets in 2024 Obsidian …
  ('packcard-41_1_1_2', 'Traded Guy',   41, NULL),              --          … so 2024 Select decides nothing → none
  ('packcard-40_1_1_3', 'Duo A | Duo B', 40, NULL),             --          a two-player card is evidence for nothing …
  ('packcard-41_1_1_3', 'Duo A | Duo B', 41, NULL),             --          … and is never placed → none
  ('packcard-21_1_1_1', 'Hoop Guy',     21, NULL),              --          Basketball: suns in 2024 Hoops …
  ('packcard-20_1_1_9', 'Hoop Guy',     20, NULL),              --          … 2024 Prizm Basketball stays none (not used)
  ('packcard-31_1_1_1', 'Moment Star',  31, NULL),              -- claim 9: Top Shot 2024 moments all Aces → aces
  ('packcard-31_1_1_2', 'Traded Star',  31, NULL),              --          moments Aces and Fever → none
  ('packcard-31_1_1_3', 'Old Star',     31, NULL),              --          only 2023 moments → none
  ('packcard-44_1_1_1', 'Gridiron Guy', 44, NULL);              --          All Day Jan 2023 game = 2022 season → chiefs

INSERT INTO public.panini_team_listings VALUES
  ('s1', 'packcard-10_1_1_1', ARRAY['NBA:lakers'], '10', 2023),
  ('s3', 'packcard-10_1_1_3', ARRAY['NBA:bulls'],  '10', 2023),
  ('s5', 'packcard-10_1_1_5', ARRAY['NBA:heat'],   '10', 2023),
  ('s6', 'packcard-10_1_1_6', ARRAY['NBA:knicks'], '10', 2023),
  ('t1', 'packcard-40_1_1_1', ARRAY['NFL:chiefs'], '40', 2024),
  ('t2', 'packcard-40_1_1_2', ARRAY['NFL:bills'],  '40', 2024),
  ('t3', 'packcard-43_1_1_2', ARRAY['NFL:jets'],   '43', 2024),
  ('t4', 'packcard-40_1_1_3', ARRAY['NFL:chiefs'], '40', 2024),
  ('t5', 'packcard-21_1_1_1', ARRAY['NBA:suns'],   '21', 2024);

INSERT INTO public.teams_master VALUES
  ('WNBA', 'aces', 'Las Vegas Aces', true), ('WNBA', 'fever', 'Indiana Fever', true),
  ('NFL', 'chiefs', 'Kansas City Chiefs', true), ('NFL', 'bills', 'Buffalo Bills', true);

INSERT INTO public.editions VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ts1', 'Moment Star',  'Las Vegas Aces',     '2024-06-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ts2', 'Traded Star',  'Las Vegas Aces',     '2024-06-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ts3', 'Traded Star',  'Indiana Fever',      '2024-08-01'),
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'ts4', 'Old Star',     'Las Vegas Aces',     '2023-06-01'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'ad1', 'Gridiron Guy', 'Kansas City Chiefs', '2023-01-15'),
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'ad2', 'Season Guy',   'Buffalo Bills',      '2024-10-01'),  -- Panini season says chiefs: Panini wins
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'ad3', 'Traded Guy',   'Kansas City Chiefs', '2024-10-01'),  -- Panini season conflict: stays none
  ('dee28451-5d62-409e-a1ad-a83f763ac070', 'ad4', 'Moment Star',  'Kansas City Chiefs', '2024-10-01');  -- an NFL moment never decides a WNBA card

-- >>> BEGIN verbatim refresh_panini_edition_team_keys >>>
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
-- <<< END verbatim refresh_panini_edition_team_keys <<<

DO $$
DECLARE
  v int;
  k text;
BEGIN
  v := public.refresh_panini_edition_team_keys();
  PERFORM _assert_eq(v::text, '23', 'first run writes one row per catalogued team-sport edition (soccer excluded, claim 5)');
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM public.panini_edition_team_keys WHERE external_id = 'packcard-99_1_1_1'), 'soccer has no row (claim 5)');

  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_1';
  PERFORM _assert_eq(k, 'NBA:lakers/listing', 'the walk listing beats the printed team (claim 1)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_2';
  PERFORM _assert_eq(k, 'NBA:celtics/printed', 'no listing: the printed team, through the resolver (claim 2)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_4';
  PERFORM _assert_eq(k, 'NBA:bulls/sibling', 'no own evidence: the team its same-product siblings agree on (claim 3)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_7';
  PERFORM _assert_eq(k, '/none', 'siblings that disagree decide nothing (claim 4)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-20_1_1_8';
  PERFORM _assert_eq(k, '/none', 'a sibling in another product is not evidence (claim 4)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-30_1_1_9';
  PERFORM _assert_eq(k, 'WNBA:fever/printed', 'a WNBA card is mapped from its printed team');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_1';
  PERFORM _assert_eq(k, 'NFL:chiefs/sibling', 'no evidence in its own product: the team its same-season other products agree on (claim 8)');
  PERFORM _assert_eq((SELECT basis FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_1'), 'same_season', 'a season placement says so in basis (claim 8)');
  PERFORM _assert_eq((SELECT basis FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_4'), 'same_product', 'a same-product sibling says so in basis (claim 3)');
  PERFORM _assert((SELECT basis IS NULL FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_1'), 'a listing has no basis (claim 1)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-42_1_1_1';
  PERFORM _assert_eq(k, '/none', 'another season is not evidence (claim 8)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_2';
  PERFORM _assert_eq(k, '/none', 'same-season products that disagree decide nothing (claim 8)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_3';
  PERFORM _assert_eq(k, '/none', 'a two-player card is never placed by season (claim 8)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-20_1_1_9';
  PERFORM _assert_eq(k, '/none', 'the season rule is not used for Basketball (claim 8)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source || '/' || coalesce(inferred_from, '-') INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-31_1_1_1';
  PERFORM _assert_eq(k, 'WNBA:aces/sibling/topshot_moments', 'no Panini evidence: the team the player''s Top Shot moments that season agree on (claim 9)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-31_1_1_2';
  PERFORM _assert_eq(k, '/none', 'moments that disagree decide nothing (claim 9)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-31_1_1_3';
  PERFORM _assert_eq(k, '/none', 'another season''s moments are not evidence (claim 9)');
  SELECT array_to_string(franchise_keys, ',') || '/' || coalesce(inferred_from, '-') INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-44_1_1_1';
  PERFORM _assert_eq(k, 'NFL:chiefs/allday_moments', 'an All Day January game belongs to the season before (claim 9)');
  SELECT array_to_string(franchise_keys, ',') || '/' || coalesce(inferred_from, '-') INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_1';
  PERFORM _assert_eq(k, 'NFL:chiefs/same_season', 'Panini same-season evidence wins over moments (claim 9)');
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-41_1_1_2';
  PERFORM _assert_eq(k, '/none', 'a Panini same-season conflict is never overridden by moments (claim 9)');
  PERFORM _assert((SELECT inferred_from IS NULL FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_1'), 'a listing has no inferred_from (claim 9)');
  PERFORM _assert_eq((SELECT inferred_from FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_4'), 'same_product', 'a same-product sibling says so in inferred_from (claim 9)');

  v := public.refresh_panini_edition_team_keys();
  PERFORM _assert_eq(v::text, '0', 'an unchanged second run writes nothing (claim 7)');
  PERFORM _assert_eq((SELECT count(*) FROM public.pipeline_runs_stub WHERE pipeline = 'panini-edition-team-keys' AND ok)::text, '2', 'every run is logged ok (claim 7)');

  -- the evidence goes away: the row stays, now none (claim 6)
  UPDATE public.panini_team_listings SET franchise_keys = '{}' WHERE sku = 's3';
  v := public.refresh_panini_edition_team_keys();
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_4';
  PERFORM _assert_eq(k, '/none', 'a card whose evidence is gone becomes none (claim 6)');
  PERFORM _assert_eq((SELECT count(*) FROM public.panini_edition_team_keys)::text, '23', 'no row is ever deleted (claim 6)');
END $$;

SELECT '✓ refresh_panini_edition_team_keys invariants pass' AS result;

ROLLBACK;
