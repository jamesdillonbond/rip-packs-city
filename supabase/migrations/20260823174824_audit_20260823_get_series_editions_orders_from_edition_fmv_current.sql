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
-- anon-exec: unchanged — public.get_series_editions is SECURITY DEFINER and already revoked from PUBLIC, anon and authenticated (verified live 2026-08-24 by has_function_privilege).
--
-- get_series_editions: take the ORDERING from edition_fmv_current, keep the
-- DISPLAYED values live.
--
-- The project-after-LIMIT fix earlier today removed entity_rep_nft_id() from the
-- candidate set but left the real cost: one fmv_snapshots probe per candidate,
-- purely to sort by FMV. That is read-bound, so it looked fixed warm and was not:
--   Top Shot series-7, 4,895 editions
--     06:00 UTC quiet, warm ......    219 ms   24,739 buf   125 reads
--     17:20 UTC under load ....... 47,669 ms   24,739 buf  2,926 reads  <- page grid empty
--     this shape .................     55 ms    2,975 buf    14 reads
-- 14 reads is the number that matters: phase 1 no longer probes anything. It is
-- a seq scan of a 606-page table hash-joined to an index scan of `editions`.
--
-- ⭐ THE SPLIT IS THE POINT, and it is an accuracy decision, not a perf one:
--   * ORDERING comes from edition_fmv_current, refreshed hourly. Worst case the
--     ranking of the top 100 is up to an hour stale.
--   * DISPLAYED fmv_usd / floor / confidence are still read LIVE from
--     fmv_snapshots, for exactly the 100 rows that survive the LIMIT.
--   So no collector is ever shown a stale price. Only which 100 appear, and in
--   what order, can lag - on a page already cached 600 s by `revalidate`.
--
-- FALLBACK: if edition_fmv_current holds nothing for this collection (never
-- refreshed, or refresh wedged), an all-NULL sort key would silently reorder the
-- grid by first_minted_at and look like a product change. The EXISTS guard sends
-- that case down the original live-lateral path instead: slow, but honest.
--
-- Pinnacle branch untouched.
--
-- REVERT: audit_20260823_get_series_editions_project_after_limit (this body with
-- the pick CTE reading the fmv_snapshots lateral instead of edition_fmv_current,
-- and no EXISTS guard).
CREATE OR REPLACE FUNCTION public.get_series_editions(p_collection_id uuid, p_series_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '8s'
AS $function$
DECLARE
  v_pinnacle_uuid CONSTANT uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_safe_limit    int := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
  v_safe_offset   int := GREATEST(COALESCE(p_offset, 0), 0);
  v_series        RECORD;
  v_pinnacle_year int;
  v_have_current  boolean;
  result          jsonb;
BEGIN
  SELECT * INTO v_series
  FROM collection_series
  WHERE collection_id = p_collection_id
    AND regexp_replace(lower(trim(display_label)), '[^a-z0-9]+', '-', 'g') = p_series_slug
  LIMIT 1;

  IF v_series IS NULL THEN RETURN '[]'::jsonb; END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    BEGIN
      v_pinnacle_year := v_series.season::int;
    EXCEPTION WHEN invalid_text_representation THEN
      v_pinnacle_year := NULL;
    END;

    IF v_pinnacle_year IS NULL THEN RETURN '[]'::jsonb; END IF;

    WITH ed AS (
      SELECT
        pe.id                                               AS route_slug,
        pe.character_name                                   AS player_name,
        regexp_replace(lower(trim(pe.character_name)), '[^a-z0-9]+', '-', 'g') AS player_slug,
        pe.character_name || ' (' || pe.variant_type || ')' AS name,
        pe.set_name,
        regexp_replace(lower(pe.set_name), '[^a-z0-9]+', '-', 'g') AS set_slug,
        pe.variant_type                                     AS tier,
        pe.series_year::text                                AS series_label,
        pe.mint_count                                       AS circulation_count,
        pe.thumbnail_url,
        fmv.fmv_usd,
        fmv.floor_usd                                       AS floor_usd,
        fmv.confidence::text                                AS fmv_confidence,
        fmv.fmv_min,
        fmv.fmv_max,
        fmv.render_count
      FROM pinnacle_editions pe
      LEFT JOIN LATERAL public.get_pinnacle_edition_fmv_collapsed(pe.id) fmv ON true
      WHERE pe.series_year = v_pinnacle_year
        AND pe.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, pe.minting_date DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
    RETURN result;
  END IF;

  SELECT EXISTS (SELECT 1 FROM edition_fmv_current WHERE collection_id = p_collection_id)
  INTO v_have_current;

  IF v_have_current THEN
    WITH pick AS (
      -- PHASE 1: ordering only, from the hourly rollup. No probes.
      SELECT e.id, e.first_minted_at, c.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN edition_fmv_current c ON c.edition_id = e.id
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number
        AND e.thumbnail_url IS NOT NULL
      ORDER BY c.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: live FMV + entity_rep_nft_id, over v_safe_limit rows only.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.series::text                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    -- No rollup for this collection. Original path: correct, and slow enough to
    -- notice, which is the point.
    WITH pick AS (
      SELECT e.id, e.first_minted_at, fmv.fmv_usd AS ord_fmv
      FROM editions e
      LEFT JOIN LATERAL (
        SELECT fmv_usd FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      WHERE e.collection_id = p_collection_id
        AND e.series = v_series.series_number
        AND e.thumbnail_url IS NOT NULL
      ORDER BY fmv.fmv_usd DESC NULLS LAST, e.first_minted_at DESC NULLS LAST
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        CASE WHEN e.player_name IS NULL THEN NULL
             ELSE regexp_replace(lower(trim(e.player_name)), '[^a-z0-9]+', '-', 'g') END AS player_slug,
        e.name,
        e.set_name,
        CASE WHEN e.set_name IS NULL THEN NULL
             ELSE regexp_replace(lower(e.set_name), '[^a-z0-9]+', '-', 'g') END AS set_slug,
        e.tier::text                                       AS tier,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1 WHEN 'LEGENDARY'  THEN 2 WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4 WHEN 'CONTENDER'  THEN 5 WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7 WHEN 'FANDOM'     THEN 8 WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.series::text                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC LIMIT 1
      ) fmv ON true
      ORDER BY p.ord_fmv DESC NULLS LAST, p.first_minted_at DESC NULLS LAST
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;