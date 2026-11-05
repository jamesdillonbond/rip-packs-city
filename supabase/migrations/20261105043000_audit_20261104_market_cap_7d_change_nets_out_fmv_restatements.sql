-- audit_20261104_market_cap_7d_change_nets_out_fmv_restatements — 2026-11-04 ~8:30 PM PT (Cowork cloud; Trevor:
-- "Figure out how to solve #233").
--
-- #233: the market-cap "7-day change" published OUR OWN re-prices as market moves. market_cap_daily stores
-- collector-held x FMV per PT day and the readers compare today with 7 days ago, so a pricing-rule change (a cap,
-- a floor, a new algorithm) landed in the 7-day column for a week ("Drake Maye" -69 % from the 10-29 _histcap; the
-- 11-04 Top Shot last-sale cap ~-$48k).
--
-- Fix: a restatement ledger and a restated baseline.
--   * fmv_restatements: one row per (source, collection, edition) a rule change re-priced, old -> new FMV, with
--     when. Seeded below from the backup tables every re-price migration of the last 7 days already wrote.
--     EVERY FUTURE RE-PRICE MIGRATION must insert its rows here (docs/reference/database.md, #233).
--   * refresh_market_cap_current carries, per group, sum((new - old) x collector_held) over restatements dated
--     after the 7-day baseline day (PT days v_day-6 .. v_day) into market_cap_current.mcap_restated_7d_usd —
--     computed inside the same grouping as the cap itself, so player/team/set/series/collection all agree.
--   * get_market_cap_board (collection grain) and get_market_cap_entity return the 7-day baseline RESTATED to
--     today's rules: market_cap_daily.mcap_usd + mcap_restated_7d_usd. The 7-day change then reads ~0 for a group
--     whose only move was a re-price, and the market part of a move survives. History rows are not rewritten.
--   The comparable-coverage rule (20261104235053) is unchanged.
--
-- Limits (stated, not hidden): a restatement nets the price jump on the rows it re-priced at that moment; a rule's
-- later effect on rows it had not yet touched (a trigger capping tomorrow's insert) is not netted. The restatement
-- is scaled by TODAY's collector-held count. Both are second-order next to a migration's one-time re-price.
--
-- anon-exec: NOT granted — refresh_market_cap_current is a pg_cron writer; get_market_cap_board / get_market_cap_entity keep their existing grants (CREATE OR REPLACE keeps the ACL) (refresh_market_cap_current)
--
-- REVERT: re-apply the three function bodies from 20261104235053 (board, entity) and 20261021041717 (refresh), then
--   ALTER TABLE public.market_cap_current DROP COLUMN mcap_restated_7d_usd; DROP TABLE public.fmv_restatements;

CREATE TABLE IF NOT EXISTS public.fmv_restatements (
  source           text        NOT NULL,   -- the migration name that re-priced
  collection_slug  text        NOT NULL,   -- collections.slug
  ext_id           text        NOT NULL,   -- editions.external_id; pinnacle_catalog.render_id for Disney Pinnacle
  old_fmv_usd      numeric     NOT NULL,
  new_fmv_usd      numeric     NOT NULL,
  restated_at      timestamptz NOT NULL,
  PRIMARY KEY (source, collection_slug, ext_id)
);
ALTER TABLE public.fmv_restatements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fmv_restatements FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.fmv_restatements IS
  'FMV re-prices made by a RULE change (a migration), not by the market: old -> new per edition. The market-cap 7-day change nets these out of its baseline (#233, 2026-11-04). Every re-price migration must insert its rows here.';

-- Seed: the re-price migrations whose backups hold old/new per edition (10-29 onward; the window keeps only the
-- last 7 PT days, older rows are inert history).
INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT src, c.slug, e.external_id, sum(b.old_fmv_usd), sum(b.new_fmv_usd), min(b.at)
FROM (
  SELECT 'audit_20261029_allday_ask_only_histcap' AS src, edition_id, old_fmv_usd, new_fmv_usd, capped_at AS at FROM public.audit_20261029_allday_ask_only_histcap_backup
  UNION ALL SELECT 'audit_20261029_topshot_ask_only_histcap', edition_id, old_fmv_usd, new_fmv_usd, capped_at FROM public.audit_20261029_topshot_ask_only_histcap_backup
  UNION ALL SELECT 'audit_20261104_topshot_ask_only_recent_sales_histcap', edition_id, old_fmv_usd, new_fmv_usd, capped_at FROM public.audit_20261104_topshot_ask_only_recent_histcap_backup
  UNION ALL SELECT 'audit_20261104_topshot_ask_only_last_sale_cap', edition_id, old_fmv_usd, new_fmv_usd, capped_at FROM public.audit_20261104_topshot_ask_only_last_sale_cap_backup
  UNION ALL SELECT 'audit_20261104_topshot_fmv_floor_at_best_offer', edition_id, old_fmv_usd, new_fmv_usd, floored_at FROM public.audit_20261104_topshot_fmv_bidfloor_backup
) b
JOIN public.editions e ON e.id = b.edition_id
JOIN public.collections c ON c.id = e.collection_id
GROUP BY src, c.slug, e.external_id
ON CONFLICT DO NOTHING;

INSERT INTO public.fmv_restatements (source, collection_slug, ext_id, old_fmv_usd, new_fmv_usd, restated_at)
SELECT 'audit_20261104_pinnacle_ask_only_histcap', 'disney_pinnacle', b.render_id, b.fmv_usd, b.capped_to,
       '2026-11-05 01:08:15+00'::timestamptz   -- the migration's applied version (20261105010815)
FROM public.audit_20261104_pinnacle_ask_only_histcap_backup b
WHERE b.fmv_usd IS NOT NULL AND b.capped_to IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE public.market_cap_current ADD COLUMN IF NOT EXISTS mcap_restated_7d_usd numeric;
COMMENT ON COLUMN public.market_cap_current.mcap_restated_7d_usd IS
  'sum((new - old FMV) x collector_held) over fmv_restatements dated after the 7-day baseline day; readers add it to market_cap_daily.mcap_usd so a rule change is not a 7-day move (#233).';

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
  WITH rs AS MATERIALIZED (
    -- 2026-11-04 (#233): FMV RESTATEMENTS (a re-price by a rule change, not by the market) dated after the
    -- 7-day baseline day. Each re-price migration records old/new per edition in fmv_restatements; the
    -- 7-day change adds sum(new - old) x collector_held to its baseline so a rule change does not read as a
    -- market move. Days v_day-6 .. v_day are after the v_day-7 baseline the readers compare against.
    SELECT x.collection_slug, x.ext_id, sum(x.new_fmv_usd - x.old_fmv_usd) AS d
    FROM public.fmv_restatements x
    WHERE x.restated_at >= ((v_day - 6)::timestamp AT TIME ZONE 'America/Los_Angeles')
    GROUP BY x.collection_slug, x.ext_id
  ),
  ed AS MATERIALIZED (
    SELECT r.*, c.id AS cid, coalesce(rs.d, 0) AS restate_per_unit
    FROM public.market_cap_edition_rows(NULL, false) r
    JOIN public.collections c ON c.slug = r.coll
    LEFT JOIN rs ON rs.collection_slug = r.coll AND rs.ext_id = r.ext_id
  ),
  sl AS MATERIALIZED (
    SELECT ed.*,
           coalesce(pl.name, ed.player_name) AS person_name,
           regexp_replace(lower(coalesce(pl.name, ed.player_name)), '[^a-z0-9]+', '-', 'g') AS p_plain,
           regexp_replace(lower(extensions.unaccent(coalesce(pl.name, ed.player_name))), '[^a-z0-9]+', '-', 'g') AS p_ascii,
           regexp_replace(lower(ed.team_name), '[^a-z0-9]+', '-', 'g') AS t_plain,
           regexp_replace(lower(extensions.unaccent(ed.team_name)), '[^a-z0-9]+', '-', 'g') AS t_ascii,
           (ed.player_name <> '' AND NOT coalesce(ed.is_team_moment, false)) AS is_player,
           pc.characters AS pin_chars,
           pc.franchises AS pin_fr
    FROM ed
    LEFT JOIN public.pinnacle_catalog pc ON ed.coll = 'disney_pinnacle' AND pc.render_id = ed.ext_id
    -- 2026-10-20: the PERSON the edition is linked to (player_key = editions.player_id
    -- when linked), so one person's label variants are one group.
    LEFT JOIN public.players pl
      ON pl.id = CASE WHEN ed.player_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                      THEN ed.player_key::uuid END
  ),
  tk AS MATERIALIZED (
    SELECT d.coll, d.t_plain,
           (SELECT string_agg(x, ',' ORDER BY x) FROM unnest(public.team_franchise_slugs(d.cid, d.t_plain)) x) AS fkey
    FROM (SELECT DISTINCT s.coll, s.cid, s.t_plain FROM sl s WHERE s.t_plain <> '') d
  ),
  units AS (
    SELECT s.coll, 'collection'::text AS grain, s.coll AS gkey, s.coll AS lbl, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd FROM sl s
    UNION ALL
    SELECT s.coll, 'edition', s.ext_id, coalesce(nullif(s.player_name, ''), nullif(s.team_name, ''), s.set_name), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd FROM sl s
    UNION ALL
    SELECT s.coll, 'player', s.p_ascii, s.person_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd FROM sl s WHERE s.is_player
    UNION ALL
    SELECT s.coll, 'team', coalesce(t.fkey, s.t_plain), s.team_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd FROM sl s
      LEFT JOIN tk t ON t.coll = s.coll AND t.t_plain = s.t_plain
     WHERE s.t_plain <> ''
    UNION ALL
    SELECT s.coll, 'set', s.set_slug, s.set_name, s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd FROM sl s WHERE s.set_slug <> ''
    UNION ALL
    SELECT s.coll, 'series', coalesce(s.series_num::text, nullif(s.series_name, '')),
           coalesce(nullif(s.series_name, ''), s.series_num::text), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd
      FROM sl s WHERE coalesce(s.series_num::text, nullif(s.series_name, '')) IS NOT NULL
    UNION ALL
    SELECT s.coll, 'player', regexp_replace(lower(btrim(ch)), '[^a-z0-9]+', '-', 'g'), btrim(ch), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd
      FROM sl s CROSS JOIN LATERAL unnest(s.pin_chars) ch
     WHERE s.coll = 'disney_pinnacle' AND btrim(coalesce(ch, '')) <> ''
    UNION ALL
    SELECT s.coll, 'team', regexp_replace(lower(btrim(regexp_replace(fr, '[™®©]', '', 'g'))), '[^a-z0-9]+', '-', 'g'),
           btrim(regexp_replace(fr, '[™®©]', '', 'g')), s.minted, s.burned, s.issuer_held, s.collector_held, s.fmv_usd, s.confidence, s.collector_held * s.restate_per_unit AS restate_usd
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
           round(sum(u.fmv_usd * u.minted), 2) AS s_mcap_minted,
           round(sum(u.restate_usd), 2) AS s_restate
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
           r.n_capped, r.s_mcap, r.s_mcap_hm, r.s_mcap_minted, r.rnk, r.n_ranked, r.s_restate
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
         kd.rnk AS mcap_rank, kd.n_ranked AS groups_ranked,
         kd.s_restate AS mcap_restated_7d_usd
  FROM keyed kd;

  SELECT count(*)::integer INTO v_staged FROM _mc_stage;
  IF v_staged = 0 THEN
    RAISE EXCEPTION 'refresh_market_cap_current: staged 0 rows — refusing to replace market_cap_current';
  END IF;

  WITH up AS (
    INSERT INTO public.market_cap_current AS m
      (collection_slug, grain, match_key, group_key, is_primary, group_label, editions, editions_supply_known,
       editions_priced, minted, burned, issuer_held, collector_held, mcap_usd, mcap_high_conf_usd,
       mcap_minted_usd, mcap_rank, groups_ranked, mcap_restated_7d_usd, computed_at)
    SELECT st.collection_slug, st.grain, st.match_key, st.group_key, st.is_primary, st.group_label, st.editions,
           st.editions_supply_known, st.editions_priced, st.minted, st.burned, st.issuer_held, st.collector_held,
           st.mcap_usd, st.mcap_high_conf_usd, st.mcap_minted_usd, st.mcap_rank, st.groups_ranked, st.mcap_restated_7d_usd, v_run
    FROM _mc_stage st
    ON CONFLICT (collection_slug, grain, match_key) DO UPDATE
      SET group_key = EXCLUDED.group_key, is_primary = EXCLUDED.is_primary, group_label = EXCLUDED.group_label,
          editions = EXCLUDED.editions, editions_supply_known = EXCLUDED.editions_supply_known,
          editions_priced = EXCLUDED.editions_priced, minted = EXCLUDED.minted, burned = EXCLUDED.burned,
          issuer_held = EXCLUDED.issuer_held, collector_held = EXCLUDED.collector_held,
          mcap_usd = EXCLUDED.mcap_usd, mcap_high_conf_usd = EXCLUDED.mcap_high_conf_usd,
          mcap_minted_usd = EXCLUDED.mcap_minted_usd, mcap_rank = EXCLUDED.mcap_rank,
          groups_ranked = EXCLUDED.groups_ranked, mcap_restated_7d_usd = EXCLUDED.mcap_restated_7d_usd,
          computed_at = EXCLUDED.computed_at
      WHERE (m.group_key, m.is_primary, m.group_label, m.editions, m.editions_supply_known, m.editions_priced,
             m.minted, m.burned, m.issuer_held, m.collector_held, m.mcap_usd, m.mcap_high_conf_usd,
             m.mcap_minted_usd, m.mcap_rank, m.groups_ranked, m.mcap_restated_7d_usd)
        IS DISTINCT FROM
            (EXCLUDED.group_key, EXCLUDED.is_primary, EXCLUDED.group_label, EXCLUDED.editions,
             EXCLUDED.editions_supply_known, EXCLUDED.editions_priced, EXCLUDED.minted, EXCLUDED.burned,
             EXCLUDED.issuer_held, EXCLUDED.collector_held, EXCLUDED.mcap_usd, EXCLUDED.mcap_high_conf_usd,
             EXCLUDED.mcap_minted_usd, EXCLUDED.mcap_rank, EXCLUDED.groups_ranked, EXCLUDED.mcap_restated_7d_usd)
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
              THEN d.mcap_usd + coalesce(m.mcap_restated_7d_usd, 0) END,  -- #233: restated to today's rules
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

-- Populate mcap_restated_7d_usd now rather than at the next 2-hourly tick.
SELECT public.refresh_market_cap_current();
