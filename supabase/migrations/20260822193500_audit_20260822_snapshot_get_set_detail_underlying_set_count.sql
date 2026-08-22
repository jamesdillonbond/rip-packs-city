-- Snapshot migration: public.get_set_detail(uuid,text).
--
-- Commits the CURRENT LIVE definition verbatim (pg_get_functiondef read
-- 2026-08-22; byte-identical, md5 f0371ee9a1d010456e70957ca9a11219 — the
-- transcription was verified against the database's own md5 rather than by eye).
-- Applying it is a NO-OP against prod: prod already has exactly this body.
--
-- WHY IT EXISTS. `db-pin-staleness` had reported this pin STALE on every run
-- since 2026-08-10 (13 consecutive; known-issues #24). The live body had gained
-- the D20 `underlying_set_count` rollup — a count of how many underlying `sets`
-- rows merged into one slug, which the set page keys a "merged set" banner on —
-- and the pinned copy predated it. Diffed rather than assumed: that ONE feature
-- (a DECLARE line, an eight-line SELECT, and a jsonb key) is the entire drift.
--
-- ⚠ TWO THINGS THE STALE REPORT DID **NOT** MEAN, both of which a reasonable
-- reading of the old pin's header would have suggested:
--   * the per-edition latest-FMV rollup did NOT change mechanism here. The
--     LEFT JOIN LATERAL ... ORDER BY computed_at DESC LIMIT 1 was already in the
--     pinned copy. The old header called it "DISTINCT-latest", which had not
--     described its own pinned DDL for some time — a documentation bug, not
--     drift, and it is corrected in the test file alongside this.
--   * the Pinnacle render-level branch is NOT new either; it was pinned too.
-- Recorded because the probe that found "no DISTINCT ON in live" invited exactly
-- the wrong conclusion, and only the actual diff refuted it.

-- ── anon-execute decision (guard: __tests__/migration-new-function-states-its-anon-exec-decision.test.ts) ──
-- anon-exec: unchanged — get_set_detail is ALREADY revoked in prod. Verified
-- 2026-08-22 with has_function_privilege (not the acl text): anon EXECUTE false,
-- authenticated EXECUTE false, service_role EXECUTE true. The public set page
-- reaches it server-side as service_role, not directly from the browser.
-- ⚠ Deliberately a MARKER and not a REVOKE: this is a byte-identical snapshot, and
-- CREATE OR REPLACE FUNCTION does NOT reset a function's ACL, so adding a REVOKE
-- here would CHANGE production while presenting itself as a no-op.

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
