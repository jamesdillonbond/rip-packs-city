-- audit_20261003_market_cap_entity_lookup_and_shared_edition_rows
--
-- Market cap tiles for the edition / player / team / set pages (Trevor, 2026-10-03:
-- "Do it all").
--
-- (1) market_cap_edition_rows(p_collection, p_badges) — the ONE per-edition supply x
--     FMV row set, lifted verbatim out of get_market_cap_board (20261003201018) so
--     the board, the entity lookup and the daily snapshot cannot drift apart.
--     Adds `set_slug` (the sets_summary spelling) for the set-page match.
--     SECURITY INVOKER: only ever called from the SECDEF readers below.
-- (2) get_market_cap_board — same signature, same output; its edition CTE now reads
--     (1). The pin's assertions are unchanged and must still pass.
-- (3) get_market_cap_entity(p_group, p_collection, p_match) — ONE entity's cap and
--     its rank. p_match is exactly what the page's own detail RPC keys on, matched by
--     that RPC's own rule, so the tile and the page always mean the same entity:
--       edition — editions.external_id
--       player  — get_player_detail's slug: lower(name) non-alnum→'-', plain OR
--                 unaccented; team highlights (player_name = team_name / city) are
--                 not players
--       team    — get_team_detail's franchise rule: team_franchise_slugs() over
--                 every label of the franchise (historic names fold in)
--       set     — sets_summary.set_slug: lower(set_name) non-alnum→'-' (all series)
--     Rank = position among the collection's groups of that grain WITH a known cap
--     (other teams are grouped by franchise the same way). An entity whose cap is
--     unknown gets mcap_rank NULL. No matching edition → ZERO rows (the tile renders
--     nothing), never a $0 row. An unknown collection → zero rows.
--
-- anon-exec: revoked (market_cap_edition_rows) — new internal fn; service_role only.
-- anon-exec: unchanged (get_market_cap_board) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
-- anon-exec: revoked (get_market_cap_entity) — new fn; read only by server components through the service-role client.
--
-- Revert: DROP FUNCTION public.get_market_cap_entity(text, text, text); re-apply
-- 20261003201018 (restores the self-contained board body); then
-- DROP FUNCTION public.market_cap_edition_rows(text, boolean);

CREATE OR REPLACE FUNCTION public.market_cap_edition_rows(p_collection text, p_badges boolean)
 RETURNS TABLE(coll text, ext_id text, player_key text, player_name text, team_name text, set_name text, set_slug text, tier text, series_num integer, series_name text, is_team_moment boolean, badges text[], minted bigint, burned bigint, issuer_held bigint, collector_held bigint, fmv_usd numeric, confidence text)
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
           -- Top Shot's team highlight stores player_name = team_name; All Day's Team
           -- Melt stores the city as player_name (lib/entity-href.ts isTeamMoment).
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
           btrim(pc.set_name), regexp_replace(lower(btrim(pc.set_name)), '[^a-z0-9]+', '-', 'g'),
           pc.edition_type, NULL::integer, btrim(pc.series_name), false,
           NULL::text[],
           pc.total_minted::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
           pc.fmv_usd, pc.fmv_confidence::text
    FROM pinnacle_catalog pc
    WHERE p_collection IS NULL OR p_collection = 'disney_pinnacle';
$function$;

REVOKE ALL ON FUNCTION public.market_cap_edition_rows(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_cap_edition_rows(text, boolean) TO service_role;

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
         round(a.s_mcap_minted, 2)
  FROM agg a
  ORDER BY a.s_mcap DESC NULLS LAST, a.s_mcap_minted DESC NULLS LAST, a.coll, a.gkey
  LIMIT v_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_market_cap_entity(p_group text, p_collection text, p_match text)
 RETURNS TABLE(collection_slug text, group_label text, editions integer, editions_supply_known integer, editions_priced integer, minted bigint, burned bigint, issuer_held bigint, collector_held bigint, mcap_usd numeric, mcap_high_conf_usd numeric, mcap_minted_usd numeric, mcap_rank integer, groups_ranked integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_cid   uuid;
  v_team  text[];
BEGIN
  IF p_group IS NULL OR p_group NOT IN ('edition','player','team','set') THEN
    RAISE EXCEPTION 'get_market_cap_entity: unknown group %', p_group USING ERRCODE = '22023';
  END IF;
  IF p_collection IS NULL OR p_match IS NULL OR btrim(p_match) = '' THEN
    RETURN;
  END IF;
  SELECT c.id INTO v_cid FROM collections c WHERE c.slug = p_collection;
  IF v_cid IS NULL THEN
    RETURN;
  END IF;
  IF p_group = 'team' THEN
    v_team := public.team_franchise_slugs(v_cid, p_match);
  END IF;

  RETURN QUERY
  WITH ed AS (
    SELECT * FROM public.market_cap_edition_rows(p_collection, false)
  ),
  slugged AS (
    SELECT ed.*,
           regexp_replace(lower(ed.player_name), '[^a-z0-9]+', '-', 'g') AS p_plain,
           regexp_replace(lower(extensions.unaccent(ed.player_name)), '[^a-z0-9]+', '-', 'g') AS p_ascii,
           regexp_replace(lower(ed.team_name), '[^a-z0-9]+', '-', 'g') AS t_plain,
           regexp_replace(lower(extensions.unaccent(ed.team_name)), '[^a-z0-9]+', '-', 'g') AS t_ascii
    FROM ed
  ),
  -- Other teams rank as FRANCHISES too, keyed by the sorted slug set
  -- team_franchise_slugs() returns for any of their labels.
  team_keys AS (
    SELECT d.t_plain,
           (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(public.team_franchise_slugs(v_cid, d.t_plain)) x) AS fkey
    FROM (SELECT DISTINCT s.t_plain FROM slugged s WHERE p_group = 'team' AND s.t_plain <> '') d
  ),
  keyed AS (
    SELECT s.*,
           CASE p_group
             WHEN 'edition' THEN s.ext_id = p_match
             WHEN 'player'  THEN s.player_name <> '' AND NOT coalesce(s.is_team_moment, false)
                                 AND (s.p_plain = p_match OR s.p_ascii = p_match)
             WHEN 'team'    THEN s.team_name <> '' AND (s.t_plain = ANY (v_team) OR s.t_ascii = ANY (v_team))
             WHEN 'set'     THEN s.set_slug = p_match
           END AS is_match,
           CASE p_group
             WHEN 'edition' THEN s.ext_id
             WHEN 'player'  THEN CASE WHEN s.player_name <> '' AND NOT coalesce(s.is_team_moment, false) THEN s.p_ascii END
             WHEN 'team'    THEN nullif(s.team_name, '')
             WHEN 'set'     THEN nullif(s.set_slug, '')
           END AS gkey
    FROM slugged s
  ),
  grouped AS (
    SELECT CASE WHEN k.is_match THEN '' ELSE coalesce(tk.fkey, k.gkey) END AS g,
           bool_or(k.is_match) AS is_target,
           CASE p_group
             WHEN 'edition' THEN min(coalesce(nullif(k.player_name, ''), nullif(k.team_name, ''), k.set_name))
             WHEN 'player'  THEN min(k.player_name)
             WHEN 'team'    THEN min(k.team_name)
             WHEN 'set'     THEN min(k.set_name)
           END AS glabel,
           count(*)::integer AS n,
           count(k.collector_held)::integer AS n_known,
           count(k.fmv_usd)::integer AS n_priced,
           sum(k.minted)::bigint AS s_minted,
           sum(k.burned)::bigint AS s_burned,
           sum(k.issuer_held)::bigint AS s_issuer,
           sum(k.collector_held)::bigint AS s_collector,
           count(k.fmv_usd * k.collector_held) AS n_capped,
           sum(k.fmv_usd * k.collector_held) AS s_mcap,
           sum(k.fmv_usd * k.collector_held) FILTER (WHERE k.confidence IN ('HIGH','MEDIUM')) AS s_mcap_hm,
           sum(k.fmv_usd * k.minted) AS s_mcap_minted
    FROM keyed k
    LEFT JOIN team_keys tk ON p_group = 'team' AND tk.t_plain = k.t_plain AND NOT coalesce(k.is_match, false)
    WHERE coalesce(k.is_match, false) OR k.gkey IS NOT NULL
    GROUP BY 1
  ),
  ranked AS (
    SELECT gr.*,
           CASE WHEN gr.s_mcap IS NOT NULL
                THEN (rank() OVER (PARTITION BY gr.s_mcap IS NOT NULL ORDER BY gr.s_mcap DESC))::integer END AS rnk,
           (count(gr.s_mcap) OVER ())::integer AS n_ranked
    FROM grouped gr
  )
  SELECT p_collection, r.glabel, r.n, r.n_known, r.n_priced,
         r.s_minted, r.s_burned, r.s_issuer, r.s_collector,
         round(r.s_mcap, 2),
         CASE WHEN r.n_capped > 0 THEN round(coalesce(r.s_mcap_hm, 0), 2) END,
         round(r.s_mcap_minted, 2),
         r.rnk, r.n_ranked
  FROM ranked r
  WHERE r.is_target;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_market_cap_entity(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_cap_entity(text, text, text) TO service_role;
