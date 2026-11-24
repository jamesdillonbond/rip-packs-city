-- audit_20261123: the Market Cap board's Players / Teams drill-downs read EMPTY for Disney Pinnacle (0 rows each),
-- because market_cap_edition_rows carries no player/team for a pin. The entity tiles already know Pinnacle's
-- characters and franchises (refresh_market_cap_current unnests the traits, 20261003213500), so the board now does the
-- same: on Disney Pinnacle the player grain is a CHARACTER (the `characters` trait) and the team grain a FRANCHISE (the
-- `franchises` trait, ™/®/© stripped) — keys identical to the entity rows, so a board row and its character page agree.
-- A pin with two characters (227 of 2,985 on 11-23) counts toward both, so these rows do not sum to the collection.
-- Every other collection and grain is unchanged (the new arm only fires for disney_pinnacle player/team).
--
-- Base verified 11-23 ~4:50 PM PT: live prosrc md5 850429b479ec1b585863a9014f9161dd = the body in 20261105043000.
-- anon-exec: NOT granted — CREATE OR REPLACE keeps the existing ACL (postgres + service_role) (get_market_cap_board)
--
-- REVERT: re-apply get_market_cap_board from 20261105043000_audit_20261104_market_cap_7d_change_nets_out_fmv_restatements.sql.

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
    UNION ALL
    -- 2026-11-23: Disney Pinnacle's character / franchise grains. A character is the `characters` TRAIT and a
    -- franchise the `franchises` trait with ™/®/© stripped (never character_name), keyed exactly as
    -- refresh_market_cap_current keys the entity rows. A pin with two characters counts toward both, so the
    -- character (or franchise) rows do not sum to the collection.
    SELECT k.coll, t.gk,
           CASE WHEN p_group = 'player' THEN t.lbl END, CASE WHEN p_group = 'team' THEN t.lbl END,
           NULL, NULL, NULL, NULL, NULL,
           k.minted, k.burned, k.issuer_held, k.collector_held, k.fmv_usd, k.confidence
    FROM keyed k
    JOIN public.pinnacle_catalog pc ON pc.render_id = k.ext_id
    CROSS JOIN LATERAL (
      SELECT regexp_replace(lower(btrim(x.v)), '[^a-z0-9]+', '-', 'g') AS gk, min(btrim(x.v)) AS lbl
        FROM unnest(CASE WHEN p_group = 'player' THEN pc.characters ELSE pc.franchises END) AS u(raw)
        CROSS JOIN LATERAL (SELECT CASE WHEN p_group = 'team' THEN regexp_replace(u.raw, '[™®©]', '', 'g') ELSE u.raw END AS v) x
       WHERE btrim(coalesce(x.v, '')) <> ''
       GROUP BY 1
    ) t
    WHERE p_group IN ('player', 'team') AND k.coll = 'disney_pinnacle'
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
         -- 2026-11-04: a 7-day baseline counts only when it covered the same editions (supply known on
         -- within 2 % of today's count). Candy MLB's 10-28 row knew 9 of 125 and printed "+550.4 %".
         CASE WHEN a.n_known > 0
               AND abs(d.editions_supply_known - a.n_known) <= 0.02 * a.n_known
              THEN d.mcap_usd + coalesce(mc.mcap_restated_7d_usd, 0) END
  FROM agg a
  LEFT JOIN market_cap_daily d
    ON p_group = 'collection' AND d.snapshot_date = v_day7 AND d.collection_slug = a.coll
   AND d.grain = 'collection' AND d.group_key = a.coll
  -- 2026-11-04 (#233): the baseline restated to today's pricing rules (see refresh_market_cap_current).
  LEFT JOIN market_cap_current mc
    ON p_group = 'collection' AND mc.collection_slug = a.coll AND mc.grain = 'collection' AND mc.match_key = a.coll
  ORDER BY a.s_mcap DESC NULLS LAST, a.s_mcap_minted DESC NULLS LAST, a.coll, a.gkey
  LIMIT v_limit;
END;
$function$;
