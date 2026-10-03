-- audit_20261003_market_cap_current_daily_history_and_four_more_supply_sources
--
-- (Trevor, 2026-10-03: "Do it all".)
--
-- (1) market_cap_edition_rows gains three supply sources and a `supply_source` column:
--       atlas_badge  — Top Shot / All Day badge_editions (unchanged)
--       atlas_supply — Golazos + Pinnacle from atlas_edition_supply (20261003213000),
--                      ignored when fetched_at is older than 3 days: an old split is
--                      unknown, not current
--       panini       — panini_editions (unchanged)
--       candy        — mv_candy_scarcity_board: sealed = held by the Candy treasury
--                      (issuer), circulating = everyone else; burned = circulation -
--                      sealed - circulating (burnt assets are skipped at ingest, so 0
--                      today). Measured 2026-10-03: sealed + circulating = circulation
--                      on 125/125 editions.
--     UFC Strike is the only collection left with no source (Atlas rejects every
--     product name tried; market closed 2026-05-13).
--     A source row whose parts exceed its whole is still treated as UNKNOWN.
--
-- (2) market_cap_current — every entity's cap and rank, recomputed every 2 hours by
--     refresh_market_cap_current(), so an entity-page tile is one index probe instead
--     of the ~51k-buffer / 0.4–0.6 s live aggregate measured for get_market_cap_entity.
--     Grains: collection, edition, player, team, set. Rows are keyed by the slug each
--     page passes; a group gets ALIAS rows for every other slug that page could carry
--     (the plain spelling of an accented player name; every label of a team
--     franchise), with is_primary = false so they never count toward a rank.
--     Write-first: the new set is staged, upserted (unchanged rows untouched), and only
--     then are rows the run did NOT produce deleted.
--
-- (3) market_cap_daily — one row per (PT date, collection, grain, primary key) for
--     collection / player / team / set; the latest run of the PT day wins. This is the
--     7-day-change history. It starts 2026-10-03, so a 7-day figure is NULL until
--     2026-10-10 — and NULL renders as "no history yet", never as 0 %.
--
-- (4) get_market_cap_entity now reads (2) and adds mcap_usd_7d_ago + refreshed_at.
--     Same matching contract as 20261003210031: team slugs resolve through
--     team_franchise_slugs(); no match → zero rows.
-- (5) get_market_cap_board gains mcap_usd_7d_ago (collection grain only — the other
--     grains' board keys are not the daily table's keys).
--
-- anon-exec: revoked (market_cap_edition_rows) — DROP+CREATE for the new supply_source column; ACL re-applied, service_role only.
-- anon-exec: revoked (get_market_cap_board) — DROP+CREATE for the new mcap_usd_7d_ago column; ACL re-applied, service_role only.
-- anon-exec: revoked (get_market_cap_entity) — DROP+CREATE for new columns; ACL re-applied, service_role only.
-- anon-exec: revoked (refresh_market_cap_current) — new fn; pg_cron (postgres) only.
--
-- Revert: SELECT cron.unschedule('rpc-market-cap-refresh'); DROP the four functions;
-- DROP TABLE market_cap_current, market_cap_daily, market_cap_refresh_state; re-apply
-- 20261003210031 (restores the previous three function bodies).

DROP FUNCTION IF EXISTS public.get_market_cap_entity(text, text, text);
DROP FUNCTION IF EXISTS public.get_market_cap_board(text, text, integer);
DROP FUNCTION IF EXISTS public.market_cap_edition_rows(text, boolean);

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

REVOKE ALL ON FUNCTION public.market_cap_edition_rows(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_cap_edition_rows(text, boolean) TO service_role;

-- ── (2)/(3) storage ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.market_cap_current (
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
ALTER TABLE public.market_cap_current ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_cap_current FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.market_cap_current TO service_role;

CREATE TABLE IF NOT EXISTS public.market_cap_daily (
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
ALTER TABLE public.market_cap_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_cap_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.market_cap_daily TO service_role;

CREATE TABLE IF NOT EXISTS public.market_cap_refresh_state (
  id            boolean     PRIMARY KEY DEFAULT true CHECK (id),
  refreshed_at  timestamptz NOT NULL
);
ALTER TABLE public.market_cap_refresh_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.market_cap_refresh_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.market_cap_refresh_state TO service_role;

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
           (ed.player_name <> '' AND NOT coalesce(ed.is_team_moment, false)) AS is_player
    FROM ed
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
    WHERE st.is_primary AND st.grain IN ('collection','player','team','set')
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

REVOKE ALL ON FUNCTION public.refresh_market_cap_current() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_market_cap_current() TO service_role;

-- ── (4) entity read ─────────────────────────────────────────────────────────
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
  IF p_group IS NULL OR p_group NOT IN ('collection','edition','player','team','set') THEN
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

REVOKE ALL ON FUNCTION public.get_market_cap_entity(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_cap_entity(text, text, text) TO service_role;

-- ── (5) board ───────────────────────────────────────────────────────────────
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

REVOKE ALL ON FUNCTION public.get_market_cap_board(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_market_cap_board(text, text, integer) TO service_role;

-- (Function bodies carry no comments: the SQL transport refused the commented
-- bodies; the rationale is all in this header.)
--
-- Every 2 hours at :41 (FMV moves hourly-ish; the tile need not be fresher).
SELECT cron.schedule('rpc-market-cap-refresh', '41 */2 * * *', 'SELECT public.refresh_market_cap_current()');
