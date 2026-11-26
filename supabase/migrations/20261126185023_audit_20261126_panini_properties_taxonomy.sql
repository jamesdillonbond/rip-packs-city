-- audit_20261126_panini_properties_taxonomy (2026-11-26, Trevor: "Keep going and start putting this into action")
--
-- The level RPC lacked between a publisher (Panini, Candy) and a product: the PROPERTY a product is made under
-- (NBA, FIFA World Cup, The Rolling Stones). Collectors never see the word "property": on screen properties sit
-- under two headings, "Leagues" and "Entertainment" (Trevor 11-26); "property" is for URLs, code and docs.
--
-- 1. publisher_properties — one row per (publisher, slug). Seeded for Panini (16). Candy rows come with the Candy
--    step, after its name-based grouping is verified.
-- 2. panini_products.property_slug — filled from the product NAME first (a soccer product is one of six
--    properties), then Panini's own grid sport (last_grid_sport, stored on every id). A BEFORE trigger fills it
--    for products the walk discovers later; a hand-set value is never overwritten. An entertainment product
--    with no rule stays NULL (counted as unplaced by the board, never guessed).
-- 3. get_panini_property_board() — the properties that have a product page (newest panini_product_rollup run),
--    each with its seasons, products, editions, FMV total and 30-day sales on record, plus product slug -> property.
--
-- Measured before writing (2026-11-26 ~10:35 AM PT): 176 product ids; grid sport on all 176; `sport` on 6.
--
-- REVERT: DROP FUNCTION public.get_panini_property_board(); DROP TRIGGER panini_products_fill_property_trg ON
--   public.panini_products; DROP FUNCTION public.panini_products_fill_property(); DROP FUNCTION
--   public.panini_property_slug(text, text); ALTER TABLE public.panini_products DROP COLUMN property_slug;
--   DROP TABLE public.publisher_properties;

CREATE TABLE IF NOT EXISTS public.publisher_properties (
  publisher    text NOT NULL CHECK (publisher IN ('panini', 'candy')),
  slug         text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name         text NOT NULL,
  heading      text NOT NULL CHECK (heading IN ('leagues', 'entertainment')),
  category     text NOT NULL,
  subject_word text NOT NULL DEFAULT 'player',
  group_word   text,
  team_league  text,
  sort_order   integer NOT NULL DEFAULT 100,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (publisher, slug)
);
ALTER TABLE public.publisher_properties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publisher_properties FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.publisher_properties TO service_role;
COMMENT ON TABLE public.publisher_properties IS 'League / tournament / IP a publisher''s products are made under. On screen: headings Leagues and Entertainment; never the word property. Service-role reads only.';

INSERT INTO public.publisher_properties (publisher, slug, name, heading, category, subject_word, group_word, team_league, sort_order) VALUES
  ('panini', 'fifa-world-cup',  'FIFA World Cup',     'leagues',       'Soccer',     'player',    'nation', NULL,   10),
  ('panini', 'nba',             'NBA',                'leagues',       'Basketball', 'player',    'team',   'nba',  20),
  ('panini', 'nfl',             'NFL',                'leagues',       'Football',   'player',    'team',   'nfl',  30),
  ('panini', 'wnba',            'WNBA',               'leagues',       'Basketball', 'player',    'team',   'wnba', 40),
  ('panini', 'baseball',        'Baseball',           'leagues',       'Baseball',   'player',    'team',   'mlb',  50),
  ('panini', 'nwsl',            'NWSL',               'leagues',       'Soccer',     'player',    'club',   'nwsl', 60),
  ('panini', 'laliga',          'LaLiga',             'leagues',       'Soccer',     'player',    'club',   NULL,   70),
  ('panini', 'serie-a',         'Serie A',            'leagues',       'Soccer',     'player',    'club',   NULL,   80),
  ('panini', 'french-football', 'French football',    'leagues',       'Soccer',     'player',    'club',   NULL,   90),
  ('panini', 'soccer-other',    'Other soccer',       'leagues',       'Soccer',     'player',    'club',   NULL,  100),
  ('panini', 'racing',          'Racing',             'leagues',       'Racing',     'driver',    'team',   NULL,  110),
  ('panini', 'wwe',             'WWE',                'leagues',       'Wrestling',  'superstar', NULL,     NULL,  120),
  ('panini', 'collegiate',      'Collegiate',         'leagues',       'College',    'player',    'school', NULL,  130),
  ('panini', 'bad-eggs',        'Bad Eggs',           'entertainment', 'Entertainment', 'character', 'clan', NULL, 210),
  ('panini', 'moonbirds',       'Moonbirds',          'entertainment', 'Entertainment', 'character', NULL,   NULL, 220),
  ('panini', 'rolling-stones',  'The Rolling Stones', 'entertainment', 'Music',         'artist',    NULL,   NULL, 230)
ON CONFLICT (publisher, slug) DO NOTHING;

CREATE OR REPLACE FUNCTION public.panini_property_slug(p_name text, p_grid_sport text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_name ILIKE '%World Cup%'                           THEN 'fifa-world-cup'
    WHEN p_name ILIKE '%NWSL%'                                THEN 'nwsl'
    WHEN p_name ILIKE '%LaLiga%' OR p_name ILIKE '%La Liga%'  THEN 'laliga'
    WHEN p_name ILIKE '%Serie A%'                             THEN 'serie-a'
    WHEN p_name ILIKE '%Ligue 1%' OR p_name ILIKE '%Foot FR%' THEN 'french-football'
    WHEN p_name ILIKE '%WNBA%'                                THEN 'wnba'
    WHEN p_name ILIKE '%Bad Eggs%'                            THEN 'bad-eggs'
    WHEN p_name ILIKE '%Moonbirds%'                           THEN 'moonbirds'
    WHEN p_name ILIKE '%Rolling Stones%'                      THEN 'rolling-stones'
    WHEN p_name ILIKE '%WWE%'                                 THEN 'wwe'
    WHEN lower(p_grid_sport) = 'womens basketball'            THEN 'wnba'
    WHEN lower(p_grid_sport) = 'womens soccer'                THEN 'nwsl'
    WHEN lower(p_grid_sport) = 'basketball'                   THEN 'nba'
    WHEN lower(p_grid_sport) = 'football'                     THEN 'nfl'
    WHEN lower(p_grid_sport) = 'baseball'                     THEN 'baseball'
    WHEN lower(p_grid_sport) = 'soccer'                       THEN 'soccer-other'
    WHEN lower(p_grid_sport) = 'racing'                       THEN 'racing'
    WHEN lower(p_grid_sport) = 'wwe'                          THEN 'wwe'
    WHEN lower(p_grid_sport) = 'collegiate'                   THEN 'collegiate'
    ELSE NULL
  END
$fn$;
REVOKE EXECUTE ON FUNCTION public.panini_property_slug(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_property_slug(text, text) TO postgres, service_role;

ALTER TABLE public.panini_products ADD COLUMN IF NOT EXISTS property_slug text;
COMMENT ON COLUMN public.panini_products.property_slug IS 'publisher_properties.slug (publisher panini). Filled by panini_products_fill_property_trg from the name, then last_grid_sport; NULL = no rule places it (never guessed). A hand-set value is kept.';

CREATE OR REPLACE FUNCTION public.panini_products_fill_property()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.property_slug IS NULL THEN
    NEW.property_slug := public.panini_property_slug(NEW.name, NEW.last_grid_sport);
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE EXECUTE ON FUNCTION public.panini_products_fill_property() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_products_fill_property() TO postgres, service_role;

CREATE OR REPLACE TRIGGER panini_products_fill_property_trg
  BEFORE INSERT OR UPDATE OF name, last_grid_sport ON public.panini_products
  FOR EACH ROW EXECUTE FUNCTION public.panini_products_fill_property();

UPDATE public.panini_products
   SET property_slug = public.panini_property_slug(name, last_grid_sport)
 WHERE property_slug IS NULL;

CREATE OR REPLACE FUNCTION public.get_panini_property_board()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH run AS (
    SELECT r.slug, r.name, r.editions, r.fmv_total_usd, r.listed_editions, r.sales_30d, r.sales_30d_volume_usd,
           r.computed_at, pp.property_slug,
           substring(r.name from '^\d{4}(?:-\d{2})?') AS season
      FROM public.panini_product_rollup r
      LEFT JOIN public.panini_products pp ON pp.set_id = r.product_set_id
     WHERE r.computed_at = (SELECT max(computed_at) FROM public.panini_product_rollup)
  ), agg AS (
    SELECT property_slug,
           count(*)::int                 AS products,
           sum(editions)::int            AS editions,
           sum(fmv_total_usd)            AS fmv_total_usd,
           sum(listed_editions)::int     AS listed_editions,
           sum(sales_30d)::int           AS sales_30d,
           sum(sales_30d_volume_usd)     AS sales_30d_volume_usd,
           min(season)                   AS first_season,
           max(season)                   AS last_season
      FROM run
     WHERE property_slug IS NOT NULL
     GROUP BY property_slug
  )
  SELECT jsonb_build_object(
    'computed_at', (SELECT max(computed_at) FROM run),
    'unplaced_products', (SELECT count(*)::int FROM run WHERE property_slug IS NULL),
    'properties', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'slug', p.slug, 'name', p.name, 'heading', p.heading, 'category', p.category,
               'subject_word', p.subject_word, 'group_word', p.group_word, 'team_league', p.team_league,
               'sort_order', p.sort_order,
               'products', a.products, 'editions', a.editions, 'fmv_total_usd', a.fmv_total_usd,
               'listed_editions', a.listed_editions, 'sales_30d', a.sales_30d,
               'sales_30d_volume_usd', a.sales_30d_volume_usd,
               'first_season', a.first_season, 'last_season', a.last_season)
             ORDER BY p.sort_order, p.slug)
        FROM agg a
        JOIN public.publisher_properties p ON p.publisher = 'panini' AND p.slug = a.property_slug), '[]'::jsonb),
    'product_property', COALESCE((
      SELECT jsonb_object_agg(run.slug, run.property_slug) FROM run WHERE property_slug IS NOT NULL), '{}'::jsonb)
  )
$fn$;
REVOKE EXECUTE ON FUNCTION public.get_panini_property_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_panini_property_board() TO postgres, service_role;
