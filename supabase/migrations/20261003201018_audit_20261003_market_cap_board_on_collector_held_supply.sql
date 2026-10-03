-- audit_20261003_market_cap_board_on_collector_held_supply
--
-- Market cap for every grain the site already has a page for: collection, edition,
-- player, team, set, series, tier and badge. One function, one definition, so a
-- collection total is by construction the sum of its editions.
--
--   market cap = edition FMV x COLLECTOR-HELD supply
--
-- COLLECTOR-HELD, not minted — burned Moments are gone and Moments the issuer still
-- holds (sealed packs, unsold packs, reserve never packed) are not on the market.
-- The supply split is measured, not modelled (2026-10-03):
--
--   Top Shot / All Day — Atlas (badge_editions). Atlas partitions every minted Moment
--     EXACTLY: numMinted = numBurned + numOwned + numLocked + numListed +
--     numHiddenInPacks, on 51,743 of 51,743 edition payloads. We drop numListed at
--     ingest, but collector-held = owned + locked + listed = minted - burned - hidden,
--     so it is exact without it. `hidden_in_packs` is everything the issuer still
--     holds: Top Shot mints the full run up front (on-chain count = edition size on
--     873/957 audited editions incl. parallels), so "minted, never packed" sits
--     INSIDE hidden; Atlas does not split it from sealed packs, and neither do we.
--   Panini — panini_editions: mint_cap = with_collectors (pulled_count) +
--     unopened (still_in_packs) + burned on 13,115/13,181. pulled_count IS
--     collector-held.
--   Golazos / UFC / Pinnacle / Candy — NO burn or issuer-held source (Golazos'
--     218 badge_editions rows carry circulation 0, 200 older than 7 days). Their
--     collector_held is NULL and so is mcap_usd: an unknown burn is not a zero burn.
--     mcap_minted_usd (FMV x minted) is returned for every edition as the labelled
--     upper bound.
--
-- Honesty: every rollup carries editions / editions_supply_known / editions_priced so
-- a partial sum can never read as a complete one, and mcap_high_conf_usd (the part
-- priced at HIGH/MEDIUM confidence) so a cap built on asks-only FMV reads as such.
-- An unknown p_collection returns ZERO rows — never another collection's numbers.
--
-- Cost (measured live): the full 37,845-edition union is ~8k shared buffers / 215 ms,
-- so it is computed per call; the public route edge-caches it for 15 minutes.
--
-- anon-exec: revoked (get_market_cap_board) — new fn; read only through the service-role /api/public/insights/market-cap route.
--
-- Revert: DROP FUNCTION public.get_market_cap_board(text, text, integer);

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

REVOKE ALL ON FUNCTION public.get_market_cap_board(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_cap_board(text, text, integer) TO service_role;
