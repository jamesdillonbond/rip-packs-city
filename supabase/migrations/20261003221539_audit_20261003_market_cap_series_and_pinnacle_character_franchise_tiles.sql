-- audit_20261003_market_cap_series_and_pinnacle_character_franchise_tiles
--
-- (Trevor, 2026-10-03: "Keep going".) Market-cap tiles reach the remaining entity pages.
-- refresh_market_cap_current gains three grains in market_cap_current (+ daily history):
--   series — keyed like each series page resolves: the on-chain series number for
--            Top Shot / All Day / Golazos / UFC (collection_series.series_number ==
--            editions.series on every collection, measured 2026-10-03), the label for
--            Pinnacle (pinnacle_catalog.series_name == collection_series.display_label,
--            "2023".."2026");
--   Pinnacle player — one row per CHARACTER trait (pinnacle_catalog.characters; a duo
--            pin counts for both), keyed slugifyName(name) like pinnacleCharacterHref;
--   Pinnacle team — one row per FRANCHISE trait, keyed slugifyName with ™ ® © removed,
--            like pinnacleFranchiseHref.
-- get_market_cap_entity accepts 'series'. Both are CREATE OR REPLACE with unchanged
-- signatures (ACL preserved).
--
-- ⚠ NO NEW DESTRUCTIVE STATEMENT: the only DELETEs are refresh_market_cap_current's
-- existing prunes of market_cap_current / market_cap_daily, unchanged.
--
-- 🚨 APPLY STATUS (2026-10-03 ~3:35 PM PT): get_market_cap_entity is APPLIED.
-- refresh_market_cap_current is NOT — a plain apply_migration was HELD by the Supabase
-- MCP's human-confirmation gate (its body carries the two existing prunes) and rolled
-- back cleanly. It needs a human-confirmed apply of the function below; until then
-- the live refresh is the 20261003213500 body, so the new series / Pinnacle
-- character / franchise rows do not exist and those tiles render nothing. A guarded
-- splice was refused as a bypass of that gate; do not route around it.
-- (`npm run db:pins:check` will read this pin STALE until the apply lands.)
--
-- anon-exec: unchanged (refresh_market_cap_current) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
-- anon-exec: unchanged (get_market_cap_entity) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false.
--
-- Revert: re-apply the two function bodies from
-- 20261003213500_audit_20261003_market_cap_current_daily_history_and_four_more_supply_sources.sql;
-- the next refresh retires the new grains' rows.

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
