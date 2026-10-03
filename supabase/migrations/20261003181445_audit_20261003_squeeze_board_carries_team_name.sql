-- 2026-10-03 beta feedback 10253 (squeeze board: "Add player and team filters").
-- The board view had no team column, so a team filter had nothing to read.
-- ONE column is APPENDED (`team_name text`, from the editions row the view
-- already joins) — the only shape CREATE OR REPLACE VIEW allows; every
-- existing column keeps its name, position and type. Readers selecting named
-- columns (lib/insights/squeeze-board.ts, get_edition_insight_links,
-- get_insights_hub_stats, get_team_squeeze, topshot_set_squeeze_board) are
-- unaffected. The route resolves a typed team to its FRANCHISE's labels with
-- resolve_team_name() (historic names included — "LA Clippers" and "Los
-- Angeles Clippers" are one franchise) and filters team_name = ANY(labels);
-- the label itself is never the franchise (CLAUDE.md concierge rule 2).
--
-- ⚠ CREATE OR REPLACE VIEW with no WITH clause RESETS reloptions and strips
-- security_invoker — carried in the WITH clause and re-asserted below. No
-- grant change.
--
-- Revert: the appended column cannot be dropped by CREATE OR REPLACE — a
-- revert that must remove it is DROP VIEW public.topshot_squeeze_board CASCADE
-- (topshot_set_squeeze_board depends on it) + re-create both from
-- supabase/migrations/20260903134528_audit_20260903_topshot_squeeze_boards_latest_fmv_from_edition_fmv_current.sql,
-- then re-grant. Leaving the column in place is harmless.

CREATE OR REPLACE VIEW public.topshot_squeeze_board
WITH (security_invoker = on) AS
 SELECT e.id AS edition_id,
    e.external_id,
    COALESCE(e.player_name, be.player_name) AS player_name,
    COALESCE(e.set_name, be.set_name) AS set_name,
    COALESCE(e.tier::text, replace(be.tier, 'MOMENT_TIER_'::text, ''::text)) AS tier,
    COALESCE(e.circulation_count, be.circulation_count) AS circulation,
    be.locked,
    be.burned,
    round(100.0 * COALESCE(be.locked, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS lock_pct,
    round(100.0 * COALESCE(be.burned, 0)::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS burn_pct,
    round(100.0 * (COALESCE(be.locked, 0) + COALESCE(be.burned, 0))::numeric / NULLIF(COALESCE(e.circulation_count, be.circulation_count, 0), 0)::numeric, 1) AS squeeze_pct,
    GREATEST(COALESCE(e.circulation_count, be.circulation_count, 0) - COALESCE(be.locked, 0) - COALESCE(be.burned, 0), 0) AS effectively_buyable,
    CASE WHEN efc.fmv_usd IS NULL THEN NULL::numeric ELSE be.low_ask END AS low_ask,
    efc.fmv_usd::numeric(12,4) AS fmv_usd,
    efc.confidence::text AS confidence,
    e.game_date,
    e.thumbnail_url,
    efc.fmv_usd IS NOT NULL AND efc.fmv_usd > 0::numeric AND be.low_ask IS NOT NULL AND be.low_ask > (10::numeric * efc.fmv_usd) AS low_ask_disconnected,
    e.set_id,
    -- APPENDED 2026-10-03 for the board's team filter (beta feedback 10253).
    e.team_name
   FROM badge_editions be
     JOIN editions e ON e.external_id::text = be.external_id AND e.collection_id = be.collection_id
     LEFT JOIN edition_fmv_current efc ON efc.edition_id = e.id
  WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid AND COALESCE(e.circulation_count, be.circulation_count) IS NOT NULL AND COALESCE(e.circulation_count, be.circulation_count) > 0;

ALTER VIEW public.topshot_squeeze_board SET (security_invoker = on);

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.topshot_squeeze_board'::regclass AND attname = 'team_name' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'topshot_squeeze_board has no team_name column';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.topshot_squeeze_board'::regclass
      AND reloptions @> ARRAY['security_invoker=on']
  ) THEN
    RAISE EXCEPTION 'topshot_squeeze_board lost security_invoker';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.topshot_squeeze_board'::regclass AND attnum > 0 AND NOT attisdropped) <> 20 THEN
    RAISE EXCEPTION 'topshot_squeeze_board column count is not 20';
  END IF;
END
$verify$;
