-- audit_20260729_snapshot_read_rpc_ddl_batch2
--
-- DOCUMENTATION SNAPSHOT — NOT a behavior change (same rationale as
-- 20260729000000_..._snapshot_read_write_rpc_ddl_for_pinning.sql). get_player_detail
-- and get_wallet_collection_snapshot were live but had NO committed migration
-- carrying their current definition (applied via MCP). Each block below is a
-- VERBATIM copy of the live definition captured via pg_get_functiondef() on
-- 2026-07-29, so re-applying it is an idempotent no-op. It exists so the
-- DB-invariant tests can pin these functions with the drift guard keeping the
-- pinned copies honest. Faithfulness verified via scripts/verify-live-ddl.mjs.

-- ── get_player_detail — the player/character hub read ─────────────────────────
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
      AND regexp_replace(lower(trim(p.name)), '[^a-z0-9]+', '-', 'g') = p_player_slug
  )
  SELECT * INTO v_player
  FROM cand
  ORDER BY team_edition_count DESC NULLS LAST,
           (is_active IS TRUE) DESC,
           (headshot_url IS NOT NULL) DESC,
           id
  LIMIT 1;

  IF v_player IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
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

-- ── get_wallet_collection_snapshot — the /share collection-card read ──────────
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
               'fmv', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2)
             ) AS pc
      FROM w JOIN collections c ON c.id = w.collection_id
      GROUP BY c.slug, c.name
    ) x
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
    'totalFmv', round(COALESCE((SELECT sum(fmv_usd) FROM w), 0)::numeric, 2),
    'topMoments', COALESCE((SELECT arr FROM top5), '[]'::jsonb),
    'badgeCount', COALESCE((SELECT c FROM badges), 0),
    'seriesBreakdown', COALESCE((SELECT obj FROM series), '{}'::jsonb),
    'perCollection', COALESCE((SELECT arr FROM per_coll), '[]'::jsonb),
    'rarest', (SELECT obj FROM rarest)
  );
$function$;
