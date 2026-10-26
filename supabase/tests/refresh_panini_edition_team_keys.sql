-- DB invariant: public.refresh_panini_edition_team_keys — the per-edition Panini team map behind the franchise
-- hubs, the edition-page team chip, player-page teams and the concierge (migration
-- 20261026044548_audit_20261025_panini_edition_team_keys.sql). Claims:
--   1. a card the team walk saw under a team filter takes THAT team (source listing), even when another team is
--      printed on it;
--   2. a card with no listing takes the team printed on it (panini_editions.nation) through the resolver (printed);
--   3. a card with neither takes the team its evidenced SIBLINGS — same product, same player — agree on (sibling);
--   4. siblings that disagree decide nothing (none), and a sibling in ANOTHER product is never evidence;
--   5. only Basketball / Baseball / Football / Womens Basketball products are mapped (soccer is not a team sport here);
--   6. rows are NEVER deleted: a card that loses its evidence becomes source none with keys '{}';
--   7. a second run with nothing changed writes 0 rows (the IS DISTINCT FROM guard), and every run is logged.
--
-- The function DDL below is VERBATIM from the committed migration;
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.

BEGIN;

CREATE TABLE public.panini_products (set_id integer PRIMARY KEY, name text, last_grid_sport text);
CREATE TABLE public.panini_editions (external_id text PRIMARY KEY, player_name text, product_set_id integer, nation text);
CREATE TABLE public.panini_team_listings (sku text PRIMARY KEY, psku text, franchise_keys text[], set_id text, genesis_year integer);
CREATE TABLE public.pipeline_runs_stub (pipeline text, ok boolean, rows_found integer, rows_written integer, error text);

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
  computed_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.panini_products VALUES
  (10, '2023 Panini NFT Prizm Basketball', 'Basketball'),
  (20, '2024 Panini NFT Prizm Basketball', 'Basketball'),
  (30, '2026 Panini NFT Prizm WNBA', 'Womens Basketball'),
  (99, '2026 Panini Prizm World Cup', 'Soccer');

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
  ('packcard-99_1_1_1', 'Messi',        99, 'Argentina');       -- claim 5: soccer → no row

INSERT INTO public.panini_team_listings VALUES
  ('s1', 'packcard-10_1_1_1', ARRAY['NBA:lakers'], '10', 2023),
  ('s3', 'packcard-10_1_1_3', ARRAY['NBA:bulls'],  '10', 2023),
  ('s5', 'packcard-10_1_1_5', ARRAY['NBA:heat'],   '10', 2023),
  ('s6', 'packcard-10_1_1_6', ARRAY['NBA:knicks'], '10', 2023);

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
-- <<< END verbatim refresh_panini_edition_team_keys <<<

DO $$
DECLARE
  v int;
  k text;
BEGIN
  v := public.refresh_panini_edition_team_keys();
  PERFORM _assert_eq(v::text, '9', 'first run writes one row per catalogued team-sport edition (soccer excluded, claim 5)');
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

  v := public.refresh_panini_edition_team_keys();
  PERFORM _assert_eq(v::text, '0', 'an unchanged second run writes nothing (claim 7)');
  PERFORM _assert_eq((SELECT count(*) FROM public.pipeline_runs_stub WHERE pipeline = 'panini-edition-team-keys' AND ok)::text, '2', 'every run is logged ok (claim 7)');

  -- the evidence goes away: the row stays, now none (claim 6)
  UPDATE public.panini_team_listings SET franchise_keys = '{}' WHERE sku = 's3';
  v := public.refresh_panini_edition_team_keys();
  SELECT array_to_string(franchise_keys, ',') || '/' || source INTO k FROM public.panini_edition_team_keys WHERE external_id = 'packcard-10_1_1_4';
  PERFORM _assert_eq(k, '/none', 'a card whose evidence is gone becomes none (claim 6)');
  PERFORM _assert_eq((SELECT count(*) FROM public.panini_edition_team_keys)::text, '9', 'no row is ever deleted (claim 6)');
END $$;

SELECT '✓ refresh_panini_edition_team_keys invariants pass' AS result;

ROLLBACK;
