-- audit_20260906_snapshot_five_spliced_functions_so_their_pins_can_be_repointed
--
-- `db-pin-staleness` has been red for three consecutive runs (warn at 3): five
-- pinned functions differ from their pinned migration. None of the five is an
-- uncommitted live edit — each was changed by a COMMITTED migration that
-- SPLICES (reads pg_get_functiondef, replace()s a substring, EXECUTEs), so no
-- migration file carries the full current text and the pin has nothing new to
-- point at:
--   detect_stalled_pipelines         ← 20260904041635 (created_at grace for new watchlist rows)
--   get_player_detail                ← 20260906165511 (unaccented slug match)
--   get_pack_detail_bundle           ← 20260906165511 (hero subject falls back to team_name)
--   get_wallet_collection_snapshot   ← 20260904045817 + 20260906174634 (stale split, per-collection)
--   refresh_unmapped_backlog_growth  ← 20260905163444 (drain stall as a liveness test)
--
-- This file is the SNAPSHOT the staleness script asks for: each body below is
-- the live `pg_get_functiondef()` captured 2026-09-06 21:47Z (md5 of the
-- captured text: 21ce73ef…, 4fae6e25…, 9690a06f…, 218f771f…, 8927f623…),
-- byte-identical to production, so applying it is a no-op on the database and
-- exists so the repo can DESCRIBE what runs. The five pins in
-- __tests__/db-invariants-drift-guard.test.ts and their supabase/tests copies
-- now point here; each test's ASSERTIONS were re-run against the new body on a
-- local Postgres 16 before this was committed.
--
-- ACL: unchanged (CREATE OR REPLACE keeps the existing ACL; the REVOKEs are
-- restated for the standing rule). anon-exec: unchanged — none of the five is
-- anon-callable; check_secdef_anon_exec_drift() re-run after apply.
-- Revert: nothing to revert (identical bodies); to un-pin, restore the previous
-- PINS paths.

-- ── detect_stalled_pipelines ──
CREATE OR REPLACE FUNCTION public.detect_stalled_pipelines()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'pipeline', w.pipeline,
           'severity', w.severity,
           'max_silent_minutes', w.max_silent_minutes,
           'silent_minutes', round((extract(epoch from (now()-lr.last_run))/60)::numeric, 0),
           'last_run', lr.last_run,
           'heartbeat_last_run', hbl.last_hb,
           'uncorrelated_heartbeats', orp.uncorrelated,
           'classification',
             CASE
               WHEN hbl.last_hb IS NULL THEN 'no_marker'
               WHEN (extract(epoch from (now()-hbl.last_hb))/60) <= w.max_silent_minutes
                 THEN 'invoked_but_never_logged'
               ELSE 'not_invoked'
             END,
           'notes', w.notes
         ) ORDER BY (extract(epoch from (now()-lr.last_run))/60) DESC NULLS FIRST), '[]'::jsonb)
  FROM pipeline_cadence_watchlist w
  LEFT JOIN LATERAL (
    SELECT max(started_at) AS last_run FROM pipeline_runs pr WHERE pr.pipeline = w.pipeline
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT max(h.started_at) AS last_hb
    FROM pipeline_runs h WHERE h.pipeline = w.pipeline || '-heartbeat'
  ) hbl ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS uncorrelated FROM pipeline_runs h
    WHERE h.pipeline = w.pipeline || '-heartbeat'
      AND h.started_at > COALESCE(lr.last_run, now() - interval '30 days') - interval '5 s'
      AND NOT EXISTS (SELECT 1 FROM pipeline_runs t
                      WHERE t.pipeline = w.pipeline
                        AND t.started_at BETWEEN h.started_at - interval '5 s'
                                             AND h.started_at + interval '5 s')
  ) orp ON true
  WHERE w.is_active
    -- 2026-09-04: a row younger than its own threshold cannot be stalled yet (grace for new pipelines)
    AND w.created_at < now() - (w.max_silent_minutes * interval '1 minute')
    AND (lr.last_run IS NULL OR (extract(epoch from (now()-lr.last_run))/60) > w.max_silent_minutes);
$function$;
REVOKE ALL ON FUNCTION public.detect_stalled_pipelines() FROM PUBLIC, anon, authenticated;

-- ── get_player_detail ──
CREATE OR REPLACE FUNCTION public.get_player_detail(p_collection_id uuid, p_player_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid    CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_player           RECORD;
  v_collection_slug  text;
  v_edition_count    int;
  v_total_circulation int;
  v_fmv_total        numeric;
  v_floor_total      numeric;
  v_first_minted     timestamptz;
  v_last_minted      timestamptz;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  WITH cand AS (
    SELECT p.*,
      (SELECT count(*) FROM editions e
         WHERE e.collection_id = p_collection_id
           AND (e.player_id = p.id OR e.player_name = p.name)
           AND e.team_name IS NOT DISTINCT FROM p.team) AS team_edition_count
    FROM players p
    WHERE p.collection_id = p_collection_id
      AND (regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
           OR regexp_replace(lower(trim(extensions.unaccent(p.name))), '[^a-z0-9]+', '-', 'g') = p_player_slug)
  ),
  recent AS (
    SELECT e.team_name, e.game_date
    FROM editions e
    WHERE e.collection_id = p_collection_id
      AND e.player_name = (SELECT min(name) FROM cand)
      AND e.team_name IS NOT NULL
      AND e.game_date IS NOT NULL
    ORDER BY e.game_date DESC
    LIMIT 1
  ),
  horizon AS (
    SELECT max(game_date) AS max_gd
    FROM editions
    WHERE collection_id = p_collection_id
      AND game_date IS NOT NULL
  )
  SELECT c.* INTO v_player
  FROM cand c
  LEFT JOIN recent r ON true
  CROSS JOIN horizon h
  ORDER BY (CASE WHEN r.team_name IS NOT NULL
                  AND r.game_date >= h.max_gd - interval '18 months'
                  AND c.team = r.team_name
                 THEN 1 ELSE 0 END) DESC,
           c.team_edition_count DESC NULLS LAST,
           (c.is_active IS TRUE) DESC,
           (c.headshot_url IS NOT NULL) DESC,
           c.id
  LIMIT 1;

  IF v_player IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      MIN(pe.minting_date),
      MAX(pe.minting_date)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.character_name = v_player.name;
  ELSE
    SELECT
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
      MIN(e.first_minted_at),
      MAX(e.first_minted_at)
    INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_first_minted, v_last_minted
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND (e.player_id = v_player.id OR e.player_name = v_player.name);
  END IF;

  RETURN jsonb_build_object(
    'id',                v_player.id,
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'player_slug',       p_player_slug,
    'external_id',       v_player.external_id,
    'name',              v_player.name,
    'first_name',        v_player.first_name,
    'last_name',         v_player.last_name,
    'team',              v_player.team,
    'team_slug',         CASE WHEN v_player.team IS NULL THEN NULL
                              ELSE regexp_replace(lower(trim(v_player.team)), '[^a-z0-9]+', '-', 'g') END,
    'jersey_number',     v_player.jersey_number,
    'position',          v_player.position,
    'player_tier',       v_player.player_tier::text,
    'is_active',         v_player.is_active,
    'headshot_url',      v_player.headshot_url,
    'is_character',      p_collection_id = v_pinnacle_uuid,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'first_minted_at',   v_first_minted,
    'last_minted_at',    v_last_minted
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_player_detail(uuid, text) FROM PUBLIC, anon, authenticated;

-- ── get_wallet_collection_snapshot ──
CREATE OR REPLACE FUNCTION public.get_wallet_collection_snapshot(p_wallet text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH w AS (
    SELECT player_name, set_name, tier, serial_number, edition_key,
           image_url, series_number, fmv_usd, mint_count, collection_id
    FROM wallet_moments_cache
    WHERE wallet_address = p_wallet
  ),
  top5 AS (
    SELECT jsonb_agg(t) AS arr FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE fmv_usd IS NOT NULL AND fmv_usd > 0
      ORDER BY fmv_usd DESC
      LIMIT 5
    ) t
  ),
  series AS (
    SELECT jsonb_object_agg(label, cnt) AS obj FROM (
      SELECT 'S' || COALESCE(series_number::text, 'Unknown') AS label,
             count(*) AS cnt
      FROM w GROUP BY 1
    ) s
  ),
  badges AS (
    SELECT count(DISTINCT be.external_id)::int AS c
    FROM badge_editions be
    WHERE be.external_id IN (SELECT DISTINCT edition_key FROM w WHERE edition_key IS NOT NULL)
  ),
  per_coll AS (
    SELECT jsonb_agg(pc ORDER BY (pc->>'moments')::int DESC) AS arr FROM (
      SELECT jsonb_build_object(
               'slug', c.slug,
               'name', c.name,
               'moments', count(*),
               -- Closed markets carry a count but no dollar total (a closed
               -- market has no current value). market_closed_at lets the UI
               -- render a "count + note" instead of a figure.
               'fmv', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),
               -- 2026-09-06: same basis as the headline (total − stale). The card
               -- printed NBA Top Shot $87,785 raw beside a $50,223 headline.
               'stale_fmv', round(COALESCE(sum(w.fmv_usd) FILTER (WHERE l.confidence = 'STALE'), 0)::numeric, 2),
               'stale_count', count(*) FILTER (WHERE l.confidence = 'STALE'),
               'market_closed_at', c.market_closed_at
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      LEFT JOIN LATERAL (
        SELECT l.confidence FROM editions e JOIN edition_fmv_current l ON l.edition_id = e.id
         WHERE e.external_id = w.edition_key AND e.collection_id = w.collection_id LIMIT 1
      ) l ON true
      GROUP BY c.slug, c.name, c.market_closed_at
    ) x
  ),
  -- 2026-09-04: stale split, so the front door can headline total − stale like the profile
  stale AS (
    SELECT
      round(COALESCE(sum(w.fmv_usd) FILTER (
        WHERE w.collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2) AS stale_fmv,
      count(*)::int AS stale_count
    FROM w
    JOIN editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
    JOIN edition_fmv_current l ON l.edition_id = e.id
    WHERE l.confidence = 'STALE'
  ),
  rarest AS (
    SELECT to_jsonb(r) AS obj FROM (
      SELECT player_name AS "playerName",
             set_name    AS "setName",
             tier,
             serial_number AS serial,
             mint_count  AS "mintCount",
             round(COALESCE(fmv_usd, 0)::numeric, 2) AS fmv,
             image_url   AS "thumbnailUrl"
      FROM w
      WHERE mint_count IS NOT NULL AND mint_count > 0
      ORDER BY mint_count ASC, fmv_usd DESC NULLS LAST
      LIMIT 1
    ) r
  )
  SELECT jsonb_build_object(
    'wallet', p_wallet,
    'totalMoments', (SELECT count(*)::int FROM w),
    -- Grand FMV excludes collections whose market has closed; their moments
    -- still count in totalMoments (real holdings), but their dead-market value
    -- is not folded into the headline total.
    'totalFmv', round(COALESCE((
        SELECT sum(fmv_usd) FROM w
        WHERE collection_id NOT IN (SELECT id FROM collections WHERE market_closed_at IS NOT NULL)
      ), 0)::numeric, 2),
    'topMoments', COALESCE((SELECT arr FROM top5), '[]'::jsonb),
    'badgeCount', COALESCE((SELECT c FROM badges), 0),
    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest),
    'staleFmv', COALESCE((SELECT stale_fmv FROM stale), 0),
    'staleCount', COALESCE((SELECT stale_count FROM stale), 0)
  );
$function$;
REVOKE ALL ON FUNCTION public.get_wallet_collection_snapshot(text) FROM PUBLIC, anon, authenticated;

-- ── get_pack_detail_bundle ──
CREATE OR REPLACE FUNCTION public.get_pack_detail_bundle(p_collection_id uuid, p_dist_id text, p_collection_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_pack_row      jsonb;
  v_dist_fallback jsonb;
  v_corrected_ev  jsonb;
  v_hero          jsonb;
  v_has_pool      boolean;
begin
  select to_jsonb(t) into v_pack_row
  from public.pack_table_rows t
  where t.collection_id = p_collection_id and t.dist_id = p_dist_id
  limit 1;

  select jsonb_build_object('metadata', d.metadata, 'image_url', d.image_url, 'title', d.title)
    into v_dist_fallback
  from public.pack_distributions d
  where d.collection_id = p_collection_id and d.dist_id = p_dist_id
  limit 1;

  -- AllDay corrected EV (odds/median-robust cross-check) — AllDay only.
  -- Reads the LEAN v_allday_pack_detail_ev (see migration header): identical columns
  -- and values to v_allday_pack_info, without its 1.19M-cost pack_ev_latest join.
  if p_collection_slug = 'nfl-all-day' then
    select jsonb_build_object(
             'corrected_gross_ev', v.corrected_gross_ev,
             'corrected_net_ev', v.corrected_net_ev,
             'corrected_value_ratio', v.corrected_value_ratio,
             'ev_method', v.ev_method,
             'has_published_odds', v.has_published_odds,
             'stale_value_share_pct', v.stale_value_share_pct,
             'low_confidence_ev', v.low_confidence_ev,
             'opened_count', v.opened_count,
             'packnft_total', v.packnft_total,
             'opened_pct_of_minted', v.opened_pct_of_minted
           )
      into v_corrected_ev
    from public.v_allday_pack_detail_ev v
    where v.dist_id = p_dist_id
    limit 1;
  end if;

  -- Top-5 pool editions by FMV — powers the hero montage + Top-pulls strip.
  -- Optimized (see migration header): score FMV once/edition in a MATERIALIZED
  -- CTE, fold total_weight over the same set, then join editions + the rep-nft
  -- lookup only for the final 5 rows.
  with scored as materialized (
    select pdp.edition_id, pdp.drop_weight,
           -- `computed_at <= now()` is a no-op on the RESULT (no snapshot is
           -- computed in the future) but it hands the planner the partition key,
           -- which prunes the empty future partition at runtime. See header.
           (select fs.fmv_usd from public.fmv_snapshots fs
              where fs.edition_id = pdp.edition_id and fs.computed_at <= now()
              order by fs.computed_at desc limit 1) as fmv_usd
    from public.pack_drop_pool pdp
    where pdp.collection_id = p_collection_id and pdp.dist_id = p_dist_id
      and pdp.drop_weight > 0
  ),
  tw as (
    select nullif(sum(drop_weight), 0) as total_weight from scored
  ),
  top5 as (
    select edition_id, drop_weight, fmv_usd
    from scored
    where fmv_usd is not null and fmv_usd > 0
    order by fmv_usd desc
    limit 5
  )
  select coalesce(jsonb_agg(row_to_json(h)::jsonb order by h.fmv_usd desc), '[]'::jsonb)
    into v_hero
  from (
    select coalesce(e.external_id, e.id::text) as route_slug,
           coalesce(nullif(trim(e.player_name), ''), e.team_name) as player_name,
           e.team_name, e.set_name, e.tier::text as tier, e.thumbnail_url,
           (select w.moment_id from public.wallet_moments_cache w
              where w.collection_id = p_collection_id and w.edition_key = e.external_id
                and w.moment_id ~ '^[0-9]+$' limit 1) as rep_nft_id,
           t.fmv_usd::float8 as fmv_usd,
           (t.drop_weight / tw.total_weight)::float8 as hit_probability
    from top5 t
    cross join tw
    join public.editions e on e.id = t.edition_id
  ) h;

  select exists(
    select 1 from public.pack_drop_pool
    where collection_id = p_collection_id and dist_id = p_dist_id and drop_weight > 0
  ) into v_has_pool;

  return jsonb_build_object(
    'pack_row', v_pack_row,
    'dist_fallback', v_dist_fallback,
    'corrected_ev', v_corrected_ev,
    'hero_editions', coalesce(v_hero, '[]'::jsonb),
    'has_pool', coalesce(v_has_pool, false)
  );
end;
$function$;
REVOKE ALL ON FUNCTION public.get_pack_detail_bundle(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ── refresh_unmapped_backlog_growth ──
CREATE OR REPLACE FUNCTION public.refresh_unmapped_backlog_growth()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  WITH tx AS (
    -- One row per (collection, transaction) over OPEN rows only. open_n > 1 marks a
    -- multi-NFT tx; those rows' price cannot be attributed per-NFT because
    -- decodeV1SaleTx returns a single gross DUC total for the whole transaction.
    --
    -- THE `OFFSET 0` IS AN OPTIMIZATION FENCE AND IS LOAD-BEARING. DO NOT REMOVE IT.
    -- It blocks subquery pull-up so this scan is planned on its own, coming out as
    -- Seq Scan + HashAggregate instead of an Index Scan on unmapped_sales_dedup_idx
    -- (transaction_hash, nft_id, collection_id) that walks ~105k open rows in INDEX
    -- order and heap-fetches each one -- index order does not match heap order.
    --
    -- MEASURED AT THE FUNCTION LEVEL (the shape pg_cron actually calls), warm,
    -- 2026-08-31, by DO-block + clock_timestamp() with a RAISE to roll the write back:
    --     unfenced  1,550 ms   ->   fenced  560 ms     (2.8x)
    --
    -- DO NOT SIZE THIS FROM AN INLINE `EXPLAIN`, AND THAT IS THE REAL LESSON HERE.
    -- Run as standalone SQL the unfenced CTE plans as that Index Scan and costs
    -- 102,550 buffers / 9,816 ms -- but the FUNCTION does not use that plan, and the
    -- production ticks it produces are ~2 s, not ~10 s. Both numbers are real; only the
    -- function-level pair describes what runs. A plpgsql function prepares and may plan
    -- its statements differently from the same text pasted into a session, so an inline
    -- EXPLAIN is a measurement of a DIFFERENT QUERY that happens to share your text.
    --
    -- `AS MATERIALIZED` also defeats the index path but was slower in the inline test
    -- (temp written 1,854 vs 631) because it round-trips every row through a tuplestore.
    -- Equivalence proven over the population both directions (EXCEPT each way = 0).
    SELECT
      s.collection_id,
      count(*)                                                  AS open_n,
      count(*) FILTER (WHERE COALESCE(s.price_usd,0) = 0)       AS open_unpriced_n
    FROM (
      SELECT u.collection_id, u.transaction_hash, u.price_usd
      FROM public.unmapped_sales u
      WHERE u.resolved_at IS NULL
      OFFSET 0
    ) s
    GROUP BY s.collection_id, s.transaction_hash
  ), unspl AS (
    SELECT
      t.collection_id,
      COALESCE(sum(t.open_unpriced_n) FILTER (WHERE t.open_n > 1), 0)::bigint AS open_gross_unsplittable_rows
    FROM tx t
    GROUP BY t.collection_id
  ), per_collection AS (
    SELECT
      u.collection_id,
      count(*) FILTER (WHERE u.resolved_at IS NULL)                                 AS open_rows,
      count(*) FILTER (WHERE u.resolved_at IS NULL AND COALESCE(u.price_usd,0) > 0) AS open_priced_rows,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours')           AS inflow_24h,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at    > now() - interval '7 days')              AS inflow_24h_fresh,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '24 hours'
                         AND u.sold_at   <= now() - interval '7 days')              AS inflow_24h_backfill,
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '24 hours')          AS outflow_24h,
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '3 hours')           AS outflow_3h,
      -- 7-DAY WINDOW (added 2026-09-05). Wide enough to contain a bulk sweep AND the
      -- quiet stretch after it, which is the only way to see that the two disagree.
      count(*) FILTER (WHERE u.resolved_at  > now() - interval '7 days')            AS outflow_7d,
      count(*) FILTER (WHERE u.ingested_at > now() - interval '7 days'
                         AND u.sold_at     > u.ingested_at - interval '7 days')     AS inflow_7d_fresh,
      -- LIVENESS. This is the one fact the ratio test could never report: when did this
      -- resolver last actually do something. It is a timestamp, not a rate, so no window
      -- choice can distort it.
      max(u.resolved_at)                                                            AS last_resolved_at,
      min(u.sold_at) FILTER (WHERE u.resolved_at IS NULL)                           AS oldest_open_sold_at
    FROM public.unmapped_sales u
    GROUP BY u.collection_id
  ), scored AS (
    SELECT
      c.slug AS collection,
      p.open_rows,
      p.open_priced_rows,
      COALESCE(x.open_gross_unsplittable_rows, 0)                  AS open_gross_unsplittable_rows,
      p.open_rows - COALESCE(x.open_gross_unsplittable_rows, 0)    AS open_actionable_rows,
      p.inflow_24h,
      p.inflow_24h_fresh,
      p.inflow_24h_backfill,
      p.outflow_24h,
      p.outflow_3h,
      p.outflow_7d,
      p.inflow_7d_fresh,
      p.last_resolved_at,
      CASE WHEN p.last_resolved_at IS NOT NULL
           THEN round((extract(epoch FROM (now() - p.last_resolved_at)) / 3600.0)::numeric, 2)
      END AS drain_quiet_hours,
      -- REPLACED 2026-09-05. Was `outflow_3h * 16 < outflow_24h`, a ratio of two
      -- trailing counts that read TRUE 45.8% of the resolver's life and whose only
      -- effect was to null the ETA. This is a liveness test: has the resolver resolved
      -- ANYTHING in 12h. Calibrated on 5,571 consecutive gaps -- max 6.00h, p99 0.74h,
      -- zero gaps over 6h -- so it would have fired zero times historically.
      (p.last_resolved_at IS NULL
       OR p.last_resolved_at < now() - interval '12 hours')       AS drain_stalled,
      p.inflow_24h - p.outflow_24h AS net_24h,
      CASE WHEN p.inflow_24h > 0
           THEN round(p.outflow_24h::numeric / p.inflow_24h, 4) END AS drain_ratio,
      -- TWO ETAs, DELIBERATELY. They disagree by ~50x on nfl_all_day at apply time
      -- because this resolver works in intermittent bulk sweeps. The reader compares
      -- them and prints a range rather than a number when they diverge.
      CASE WHEN p.outflow_24h > p.inflow_24h_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / (p.outflow_24h - p.inflow_24h_fresh), 1)
      END AS days_to_drain_24h,
      CASE WHEN p.outflow_7d > p.inflow_7d_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / ((p.outflow_7d - p.inflow_7d_fresh)::numeric / 7.0), 1)
      END AS days_to_drain_7d,
      -- Back-compat key. Now the 7d figure, and NULL while the resolver is quiet.
      CASE WHEN NOT (p.last_resolved_at IS NULL
                     OR p.last_resolved_at < now() - interval '12 hours')
            AND p.outflow_7d > p.inflow_7d_fresh
           THEN round((p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0))::numeric
                      / ((p.outflow_7d - p.inflow_7d_fresh)::numeric / 7.0), 1)
      END AS days_to_drain,
      p.oldest_open_sold_at,
      CASE
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >= 10000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'high'
        WHEN (p.open_rows - COALESCE(x.open_gross_unsplittable_rows,0)) >=  1000
             AND p.inflow_24h_fresh > p.outflow_24h THEN 'medium'
        ELSE 'info'
      END AS severity
    FROM per_collection p
    JOIN public.collections c ON c.id = p.collection_id
    LEFT JOIN unspl x ON x.collection_id = p.collection_id
    WHERE p.open_rows >= 1000
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.open_rows DESC), '[]'::jsonb)
    INTO v_payload
    FROM scored s;

  INSERT INTO public.unmapped_backlog_growth_cache (id, payload, row_count, refreshed_at)
  VALUES (1, v_payload, jsonb_array_length(v_payload), now())
  ON CONFLICT (id) DO UPDATE
    SET payload = EXCLUDED.payload,
        row_count = EXCLUDED.row_count,
        refreshed_at = EXCLUDED.refreshed_at;

  RETURN v_payload;
END;
$function$;
REVOKE ALL ON FUNCTION public.refresh_unmapped_backlog_growth() FROM PUBLIC, anon, authenticated;

