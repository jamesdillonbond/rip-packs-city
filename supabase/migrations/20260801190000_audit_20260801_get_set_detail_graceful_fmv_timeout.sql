-- Sentry JAVASCRIPT-NEXTJS-22: "set detail unavailable: canceling statement due
-- to statement timeout" on GET /[collection]/set/[slug]. Root-caused by profiling:
-- the ONLY expensive part of get_set_detail is the per-edition latest-FMV rollup.
-- On the largest sets (Top Shot "Base Set", ~3,600 thumbnail-bearing editions) it
-- fans out to thousands of correlated LATERAL probes across the yearly
-- fmv_snapshots partitions (~2s warm) and, cold under connection contention,
-- exceeded the request statement budget and THREW -- erroring the whole public
-- set page. (Profiled alternatives: swapping the LATERAL for a fmv_current
-- DISTINCT-ON join is 11x WORSE at 22s because it materializes the DISTINCT ON
-- over all ~942k snapshot rows before filtering; a covering index does not help
-- since the wanted row is always on a hot, recently-written, not-all-visible page.)
--
-- Fix: wrap ONLY the expensive rollup in BEGIN/EXCEPTION WHEN query_canceled so a
-- request-level statement timeout DEGRADES the header stats to NULL (rendered "-")
-- instead of throwing. The page -- including the separately-fetched editions grid
-- -- still renders. Verified deterministically: with the timeout armed at the
-- command boundary and a rollup exceeding it, the handler catches query_canceled
-- and the function returns the envelope with NULL stats rather than propagating.
-- Also drops the RETURN's COALESCE(edition_count,0) so a degraded read shows "-"
-- (fmtCount(null)) rather than a misleading "0" beside a populated grid; the happy
-- path is unchanged because COUNT(*) is never NULL.
--
-- Every normal-sized set finishes in a few ms and is behaviourally identical.
-- NB: statement_timeout is armed at the top-level command boundary and cannot be
-- re-armed mid-function (verified), so this catches the request/role timeout that
-- was already firing -- it does not add a new inner budget.
-- Revert: CREATE OR REPLACE back to the 20260626162000 body (no BEGIN/EXCEPTION).
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

  -- The per-edition latest-FMV rollup is the only expensive read here. On the
  -- largest sets it can exceed the request statement budget cold and would
  -- otherwise error the whole page (Sentry JAVASCRIPT-NEXTJS-22). Catch that
  -- cancellation and degrade the header stats to NULL (rendered "-") instead of
  -- throwing; normal-sized sets finish in a few ms and never trip this.
  BEGIN
    IF p_collection_id = v_pinnacle_uuid THEN
      -- Render-level (per-pin), matching the get_set_editions grid. Joined by
      -- btrim(set_name) to defuse the catalog leading-space quirk.
      SELECT
        COUNT(*),
        SUM(pc.fmv_usd)                                  FILTER (WHERE pc.fmv_usd > 0),
        SUM(COALESCE(pc.floor_ask, pc.fmv_usd))          FILTER (WHERE COALESCE(pc.floor_ask, pc.fmv_usd) > 0),
        COUNT(pc.fmv_usd)                                FILTER (WHERE pc.fmv_usd > 0)
      INTO v_edition_count, v_fmv_total, v_floor_total, v_editions_with_fmv
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
  END;

  RETURN jsonb_build_object(
    'collection_id',       v_set.collection_id,
    'collection_slug',     v_collection_slug,
    'set_slug',            v_set.set_slug,
    'set_name',            v_set.set_name,
    'set_name_variants',   v_set.set_name_variants,
    'edition_count',       v_edition_count,
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

-- Preserve the service_role-only surface (CREATE OR REPLACE keeps grants; explicit for clarity).
REVOKE EXECUTE ON FUNCTION public.get_set_detail(uuid, text) FROM anon, authenticated, PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_set_detail(uuid, text) TO service_role, postgres;
