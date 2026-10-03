-- DB invariant: public.get_market_cap_board — market cap = FMV x COLLECTOR-HELD
-- supply, at every grain (collection / edition / player / team / set / series /
-- tier / badge). Pins:
--   · burned Moments and issuer-held Moments (sealed packs, reserve) are EXCLUDED
--     from the cap — the reason the function exists;
--   · an edition with NO supply split is collector_held NULL and contributes NOTHING
--     to mcap_usd (an unknown burn is not a zero burn), while still counting in
--     `editions` and `mcap_minted_usd`, so a partial sum is visible as partial;
--   · a collection with no supply source at all reports mcap_usd NULL, never $0;
--   · an Atlas row whose parts exceed its whole is treated as unknown, not clamped;
--   · an unknown p_collection returns ZERO rows (never another collection's data);
--   · an unknown p_group raises 22023; p_limit is clamped to 1..500;
--   · team highlights (player_name = team_name) are not players;
--   · ranking puts every known cap ahead of every unknown one.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20261003201018_audit_20261003_market_cap_board_on_collector_held_supply.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from it.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

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
CREATE TABLE public.edition_fmv_current (edition_id uuid, fmv_usd numeric, confidence text);
CREATE TABLE public.pinnacle_catalog (
  render_id text, set_name text, edition_type text, series_name text,
  total_minted integer, fmv_usd numeric, fmv_confidence text
);

INSERT INTO public.collections VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'nba_top_shot'),
  ('00000000-0000-0000-0000-0000000000a2', 'laliga_golazos'),
  ('00000000-0000-0000-0000-0000000000a3', 'panini_blockchain');

-- Top Shot: E1 split known (100 minted, 30 burned, 10 issuer-held -> 60 collector-held),
-- E2 fully collector-held, E3 has NO Atlas row, E4 is a team highlight,
-- E5's Atlas parts exceed its whole (20 - 15 - 10 < 0) and is unpriced.
INSERT INTO public.editions VALUES
  ('00000000-0000-0000-0000-000000000e01', '1:1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'Alice', 'Kings', 'Base Set', 'COMMON', 2, 100, NULL),
  ('00000000-0000-0000-0000-000000000e02', '1:2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b02', 'Bob',   'Kings', 'Base Set', 'COMMON', 2, 50,  NULL),
  ('00000000-0000-0000-0000-000000000e03', '1:3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b03', 'Carl',  'Kings', 'Base Set', 'RARE',   2, 40,  NULL),
  ('00000000-0000-0000-0000-000000000e04', '1:4', '00000000-0000-0000-0000-0000000000a1', NULL, 'Sacramento Kings', 'Sacramento Kings', 'Squad Goals', 'COMMON', 2, 10, NULL),
  ('00000000-0000-0000-0000-000000000e05', '1:5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000b01', 'Alice', 'Kings', 'Base Set', 'COMMON', 0, 20,  NULL),
  ('00000000-0000-0000-0000-000000000e06', 'g1',  '00000000-0000-0000-0000-0000000000a2', NULL, 'Dani', 'Club', 'Eternal', 'COMMON', 1, 1000, NULL),
  ('00000000-0000-0000-0000-000000000e07', 'p1',  '00000000-0000-0000-0000-0000000000a3', NULL, 'Eve', NULL, 'Prizm', 'RARE', NULL, 100, NULL);

INSERT INTO public.badge_editions VALUES
  ('00000000-0000-0000-0000-0000000000a1', '1:1', 100, 30, 10, '[{"id":"ROOKIE_YEAR","title":"Rookie Year"},{"id":"X","title":"Not A Badge"}]', '[]', true, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:2', 50, 0, 0, '[]', '[]', false, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:4', 10, 0, 0, '[]', '[]', false, false),
  ('00000000-0000-0000-0000-0000000000a1', '1:5', 20, 15, 10, '[]', '[]', false, false),
  -- a Golazos-shaped Atlas row is ignored: only Top Shot / All Day read badge_editions
  ('00000000-0000-0000-0000-0000000000a2', 'g1', 1000, 999, 0, '[]', '[]', false, false);

INSERT INTO public.panini_editions VALUES
  ('00000000-0000-0000-0000-0000000000a3', 'p1', 100, 40, 20, 40);

INSERT INTO public.edition_fmv_current VALUES
  ('00000000-0000-0000-0000-000000000e01', 2.00, 'HIGH'),
  ('00000000-0000-0000-0000-000000000e02', 1.00, 'ASK_ONLY'),
  ('00000000-0000-0000-0000-000000000e03', 10.00, 'HIGH'),
  ('00000000-0000-0000-0000-000000000e04', 1.00, 'LOW'),
  ('00000000-0000-0000-0000-000000000e06', 3.00, 'MEDIUM'),
  ('00000000-0000-0000-0000-000000000e07', 5.00, 'MEDIUM');

INSERT INTO public.pinnacle_catalog VALUES ('r1', 'Pin Set', 'Limited Edition', 'Series 1', 500, 1.00, 'LOW');

-- >>> BEGIN verbatim get_market_cap_board (keep byte-identical to the migration) >>>
CREATE OR REPLACE FUNCTION public.get_market_cap_board(p_group text DEFAULT 'collection', p_collection text DEFAULT NULL, p_limit integer DEFAULT 100)
 RETURNS TABLE(collection_slug text, group_key text, group_label text, set_name text, tier text, series_num integer, series_name text, edition_external_id text, editions integer, editions_supply_known integer, editions_priced integer, minted bigint, burned bigint, issuer_held bigint, collector_held bigint, mcap_usd numeric, mcap_high_conf_usd numeric, mcap_minted_usd numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('collection','edition','player','team','set','series','tier','badge') THEN
    RAISE EXCEPTION 'get_market_cap_board: unknown group %', p_group USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH ed AS (
    SELECT c.slug::text AS coll,
           e.external_id::text AS ext_id,
           coalesce(e.player_id::text, lower(btrim(e.player_name))) AS player_key,
           btrim(e.player_name) AS player_name,
           btrim(e.team_name) AS team_name,
           btrim(e.set_name) AS set_name,
           e.tier::text AS tier,
           e.series::integer AS series_num,
           NULL::text AS series_name,
           -- Top Shot's team highlight stores player_name = team_name; All Day's Team
           -- Melt stores the city as player_name (lib/entity-href.ts isTeamMoment).
           (btrim(e.player_name) = btrim(e.team_name) OR btrim(e.team_name) LIKE btrim(e.player_name) || ' %') AS is_team_moment,
           CASE WHEN p_group = 'badge' THEN ARRAY(
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
           f.confidence::text AS confidence
    FROM editions e
    JOIN collections c ON c.id = e.collection_id
    LEFT JOIN badge_editions b
      ON b.collection_id = e.collection_id AND b.external_id = e.external_id
     AND c.slug IN ('nba_top_shot','nfl_all_day')
    LEFT JOIN panini_editions p
      ON p.collection_id = e.collection_id AND p.external_id = e.external_id
     AND c.slug = 'panini_blockchain'
    LEFT JOIN edition_fmv_current f ON f.edition_id = e.id
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN b.circulation_count > 0 AND b.burned IS NOT NULL AND b.hidden_in_packs IS NOT NULL
               AND b.circulation_count - b.burned - b.hidden_in_packs >= 0
               THEN b.circulation_count
             WHEN p.mint_cap IS NOT NULL THEN p.mint_cap
             ELSE e.circulation_count END::bigint AS minted,
        CASE WHEN b.circulation_count > 0 AND b.burned IS NOT NULL AND b.hidden_in_packs IS NOT NULL
               AND b.circulation_count - b.burned - b.hidden_in_packs >= 0
               THEN b.burned
             WHEN p.mint_cap IS NOT NULL THEN p.burned_count END::bigint AS burned,
        CASE WHEN b.circulation_count > 0 AND b.burned IS NOT NULL AND b.hidden_in_packs IS NOT NULL
               AND b.circulation_count - b.burned - b.hidden_in_packs >= 0
               THEN b.hidden_in_packs
             WHEN p.mint_cap IS NOT NULL THEN p.still_in_packs END::bigint AS issuer_held,
        CASE WHEN b.circulation_count > 0 AND b.burned IS NOT NULL AND b.hidden_in_packs IS NOT NULL
               AND b.circulation_count - b.burned - b.hidden_in_packs >= 0
               THEN b.circulation_count - b.burned - b.hidden_in_packs
             WHEN p.mint_cap IS NOT NULL THEN p.pulled_count END::bigint AS collector_held
    ) s
    WHERE p_collection IS NULL OR c.slug = p_collection

    UNION ALL

    -- Disney Pinnacle is render-keyed in pinnacle_catalog (no editions rows). No
    -- burn / issuer-held source, so collector_held stays NULL. A pin has no
    -- player/team here: a character is the `characters` TRAIT, not character_name.
    SELECT 'disney_pinnacle', pc.render_id::text, NULL, NULL, NULL,
           btrim(pc.set_name), pc.edition_type, NULL::integer, btrim(pc.series_name), false,
           NULL::text[],
           pc.total_minted::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
           pc.fmv_usd, pc.fmv_confidence::text
    FROM pinnacle_catalog pc
    WHERE p_collection IS NULL OR p_collection = 'disney_pinnacle'
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
         round(a.s_mcap_minted, 2)
  FROM agg a
  ORDER BY a.s_mcap DESC NULLS LAST, a.s_mcap_minted DESC NULLS LAST, a.coll, a.gkey
  LIMIT v_limit;
END;
$function$;
-- <<< END verbatim get_market_cap_board <<<

-- ── Collection grain ───────────────────────────────────────────────────────
-- Top Shot: E1 2x60=120, E2 1x50=50, E4 1x10=10 → 180. E3 (no split) and E5
-- (parts exceed whole) are UNKNOWN and add nothing — not 2x100, not 1x20.
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

-- Golazos: no supply source → cap is NULL, never 0, and its Atlas row is not read.
SELECT _assert((SELECT mcap_usd IS NULL AND mcap_high_conf_usd IS NULL AND collector_held IS NULL AND burned IS NULL
                FROM get_market_cap_board('collection', 'laliga_golazos')),
  'a collection with no burn source reports an UNKNOWN cap, not $0');
SELECT _assert_eq((SELECT mcap_minted_usd::text FROM get_market_cap_board('collection', 'laliga_golazos')), '3000.00',
  'a collection with no burn source still carries its minted-basis upper bound');

-- Panini: collector-held is pulled_count (with collectors); burned and unopened excluded.
SELECT _assert_eq((SELECT mcap_usd || '/' || collector_held || '/' || issuer_held || '/' || burned FROM get_market_cap_board('collection', 'panini_blockchain')),
  '200.00/40/20/40', 'Panini cap = FMV x with-collectors; unopened and burned excluded');

-- Pinnacle: catalog arm, no supply split.
SELECT _assert((SELECT mcap_usd IS NULL AND minted = 500 AND mcap_minted_usd = 500 FROM get_market_cap_board('collection', 'disney_pinnacle')),
  'Pinnacle comes from pinnacle_catalog with an unknown cap and a minted upper bound');

-- Ranking: known caps first (Panini 200 > Top Shot 180), unknown caps after by upper bound.
SELECT _assert_eq((SELECT string_agg(collection_slug, ',') FROM get_market_cap_board('collection')),
  'panini_blockchain,nba_top_shot,laliga_golazos,disney_pinnacle',
  'every known cap ranks ahead of every unknown one');

-- ── Refusals ───────────────────────────────────────────────────────────────
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('collection', 'candy_mlb')), '0',
  'an unknown/absent collection returns ZERO rows, not another collection''s numbers');
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('player', 'not_a_collection')), '0',
  'a misspelled collection returns zero rows at every grain');
DO $$
BEGIN
  PERFORM * FROM get_market_cap_board('wallet', NULL);
  RAISE EXCEPTION 'ASSERT FAILED: an unknown group did not raise';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END $$;
SELECT _assert_eq((SELECT count(*)::text FROM get_market_cap_board('collection', NULL, 0)), '1', 'p_limit 0 clamps to 1');

-- ── Other grains ───────────────────────────────────────────────────────────
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
SELECT _assert_eq((SELECT string_agg(group_key, ',' ORDER BY group_key) FROM get_market_cap_board('series', 'nba_top_shot')), '0,2',
  'series grain keys on the raw series number (labelled client-side)');
SELECT _assert_eq((SELECT string_agg(group_label || '=' || coalesce(mcap_usd::text, 'unknown'), ',' ORDER BY group_label) FROM get_market_cap_board('tier', 'nba_top_shot')),
  'COMMON=180.00,RARE=unknown', 'tier grain; a tier whose only edition is unsplit stays unknown');

SELECT '✓ get_market_cap_board: all assertions passed' AS result;

ROLLBACK;
