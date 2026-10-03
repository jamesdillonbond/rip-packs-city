-- DB invariant: market cap — public.market_cap_edition_rows, get_market_cap_board,
-- refresh_market_cap_current and get_market_cap_entity.
--
-- market cap = FMV x COLLECTOR-HELD supply (minted - burned - issuer-held). Pins:
--   · burned + issuer-held Moments are EXCLUDED, for every supply source
--     (Atlas badge_editions, Atlas edition supply, Panini, Candy treasury split);
--   · an edition with no split — or a split older than 3 days, or one whose parts
--     exceed its whole — is collector_held NULL: it adds nothing to mcap_usd but still
--     counts in `editions` / mcap_minted_usd, so a partial sum reads as partial;
--   · a collection with no source (UFC) reports mcap_usd NULL, never $0;
--   · unknown collection → zero rows; unknown grain → 22023; p_limit clamps 1..500;
--   · team highlights are not players; known caps rank ahead of unknown ones;
--   · refresh_market_cap_current: entity rows match each page's own slug rule
--     (accent-folded players with a plain-spelling ALIAS, team FRANCHISES, sets
--     across series), aliases never count toward a rank, a second identical run
--     changes nothing, and an EMPTY stage refuses to wipe the table;
--   · the 7-day figure comes from market_cap_daily and is NULL without history.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261003213500_audit_20261003_market_cap_current_daily_history_and_four_more_supply_sources.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if a copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- Stub of the franchise registry: 'kings' and 'sacramento-kings' are one franchise.
CREATE FUNCTION public.team_franchise_slugs(p_collection_id uuid, p_team_slug text) RETURNS text[]
LANGUAGE sql AS $$
  SELECT CASE WHEN p_team_slug IN ('kings','sacramento-kings') THEN ARRAY['kings','sacramento-kings'] ELSE ARRAY[p_team_slug] END
$$;
CREATE TABLE public.pipeline_log (pipeline text, ok boolean, extra jsonb);
CREATE FUNCTION public.log_pipeline_run(p_pipeline text, p_started_at timestamptz, p_rows_found integer, p_rows_written integer,
  p_rows_skipped integer, p_ok boolean, p_error text, p_collection_slug text, p_cursor_before text, p_cursor_after text, p_extra jsonb)
RETURNS bigint LANGUAGE sql AS $$ INSERT INTO public.pipeline_log VALUES (p_pipeline, p_ok, p_extra) RETURNING 1::bigint $$;

CREATE TABLE public.collections (id uuid PRIMARY KEY, slug varchar);
CREATE TABLE public.editions (
  id uuid PRIMARY KEY, external_id varchar, collection_id uuid, player_id uuid,
  player_name text, team_name text, set_name text, tier text, series smallint,
  circulation_count integer, badges text[]
);
CREATE TABLE public.badge_editions (
  collection_id uuid, external_id text, circulation_count integer, burned integer,
  hidden_in_packs integer, play_tags jsonb, set_play_tags jsonb,
  has_rookie_mint boolean, is_three_star_rookie boolean
);
CREATE TABLE public.panini_editions (
  collection_id uuid, external_id text, mint_cap integer, pulled_count integer,
  still_in_packs integer, burned_count integer
);
CREATE TABLE public.mv_candy_scarcity_board (external_id varchar, circulation_count integer, sealed bigint, circulating bigint);
CREATE TABLE public.atlas_edition_supply (
  product text, edition_id text, minted bigint, burned bigint, owned bigint, locked bigint,
  listed bigint, hidden bigint, max_mint bigint, fetched_at timestamptz
);
CREATE TABLE public.edition_fmv_current (edition_id uuid, fmv_usd numeric, confidence text);
CREATE TABLE public.pinnacle_catalog (
  render_id text, edition_id text, set_name text, edition_type text, series_name text,
  total_minted integer, fmv_usd numeric, fmv_confidence text, characters text[], franchises text[]
);
CREATE TABLE public.market_cap_current (
  collection_slug        text        NOT NULL,
  grain                  text        NOT NULL,
  match_key              text        NOT NULL,
  group_key              text        NOT NULL,
  is_primary             boolean     NOT NULL,
  group_label            text,
  editions               integer     NOT NULL,
  editions_supply_known  integer     NOT NULL,
  editions_priced        integer     NOT NULL,
  minted                 bigint,
  burned                 bigint,
  issuer_held            bigint,
  collector_held         bigint,
  mcap_usd               numeric,
  mcap_high_conf_usd     numeric,
  mcap_minted_usd        numeric,
  mcap_rank              integer,
  groups_ranked          integer     NOT NULL,
  computed_at            timestamptz NOT NULL,
  PRIMARY KEY (collection_slug, grain, match_key)
);
CREATE TABLE public.market_cap_daily (
  snapshot_date          date        NOT NULL,
  collection_slug        text        NOT NULL,
  grain                  text        NOT NULL,
  group_key              text        NOT NULL,
  group_label            text,
  editions               integer     NOT NULL,
  editions_supply_known  integer     NOT NULL,
  collector_held         bigint,
  mcap_usd               numeric,
  mcap_high_conf_usd     numeric,
  computed_at            timestamptz NOT NULL,
  PRIMARY KEY (snapshot_date, collection_slug, grain, group_key)
);
CREATE TABLE public.market_cap_refresh_state (
  id            boolean     PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at  timestamptz NOT NULL
);

INSERT INTO public.collections VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'nba_top_shot'),
  ('00000000-0000-0000-0000-0000000000a2', 'laliga_golazos'),
  ('00000000-0000-0000-0000-0000000000a3', 'panini_blockchain'),
  ('00000000-0000-0000-0000-0000000000a4', 'ufc_strike'),
  ('00000000-0000-0000-0000-0000000000a5', 'candy_mlb'),
  ('00000000-0000-0000-0000-0000000000a6', 'disney_pinnacle');

-- Top Shot: E1 split known (100 minted, 30 burned, 10 issuer-held -> 60 collector-held),
-- E2 fully collector-held, E3 has NO Atlas row, E4 is a team highlight,
-- E5's Atlas parts exceed its whole (20 - 15 - 10 < 0) and is unpriced.
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-000000000e01', '1:1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'Alice', 'Kings', 'Base Set', 'COMMON', 2, 100, NULL),
  ('00000000-0000-0000-0000-000000000e02', '1:2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', 'Bob',   'Kings', 'Base Set', 'COMMON', 2, 50,  NULL),
  ('00000000-0000-0000-0000-000000000e03', '1:3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b03', 'Carl',  'Kings', 'Base Set', 'RARE',   2, 40,  NULL),
  ('00000000-0000-0000-0000-000000000e04', '1:4', '00000000-0000-0000-0000-0000000000a1', NULL, 'Sacramento Kings', 'Sacramento Kings', 'Squad Goals', 'COMMON', 2, 10, NULL),
  ('00000000-0000-0000-0000-000000000e05', '1:5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'Alice', 'Kings', 'Base Set', 'COMMON', 0, 20,  NULL),
  -- Golazos: g1 has a FRESH Atlas split, g2 a STALE one (5 days)
  ('00000000-0000-0000-0000-000000000e06', 'g1',  '00000000-0000-0000-0000-0000000000a2', NULL, 'Dani', 'Club', 'Eternal', 'COMMON', 1, 1000, NULL),
  ('00000000-0000-0000-0000-000000000e08', 'g2',  '00000000-0000-0000-0000-0000000000a2', NULL, 'José Núñez', 'Club', 'Eternal', 'RARE', 1, 50, NULL),
  ('00000000-0000-0000-0000-000000000e07', 'p1',  '00000000-0000-0000-0000-0000000000a3', NULL, 'Eve', NULL, 'Prizm', 'RARE', NULL, 100, NULL),
  -- UFC: no supply source at all
  ('00000000-0000-0000-0000-000000000e09', 'u1',  '00000000-0000-0000-0000-0000000000a4', NULL, 'Fran', NULL, 'Strike', 'CHALLENGER', 1, 1000, NULL),
  -- Candy: treasury split 10 sealed / 85 circulating of 100 → 5 burned
  ('00000000-0000-0000-0000-000000000e10', 'c1',  '00000000-0000-0000-0000-0000000000a5', NULL, 'Gus', 'Reds', 'Base', 'COMMON', 1, 100, '{"First Mint"}');

INSERT INTO public.badge_editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '1:1', 100, 30, 10, '[{"id":"ROOKIE_YEAR","title":"Rookie Year"},{"id":"X","title":"Not A Badge"}]', '[]', true, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:2', 50, 0, 0, '[]', '[]', false, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:4', 10, 0, 0, '[]', '[]', false, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:5', 20, 15, 10, '[]', '[]', false, false),
  -- a Golazos-shaped badge row (the seeded fabricated zeros) is never read
  ('00000000-0000-0000-0000-0000000000a2', 'g1', 0, 0, 0, '[]', '[]', false, false);

INSERT INTO public.atlas_edition_supply VALUES
  ('laliga', 'g1', 1000, 200, 400, 50, 50, 300, 1000, now() - interval '1 hour'),
  ('laliga', 'g2', 50, 0, 50, 0, 0, 0, 50, now() - interval '5 days'),
  ('disney', 'd1', 500, 50, 300, 20, 30, 100, 500, now() - interval '1 hour');

INSERT INTO public.panini_editions VALUES
  ('00000000-0000-0000-0000-0000000000a3', 'p1', 100, 40, 20, 40);

INSERT INTO public.mv_candy_scarcity_board VALUES ('c1', 100, 10, 85);

INSERT INTO public.edition_fmv_current VALUES
  ('00000000-0000-0000-0000-000000000e01', 2.00, 'HIGH'),
  ('00000000-0000-0000-0000-000000000e02', 1.00, 'ASK_ONLY'),
  ('00000000-0000-0000-0000-000000000e03', 10.00, 'HIGH'),
  ('00000000-0000-0000-0000-000000000e04', 1.00, 'LOW'),
  ('00000000-0000-0000-0000-000000000e06', 3.00, 'MEDIUM'),
  ('00000000-0000-0000-0000-000000000e08', 4.00, 'MEDIUM'),
  ('00000000-0000-0000-0000-000000000e07', 5.00, 'MEDIUM'),
  ('00000000-0000-0000-0000-000000000e09', 3.00, 'LOW'),
  ('00000000-0000-0000-0000-000000000e10', 2.00, 'HIGH');

INSERT INTO public.pinnacle_catalog VALUES ('r1', 'd1', 'Pin Set', 'Limited Edition', 'Series 1', 500, 1.00, 'LOW', '{"Minnie Mouse","Daisy Duck"}', '{"Star Wars™"}');

-- >>> BEGIN verbatim market_cap_edition_rows (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.market_cap_edition_rows(p_collection text, p_badges boolean)
 RETURNS TABLE(coll text, ext_id text, player_key text, player_name text, team_name text, set_name text, set_slug text, tier text, series_num integer, series_name text, is_team_moment boolean, badges text[], minted bigint, burned bigint, issuer_held bigint, collector_held bigint, fmv_usd numeric, confidence text, supply_source text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT c.slug::text AS coll,
           e.external_id::text AS ext_id,
           coalesce(e.player_id::text, lower(btrim(e.player_name))) AS player_key,
           btrim(e.player_name) AS player_name,
           btrim(e.team_name) AS team_name,
           btrim(e.set_name) AS set_name,
           regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
           e.tier::text AS tier,
           e.series::integer AS series_num,
           NULL::text AS series_name,
           (btrim(e.player_name) = btrim(e.team_name) OR btrim(e.team_name) LIKE btrim(e.player_name) || ' %') AS is_team_moment,
           CASE WHEN p_badges THEN ARRAY(
             SELECT DISTINCT CASE WHEN regexp_replace(lower(t.title), '[^a-z0-9]+', '', 'g') = 'codenamemercury'
                                  THEN 'Leaderboard Reward' ELSE btrim(t.title) END
             FROM (
               SELECT x->>'title' AS title
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.play_tags) = 'array' THEN b.play_tags ELSE '[]'::jsonb END) x
               WHERE regexp_replace(lower(coalesce(x->>'title', x->>'id', '')), '[^a-z0-9]+', '', 'g') = ANY (ARRAY[
                 'topshotdebut','rookieyear','rookiemint','rookiepremiere',
                 'mvpyear','championshipyear','rookieoftheyear','allstar','threestarrookie'])
               UNION ALL
               SELECT x->>'title'
               FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.set_play_tags) = 'array' THEN b.set_play_tags ELSE '[]'::jsonb END) x
               UNION ALL SELECT 'Rookie Mint' WHERE b.has_rookie_mint IS TRUE
               UNION ALL SELECT 'Three-Star Rookie' WHERE b.is_three_star_rookie IS TRUE
               UNION ALL SELECT unnest(coalesce(e.badges, '{}'::text[]))
             ) t
             WHERE btrim(coalesce(t.title, '')) <> ''
           ) END AS badges,
           s.minted, s.burned, s.issuer_held, s.collector_held,
           f.fmv_usd,
           f.confidence::text AS confidence,
           k.src AS supply_source
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    LEFT JOIN badge_editions b
      ON b.collection_id = e.collection_id AND b.external_id = e.external_id
     AND c.slug IN ('nba_top_shot','nfl_all_day')
    LEFT JOIN atlas_edition_supply g
      ON c.slug = 'laliga_golazos' AND g.product = 'laliga' AND g.edition_id = e.external_id
     AND g.fetched_at > now() - interval '3 days'
    LEFT JOIN panini_editions p
      ON p.collection_id = e.collection_id AND p.external_id = e.external_id
     AND c.slug = 'panini_blockchain'
    LEFT JOIN mv_candy_scarcity_board cs
      ON c.slug = 'candy_mlb' AND cs.external_id = e.external_id
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN b.circulation_count > 0 AND b.burned IS NOT NULL AND b.hidden_in_packs IS NOT NULL
             AND b.circulation_count - b.burned - b.hidden_in_packs >= 0 THEN 'atlas_badge'
        WHEN g.minted > 0 AND g.minted - g.burned - g.hidden >= 0 THEN 'atlas_supply'
        WHEN p.mint_cap IS NOT NULL THEN 'panini'
        WHEN cs.circulation_count > 0 AND cs.sealed IS NOT NULL AND cs.circulating IS NOT NULL
             AND cs.circulation_count - cs.sealed - cs.circulating >= 0 THEN 'candy'
      END AS src
    ) k
    CROSS JOIN LATERAL (
      SELECT
        CASE k.src WHEN 'atlas_badge'  THEN b.circulation_count
                   WHEN 'atlas_supply' THEN g.minted
                   WHEN 'panini'       THEN p.mint_cap
                   WHEN 'candy'        THEN cs.circulation_count
                   ELSE e.circulation_count END::bigint AS minted,
        CASE k.src WHEN 'atlas_badge'  THEN b.burned
                   WHEN 'atlas_supply' THEN g.burned
                   WHEN 'panini'       THEN p.burned_count
                   WHEN 'candy'        THEN cs.circulation_count - cs.sealed - cs.circulating END::bigint AS burned,
        CASE k.src WHEN 'atlas_badge'  THEN b.hidden_in_packs
                   WHEN 'atlas_supply' THEN g.hidden
                   WHEN 'panini'       THEN p.still_in_packs
                   WHEN 'candy'        THEN cs.sealed END::bigint AS issuer_held,
        CASE k.src WHEN 'atlas_badge'  THEN b.circulation_count - b.burned - b.hidden_in_packs
                   WHEN 'atlas_supply' THEN g.minted - g.burned - g.hidden
                   WHEN 'panini'       THEN p.pulled_count
                   WHEN 'candy'        THEN cs.circulating END::bigint AS collector_held
    ) s
    WHERE p_collection IS NULL OR c.slug = p_collection

    UNION ALL

    SELECT 'disney_pinnacle', pc.render_id::text, NULL, NULL, NULL,
           btrim(pc.set_name), regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g'),
           pc.edition_type, NULL::integer, btrim(pc.series_name), false,
           NULL::text[],
           CASE WHEN dk.ok THEN d.minted ELSE pc.total_minted::bigint END,
           CASE WHEN dk.ok THEN d.burned END,
           CASE WHEN dk.ok THEN d.hidden END,
           CASE WHEN dk.ok THEN d.minted - d.burned - d.hidden END,
           pc.fmv_usd, pc.fmv_confidence::text,
           CASE WHEN dk.ok THEN 'atlas_supply' END
    FROM pinnacle_catalog pc
    LEFT JOIN atlas_edition_supply d
      ON d.product = 'disney' AND d.edition_id = pc.edition_id
     AND d.fetched_at > now() - interval '3 days'
    CROSS JOIN LATERAL (SELECT coalesce(d.minted > 0 AND d.minted - d.burned - d.hidden >= 0, false) AS ok) dk
    WHERE p_collection IS NULL OR p_collection = 'disney_pinnacle';
$function$;
-- <<< END verbatim market_cap_edition_rows <<<

-- >>> BEGIN verbatim get_market_cap_board (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_market_cap_board(p_group text DEFAULT 'collection', p_collection text DEFAULT NULL, p_limit integer DEFAULT 100)
 RETURNS TABLE(collection_slug text, group_key text, group_label text, set_name text, tier text, series_num integer, series_name text, edition_external_id text, editions integer, editions_supply_known integer, editions_priced integer, minted bigint, burned bigint, issuer_held bigint, collector_held bigint, mcap_usd numeric, mcap_high_conf_usd numeric, mcap_minted_usd numeric, mcap_usd_7d_ago numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_day7  date := (now() AT TIME ZONE 'America/Los_Angeles')::date - 7;
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('collection','edition','player','team','set','series','tier','badge') THEN
    RAISE EXCEPTION 'get_market_cap_board: unknown group %', p_group USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ed AS (
    SELECT * FROM public.market_cap_edition_rows(p_collection, p_group = 'badge')
  ),
  keyed AS (
    SELECT ed.*,
           CASE p_group
             WHEN 'collection' THEN ed.coll
             WHEN 'edition'    THEN ed.ext_id
             WHEN 'player'     THEN CASE WHEN ed.player_name <> '' AND NOT coalesce(ed.is_team_moment, false) THEN ed.player_key END
             WHEN 'team'       THEN nullif(ed.team_name, '')
             WHEN 'set'        THEN CASE WHEN ed.set_name <> '' THEN ed.set_name || '|' || coalesce(ed.series_num::text, ed.series_name, '') END
             WHEN 'series'     THEN coalesce(ed.series_num::text, nullif(ed.series_name, ''))
             WHEN 'tier'       THEN nullif(ed.tier, '')
           END AS gkey
    FROM ed
  ),
  rows_ AS (
    SELECT k.coll, k.gkey, k.player_name, k.team_name, k.set_name, k.tier, k.series_num, k.series_name, k.ext_id,
           k.minted, k.burned, k.issuer_held, k.collector_held, k.fmv_usd, k.confidence
    FROM keyed k
    WHERE p_group <> 'badge' AND k.gkey IS NOT NULL
    UNION ALL
    SELECT k.coll, regexp_replace(lower(bt.title), '[^a-z0-9]+', '', 'g'), bt.title, NULL, NULL, NULL, NULL, NULL, NULL,
           k.minted, k.burned, k.issuer_held, k.collector_held, k.fmv_usd, k.confidence
    FROM keyed k
    CROSS JOIN LATERAL unnest(k.badges) AS bt(title)
    WHERE p_group = 'badge'
  ),
  agg AS (
    SELECT r.coll,
           r.gkey,
           CASE p_group
             WHEN 'collection' THEN r.coll
             WHEN 'edition'    THEN min(coalesce(nullif(r.player_name, ''), nullif(r.team_name, ''), r.set_name))
             WHEN 'player'     THEN min(r.player_name)
             WHEN 'team'       THEN min(r.team_name)
             WHEN 'set'        THEN min(r.set_name)
             WHEN 'series'     THEN coalesce(min(r.series_name), min(r.series_num)::text)
             WHEN 'tier'       THEN min(r.tier)
             WHEN 'badge'      THEN min(r.player_name)
           END AS glabel,
           CASE WHEN p_group IN ('edition','set') THEN min(r.set_name) END AS gset,
           CASE WHEN p_group IN ('edition','tier') THEN min(r.tier) END AS gtier,
           CASE WHEN p_group IN ('edition','set','series') THEN min(r.series_num) END AS gseries,
           CASE WHEN p_group IN ('edition','set','series') THEN min(r.series_name) END AS gseries_name,
           CASE WHEN p_group = 'edition' THEN min(r.ext_id) END AS gext,
           count(*)::integer AS n,
           count(r.collector_held)::integer AS n_known,
           count(r.fmv_usd)::integer AS n_priced,
           sum(r.minted)::bigint AS s_minted,
           sum(r.burned)::bigint AS s_burned,
           sum(r.issuer_held)::bigint AS s_issuer,
           sum(r.collector_held)::bigint AS s_collector,
           count(r.fmv_usd * r.collector_held) AS n_capped,
           sum(r.fmv_usd * r.collector_held) AS s_mcap,
           sum(r.fmv_usd * r.collector_held) FILTER (WHERE r.confidence IN ('HIGH','MEDIUM')) AS s_mcap_hm,
           sum(r.fmv_usd * r.minted) AS s_mcap_minted
    FROM rows_ r
    GROUP BY r.coll, r.gkey
  )
  SELECT a.coll, a.gkey, a.glabel, a.gset, a.gtier, a.gseries, a.gseries_name, a.gext,
         a.n, a.n_known, a.n_priced,
         a.s_minted, a.s_burned, a.s_issuer, a.s_collector,
         round(a.s_mcap, 2),
         CASE WHEN a.n_capped > 0 THEN round(coalesce(a.s_mcap_hm, 0), 2) END,
         round(a.s_mcap_minted, 2),
         d.mcap_usd
  FROM agg a
  LEFT JOIN market_cap_daily d
    ON p_group = 'collection' AND d.snapshot_date = v_day7 AND d.collection_slug = a.coll
   AND d.grain = 'collection' AND d.group_key = a.coll
  ORDER BY a.s_mcap DESC NULLS LAST, a.s_mcap_minted DESC NULLS LAST, a.coll, a.gkey
  LIMIT v_limit;
END;
$function$;
-- <<< END verbatim get_market_cap_board <<<

-- >>> BEGIN verbatim refresh_market_cap_current (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.refresh_market_cap_current()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_run      timestamptz := clock_timestamp();
  v_day      date := (now() AT TIME ZONE 'America/Los_Angeles')::date;
  v_staged   integer;
  v_changed  integer;
  v_deleted  integer;
  v_daily    integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp._mc_stage;
  CREATE TEMP TABLE _mc_stage ON COMMIT DROP AS
  WITH ed AS MATERIALIZED (
    SELECT r.*, c.id AS cid
    FROM public.market_cap_edition_rows(NULL, false) r
    JOIN public.collections c ON c.slug = r.coll
  ),
  sl AS MATERIALIZED (
    SELECT ed.*,
           regexp_replace(lower(ed.player_name), '[^a-z0-9]+', '-', 'g') AS p_plain,
           regexp_replace(lower(extensions.unaccent(ed.player_name)), '[^a-z0-9]+', '-', 'g') AS p_ascii,
           regexp_replace(lower(ed.team_name), '[^a-z0-9]+', '-', 'g') AS t_plain,
           regexp_replace(lower(extensions.unaccent(ed.team_name)), '[^a-z0-9]+', '-', 'g') AS t_ascii,
           (ed.player_name <> '' AND NOT coalesce(ed.is_team_moment, false)) AS is_player,
           pc.characters AS pin_chars,
           pc.franchises AS pin_fr
    FROM ed
    LEFT JOIN public.pinnacle_catalog pc ON ed.coll = 'disney_pinnacle' AND pc.render_id = ed.ext_id
  ),
  tk AS MATERIALIZED (
    SELECT d.coll, d.t_plain,
           (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(public.team_franchise_slugs(d.cid, d.t_plain)) x) AS fkey
    FROM (SELECT DISTINCT s.coll, s.cid, s.t_plain FROM sl s WHERE s.t_plain <> '') d
  ),
  units AS (
    SELECT s.coll, 'collection'::text AS grain, s.coll AS gkey, s.coll AS lbl, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence FROM sl s
    UNION ALL
    SELECT s.coll, 'edition', s.ext_id, coalesce(nullif(s.player_name, ''), nullif(s.team_name, ''), s.set_name), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence FROM sl s
    UNION ALL
    SELECT s.coll, 'player', s.p_ascii, s.player_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence FROM sl s WHERE s.is_player
    UNION ALL
    SELECT s.coll, 'team', coalesce(t.fkey, s.t_plain), s.team_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence FROM sl s
      LEFT JOIN tk t ON t.coll = s.coll AND t.t_plain = s.t_plain
     WHERE s.t_plain <> ''
    UNION ALL
    SELECT s.coll, 'set', s.set_slug, s.set_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence FROM sl s WHERE s.set_slug <> ''
    UNION ALL
    SELECT s.coll, 'series', coalesce(s.series_num::text, nullif(s.series_name, '')),
           coalesce(nullif(s.series_name, ''), s.series_num::text), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence
      FROM sl s WHERE coalesce(s.series_num::text, nullif(s.series_name, '')) IS NOT NULL
    UNION ALL
    SELECT s.coll, 'player', regexp_replace(lower(btrim(ch)), '[^a-z0-9]+', '-', 'g'), btrim(ch), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence
      FROM sl s CROSS JOIN LATERAL unnest(s.pin_chars) ch
     WHERE s.coll = 'disney_pinnacle' AND btrim(coalesce(ch, '')) <> ''
    UNION ALL
    SELECT s.coll, 'team', regexp_replace(lower(btrim(regexp_replace(fr, '[™®©]', '', 'g'))), '[^a-z0-9]+', '-', 'g'),
           btrim(regexp_replace(fr, '[™®©]', '', 'g')), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence
      FROM sl s CROSS JOIN LATERAL unnest(s.pin_fr) fr
     WHERE s.coll = 'disney_pinnacle' AND btrim(coalesce(regexp_replace(fr, '[™®©]', '', 'g'), '')) <> ''
  ),
  agg AS (
    SELECT u.coll, u.grain, u.gkey,
           min(u.lbl) AS lbl,
           count(*)::integer AS n,
           count(u.collector_held)::integer AS n_known,
           count(u.fmv_usd)::integer AS n_priced,
           sum(u.minted)::bigint AS s_minted,
           sum(u.burned)::bigint AS s_burned,
           sum(u.issuer_held)::bigint AS s_issuer,
           sum(u.collector_held)::bigint AS s_collector,
           count(u.fmv_usd * u.collector_held) AS n_capped,
           round(sum(u.fmv_usd * u.collector_held), 2) AS s_mcap,
           sum(u.fmv_usd * u.collector_held) FILTER (WHERE u.confidence IN ('HIGH','MEDIUM')) AS s_mcap_hm,
           round(sum(u.fmv_usd * u.minted), 2) AS s_mcap_minted
    FROM units u
    WHERE u.gkey IS NOT NULL AND u.gkey <> ''
    GROUP BY u.coll, u.grain, u.gkey
  ),
  ranked AS (
    SELECT a.*,
           CASE WHEN a.s_mcap IS NOT NULL THEN
             (rank() OVER (PARTITION BY a.coll, a.grain, a.s_mcap IS NOT NULL ORDER BY a.s_mcap DESC))::integer END AS rnk,
           (count(a.s_mcap) OVER (PARTITION BY a.coll, a.grain))::integer AS n_ranked
    FROM agg a
  ),
  keys AS (
    SELECT r.coll, r.grain, r.gkey, r.gkey AS match_key, true AS is_primary FROM ranked r
    UNION
    SELECT s.coll, 'player', s.p_ascii, s.p_plain, false FROM sl s
     WHERE s.is_player AND s.p_plain <> s.p_ascii AND s.p_plain <> ''
    UNION
    SELECT s.coll, 'team', coalesce(t.fkey, s.t_plain), x.slug, false
      FROM sl s LEFT JOIN tk t ON t.coll = s.coll AND t.t_plain = s.t_plain
      CROSS JOIN LATERAL (VALUES (s.t_plain), (s.t_ascii)) x(slug)
     WHERE s.t_plain <> '' AND x.slug <> coalesce(t.fkey, s.t_plain)
  ),
  keyed AS (
    SELECT DISTINCT ON (k.coll, k.grain, k.match_key)
           k.coll, k.grain, k.match_key, k.gkey, k.is_primary,
           r.lbl, r.n, r.n_known, r.n_priced, r.s_minted, r.s_burned, r.s_issuer, r.s_collector,
           r.n_capped, r.s_mcap, r.s_mcap_hm, r.s_mcap_minted, r.rnk, r.n_ranked
    FROM keys k
    JOIN ranked r ON r.coll = k.coll AND r.grain = k.grain AND r.gkey = k.gkey
    ORDER BY k.coll, k.grain, k.match_key, k.is_primary DESC, r.s_mcap DESC NULLS LAST, k.gkey
  )
  SELECT kd.coll AS collection_slug, kd.grain, kd.match_key, kd.gkey AS group_key, kd.is_primary,
         kd.lbl AS group_label, kd.n AS editions, kd.n_known AS editions_supply_known, kd.n_priced AS editions_priced,
         kd.s_minted AS minted, kd.s_burned AS burned, kd.s_issuer AS issuer_held, kd.s_collector AS collector_held,
         kd.s_mcap AS mcap_usd,
         CASE WHEN kd.n_capped > 0 THEN round(coalesce(kd.s_mcap_hm, 0), 2) END AS mcap_high_conf_usd,
         kd.s_mcap_minted AS mcap_minted_usd,
         kd.rnk AS mcap_rank, kd.n_ranked AS groups_ranked
  FROM keyed kd;

  SELECT count(*)::integer INTO v_staged FROM _mc_stage;
  IF v_staged = 0 THEN
    RAISE EXCEPTION 'refresh_market_cap_current: staged 0 rows — refusing to replace market_cap_current';
  END IF;

  WITH up AS (
    INSERT INTO public.market_cap_current AS m
      (collection_slug, grain, match_key, group_key, is_primary, group_label, editions, editions_supply_known,
       editions_priced, minted, burned, issuer_held, collector_held, mcap_usd, mcap_high_conf_usd,
       mcap_minted_usd, mcap_rank, groups_ranked, computed_at)
    SELECT st.collection_slug, st.grain, st.match_key, st.group_key, st.is_primary, st.group_label, st.editions,
           st.editions_supply_known, st.editions_priced, st.minted, st.burned, st.issuer_held, st.collector_held,
           st.mcap_usd, st.mcap_high_conf_usd, st.mcap_minted_usd, st.mcap_rank, st.groups_ranked, v_run
    FROM _mc_stage st
    ON CONFLICT (collection_slug, grain, match_key) DO UPDATE
      SET group_key = EXCLUDED.group_key, is_primary = EXCLUDED.is_primary, group_label = EXCLUDED.group_label,
          editions = EXCLUDED.editions, editions_supply_known = EXCLUDED.editions_supply_known,
          editions_priced = EXCLUDED.editions_priced, minted = EXCLUDED.minted, burned = EXCLUDED.burned,
          issuer_held = EXCLUDED.issuer_held, collector_held = EXCLUDED.collector_held,
          mcap_usd = EXCLUDED.mcap_usd, mcap_high_conf_usd = EXCLUDED.mcap_high_conf_usd,
          mcap_minted_usd = EXCLUDED.mcap_minted_usd, mcap_rank = EXCLUDED.mcap_rank,
          groups_ranked = EXCLUDED.groups_ranked, computed_at = EXCLUDED.computed_at
      WHERE (m.group_key, m.is_primary, m.group_label, m.editions, m.editions_supply_known, m.editions_priced,
             m.minted, m.burned, m.issuer_held, m.collector_held, m.mcap_usd, m.mcap_high_conf_usd,
             m.mcap_minted_usd, m.mcap_rank, m.groups_ranked)
        IS DISTINCT FROM
            (EXCLUDED.group_key, EXCLUDED.is_primary, EXCLUDED.group_label, EXCLUDED.editions,
             EXCLUDED.editions_supply_known, EXCLUDED.editions_priced, EXCLUDED.minted, EXCLUDED.burned,
             EXCLUDED.issuer_held, EXCLUDED.collector_held, EXCLUDED.mcap_usd, EXCLUDED.mcap_high_conf_usd,
             EXCLUDED.mcap_minted_usd, EXCLUDED.mcap_rank, EXCLUDED.groups_ranked)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_changed FROM up;

  WITH del AS (
    DELETE FROM public.market_cap_current m
    WHERE NOT EXISTS (SELECT 1 FROM _mc_stage st
                      WHERE st.collection_slug = m.collection_slug AND st.grain = m.grain AND st.match_key = m.match_key)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_deleted FROM del;

  WITH d AS (
    INSERT INTO public.market_cap_daily AS h
      (snapshot_date, collection_slug, grain, group_key, group_label, editions, editions_supply_known,
       collector_held, mcap_usd, mcap_high_conf_usd, computed_at)
    SELECT v_day, st.collection_slug, st.grain, st.group_key, st.group_label, st.editions, st.editions_supply_known,
           st.collector_held, st.mcap_usd, st.mcap_high_conf_usd, v_run
    FROM _mc_stage st
    WHERE st.is_primary AND st.grain IN ('collection','player','team','set','series')
    ON CONFLICT (snapshot_date, collection_slug, grain, group_key) DO UPDATE
      SET group_label = EXCLUDED.group_label, editions = EXCLUDED.editions,
          editions_supply_known = EXCLUDED.editions_supply_known, collector_held = EXCLUDED.collector_held,
          mcap_usd = EXCLUDED.mcap_usd, mcap_high_conf_usd = EXCLUDED.mcap_high_conf_usd,
          computed_at = EXCLUDED.computed_at
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_daily FROM d;

  DELETE FROM public.market_cap_daily WHERE snapshot_date < v_day - 400;

  INSERT INTO public.market_cap_refresh_state (id, refreshed_at) VALUES (true, v_run)
  ON CONFLICT (id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

  PERFORM public.log_pipeline_run(
    'market-cap-refresh', v_run, v_staged, v_changed, v_deleted, true, NULL, NULL, NULL, NULL,
    jsonb_build_object('staged', v_staged, 'changed', v_changed, 'deleted', v_deleted,
                       'daily_rows', v_daily, 'snapshot_date_pt', v_day));
  RETURN jsonb_build_object('staged', v_staged, 'changed', v_changed, 'deleted', v_deleted, 'daily_rows', v_daily);
END;
$function$;
-- <<< END verbatim refresh_market_cap_current <<<

-- >>> BEGIN verbatim get_market_cap_entity (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_market_cap_entity(p_group text, p_collection text, p_match text)
 RETURNS TABLE(collection_slug text, group_label text, editions integer, editions_supply_known integer, editions_priced integer, minted bigint, burned bigint, issuer_held bigint, collector_held bigint, mcap_usd numeric, mcap_high_conf_usd numeric, mcap_minted_usd numeric, mcap_rank integer, groups_ranked integer, mcap_usd_7d_ago numeric, refreshed_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cid   uuid;
  v_keys  text[];
  v_day7  date := (now() AT TIME ZONE 'America/Los_Angeles')::date - 7;
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('collection','edition','player','team','set','series') THEN
    RAISE EXCEPTION 'get_market_cap_entity: unknown group %', p_group USING ERRCODE = '22023';
  END IF;
  IF p_collection IS NULL OR p_match IS NULL OR btrim(p_match) = '' THEN
    RETURN;
  END IF;
  SELECT c.id INTO v_cid FROM collections c WHERE c.slug = p_collection;
  IF v_cid IS NULL THEN
    RETURN;
  END IF;
  v_keys := CASE WHEN p_group = 'team'
                 THEN array_prepend(p_match, public.team_franchise_slugs(v_cid, p_match))
                 ELSE ARRAY[p_match] END;

  RETURN QUERY
  SELECT m.collection_slug, m.group_label, m.editions, m.editions_supply_known, m.editions_priced,
         m.minted, m.burned, m.issuer_held, m.collector_held,
         m.mcap_usd, m.mcap_high_conf_usd, m.mcap_minted_usd, m.mcap_rank, m.groups_ranked,
         d.mcap_usd, st.refreshed_at
  FROM market_cap_current m
  LEFT JOIN market_cap_daily d
    ON d.snapshot_date = v_day7 AND d.collection_slug = m.collection_slug
   AND d.grain = m.grain AND d.group_key = m.group_key
  LEFT JOIN market_cap_refresh_state st ON st.id
  WHERE m.collection_slug = p_collection AND m.grain = p_group AND m.match_key = ANY (v_keys)
  ORDER BY (m.match_key = p_match) DESC, m.is_primary DESC
  LIMIT 1;
END;
$function$;
-- <<< END verbatim get_market_cap_entity <<<


-- ── Collection grain ───────────────────────────────────────────────────────
-- Top Shot: E1 2x60=120, E2 1x50=50, E4 1x10=10 → 180. E3 (no split) and E5
-- (parts exceed whole) are UNKNOWN and add nothing.
SELECT _assert_eq((SELECT mcap_usd::text FROM get_market_cap_board('collection', 'nba_top_shot')), '180.00',
  'Top Shot cap = FMV x collector-held over the editions whose split is known');
SELECT _assert_eq((SELECT editions || '/' || editions_supply_known || '/' || editions_priced FROM get_market_cap_board('collection', 'nba_top_shot')), '5/3/4',
  'Top Shot rollup states 5 editions, 3 with a supply split, 4 priced');
SELECT _assert_eq((SELECT mcap_high_conf_usd::text FROM get_market_cap_board('collection', 'nba_top_shot')), '120.00',
  'only HIGH/MEDIUM-priced editions count toward the high-confidence cap');
SELECT _assert_eq((SELECT burned || '/' || issuer_held || '/' || collector_held FROM get_market_cap_board('collection', 'nba_top_shot')), '30/10/120',
  'burned and issuer-held sum only over the known splits; E5 is not clamped into them');
SELECT _assert_eq((SELECT minted::text FROM get_market_cap_board('collection', 'nba_top_shot')), '220',
  'minted counts EVERY edition, known split or not');
SELECT _assert_eq((SELECT mcap_minted_usd::text FROM get_market_cap_board('collection', 'nba_top_shot')), '660.00',
  'the minted-basis upper bound covers every priced edition');

-- Golazos from Atlas edition supply: g1 3 x (1000-200-300)=1500; g2's split is 5 days
-- old → unknown, even though its numbers look fine. The seeded badge row is ignored.
SELECT _assert_eq((SELECT mcap_usd || '/' || editions_supply_known || '/' || burned || '/' || issuer_held FROM get_market_cap_board('collection', 'laliga_golazos')),
  '1500.00/1/200/300', 'Golazos cap from the FRESH Atlas split only; a 5-day-old split is unknown');
-- Pinnacle from Atlas 'disney' keyed pinnacle_catalog.edition_id: 1 x (500-50-100)=350.
SELECT _assert_eq((SELECT mcap_usd || '/' || collector_held || '/' || minted FROM get_market_cap_board('collection', 'disney_pinnacle')),
  '350.00/350/500', 'Pinnacle cap from Atlas edition supply joined on edition_id');
-- Candy: issuer = treasury-sealed 10, collector = circulating 85, burned = 100-10-85 = 5.
SELECT _assert_eq((SELECT mcap_usd || '/' || burned || '/' || issuer_held || '/' || collector_held FROM get_market_cap_board('collection', 'candy_mlb')),
  '170.00/5/10/85', 'Candy cap = FMV x circulating; sealed is issuer-held; the rest is burned');
-- Panini: collector-held is pulled_count (with collectors); burned and unopened excluded.
SELECT _assert_eq((SELECT mcap_usd || '/' || collector_held || '/' || issuer_held || '/' || burned FROM get_market_cap_board('collection', 'panini_blockchain')),
  '200.00/40/20/40', 'Panini cap = FMV x with-collectors; unopened and burned excluded');
-- UFC: no source → cap is NULL, never 0.
SELECT _assert((SELECT mcap_usd IS NULL AND mcap_high_conf_usd IS NULL AND collector_held IS NULL AND burned IS NULL AND mcap_minted_usd = 3000
                FROM get_market_cap_board('collection', 'ufc_strike')),
  'a collection with no burn source reports an UNKNOWN cap, not $0, plus its minted upper bound');
-- Ranking: every known cap ahead of every unknown one.
SELECT _assert_eq((SELECT string_agg(collection_slug, ',') FROM get_market_cap_board('collection')),
  'laliga_golazos,disney_pinnacle,panini_blockchain,nba_top_shot,candy_mlb,ufc_strike',
  'every known cap ranks ahead of every unknown one');
SELECT _assert((SELECT bool_and(mcap_usd_7d_ago IS NULL) FROM get_market_cap_board('collection')),
  'no daily history yet → the 7-day figure is NULL, never 0');

-- ── Refusals ───────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('collection', 'candy_mlbx')), '0',
  'an unknown collection returns ZERO rows, not another collection''s numbers');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('player', 'not_a_collection')), '0',
  'a misspelled collection returns zero rows at every grain');
DO $$
BEGIN
  PERFORM * FROM get_market_cap_board('wallet', NULL);
  RAISE EXCEPTION 'ASSERT FAILED: an unknown group did not raise';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('collection', NULL, 0)), '1', 'p_limit 0 clamps to 1');

-- ── Other board grains ─────────────────────────────────────────────────────
SELECT _assert_eq((SELECT mcap_usd::text FROM get_market_cap_board('edition', 'nba_top_shot') WHERE edition_external_id = '1:1'), '120.00',
  'edition grain excludes that edition''s burned and issuer-held Moments (not 2 x 100)');
SELECT _assert((SELECT mcap_usd IS NULL AND mcap_minted_usd = 400 FROM get_market_cap_board('edition', 'nba_top_shot') WHERE edition_external_id = '1:3'),
  'an edition with no Atlas row has an unknown cap');
SELECT _assert_eq((SELECT string_agg(group_label, ',' ORDER BY group_label) FROM get_market_cap_board('player', 'nba_top_shot')), 'Alice,Bob,Carl',
  'a team highlight (player_name = team_name) is not a player');
SELECT _assert_eq((SELECT mcap_usd || '/' || editions FROM get_market_cap_board('player', 'nba_top_shot') WHERE group_label = 'Alice'), '120.00/2',
  'a player rolls up all their editions, the unknown one counted but not capped');
SELECT _assert_eq((SELECT string_agg(group_label || '=' || mcap_usd, ',' ORDER BY group_label) FROM get_market_cap_board('team', 'nba_top_shot')),
  'Kings=170.00,Sacramento Kings=10.00', 'team grain');
SELECT _assert_eq((SELECT string_agg(group_label || '=' || mcap_usd, ',' ORDER BY group_label) FROM get_market_cap_board('badge', 'nba_top_shot')),
  'Rookie Mint=120.00,Rookie Year=120.00', 'badge grain reads allowlisted play tags + the rookie-mint flag only');
SELECT _assert_eq((SELECT string_agg(group_label, ',') FROM get_market_cap_board('badge', 'candy_mlb')), 'First Mint',
  'badge grain also reads badges the ingest wrote onto the edition row');
SELECT _assert_eq((SELECT string_agg(group_key, ',' ORDER BY group_key) FROM get_market_cap_board('series', 'nba_top_shot')), '0,2',
  'series grain keys on the raw series number (labelled client-side)');
SELECT _assert_eq((SELECT string_agg(group_label || '=' || coalesce(mcap_usd::text, 'unknown'), ',' ORDER BY group_label) FROM get_market_cap_board('tier', 'nba_top_shot')),
  'COMMON=180.00,RARE=unknown', 'tier grain; a tier whose only edition is unsplit stays unknown');

-- ── refresh_market_cap_current + the entity tile ──────────────────────────
-- A daily row 7 PT-days back for Alice, so the tile's 7-day figure has history.
INSERT INTO public.market_cap_daily VALUES
  ((now() AT TIME ZONE 'America/Los_Angeles')::date - 7, 'nba_top_shot', 'player', 'alice', 'Alice', 2, 1, 60, 100.00, 100.00, now());

SELECT _assert((SELECT (refresh_market_cap_current() ->> 'staged')::int > 0), 'the refresh stages rows');
SELECT _assert_eq((SELECT pipeline || '/' || ok FROM public.pipeline_log ORDER BY 1 LIMIT 1), 'market-cap-refresh/true', 'the refresh logs its run');

SELECT _assert_eq((SELECT mcap_usd || '/' || editions || '/' || mcap_rank || '/' || groups_ranked FROM get_market_cap_entity('edition', 'nba_top_shot', '1:1')),
  '120.00/1/1/3', 'edition 1:1: cap 120, ranked 1st of the 3 Top Shot editions with a known cap');
SELECT _assert_eq((SELECT mcap_usd || '/' || editions || '/' || mcap_rank || '/' || groups_ranked || '/' || mcap_usd_7d_ago FROM get_market_cap_entity('player', 'nba_top_shot', 'alice')),
  '120.00/2/1/2/100.00', 'player alice: both editions counted, 1st of 2 ranked players, 7-day figure from the daily table');
SELECT _assert_eq((SELECT mcap_rank::text FROM get_market_cap_entity('player', 'nba_top_shot', 'bob')), '2', 'player bob ranks 2nd');
SELECT _assert((SELECT mcap_usd IS NULL AND mcap_rank IS NULL AND groups_ranked = 2 AND mcap_minted_usd = 400 AND mcap_usd_7d_ago IS NULL
                FROM get_market_cap_entity('player', 'nba_top_shot', 'carl')),
  'a player whose only edition is unsplit has an UNKNOWN cap and no rank — not $0, not last');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_entity('player', 'nba_top_shot', 'sacramento-kings')), '0',
  'a team highlight is not a player');
SELECT _assert_eq((SELECT group_label || '/' || editions FROM get_market_cap_entity('player', 'laliga_golazos', 'jose-nunez')), 'José Núñez/1',
  'player slugs match accent-folded, like get_player_detail');
SELECT _assert_eq((SELECT group_label FROM get_market_cap_entity('player', 'laliga_golazos', 'jos-n-ez')), 'José Núñez',
  'the PLAIN slug spelling of an accented name resolves through its alias row');
SELECT _assert_eq((SELECT count(*)::text FROM market_cap_current WHERE grain = 'player' AND collection_slug = 'laliga_golazos' AND is_primary), '2',
  'an alias row is not a second player');
SELECT _assert_eq((SELECT mcap_usd || '/' || editions || '/' || mcap_rank || '/' || groups_ranked FROM get_market_cap_entity('team', 'nba_top_shot', 'kings')),
  '180.00/5/1/1', 'team = the whole FRANCHISE (Kings + Sacramento Kings), not one label');
SELECT _assert_eq((SELECT mcap_usd::text FROM get_market_cap_entity('team', 'nba_top_shot', 'sacramento-kings')), '180.00',
  'any label of the franchise reaches the same franchise row');
SELECT _assert_eq((SELECT mcap_usd || '/' || editions || '/' || mcap_rank FROM get_market_cap_entity('set', 'nba_top_shot', 'base-set')),
  '170.00/4/1', 'set = every series of the set name (sets_summary slug)');
SELECT _assert_eq((SELECT mcap_rank::text FROM get_market_cap_entity('set', 'nba_top_shot', 'squad-goals')), '2', 'second set ranks 2nd');
SELECT _assert_eq((SELECT mcap_usd::text FROM get_market_cap_entity('collection', 'laliga_golazos', 'laliga_golazos')), '1500.00', 'collection grain');
SELECT _assert((SELECT refreshed_at IS NOT NULL FROM get_market_cap_entity('edition', 'nba_top_shot', '1:1')), 'the tile carries the refresh stamp');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_entity('edition', 'nba_top_shot', '9:9')), '0', 'no matching edition → zero rows, not a $0 row');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_entity('player', 'not_a_collection', 'alice')), '0', 'unknown collection → zero rows');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_entity('player', 'nba_top_shot', '')), '0', 'empty match → zero rows');
DO $$
BEGIN
  PERFORM * FROM get_market_cap_entity('badge', 'nba_top_shot', 'x');
  RAISE EXCEPTION 'ASSERT FAILED: an unsupported entity grain did not raise';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;

-- Series: keyed like each series page — the on-chain number, or Pinnacle's label.
SELECT _assert_eq((SELECT mcap_usd || '/' || editions || '/' || mcap_rank || '/' || groups_ranked FROM get_market_cap_entity('series', 'nba_top_shot', '2')),
  '180.00/4/1/1', 'series 2: four editions, the unsplit one counted but not capped; the only ranked series');
SELECT _assert((SELECT mcap_usd IS NULL AND mcap_rank IS NULL FROM get_market_cap_entity('series', 'nba_top_shot', '0')),
  'a series whose only edition is unsplit has an unknown cap');
SELECT _assert_eq((SELECT mcap_usd::text FROM get_market_cap_entity('series', 'disney_pinnacle', 'Series 1')), '350.00',
  'Pinnacle series are keyed by their label');
-- Pinnacle characters + franchises: a duo pin counts for BOTH characters; ™ is stripped.
SELECT _assert_eq((SELECT group_label || '=' || mcap_usd FROM get_market_cap_entity('player', 'disney_pinnacle', 'minnie-mouse')), 'Minnie Mouse=350.00',
  'a Pinnacle character page reads its trait row');
SELECT _assert_eq((SELECT group_label || '=' || mcap_usd FROM get_market_cap_entity('player', 'disney_pinnacle', 'daisy-duck')), 'Daisy Duck=350.00',
  'a duo pin counts for both characters');
SELECT _assert_eq((SELECT group_label || '=' || mcap_usd FROM get_market_cap_entity('team', 'disney_pinnacle', 'star-wars')), 'Star Wars=350.00',
  'a franchise is keyed with the trademark sign removed, like pinnacleFranchiseHref');

-- The daily history is written for collection/player/team/set — never for editions.
SELECT _assert_eq((SELECT string_agg(DISTINCT grain, ',' ORDER BY grain) FROM market_cap_daily WHERE snapshot_date = (now() AT TIME ZONE 'America/Los_Angeles')::date),
  'collection,player,series,set,team', 'the daily history carries collection/player/team/set/series primaries');

-- A second, identical run changes nothing and deletes nothing.
SELECT _assert_eq((SELECT (r->>'changed') || '/' || (r->>'deleted') FROM (SELECT refresh_market_cap_current() r) x), '0/0',
  'an identical second run rewrites no row');

-- A key that disappears is retired — but only after the new set was written.
DELETE FROM public.editions WHERE external_id = '1:3';
-- (two statements: a statement does not see rows its own function call deleted)
SELECT _assert((SELECT (r->>'deleted')::int > 0 FROM (SELECT refresh_market_cap_current() r) x), 'the refresh reports retired rows');
SELECT _assert(NOT EXISTS (SELECT 1 FROM market_cap_current WHERE grain = 'edition' AND match_key = '1:3'),
  'a vanished edition''s row is retired');

-- An EMPTY stage (every source read failed) must refuse, leaving the table intact.
DELETE FROM public.editions; DELETE FROM public.pinnacle_catalog;
DO $$
BEGIN
  PERFORM refresh_market_cap_current();
  RAISE EXCEPTION 'ASSERT FAILED: an empty stage did not refuse';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT LIKE 'refresh_market_cap_current: staged 0 rows%' THEN RAISE; END IF;
END $$;
SELECT _assert((SELECT count(*) > 0 FROM market_cap_current), 'a refused refresh leaves market_cap_current intact');

SELECT '✓ market cap (rows, board, refresh, entity): all assertions passed' AS result;

ROLLBACK;
