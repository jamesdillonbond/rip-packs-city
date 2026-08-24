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
-- anon-exec: unchanged — public.get_set_editions is SECURITY DEFINER and already revoked from PUBLIC, anon and authenticated (verified live 2026-08-24 by has_function_privilege).
--
-- get_set_editions: same defect as get_series_editions, and a cleaner case.
--
-- The ORDER BY is `tier_rank, circulation_count, player_name` - three columns of
-- `editions` and NOTHING from FMV. So the LIMIT was always satisfiable from
-- `editions` alone, yet the old shape computed the per-edition fmv_snapshots
-- LATERAL and public.entity_rep_nft_id() for EVERY edition in the set before
-- discarding all but 100. For nba-top-shot/base-set that is 3,609 editions of
-- work to display 100.
--
-- Measured, /nba-top-shot/set/base-set (3,609 editions with a thumbnail):
--   before  10,676 ms   29,473 buffers   3,501 reads   <- over its own 8s ceiling, so the page 500s
--   after       31 ms    2,665 buffers      20 reads
-- `Subplans Removed: 1` confirms the empty 2027 partition is pruned as well.
--
-- Why this is exactly equivalent, not approximately:
--   * the ordering keys are unchanged and come only from `editions`, so phase 1
--     selects the identical 100 rows in the identical order;
--   * the outer CTE repeats that ORDER BY so jsonb_agg preserves it;
--   * same columns, same names, same order, tier_rank included;
--   * `computed_at < now() + interval '1 day'` is a no-op on the data (zero
--     future rows) and exists only as a pruning predicate.
--
-- Pinnacle branch untouched - it reads pinnacle_catalog with no lateral.
--
-- Equivalence proof: md5 of the full jsonb output captured BEFORE the swap for
-- base-set / holo-icon / throwdowns, and re-checked after.
--
-- Context: pg_stat_statements has get_set_editions at 6,237 PostgREST calls with
-- a mean of 1,820 ms - the worst mean of any entity RPC, ~15x get_edition_detail
-- - so this is instance-wide contention relief, not just one page.
--
-- REVERT: restore the previous definition (single CTE, projection inline, no
-- computed_at predicate).
CREATE OR REPLACE FUNCTION public.get_set_editions(p_collection_id uuid, p_set_slug text, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
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
  v_variants      text[];
  result          jsonb;
BEGIN
  SELECT set_name_variants INTO v_variants
  FROM sets_summary
  WHERE collection_id = p_collection_id AND set_slug = p_set_slug;

  IF v_variants IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  IF p_collection_id = v_pinnacle_uuid THEN
    WITH ed AS (
      SELECT
        pc.render_id                                       AS route_slug,
        pc.character_name                                  AS player_name,
        pc.character_name || ' (' || pc.variant || ')'     AS name,
        pc.variant                                         AS tier,
        NULL::int                                          AS tier_rank,
        pc.series_name                                     AS series_label,
        pc.total_minted                                    AS circulation_count,
        pc.thumbnail_url,
        pc.fmv_usd,
        pc.floor_ask                                       AS floor_usd,
        pc.fmv_confidence::text                            AS fmv_confidence,
        pc.fmv_computed_at                                 AS fmv_computed_at
      FROM pinnacle_catalog pc
      WHERE btrim(pc.set_name) = ANY (SELECT btrim(x) FROM unnest(v_variants) x)
      ORDER BY pc.character_name, pc.variant
      LIMIT v_safe_limit OFFSET v_safe_offset
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  ELSE
    WITH pick AS (
      -- PHASE 1: ordering keys only. All three come from `editions`, so this
      -- picks exactly the rows the old single-CTE form would have kept.
      SELECT
        e.id,
        CASE e.tier::text
          WHEN 'ULTIMATE'   THEN 1
          WHEN 'LEGENDARY'  THEN 2
          WHEN 'CHAMPION'   THEN 3
          WHEN 'CHALLENGER' THEN 4
          WHEN 'CONTENDER'  THEN 5
          WHEN 'RARE'       THEN 6
          WHEN 'UNCOMMON'   THEN 7
          WHEN 'FANDOM'     THEN 8
          WHEN 'COMMON'     THEN 9
          ELSE 99
        END                                                AS tier_rank,
        e.circulation_count,
        e.player_name
      FROM editions e
      WHERE e.collection_id = p_collection_id
        AND e.set_name = ANY(v_variants)
        AND e.thumbnail_url IS NOT NULL
      ORDER BY 2, e.circulation_count NULLS LAST, e.player_name
      LIMIT v_safe_limit OFFSET v_safe_offset
    ),
    ed AS (
      -- PHASE 2: FMV lateral + entity_rep_nft_id, over v_safe_limit rows.
      SELECT
        COALESCE(e.external_id, e.id::text)                AS route_slug,
        e.player_name,
        e.name,
        e.tier::text                                       AS tier,
        p.tier_rank                                        AS tier_rank,
        e.series::text                                     AS series_label,
        e.circulation_count,
        e.thumbnail_url,
        public.entity_rep_nft_id(p_collection_id, e.external_id, e.id) AS rep_nft_id,
        e.video_url,
        e.team_name,
        e.play_type,
        fmv.fmv_usd,
        fmv.floor_price_usd                                AS floor_usd,
        fmv.confidence::text                               AS fmv_confidence,
        fmv.computed_at                                    AS fmv_computed_at
      FROM pick p
      JOIN editions e ON e.id = p.id
      LEFT JOIN LATERAL (
        SELECT fmv_usd, floor_price_usd, confidence, computed_at
        FROM fmv_snapshots
        WHERE edition_id = e.id
          AND computed_at < now() + interval '1 day'
        ORDER BY computed_at DESC
        LIMIT 1
      ) fmv ON true
      ORDER BY p.tier_rank, p.circulation_count NULLS LAST, p.player_name
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(ed.*)), '[]'::jsonb) INTO result FROM ed;
  END IF;

  RETURN result;
END;
$function$;