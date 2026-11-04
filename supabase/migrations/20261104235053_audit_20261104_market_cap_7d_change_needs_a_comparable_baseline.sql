-- 2026-11-04 (Claude Code cloud) — market cap "7-Day Change" compares only like with like.
--
-- get_market_cap_board / get_market_cap_entity took the 7-days-ago figure straight from market_cap_daily,
-- whatever that day covered. Candy MLB's overview read "7-Day Change +550.4 % from $9,523": the 10-28 row
-- knew supply for 9 of 125 editions ($9,523), today's for 125 ($61,936); the real move vs 10-27 is about
-- −3 %. Measured over 33 daily collection rows: Candy's supply coverage moved > 2 % day to day on 19 days,
-- Panini's on 14 (catalogue growth to 10-21); Top Shot, All Day, Golazos, Pinnacle, UFC on 0.
-- Now the baseline is returned only when its editions_supply_known is within 2 % of today's (exact for a
-- single edition); otherwise NULL, which every reader already renders as "no comparable figure".
-- Bodies built FROM the pin (supabase/tests/get_market_cap_board.sql), proven equal to live prosrc by md5
-- (882c4122… / 104eb079…) before the edit.
--
-- anon-exec: unchanged (get_market_cap_board) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false.
-- anon-exec: unchanged (get_market_cap_entity) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false.
--
-- Revert: re-apply the two function blocks from 20261003213500 / 20261003221539.

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
         -- 2026-11-04: a 7-day baseline counts only when it covered the same editions (supply known on
         -- within 2 % of today's count). Candy MLB's 10-28 row knew 9 of 125 and printed "+550.4 %".
         CASE WHEN a.n_known > 0
               AND abs(d.editions_supply_known - a.n_known) <= 0.02 * a.n_known
              THEN d.mcap_usd END
  FROM agg a
  LEFT JOIN market_cap_daily d
    ON p_group = 'collection' AND d.snapshot_date = v_day7 AND d.collection_slug = a.coll
   AND d.grain = 'collection' AND d.group_key = a.coll
  ORDER BY a.s_mcap DESC NULLS LAST, a.s_mcap_minted DESC NULLS LAST, a.coll, a.gkey
  LIMIT v_limit;
END;
$function$;

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
         -- 2026-11-04: comparable baseline only (supply known on within 2 % of today's editions).
         CASE WHEN m.editions_supply_known > 0
               AND abs(d.editions_supply_known - m.editions_supply_known) <= 0.02 * m.editions_supply_known
              THEN d.mcap_usd END,
         st.refreshed_at
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
