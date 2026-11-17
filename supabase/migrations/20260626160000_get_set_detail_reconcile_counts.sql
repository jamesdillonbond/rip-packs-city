-- Item 9 (2026-06-26 audit): reconcile set-page counts. The page rendered three
-- contradictory counts for multi-set names (e.g. "Holo Icon": EDITIONS 241 /
-- "364 with FMV" / tier-mix 608 — 364 > 241 is impossible). Root cause: edition_count
-- came from sets_summary (an unreliable, differently-scoped summary) while
-- editions_with_fmv + the page tier-mix counted editions by set_name. Fix: compute
-- BOTH edition_count and editions_with_fmv (plus fmv/floor totals) over the EXACT
-- scope the grid uses — set_name = ANY(variants) AND thumbnail_url IS NOT NULL
-- (get_set_editions' filter) — so the three numbers are self-consistent and
-- editions_with_fmv <= edition_count always holds.
-- Revert: CREATE OR REPLACE back to the prior body (edition_count from v_set.edition_count,
-- the two fmv aggregates without the thumbnail_url filter).
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
BEGIN
  SELECT * INTO v_set
  FROM sets_summary
  WHERE collection_id = p_collection_id
    AND set_slug = p_set_slug;

  IF v_set IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  -- Aggregate edition_count + FMV/floor from latest snapshot per edition, scoped
  -- identically to get_set_editions (thumbnail-bearing editions only) so the
  -- displayed counts reconcile with the grid + tier mix.
  IF p_collection_id = v_pinnacle_uuid THEN
    -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
    SELECT
      COUNT(*),
      SUM(fmv.fmv_usd)                                   FILTER (WHERE fmv.fmv_usd > 0),
      SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd))          FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
      COUNT(fmv.fmv_usd)                                 FILTER (WHERE fmv.fmv_usd > 0)
    INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
    FROM pinnacle_editions pe
    LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
    WHERE pe.set_name = ANY(v_set.set_name_variants)
      AND pe.thumbnail_url IS NOT NULL;
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

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'edition_count',       COALESCE(v_edition_count, 0),
    'editions_with_fmv',   v_editions_with_fmv,
    'total_circulation',   v_set.total_circulation,
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
