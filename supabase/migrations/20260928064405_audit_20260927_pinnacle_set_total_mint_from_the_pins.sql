-- audit_20260927_pinnacle_set_total_mint_from_the_pins
--
-- WHY. The Disney Pinnacle set page's "Total Mint" read sets_summary, whose
-- Pinnacle figure comes from pinnacle_editions — SET-level legacy keys, each
-- carrying ONE render's mint count. Measured 2026-09-27: 163 of 178 Pinnacle
-- sets disagreed with the sum over their pins (median understatement 4.9x);
-- "Mickey & Friends Vol.1" read 9,268 for six pins that total 51,592. The same
-- function already counts the set's pins, FMV and floor from pinnacle_catalog
-- (the grid's source); only Total Mint was still set-level.
--
-- WHAT. The Pinnacle arm also sums pinnacle_catalog.total_minted over those
-- pins — NULL when any pin's count is unknown (0 sets today), and NULL with the
-- other stats when the rollup is cancelled. Every other collection is unchanged
-- (it still returns sets_summary.total_circulation). Base: the live body, which
-- is byte-identical to 20260822193500 (prosrc md5 c3e29774f15cc1068e89af80077c3777,
-- re-read immediately before this migration).
--
-- anon-exec: unchanged (get_set_detail) — CREATE OR REPLACE keeps the ACL; verified 2026-08-22 anon=false, authenticated=false, service_role=true.
--
-- Revert: re-apply the CREATE OR REPLACE block from
-- 20260822193500_audit_20260822_snapshot_get_set_detail_underlying_set_count.sql.

CREATE OR REPLACE FUNCTION public.get_set_detail(p_collection_id uuid, p_set_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_set       RECORD;
  v_fmv_total numeric;
  v_floor_total numeric;
  v_editions_with_fmv int;
  v_edition_count int;
  v_collection_slug text;
  v_underlying_set_count int;
  v_pin_circulation bigint;
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  -- The per-edition latest-FMV rollup is the only expensive read here. On the
  -- largest sets it can exceed the request statement budget cold and would
  -- otherwise error the whole page (Sentry JAVASCRIPT-NEXTJS-22). Catch that
  -- cancellation and degrade the header stats to NULL (rendered "-") instead of
  -- throwing; normal-sized sets finish in a few ms and never trip this.
  BEGIN
    IF p_collection_id = v_pinnacle_uuid THEN
      -- Render-level (per-pin), matching the get_set_editions grid. Joined by
      -- btrim(set_name) to defuse the catalog leading-space quirk.
      -- Total Mint too (2026-09-27): sets_summary's figure for Pinnacle is ONE
      -- set-level legacy key's mint count, not the set's (163 of 178 sets were
      -- understated, median 4.9x). Summed over the same pins the grid lists, and
      -- NULL — never a partial sum — if any pin's mint count is unknown.
      SELECT
        COUNT(*),
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
        SUM(COALESCE(pc.floor_ask, pc.fmv_usd))          FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
        COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0),
        CASE WHEN COUNT(*) > 0 AND COUNT(*) = COUNT(pc.total_minted) THEN SUM(pc.total_minted) END
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv, v_pin_circulation
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_set.set_name_variants) x);
    ELSE
      SELECT
        COUNT(*),
        SUM(fmv.fmv_usd)                                          FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd))           FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(fmv.fmv_usd)                                        FILTER (WHERE fmv.fmv_usd > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd
        FROM fmv_snapshots
        WHERE edition_id = e.id
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_set.set_name_variants)
        AND e.thumbnail_url IS NOT NULL;
    END IF;
  EXCEPTION WHEN query_canceled THEN
    -- Rollup blew the request statement budget: return the header with NULL stats
    -- (page shows "-") rather than throwing the whole page away.
    v_edition_count := NULL;
    v_fmv_total := NULL;
    v_floor_total := NULL;
    v_editions_with_fmv := NULL;
    v_pin_circulation := NULL;
  END;

  -- D20: how many underlying `sets` rows merged into this slug. Complete-by-
  -- construction merge signal (name-identical seasonal repeats included, which
  -- set_name_variants misses). Reads the 914-row `sets` table — trivially cheap.
  -- Pinnacle has no `sets` rows → 0 (page keys the banner on > 1).
  SELECT count(*) INTO v_underlying_set_count
  FROM sets s
  WHERE s.collection_id = p_collection_id
    AND s.name::text = ANY(v_set.set_name_variants);

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'underlying_set_count', v_underlying_set_count,
    'edition_count',       v_edition_count,
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   CASE WHEN p_collection_id = v_pinnacle_uuid THEN v_pin_circulation ELSE v_set.total_circulation END,
    'tiers_present',       v_set.tiers_present,
    'min_series',          v_set.min_series,
    'max_series',          v_set.max_series,
    'first_minted_at',     v_set.first_minted_at,
    'last_updated_at',     v_set.last_updated_at,
    'fmv_total_usd',       v_fmv_total,
    'floor_total_usd',     v_floor_total,
    'summary_computed_at', v_set.computed_at
  );
END;
$function$;
