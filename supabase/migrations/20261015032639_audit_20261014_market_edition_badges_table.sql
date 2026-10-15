-- audit_20261014_market_edition_badges_table
--
-- 2026-10-14 (~8:30 PM PT, Claude Code cloud; Trevor: "Yes do it all"). The
-- Market badge filter ran IN MEMORY over the Top Shot / All Day RPCs' ≤500-row
-- window, because the canonical badge rule (get_edition_badges_unified) costs
-- 0.33 ms per edition — 4.9 s for Top Shot's 14.5k editions (measured
-- 2026-10-14), too slow per request. A badge carried only outside the window
-- answered "no listings". This table holds edition → canonical badge title,
-- filled hourly by refresh_market_edition_badges (next migration), so the v2
-- market RPCs can filter badges before their LIMIT.
--
-- Rows from older runs are not deleted (the MCP held every statement carrying a
-- DELETE for a confirmation this session could not give). Readers instead count
-- only rows stamped by the collection's latest run — see
-- market_edition_badges_runs in 20261015033523.
--
-- Service-role only: RLS on, no anon/authenticated grants.
--
-- REVERT: DROP TABLE public.market_edition_badges;  (after the readers are gone)
SET LOCAL lock_timeout = '8s';
CREATE TABLE IF NOT EXISTS public.market_edition_badges (
  collection_id uuid NOT NULL,
  edition_id    uuid NOT NULL,
  title         text NOT NULL,
  refreshed_at  timestamptz NOT NULL,
  PRIMARY KEY (edition_id, title)
);
CREATE INDEX IF NOT EXISTS market_edition_badges_collection_title_idx
  ON public.market_edition_badges (collection_id, title);
ALTER TABLE public.market_edition_badges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.market_edition_badges FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.market_edition_badges TO postgres, service_role;
