-- audit_20260729_snapshot_read_write_rpc_ddl_for_pinning
--
-- DOCUMENTATION SNAPSHOT — NOT a behavior change.
--
-- These five functions were live in production but had NO committed migration
-- carrying their CURRENT definition: fmv_recalc_edition_page,
-- get_edition_badges_unified, recalc_ultimate_fmv, and refresh_seeded_wallet_stats
-- were applied via MCP and never committed as files, and get_team_detail's live
-- definition had DRIFTED past its last committed migration
-- (20260703233446_..._get_team_detail_scope_sales_by_collection.sql — that copy
-- predates the teams_master branding + short-slug + 30d-activity additions).
--
-- Each block below is a VERBATIM copy of the live definition captured via
-- pg_get_functiondef() on 2026-07-29 (project bxcqstmqfzmuolpuynti). Re-applying
-- it is an idempotent CREATE OR REPLACE with a byte-identical body, so it is a
-- pure no-op against prod — it exists so the DB-invariant tests in
-- supabase/tests/*.sql can pin these functions with the drift guard
-- (__tests__/db-invariants-drift-guard.test.ts) keeping the pinned copies honest.
--
-- Faithfulness of each block to the live definition was verified by comparing the
-- whitespace-normalized md5 (scripts/verify-live-ddl.mjs) against the live
-- pg_get_functiondef md5.

-- ── fmv_recalc_edition_page — the edition-selection page that drives fmv-recalc ──
CREATE OR REPLACE FUNCTION public.fmv_recalc_edition_page(p_window_start timestamp with time zone, p_pinnacle_collection_id uuid, p_limit integer, p_offset integer)
 RETURNS TABLE(edition_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET statement_timeout TO '120s'
 SET search_path TO 'public'
AS $function$
  SELECT s.edition_id
  FROM sales s
  WHERE s.sold_at >= p_window_start
    AND s.price_usd > 0
    AND s.collection_id <> p_pinnacle_collection_id
    AND s.edition_id IS NOT NULL
  GROUP BY s.edition_id
  ORDER BY MAX(s.sold_at) DESC NULLS LAST
  LIMIT p_limit OFFSET p_offset
$function$;

-- ── get_edition_badges_unified — the unified badge list (play-tag allowlist + Three-Star derivation) ──
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  WITH ed AS (
    SELECT e.id, e.external_id,
           split_part(e.external_id::text, '::', 1) AS base_external_id,
           e.collection_id, e.set_name
    FROM editions e WHERE e.id = p_edition_id
  ),
  be_row AS (
    SELECT be.*
    FROM badge_editions be
    JOIN ed ON be.external_id = ed.base_external_id AND be.collection_id = ed.collection_id
    LIMIT 1
  ),
  sync_play AS (
    SELECT pt.tag, 'play' AS source
    FROM be_row be
    CROSS JOIN LATERAL jsonb_array_elements(be.play_tags) AS pt(tag)
    WHERE jsonb_typeof(be.play_tags) = 'array'
      AND regexp_replace(
            lower(unaccent(coalesce(pt.tag->>'title', pt.tag->>'id', ''))),
            '[^a-z0-9]+', '', 'g'
          ) = ANY (ARRAY[
            'topshotdebut','rookieyear','rookiemint','rookiepremiere',
            'mvpyear','championshipyear','rookieoftheyear','allstar',
            'threestarrookie'
          ])
  ),
  sync_set_play AS (
    SELECT jsonb_array_elements(be.set_play_tags) AS tag, 'set_play' AS source
    FROM be_row be
    WHERE jsonb_typeof(be.set_play_tags) = 'array'
  ),
  sync_mint AS (
    SELECT jsonb_build_object('id','rookie-mint','title','Rookie Mint') AS tag, 'flag' AS source
    FROM be_row be
    WHERE be.has_rookie_mint = true
  ),
  -- real synced tags (excluding the derived-from-Three-Star injection below)
  real_tags AS (
    SELECT tag, source FROM sync_play
    UNION ALL SELECT tag, source FROM sync_set_play
    UNION ALL SELECT tag, source FROM sync_mint
  ),
  -- v2 Three-Star rule: Rookie Year + Rookie Mint + Rookie Premiere present.
  flags AS (
    SELECT
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookieyear')     AS has_year,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiepremiere') AS has_premiere,
      bool_or(regexp_replace(lower(unaccent(coalesce(tag->>'title',tag->>'id',''))),'[^a-z0-9]+','','g')='rookiemint')     AS has_mint
    FROM real_tags
  ),
  tsr AS (
    SELECT (
      COALESCE((SELECT is_three_star_rookie FROM be_row), false)
      OR COALESCE((SELECT has_year AND has_premiere AND has_mint FROM flags), false)
    ) AS v
  ),
  sync_tsr AS (
    SELECT jsonb_build_object('id','three-star-rookie','title','Three-Star Rookie') AS tag, 'flag' AS source
    FROM tsr WHERE tsr.v = true
  ),
  combined_real AS (
    SELECT tag, source FROM real_tags
    UNION ALL SELECT tag, source FROM sync_tsr
  ),
  derived AS (
    SELECT jsonb_array_elements(derive_badges_from_set_name(ed.set_name)) AS tag, 'derived' AS source
    FROM ed
  ),
  all_tags AS (
    SELECT tag, source FROM combined_real
    UNION ALL
    SELECT tag, source FROM derived
    WHERE NOT EXISTS (SELECT 1 FROM combined_real)
  ),
  normalized AS (
    SELECT
      tag, source,
      regexp_replace(
        lower(unaccent(coalesce(tag->>'title', tag->>'id', ''))),
        '[^a-z0-9]+', '', 'g'
      ) AS norm_key
    FROM all_tags
    WHERE tag ? 'id' OR tag ? 'title'
  ),
  ranked AS (
    SELECT tag, source, norm_key,
      row_number() OVER (
        PARTITION BY norm_key
        ORDER BY CASE source
          WHEN 'play' THEN 1 WHEN 'set_play' THEN 2
          WHEN 'flag' THEN 3 WHEN 'derived' THEN 4
        END
      ) AS rnk
    FROM normalized
    WHERE norm_key <> ''
  ),
  has_tsr AS (
    SELECT EXISTS (SELECT 1 FROM ranked WHERE rnk = 1 AND norm_key = 'threestarrookie') AS v
  )
  SELECT coalesce(
    jsonb_agg(
      (CASE
         WHEN norm_key = 'codenamemercury'
           THEN (tag - 'title') || jsonb_build_object('title', 'Leaderboard Reward')
         ELSE tag
       END) || jsonb_build_object('source', source)
      ORDER BY
        CASE source WHEN 'flag' THEN 1 WHEN 'play' THEN 2 WHEN 'set_play' THEN 3 WHEN 'derived' THEN 4 END,
        norm_key
    ),
    '[]'::jsonb
  )
  FROM ranked, has_tsr
  WHERE rnk = 1
    -- Three-Star Rookie subsumes Rookie Year + Rookie Mint + Rookie Premiere; hide
    -- those standalone badges when it is present (Top Shot Debut stays separate).
    AND NOT (has_tsr.v AND norm_key IN ('rookieyear','rookiepremiere','rookiemint'));
$function$;

-- ── recalc_ultimate_fmv — the ULTIMATE-tier FMV writer (delete-today-then-insert) ──
CREATE OR REPLACE FUNCTION public.recalc_ultimate_fmv()
 RETURNS TABLE(total_editions integer, inserted integer, no_data integer, ask_only integer, sales_only integer, min_sale_ask integer, ran_at timestamp with time zone, duration_ms integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total int := 0;
  v_inserted int := 0;
  v_no_data int := 0;
  v_ask_only int := 0;
  v_sales_only int := 0;
  v_min int := 0;
  v_start timestamptz := clock_timestamp();
  v_ran timestamptz := now();
  v_finish timestamptz;
  v_dur int;
BEGIN
  DELETE FROM fmv_snapshots
  WHERE algo_version = 'ultimate-v1'
    AND computed_at >= date_trunc('day', v_ran)
    AND edition_id IN (SELECT id FROM editions WHERE tier = 'ULTIMATE');

  WITH src AS (
    SELECT
      e.id                          AS ed_id,
      r.collection_id               AS coll_id,
      r.collection_slug             AS coll_slug,
      r.fmv_usd                     AS fmv,
      r.lowest_non_special_ask      AS low_ask,
      r.confidence                  AS conf,
      r.days_since_sale             AS days,
      r.source                      AS src_kind
    FROM editions e
    LEFT JOIN LATERAL compute_ultimate_non_special_fmv(e.id) r ON true
    WHERE e.tier = 'ULTIMATE'
  ),
  ins AS (
    INSERT INTO fmv_snapshots (
      edition_id, collection_id, collection,
      fmv_usd, floor_price_usd, ask_proxy_fmv,
      confidence, days_since_sale,
      algo_version, computed_at
    )
    SELECT
      s.ed_id, s.coll_id, s.coll_slug,
      s.fmv, s.low_ask, s.low_ask,
      s.conf::fmv_confidence, s.days,
      'ultimate-v1', v_ran
    FROM src s
    WHERE s.fmv IS NOT NULL
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::int FROM src),
    (SELECT COUNT(*)::int FROM ins),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'no_data'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'ask_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'sale_only'),
    (SELECT COUNT(*)::int FROM src WHERE src_kind = 'min_sale_ask')
  INTO v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min;

  v_finish := clock_timestamp();
  v_dur := EXTRACT(MILLISECONDS FROM (v_finish - v_start))::int;

  INSERT INTO pipeline_runs (
    pipeline, started_at, finished_at,
    rows_found, rows_written, rows_skipped, ok, extra
  )
  VALUES (
    'ultimate-fmv-recalc-v1', v_start, v_finish,
    v_total, v_inserted, v_no_data, true,
    jsonb_build_object(
      'algo_version', 'ultimate-v1',
      'no_data', v_no_data,
      'ask_only', v_ask_only,
      'sales_only', v_sales_only,
      'min_sale_ask', v_min,
      'duration_ms', v_dur
    )
  );

  RETURN QUERY SELECT v_total, v_inserted, v_no_data, v_ask_only, v_sales_only, v_min, v_ran, v_dur;
END;
$function$;

-- ── refresh_seeded_wallet_stats — the seeded_wallets cache writer (tier precedence) ──
CREATE OR REPLACE FUNCTION public.refresh_seeded_wallet_stats(p_wallet_address text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_summary  jsonb;
  v_count    integer;
  v_fmv      numeric;
  v_top_tier text;
BEGIN
  -- Authoritative FMV + moment count via dashboard function
  v_summary := holdings_summary(p_wallet_address);
  v_count   := COALESCE((v_summary->>'total_moments')::integer, 0);
  v_fmv     := COALESCE((v_summary->>'total_fmv_usd')::numeric, 0);

  -- Top tier still derived from wmc (holdings_summary doesn't surface it)
  SELECT tier INTO v_top_tier
  FROM wallet_moments_cache
  WHERE wallet_address = p_wallet_address
    AND tier IS NOT NULL
    AND tier <> ''
  GROUP BY tier
  ORDER BY
    CASE lower(tier)
      WHEN 'ultimate'  THEN 5
      WHEN 'legendary' THEN 4
      WHEN 'rare'      THEN 3
      WHEN 'fandom'    THEN 2
      WHEN 'common'    THEN 1
      ELSE 0
    END DESC,
    count(*) DESC
  LIMIT 1;

  UPDATE seeded_wallets
  SET
    cached_moment_count = v_count,
    cached_fmv_usd      = v_fmv,
    cached_top_tier     = v_top_tier,
    last_refreshed_at   = now()
  WHERE wallet_address = p_wallet_address;
END;
$function$;

-- ── get_team_detail — the team/franchise hub read (branding + 30d activity) ──
CREATE OR REPLACE FUNCTION public.get_team_detail(p_collection_id uuid, p_team_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '25s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_team_variants text[];
  v_team_canonical text;
  v_collection_slug text;
  v_player_count int;
  v_edition_count int;
  v_total_circulation int;
  v_fmv_total numeric;
  v_floor_total numeric;
  -- Team Hub Phase 1: branding (teams_master) + 30d activity. NULL for Pinnacle.
  v_primary_color text;
  v_secondary_color text;
  v_abbreviation text;
  v_team_external_id text;
  v_league text;
  v_sales_30d int;
  v_volume_30d numeric;
  -- Team Hub Phase 4 (F1a): teams_master short slug, the follow-write key.
  v_team_short_slug text;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  IF p_collection_id = v_pinnacle_uuid THEN
    SELECT array_agg(DISTINCT franchise),
           (array_agg(franchise ORDER BY franchise))[1]
    INTO v_team_variants, v_team_canonical
    FROM pinnacle_editions
    WHERE franchise IS NOT NULL
      AND regexp_replace(lower(trim(franchise)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
    SELECT
      COUNT(DISTINCT pe.character_name),
      COUNT(*),
      SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
      SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.franchise = ANY(v_team_variants);
    -- Pinnacle: no teams_master branding, no sports sales activity. Leave NULL.
  ELSE
    SELECT array_agg(DISTINCT team_name),
           (array_agg(team_name ORDER BY team_name))[1]
    INTO v_team_variants, v_team_canonical
    FROM editions
    WHERE collection_id = p_collection_id
      AND team_name IS NOT NULL
      AND regexp_replace(lower(trim(team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug;

    IF v_team_variants IS NULL THEN RETURN NULL; END IF;

    SELECT
      COUNT(DISTINCT regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g'))
        FILTER (WHERE e.player_name IS NOT NULL AND e.player_name <> ''),
      COUNT(*),
      SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
      SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0)
    INTO v_player_count, v_edition_count, v_total_circulation, v_fmv_total, v_floor_total
    FROM editions e
    LEFT JOIN LATERAL (
      SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
      WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
    ) fmv ON true
    WHERE e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants);

    -- Branding: single indexed lookup on slugified team_name (no cross-league
    -- slug collisions verified among active rows, so no league guard needed).
    SELECT tm.slug, tm.primary_color, tm.secondary_color, tm.abbreviation, tm.external_id, tm.league::text
    INTO v_team_short_slug, v_primary_color, v_secondary_color, v_abbreviation, v_team_external_id, v_league
    FROM teams_master tm
    WHERE tm.active
      AND regexp_replace(lower(trim(tm.team_name)), '[^a-z0-9]+', '-', 'g') = p_team_slug
    LIMIT 1;

    -- 30d activity: bounded by the team's editions via edition_id join. The
    -- s.collection_id = p_collection_id predicate (authoritative, equal to
    -- e.collection_id via the join) lets the planner use the sales
    -- (collection_id, sold_at DESC) partition index instead of scanning the
    -- whole recent slice -> keeps the fn under its 8s cap for big TS franchises.
    SELECT COUNT(*), COALESCE(SUM(s.price_usd), 0)
    INTO v_sales_30d, v_volume_30d
    FROM sales s
    JOIN editions e ON e.id = s.edition_id
    WHERE s.collection_id = p_collection_id
      AND e.collection_id = p_collection_id
      AND e.team_name = ANY(v_team_variants)
      AND s.sold_at >= now() - interval '30 days';
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'team_slug',         p_team_slug,
    'team_name',         v_team_canonical,
    'team_name_variants',v_team_variants,
    'is_franchise',      p_collection_id = v_pinnacle_uuid,
    'player_count',      v_player_count,
    'edition_count',     v_edition_count,
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'primary_color',     v_primary_color,
    'secondary_color',   v_secondary_color,
    'abbreviation',      v_abbreviation,
    'team_external_id',  v_team_external_id,
    'league',            v_league,
    'team_short_slug',   v_team_short_slug,
    'sales_30d',         v_sales_30d,
    'volume_30d_usd',    v_volume_30d
  );
END;
$function$;
