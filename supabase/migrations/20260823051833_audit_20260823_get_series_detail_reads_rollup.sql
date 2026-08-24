-- ── APPENDED 2026-08-24 AFTER RECOVERY — comment only, SQL untouched ─────────
-- ⚠ THIS FILE IS A RECOVERED CAPTURE, not a hand-authored migration. It was
-- applied to production via MCP and its .sql was reconstructed byte-exactly from
-- `supabase_migrations.schema_migrations.statements` by
-- `scripts/recover-fileless-migrations.mjs`. Committing it turned CI RED, because
-- `__tests__/migration-new-function-states-its-anon-exec-decision.test.ts` requires
-- every migration from its 20260817000000 CUTOFF forward to STATE an anon-execute
-- decision per public function it creates — and a capture of history states none.
--
-- The decision is stated here rather than by weakening that guard, and it was
-- MEASURED rather than assumed. Verified live 2026-08-24 with
-- `has_function_privilege` (never the acl text):
--   anon = false · authenticated = false · service_role = true · SECURITY DEFINER
--
-- ⚠ ONLY THIS COMMENT WAS ADDED. Not one SQL byte changed, so re-running the file
-- against production is still a no-op and the revert path it carries is intact.
-- It does mean the file no longer md5-matches prod's stored `statements`; that is
-- the deliberate cost of satisfying the guard honestly instead of exempting it.
-- ⚠ A REVOKE must NOT be added: `CREATE OR REPLACE FUNCTION` does not reset an
-- ACL, so one here would CHANGE production while presenting itself as a no-op.
-- anon-exec: unchanged — public.get_series_detail is SECURITY DEFINER and already revoked from PUBLIC, anon and authenticated (verified live 2026-08-24 by has_function_privilege).
--
-- get_series_detail: read the precomputed rollup instead of one LEFT JOIN
-- LATERAL over fmv_snapshots per edition.
--
-- Identical signature, so grants and proconfig survive CREATE OR REPLACE.
-- Return shape is byte-identical - no key added, none removed.
--
-- Verified before swapping: rollup vs the live lateral on six aggregates across
-- NFL series-4 (54 editions), series-2 (98), series-10 (115), UFC series-1
-- (115), Golazos series-1 (575) and Top Shot series-4 (3,600).
-- All six columns matched exactly on all six series.
--
-- Pinnacle is DELIBERATELY untouched: its branch reads pinnacle_editions and
-- measured 61 ms / 507 buffers, so it has no problem to fix and no rollup rows.
--
-- The fallback matters. A missing rollup row means "refresh has not run for
-- this series yet" (every series in collection_series gets a row, zeros
-- included), so a newly added series stays CORRECT - it just pays the old slow
-- path until the next refresh, instead of quietly reporting zero editions.
--
-- REVERT: re-apply the body from
--   audit_20260823_get_series_detail_reads_rollup_REVERT below, or simply
--   restore the pre-2026-08-23 definition, which is the ELSE branch inlined
--   with no rollup read.
CREATE OR REPLACE FUNCTION public.get_series_detail(p_collection_id uuid, p_series_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid     CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_series            RECORD;
  v_collection_slug   text;
  v_edition_count     int;
  v_total_circulation bigint;
  v_fmv_total         numeric;
  v_floor_total       numeric;
  v_set_count         int;
  v_player_count      int;
  v_pinnacle_year     int;
  v_hit               boolean := false;
BEGIN
  SELECT slug INTO v_collection_slug FROM collections WHERE id = p_collection_id;

  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN NULL; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    -- Pinnacle: cast season text to int year
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NOT NULL THEN
      -- PIN-FMV-REKEY Wave 2: per-render FMV via the collapse helper.
      SELECT
        COUNT(*),
        SUM(pe.mint_count) FILTER (WHERE pe.mint_count IS NOT NULL),
        SUM(fmv.fmv_usd)   FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_usd, fmv.fmv_usd) > 0),
        COUNT(DISTINCT pe.set_name),
        COUNT(DISTINCT pe.character_name)
      INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.series_year = v_pinnacle_year;
    END IF;
  ELSE
    -- FAST PATH: the precomputed rollup (refresh_series_stats_rollup).
    SELECT true, r.edition_count, r.total_circulation, r.fmv_total_usd,
           r.floor_total_usd, r.set_count, r.player_count
    INTO v_hit, v_edition_count, v_total_circulation, v_fmv_total,
         v_floor_total, v_set_count, v_player_count
    FROM series_stats_rollup r
    WHERE r.collection_id = p_collection_id
      AND r.series_number = v_series.series_number;

    IF NOT COALESCE(v_hit, false) THEN
      -- No rollup row yet for this series. Correctness beats latency: fall back
      -- to the original per-edition computation rather than serving zeros.
      SELECT
        COUNT(*),
        SUM(e.circulation_count) FILTER (WHERE e.circulation_count IS NOT NULL),
        SUM(fmv.fmv_usd)         FILTER (WHERE fmv.fmv_usd > 0),
        SUM(COALESCE(fmv.floor_price_usd, fmv.fmv_usd)) FILTER (WHERE COALESCE(fmv.floor_price_usd, fmv.fmv_usd) > 0),
        COUNT(DISTINCT e.set_name),
        COUNT(DISTINCT COALESCE(e.player_id::text, e.player_name))
      INTO v_edition_count, v_total_circulation, v_fmv_total, v_floor_total, v_set_count, v_player_count
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd FROM fmv_snapshots
        WHERE edition_id = e.id ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'collection_id',     p_collection_id,
    'collection_slug',   v_collection_slug,
    'series_slug',       p_series_slug,
    'series_number',     v_series.series_number,
    'display_label',     v_series.display_label,
    'season',            v_series.season,
    'edition_count',     COALESCE(v_edition_count, 0),
    'total_circulation', v_total_circulation,
    'fmv_total_usd',     v_fmv_total,
    'floor_total_usd',   v_floor_total,
    'set_count',         COALESCE(v_set_count, 0),
    'player_count',      COALESCE(v_player_count, 0)
  );
END;
$function$;