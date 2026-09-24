-- Panini NBA/MLB team walk — staging for franchise hubs (2026-09-24, Trevor: "do what you think is best").
--
-- scripts/panini-team-walk.mjs (GitHub Actions, headless) walks Panini's marketplace
-- grid filtered by team and hands each page's listings to panini_team_listings_ingest.
-- NOTHING here is read by the site. Panini NBA/MLB reaches a franchise hub only after
-- it clears the accuracy gate (docs/features/franchise-hubs.md); until then this is
-- service-role-only staging.
--
-- Decision (Trevor delegated 2026-09-24): a card printed under a former franchise name
-- counts for the current franchise — SuperSonics -> Thunder, New Jersey Nets -> Nets,
-- New Orleans Hornets (2002-13) -> Pelicans, Charlotte Bobcats -> Hornets, Vancouver
-- Grizzlies -> Grizzlies, Oakland -> Athletics.
--
-- ⚠ MLB `team` is the CITY only. Los Angeles / New York / Chicago are two clubs each
-- and are deliberately NOT aliased — they land in unmapped_teams until a player+year
-- resolver exists. A guess there would put Ohtani's 2022 Angels card on the Dodgers hub.
--
-- Revert: DROP VIEW public.panini_team_listing_franchise_summary;
-- DROP FUNCTION public.panini_team_listings_ingest(text, text, timestamptz, jsonb, boolean);
-- DROP FUNCTION public.panini_resolve_team_keys(text, text);
-- DROP TABLE public.panini_team_listings; DROP TABLE public.panini_team_aliases;

-- ── Alias map: Panini's `team` string -> teams_master (league, slug) ───────────
CREATE TABLE IF NOT EXISTS public.panini_team_aliases (
  sport     text NOT NULL CHECK (sport IN ('Basketball','Baseball')),
  raw_team  text NOT NULL,
  league    public.league_t NOT NULL,
  team_slug text NOT NULL,
  note      text,
  PRIMARY KEY (sport, raw_team),
  FOREIGN KEY (league, team_slug) REFERENCES public.teams_master (league, slug)
);
COMMENT ON TABLE public.panini_team_aliases IS
  'Panini marketplace `team` string -> teams_master franchise. Basketball needs only the exceptions (panini_resolve_team_keys falls back to an exact NBA/WNBA team_name match); Baseball needs every city because Panini MLB cards carry the city only. LA/NY/Chicago are intentionally absent (two clubs each).';
ALTER TABLE public.panini_team_aliases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_team_aliases FROM anon, authenticated;

INSERT INTO public.panini_team_aliases (sport, raw_team, league, team_slug, note) VALUES
  ('Basketball','Los Angeles Clippers','NBA','clippers','Panini spelling; teams_master says LA Clippers'),
  ('Basketball','Seattle SuperSonics','NBA','thunder','former franchise'),
  ('Basketball','New Jersey Nets','NBA','nets','former franchise'),
  ('Basketball','New Orleans Hornets','NBA','pelicans','2002-13 history belongs to the Pelicans'),
  ('Basketball','Charlotte Bobcats','NBA','hornets','former franchise'),
  ('Basketball','Vancouver Grizzlies','NBA','grizzlies','former franchise'),
  ('Baseball','Arizona','MLB','diamondbacks',NULL),
  ('Baseball','Atlanta','MLB','braves',NULL),
  ('Baseball','Baltimore','MLB','orioles',NULL),
  ('Baseball','Boston','MLB','red-sox',NULL),
  ('Baseball','Cincinnati','MLB','reds',NULL),
  ('Baseball','Cleveland','MLB','guardians',NULL),
  ('Baseball','Colorado','MLB','rockies',NULL),
  ('Baseball','Detroit','MLB','tigers',NULL),
  ('Baseball','Houston','MLB','astros',NULL),
  ('Baseball','Kansas City','MLB','royals',NULL),
  ('Baseball','Miami','MLB','marlins',NULL),
  ('Baseball','Milwaukee','MLB','brewers',NULL),
  ('Baseball','Minnesota','MLB','twins',NULL),
  ('Baseball','Oakland','MLB','athletics','former city'),
  ('Baseball','Philadelphia','MLB','phillies',NULL),
  ('Baseball','Pittsburgh','MLB','pirates',NULL),
  ('Baseball','San Diego','MLB','padres',NULL),
  ('Baseball','San Francisco','MLB','giants',NULL),
  ('Baseball','Seattle','MLB','mariners',NULL),
  ('Baseball','St. Louis','MLB','cardinals',NULL),
  ('Baseball','Tampa Bay','MLB','rays',NULL),
  ('Baseball','Texas','MLB','rangers',NULL),
  ('Baseball','Toronto','MLB','blue-jays',NULL),
  ('Baseball','Washington','MLB','nationals',NULL)
ON CONFLICT (sport, raw_team) DO NOTHING;

-- ── Staging: one row per LISTED NFT (sku) the team walk has seen ─────────────
CREATE TABLE IF NOT EXISTS public.panini_team_listings (
  sku            text PRIMARY KEY,
  psku           text NOT NULL,
  sport          text NOT NULL CHECK (sport IN ('Basketball','Baseball')),
  walk_team      text NOT NULL,
  team_raw       text,
  franchise_keys text[] NOT NULL DEFAULT '{}',
  unmapped_teams text[] NOT NULL DEFAULT '{}',
  athlete        text,
  cardset        text,
  set_id         text,
  genesis_year   integer,
  rarity         text,
  end_seq        integer,
  price_usd      numeric,
  nft_type       text,
  active         boolean NOT NULL DEFAULT true,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  retired_at     timestamptz
);
COMMENT ON TABLE public.panini_team_listings IS
  'Panini NBA/MLB marketplace LISTINGS seen by scripts/panini-team-walk.mjs (team-filtered grid). Staging for franchise hubs — not read by the site. franchise_keys are "LEAGUE:team_slug"; unmapped_teams holds Panini team strings with no franchise (e.g. MLB "Los Angeles"). active=false only after a COMPLETE walk of the same (sport, walk_team) no longer saw the listing.';
CREATE INDEX IF NOT EXISTS panini_team_listings_walk_idx ON public.panini_team_listings (sport, walk_team, last_seen_at) WHERE active;
CREATE INDEX IF NOT EXISTS panini_team_listings_keys_idx ON public.panini_team_listings USING gin (franchise_keys);
ALTER TABLE public.panini_team_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_team_listings FROM anon, authenticated;

-- ── Resolver: one Panini team string -> franchise keys + what did not map ────
CREATE OR REPLACE FUNCTION public.panini_resolve_team_keys(p_sport text, p_team text)
 RETURNS TABLE(keys text[], unmapped text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH parts AS (
    SELECT DISTINCT btrim(x) AS part
    FROM unnest(string_to_array(coalesce(p_team, ''), '|')) AS x
    WHERE btrim(x) <> ''
  ), res AS (
    SELECT p.part,
           COALESCE(
             (SELECT a.league::text || ':' || a.team_slug FROM panini_team_aliases a
               WHERE a.sport = p_sport AND a.raw_team = p.part),
             CASE WHEN p_sport = 'Basketball' THEN
               (SELECT tm.league::text || ':' || tm.slug FROM teams_master tm
                 WHERE tm.league IN ('NBA','WNBA') AND tm.active AND tm.team_name = p.part
                 ORDER BY tm.league LIMIT 1)
             END
           ) AS key
    FROM parts p
  )
  SELECT COALESCE(array_agg(DISTINCT key) FILTER (WHERE key IS NOT NULL), '{}'),
         COALESCE(array_agg(part ORDER BY part) FILTER (WHERE key IS NULL), '{}')
  FROM res;
$function$;
REVOKE ALL ON FUNCTION public.panini_resolve_team_keys(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_resolve_team_keys(text, text) TO service_role;

-- ── Ingest: upsert one flush of listings; retire unseen ONLY on a complete walk ─
-- Returns {written, mapped, unmapped, retired}. `written` counts rows this call
-- actually inserted or updated (RETURNING), never rows offered.
CREATE OR REPLACE FUNCTION public.panini_team_listings_ingest(
  p_sport text, p_team_raw text, p_walk_started_at timestamptz, p_rows jsonb, p_complete boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_written int := 0;
  v_mapped int := 0;
  v_unmapped int := 0;
  v_retired int := 0;
BEGIN
  IF p_sport NOT IN ('Basketball','Baseball') THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: unsupported sport %', p_sport;
  END IF;
  IF coalesce(btrim(p_team_raw), '') = '' OR p_walk_started_at IS NULL THEN
    RAISE EXCEPTION 'panini_team_listings_ingest: team and walk start are required';
  END IF;

  WITH src AS (
    SELECT DISTINCT ON (r->>'sku')
           r->>'sku' AS sku, r->>'psku' AS psku, nullif(r->>'team', '') AS team,
           r->>'athlete' AS athlete, r->>'cardset' AS cardset,
           CASE WHEN r->>'genesis_year' ~ '^\d{4}$' THEN (r->>'genesis_year')::int END AS genesis_year,
           r->>'rarity' AS rarity,
           CASE WHEN r->>'end_seq' ~ '^\d+$' THEN (r->>'end_seq')::int END AS end_seq,
           CASE WHEN r->>'price_usd' ~ '^\d+(\.\d+)?$' THEN (r->>'price_usd')::numeric END AS price_usd,
           r->>'nft_type' AS nft_type
    FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) AS r
    WHERE coalesce(r->>'sku', '') <> '' AND coalesce(r->>'psku', '') <> ''
    ORDER BY r->>'sku'
  ), up AS (
    INSERT INTO panini_team_listings AS t
      (sku, psku, sport, walk_team, team_raw, franchise_keys, unmapped_teams, athlete, cardset,
       set_id, genesis_year, rarity, end_seq, price_usd, nft_type, active, first_seen_at, last_seen_at, retired_at)
    SELECT s.sku, s.psku, p_sport, p_team_raw, s.team, m.keys, m.unmapped, s.athlete, s.cardset,
           split_part(s.psku, '_', 1), s.genesis_year, s.rarity, s.end_seq, s.price_usd, s.nft_type,
           true, now(), now(), NULL
    FROM src s
    CROSS JOIN LATERAL panini_resolve_team_keys(p_sport, s.team) m
    ON CONFLICT (sku) DO UPDATE SET
      psku = EXCLUDED.psku, sport = EXCLUDED.sport, walk_team = EXCLUDED.walk_team,
      team_raw = EXCLUDED.team_raw, franchise_keys = EXCLUDED.franchise_keys,
      unmapped_teams = EXCLUDED.unmapped_teams, athlete = EXCLUDED.athlete, cardset = EXCLUDED.cardset,
      set_id = EXCLUDED.set_id, genesis_year = EXCLUDED.genesis_year, rarity = EXCLUDED.rarity,
      end_seq = EXCLUDED.end_seq, price_usd = EXCLUDED.price_usd, nft_type = EXCLUDED.nft_type,
      active = true, last_seen_at = now(), retired_at = NULL
    RETURNING cardinality(t.franchise_keys) > 0 AS is_mapped
  )
  SELECT count(*), count(*) FILTER (WHERE is_mapped), count(*) FILTER (WHERE NOT is_mapped)
    INTO v_written, v_mapped, v_unmapped
  FROM up;

  -- A listing this complete walk did not see is no longer listed. Scoped to the same
  -- (sport, walk_team), and never on a partial walk (the caller passes p_complete only
  -- when the grid ended in an empty page AND every earlier flush landed).
  IF p_complete THEN
    UPDATE panini_team_listings
       SET active = false, retired_at = now()
     WHERE sport = p_sport AND walk_team = p_team_raw AND active
       AND last_seen_at < p_walk_started_at;
    GET DIAGNOSTICS v_retired = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('written', v_written, 'mapped', v_mapped, 'unmapped', v_unmapped, 'retired', v_retired);
END;
$function$;
REVOKE ALL ON FUNCTION public.panini_team_listings_ingest(text, text, timestamptz, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panini_team_listings_ingest(text, text, timestamptz, jsonb, boolean) TO service_role;

-- ── Read-back: active listings per franchise (operators only) ────────────────
CREATE OR REPLACE VIEW public.panini_team_listing_franchise_summary
WITH (security_invoker = on) AS
SELECT k.franchise_key,
       count(*)                AS active_listings,
       count(DISTINCT l.psku)  AS editions,
       min(l.price_usd)        AS min_ask_usd,
       min(l.genesis_year)     AS first_year,
       max(l.genesis_year)     AS last_year,
       max(l.last_seen_at)     AS last_seen_at
FROM public.panini_team_listings l
CROSS JOIN LATERAL unnest(l.franchise_keys) AS k(franchise_key)
WHERE l.active
GROUP BY k.franchise_key;
REVOKE ALL ON public.panini_team_listing_franchise_summary FROM anon, authenticated;