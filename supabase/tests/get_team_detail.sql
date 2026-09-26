-- DB invariant: public.get_team_detail — the team/franchise hub read behind
-- /[collection]/team/[slug]: roster size, edition count, circulation, FMV/floor
-- totals, teams_master branding, and 30d sales activity. The slug is resolved via
-- a functional regexp (see the idx_editions_collection_team_slug incident), so a
-- regression can mis-scope the whole team or silently drop its branding.
--
-- Pins (standard / sports branch):
--   * team resolved by slugified team_name; no match -> NULL;
--   * team_name_variants = DISTINCT matching names; player_count = DISTINCT
--     slugified non-empty player_name (a NULL-player edition counts toward
--     edition_count + circulation but NOT player_count);
--   * fmv_total sums latest-snapshot fmv_usd > 0; floor_total sums
--     COALESCE(floor,fmv) > 0; latest snapshot per edition wins;
--   * teams_master branding is read from the ACTIVE row on the same slug;
--   * sales_30d / volume_30d count only in-window sales on this team's editions
--     (other teams excluded via the team_name filter);
-- Pins (Pinnacle branch, 2026-09-26): the render catalog by each pin's own
--   Franchises trait (™ stripped; a pin counts toward every franchise it names;
--   characters counted by page slug over every name, 'Unknown' excluded); a
--   catalog-only franchise resolves; a franchise no catalog pin names falls
--   through to the legacy pinnacle_editions read + per-render FMV collapse.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260926195205_audit_20260926_pinnacle_franchise_pages_list_every_pin.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA extensions;

-- ── minimal fixtures ─────────────────────────────────────────────────────────
CREATE TABLE public.collections (id uuid PRIMARY KEY, slug text);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, collection_id uuid, team_name text, player_name text,
  circulation_count int);
CREATE TABLE public.fmv_snapshots (
  edition_id uuid, fmv_usd numeric, floor_price_usd numeric, computed_at timestamptz);
CREATE TABLE public.teams_master (
  slug text, team_name text, primary_color text, secondary_color text,
  abbreviation text, external_id text, league text, active boolean);
CREATE TABLE public.sales (
  edition_id uuid, collection_id uuid, price_usd numeric, sold_at timestamptz);
-- Pinnacle-branch stubs (only exercised by the franchise case below).
CREATE TABLE public.pinnacle_editions (
  id uuid PRIMARY KEY, franchise text, character_name text, mint_count int);
CREATE FUNCTION public.get_pinnacle_edition_fmv_collapsed(p_id uuid)
 RETURNS TABLE(fmv_usd numeric, floor_usd numeric) LANGUAGE sql STABLE AS $$
  SELECT 12::numeric, 10::numeric WHERE p_id IS NOT NULL
$$;
CREATE TABLE public.pinnacle_catalog (
  render_id text PRIMARY KEY, franchises text[], characters text[],
  total_minted int, fmv_usd numeric, floor_ask numeric);

-- Franchise helpers (batch 62, 2026-09-25): fixture copies of the shared league
-- map and the two helpers the body now reads (their own pin is
-- supabase/tests/team_franchise_slugs.sql).
CREATE OR REPLACE FUNCTION public.league_team_abbr(p_league text)
 RETURNS TABLE(team_name text, abbr text)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT t.team_name, t.abbreviation AS abbr
    FROM public.teams_master t
   WHERE t.league::text = upper(p_league)
  UNION ALL
  SELECT v.team_name, v.abbr
    FROM (VALUES
      ('nfl', 'Washington Football Team', 'WAS'), ('nfl', 'Washington Redskins', 'WAS'),
      ('nfl', 'San Diego Chargers', 'LAC'),       ('nfl', 'St. Louis Rams', 'LAR'),
      ('nfl', 'Oakland Raiders', 'LV'),           ('nfl', 'Los Angeles Raiders', 'LV'),
      ('nfl', 'Houston Oilers', 'TEN'),           ('nfl', 'Tennessee Oilers', 'TEN'),
      ('nfl', 'Phoenix Cardinals', 'ARI'),        ('nfl', 'St. Louis Cardinals', 'ARI'),
      ('nfl', 'Baltimore Colts', 'IND'),
      ('nba', 'New Jersey Nets', 'BKN'),          ('nba', 'Seattle SuperSonics', 'OKC'),
      ('nba', 'Vancouver Grizzlies', 'MEM'),      ('nba', 'New Orleans Hornets', 'NOP'),
      ('nba', 'Charlotte Bobcats', 'CHA'),
      -- 2026-09-25 (batch 61): the historic labels Top Shot's moments carry
      ('nba', 'Washington Bullets', 'WAS'),       ('nba', 'Los Angeles Clippers', 'LAC'),
      ('nba', 'San Diego Clippers', 'LAC'),       ('nba', 'Buffalo Braves', 'LAC'),
      ('nba', 'St. Louis Hawks', 'ATL'),          ('nba', 'New Orleans/Oklahoma City Hornets', 'NOP'),
      ('nba', 'Kansas City-Omaha Kings', 'SAC'),  ('nba', 'Kansas City Kings', 'SAC'),
      ('wnba', 'San Antonio Stars', 'LVA'),       ('wnba', 'San Antonio Silver Stars', 'LVA'),
      ('wnba', 'Utah Starzz', 'LVA'),             ('wnba', 'Detroit Shock', 'DAL'),
      ('wnba', 'Tulsa Shock', 'DAL'),             ('wnba', 'Orlando Miracle', 'CON')
    ) v(league, team_name, abbr)
   WHERE v.league = p_league
$function$;

CREATE OR REPLACE FUNCTION public.team_franchise_slugs(p_collection_id uuid, p_team_slug text)
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The site slugs of every label of the franchise p_team_slug names. Keyed from
-- the REGISTRIES only (league_team_abbr — historic names, the WNBA arm — else
-- teams_master), never from editions: the callers put the result in an index
-- condition (`slug_expr = ANY (…)`), so this must cost milliseconds, and a
-- label no registry knows is its own franchise (the slug comes back alone).
-- The list may name a label no edition carries (Tennessee Oilers); harmless in
-- a predicate. Accent-tolerant on input (atletico-de-madrid finds Atlético).
DECLARE
  v_coll  text;
  v_maps  text[];
  v_tm    text;
  v_out   text[];
BEGIN
  IF p_collection_id IS NULL OR p_team_slug IS NULL OR p_team_slug = '' THEN
    RETURN ARRAY[COALESCE(p_team_slug, '')];
  END IF;
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_maps := CASE v_coll WHEN 'nfl_all_day' THEN ARRAY['nfl'] WHEN 'nba_top_shot' THEN ARRAY['nba', 'wnba'] END;
  v_tm   := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  WITH names AS (
    -- the league map(s), first map wins for a name in both (nba before wnba)
    SELECT a.team_name, 'map:' || m.lg || ':' || a.abbr AS fkey, m.ord::int AS ord
      FROM unnest(COALESCE(v_maps, '{}'::text[])) WITH ORDINALITY AS m(lg, ord)
      CROSS JOIN LATERAL public.league_team_abbr(m.lg) a
    UNION ALL
    -- teams_master, namespaced by league (the Mystics' WAS must not fold into the Wizards' WAS)
    SELECT t.team_name, 'tm:' || t.league::text || ':' || t.abbreviation, 100
      FROM public.teams_master t
     WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
  ),
  keyed AS (
    SELECT DISTINCT ON (n.team_name) n.team_name, n.fkey,
           regexp_replace(lower(trim(n.team_name)), '[^a-z0-9]+', '-', 'g') AS slug,
           regexp_replace(lower(trim(extensions.unaccent(n.team_name))), '[^a-z0-9]+', '-', 'g') AS uslug
      FROM names n
     ORDER BY n.team_name, n.ord
  ),
  hit AS (
    SELECT k.fkey FROM keyed k
     WHERE k.slug = p_team_slug OR k.uslug = p_team_slug
     ORDER BY (k.slug = p_team_slug) DESC LIMIT 1
  )
  SELECT array_agg(DISTINCT k.slug) INTO v_out
    FROM keyed k JOIN hit h ON h.fkey = k.fkey;
  RETURN COALESCE(v_out, ARRAY[p_team_slug]);
END
$function$;

CREATE OR REPLACE FUNCTION public.team_franchise_primary_name(p_collection_id uuid, p_team_slug text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- The franchise's CURRENT name: a teams_master row of the collection's league
-- (WNBA included for Top Shot) whose slug is in the franchise, else the
-- most-minted label the collection's editions carry, else NULL (no such team).
-- plpgsql on purpose: a SQL body inlines into its caller and the planner then
-- re-evaluates team_franchise_slugs per scanned row (a 57014 on first apply).
DECLARE
  v_slugs text[];
  v_coll  text;
  v_tm    text;
  v_name  text;
BEGIN
  v_slugs := public.team_franchise_slugs(p_collection_id, p_team_slug);
  SELECT c.slug INTO v_coll FROM public.collections c WHERE c.id = p_collection_id;
  v_tm := CASE v_coll WHEN 'nfl_all_day' THEN 'NFL' WHEN 'nba_top_shot' THEN 'NBA' WHEN 'laliga_golazos' THEN 'LALIGA' END;

  SELECT t.team_name INTO v_name
    FROM public.teams_master t
   WHERE t.league::text = ANY (ARRAY[v_tm, 'WNBA'])
     AND regexp_replace(lower(trim(t.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   ORDER BY t.team_name
   LIMIT 1;
  IF v_name IS NOT NULL THEN RETURN v_name; END IF;

  SELECT e.team_name INTO v_name
    FROM public.editions e
   WHERE e.collection_id = p_collection_id AND e.team_name IS NOT NULL
     AND regexp_replace(lower(trim(e.team_name)), '[^a-z0-9]+', '-', 'g') = ANY (v_slugs)
   GROUP BY e.team_name
   ORDER BY count(*) DESC, e.team_name
   LIMIT 1;
  RETURN v_name;
END
$function$;

-- >>> BEGIN verbatim get_team_detail (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- 2026-09-26: the render catalog, by each pin's own Franchises trait (™/®/©
    -- stripped, so "Star Wars™" and "Star Wars" are one franchise). The old read
    -- was pinnacle_editions — set-level keys naming ONE franchise and ONE
    -- character each — so Star Wars listed 129 of its 723 pins and ten
    -- franchises a character page links to had no page at all. A franchise no
    -- catalog pin carries falls through to that old read, unchanged.
    SELECT array_agg(DISTINCT f.name),
           (array_agg(f.name ORDER BY f.name))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_catalog pc
    CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
    CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
    WHERE f.name <> ''
      AND regexp_replace(lower(f.name), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    -- Fallback: the diacritic-stripped slug the frontend emits.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT f.name),
             (array_agg(f.name ORDER BY f.name))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_catalog pc
      CROSS JOIN LATERAL unnest(pc.franchises) AS u(fr)
      CROSS JOIN LATERAL (SELECT btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) AS name) f
      WHERE f.name <> ''
        AND regexp_replace(lower(extensions.unaccent(f.name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NOT NULL THEN
      -- The same pins get_team_top_editions / get_team_players list, so the
      -- header counts what the grid and roster show. Characters are counted by
      -- page slug over every name on a pin (a duo pin counts for both).
      WITH pins AS (
        SELECT pc.render_id, pc.characters, pc.total_minted, pc.fmv_usd, pc.floor_ask
        FROM pinnacle_catalog pc
        WHERE EXISTS (
            SELECT 1 FROM unnest(pc.franchises) AS u(fr)
            WHERE btrim(regexp_replace(u.fr, '[™®©]', '', 'g')) = ANY (v_team_variants))
      )
      SELECT
        (SELECT COUNT(DISTINCT regexp_replace(lower(btrim(u.ch)), '[^a-z0-9]+', '-', 'g'))
           FROM pins p CROSS JOIN LATERAL unnest(p.characters) AS u(ch)
          WHERE btrim(u.ch) NOT IN ('', 'Unknown')),
        (SELECT COUNT(*) FROM pins),
        (SELECT SUM(total_minted) FILTER (WHERE total_minted IS NOT NULL) FROM pins),
        (SELECT SUM(fmv_usd) FILTER (WHERE fmv_usd > 0) FROM pins),
        (SELECT SUM(COALESCE(floor_ask, fmv_usd)) FILTER (WHERE COALESCE(floor_ask, fmv_usd) > 0) FROM pins)
      INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total;
    ELSE
      SELECT array_agg(DISTINCT franchise),
             (array_agg(franchise ORDER BY franchise))[1]
      INTO v_team_variants, v_team_canonical
      FROM pinnacle_editions
      WHERE franchise IS NOT NULL
        AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

      -- Fallback: accept the diacritic-stripped slug the frontend emits.
      IF v_team_variants IS NULL THEN
        SELECT array_agg(DISTINCT franchise),
               (array_agg(franchise ORDER BY franchise))[1]
        INTO v_team_variants, v_team_canonical
        FROM pinnacle_editions
        WHERE franchise IS NOT NULL
          AND regexp_replace(lower(trim(extensions.unaccent(franchise))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
      END IF;

      IF v_team_variants IS NULL THEN RETURN NULL; END IF;

      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      SELECT
        COUNT(DISTINCT pe.character_name),
        COUNT(*),
        SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
        SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
      INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.franchise = ANY(v_team_variants);
      -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
    END IF;

  ELSE
    -- 2026-09-25 (batch 62): the WHOLE franchise — every label it minted under
    -- (Las Vegas + Oakland + Los Angeles Raiders) — and the canonical name is
    -- the franchise's primary (current) name, so a historic label's URL 308s
    -- to the current page through the layout's canonical-slug redirect.
    SELECT array_agg(DISTINCT team_name)
    INTO v_team_variants
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = ANY (ARRAY(SELECT unnest(public.team_franchise_slugs(p_collection_id, p_team_slug))));
    -- (ARRAY(SELECT …) is an InitPlan: the helper runs ONCE, never per scanned row)
    v_team_canonical := public.team_franchise_primary_name(p_collection_id, p_team_slug);

    -- Fallback: accept the diacritic-stripped slug the frontend emits
    -- (e.g. atletico-de-madrid for "Atletico de Madrid"). Runs only on a
    -- would-be 404, so the functional index still serves the hot path.
    IF v_team_variants IS NULL THEN
      SELECT array_agg(DISTINCT team_name),
             (array_agg(team_name ORDER BY team_name))[1]
      INTO v_team_variants, v_team_canonical
      FROM editions
      WHERE collection_id = p_collection_id
        AND team_name IS NOT NULL
        AND regexp_replace(lower(trim(extensions.unaccent(team_name))), '[^a-z0-9]+', '-', 'g') = p_team_slug;
    END IF;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g')
          = regexp_replace(lower(trim(COALESCE(v_team_canonical, ''))), '[^a-z0-9]+', '-', 'g')
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;
-- <<< END verbatim get_team_detail <<<

\set cid '''95f28a17-224a-4025-96ad-adf8a4c63bfd'''
\set pin '''7dd9dd11-e8b6-45c4-ac99-71331f959714'''
\set e1 '''11111111-1111-1111-1111-111111111111'''
\set e2 '''22222222-2222-2222-2222-222222222222'''
\set e3 '''33333333-3333-3333-3333-333333333333'''
\set e4 '''44444444-4444-4444-4444-444444444444'''
\set e5 '''55555555-5555-5555-5555-555555555555'''
\set e6 '''66666666-6666-6666-6666-666666666666'''

INSERT INTO public.collections (id, slug) VALUES (:cid::uuid, 'nba_top_shot'), (:pin::uuid, 'disney_pinnacle');

-- Trail Blazers roster (slug 'trail-blazers'): e1,e2,e3,e5. e4 is Lakers (excluded).
INSERT INTO public.editions (id, collection_id, team_name, player_name, circulation_count) VALUES
  (:e1::uuid, :cid::uuid, 'Trail Blazers', 'Damian Lillard',  100),
  (:e2::uuid, :cid::uuid, 'Trail Blazers', 'Anfernee Simons',  50),
  (:e3::uuid, :cid::uuid, 'Trail Blazers', 'Damian Lillard',   30),  -- same player, 2nd edition
  (:e4::uuid, :cid::uuid, 'Lakers',        'LeBron James',    999),  -- other team, excluded
  (:e5::uuid, :cid::uuid, 'Trail Blazers', NULL,               10);  -- null player: counts circ, not player_count

-- e6: a diacritic team ('Atletico Madrid' with an accent) that resolves ONLY via the
-- unaccent FALLBACK lane (its accented slug 'atl-tico-madrid' != the emitted 'atletico-madrid').
INSERT INTO public.editions (id, collection_id, team_name, player_name, circulation_count) VALUES
  (:e6::uuid, :cid::uuid, 'Atlético Madrid', 'Antoine Griezmann', 5);

-- e1 latest-snapshot-wins (50 over stale 999); e2 priced (20); e3/e5 unpriced.
INSERT INTO public.fmv_snapshots (edition_id, fmv_usd, floor_price_usd, computed_at) VALUES
  (:e1::uuid, 999, 900, now() - interval '2 days'),
  (:e1::uuid,  50,  40, now() - interval '1 hour'),
  (:e2::uuid,  20,  15, now() - interval '1 hour');

-- Branding: active row wins; an inactive same-slug row must be ignored.
INSERT INTO public.teams_master (slug, team_name, primary_color, secondary_color, abbreviation, external_id, league, active) VALUES
  ('trail-blazers', 'Trail Blazers', '#E03A2F', '#000000', 'POR', 'POR1', 'NBA', true),
  ('trail-blazers', 'Trail Blazers', '#FFFFFF', '#FFFFFF', 'OLD', 'OLD1', 'NBA', false);

-- Sales: e1 in-window (25) counts; e2 out-of-window (40d) excluded; e4 Lakers excluded.
INSERT INTO public.sales (edition_id, collection_id, price_usd, sold_at) VALUES
  (:e1::uuid, :cid::uuid, 25, now() - interval '5 days'),
  (:e2::uuid, :cid::uuid, 30, now() - interval '40 days'),
  (:e4::uuid, :cid::uuid, 500, now() - interval '5 days');

-- A FRANCHISE under two labels (batch 62): All Day 'Las Vegas Raiders' (current, teams_master) + 'Oakland Raiders' (historic, league map)
\set ad '''dee28451-5d62-409e-a1ad-a83f763ac070'''
INSERT INTO public.collections (id, slug) VALUES (:ad::uuid, 'nfl_all_day');
INSERT INTO public.editions (id, collection_id, team_name, player_name, circulation_count) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001'::uuid, :ad::uuid, 'Las Vegas Raiders', 'Maxx Crosby',  100),
  ('bbbbbbbb-0000-0000-0000-000000000002'::uuid, :ad::uuid, 'Oakland Raiders',   'Bo Jackson',    20),
  ('bbbbbbbb-0000-0000-0000-000000000003'::uuid, :ad::uuid, 'Denver Broncos',    'John Elway',    30);
INSERT INTO public.teams_master (slug, team_name, primary_color, secondary_color, abbreviation, external_id, league, active) VALUES
  ('las-vegas-raiders', 'Las Vegas Raiders', '#000000', '#A5ACAF', 'LV', 'LV1', 'NFL', true);

-- Pinnacle franchise: two renders under 'Marvel' (slug 'marvel'), FMV 12/floor 10 each.
INSERT INTO public.pinnacle_editions (id, franchise, character_name, mint_count) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001'::uuid, 'Marvel', 'Iron Man', 500),
  ('aaaaaaaa-0000-0000-0000-000000000002'::uuid, 'Marvel', 'Thor',     400);

-- Pinnacle catalog (2026-09-26). 'Star Wars™' and 'Star Wars' are one franchise;
-- r2 is a duo pin; r4 also names Lucasfilm and an 'Unknown' character; Moana
-- exists ONLY in the catalog. No catalog pin names Marvel (legacy fallback).
INSERT INTO public.pinnacle_catalog (render_id, franchises, characters, total_minted, fmv_usd, floor_ask) VALUES
  ('r1', ARRAY['Star Wars™'],             ARRAY['Luke Skywalker'],           100, 10, 8),
  ('r2', ARRAY['Star Wars'],              ARRAY['Luke Skywalker', 'Leia'],    50,  5, NULL),
  ('r3', ARRAY['Moana'],                  ARRAY['Moana'],                     25,  7, 6),
  ('r4', ARRAY['Star Wars', 'Lucasfilm'], ARRAY['Unknown'],                   NULL, NULL, NULL);

-- ── 1. not found -> NULL ─────────────────────────────────────────────────────
SELECT _assert(public.get_team_detail(:cid::uuid, 'no-such-team') IS NULL, 'unmatched team slug -> NULL');

-- ── 2. slug scope + aggregation ──────────────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'edition_count'), '4', 'edition_count = 4 (Lakers excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'player_count'), '2', 'player_count = 2 distinct players (null-player edition excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'total_circulation'), '190', 'total_circulation = 100+50+30+10');

-- ── 3. latest-snapshot FMV/floor totals ──────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'fmv_total_usd'), '70', 'fmv_total = 50 (fresh) + 20');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'floor_total_usd'), '55', 'floor_total = 40 + 15');

-- ── 4. branding from the ACTIVE teams_master row ─────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'abbreviation'), 'POR', 'branding read from ACTIVE row (not the inactive OLD row)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'league'), 'NBA', 'league passthrough');

-- ── 5. 30d activity scoped to team + window ──────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'sales_30d'), '1', 'sales_30d = 1 (out-of-window + other-team sales excluded)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'trail-blazers') ->> 'volume_30d_usd'), '25', 'volume_30d = 25');

-- ── 6. Pinnacle franchise branch ─────────────────────────────────────────────
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'is_franchise'), 'true', 'Pinnacle collection -> is_franchise true');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'player_count'), '2', 'Pinnacle: distinct characters = 2');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'marvel') ->> 'fmv_total_usd'), '24', 'Pinnacle: per-render FMV collapse 12+12');
SELECT _assert(public.get_team_detail(:pin::uuid,'marvel') ->> 'abbreviation' IS NULL, 'Pinnacle: no teams_master branding');

-- ── 6b. Pinnacle from the render catalog (2026-09-26) ────────────────────────
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'edition_count'), '3', 'catalog: every pin naming Star Wars, ™ or not, multi-franchise included');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'player_count'), '2', 'catalog: characters by page slug over every name on a pin; Unknown excluded');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'total_circulation'), '150', 'catalog: circulation over pins with a count');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'fmv_total_usd'), '15', 'catalog: FMV total over priced pins');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'floor_total_usd'), '13', 'catalog: floor falls back to FMV per pin (8 + 5)');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'star-wars') ->> 'team_name'), 'Star Wars', 'catalog: canonical name has no ™ (the layout redirect compares slugs)');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'lucasfilm') ->> 'edition_count'), '1', 'catalog: a pin counts toward every franchise it names');
SELECT _assert_eq((public.get_team_detail(:pin::uuid,'moana') ->> 'edition_count'), '1', 'catalog: a catalog-only franchise has a page (was a 404)');
SELECT _assert(public.get_team_detail(:pin::uuid,'no-such-franchise') IS NULL, 'Pinnacle: unknown franchise -> NULL');

-- ── 7. UNACCENT FALLBACK lane (2026-08-01 audit change) ──────────────────────
SELECT _assert(public.get_team_detail(:cid::uuid,'atletico-madrid') IS NOT NULL, 'diacritic team resolves via the unaccent fallback (accented slug would 404)');
SELECT _assert_eq((public.get_team_detail(:cid::uuid,'atletico-madrid') ->> 'team_name'), 'Atlético Madrid', 'unaccent fallback returns the canonical accented team_name');

-- ── 8. THE FRANCHISE (batch 62): the current name's page counts every era; a historic label's page names the current name as canonical (the layout 308s it); another team is untouched
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'las-vegas-raiders') ->> 'edition_count'), '2', 'Las Vegas + Oakland editions counted together');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'las-vegas-raiders') ->> 'total_circulation'), '120', 'circulation over both eras');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'las-vegas-raiders') ->> 'team_name'), 'Las Vegas Raiders', 'the current name is canonical');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'las-vegas-raiders') ->> 'abbreviation'), 'LV', 'branding by the primary name');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'oakland-raiders') ->> 'team_name'), 'Las Vegas Raiders', 'a historic label resolves to the franchise and names the CURRENT name (the layout redirects)');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'oakland-raiders') ->> 'edition_count'), '2', 'and counts every era too');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'denver-broncos') ->> 'edition_count'), '1', 'a one-label team is unchanged');
SELECT _assert_eq((public.get_team_detail(:ad::uuid,'denver-broncos') ->> 'team_name'), 'Denver Broncos', 'and keeps its own name');

SELECT '✓ get_team_detail: all assertions passed' AS result;

ROLLBACK;
