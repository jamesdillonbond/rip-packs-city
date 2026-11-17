-- audit_20260812_editions_description_column
--
-- Descriptive prose for a moment/edition — the paragraph the Top Shot and All
-- Day moment pages render ("Just when you think you've seen everything ...
-- Wembanyama became just NBA history's second rookie to achieve a 5x5 game")
-- and that our catalog has never carried. Its absence is exactly why a
-- narrative search — "game winner", "buzzer beater" — returns nothing: the
-- CONCEPT is missing from the data, not from the query. `editions.name` is
-- only "<Player> — <Set>", `badges`/`reward_indicators` are empty on every row
-- of all five collections, and play_type/play_category are shot mechanics.
--
-- Nullable with no default, so this is a catalog-only ALTER — no table
-- rewrite, no lock beyond the catalog update — on a ~27k-row table.
--
-- POPULATED BY: the All Day ingest, which has been SELECTING `play {
-- description }` in ALLDAY_RELAY_QUERY since that query was written while
-- AllDayEditionMeta silently dropped the field (fixed the same day in
-- lib/editions-hydrate.ts). Whether Top Shot exposes an equivalent is the
-- open question that /api/admin/discover-moment-descriptors answers — it
-- cannot be probed from a dev sandbox, which reaches neither upstream
-- (measured: status=000) and holds no TS_PROXY_SECRET.
--
-- ⚠ DELIBERATELY NOT WIRED INTO SEARCH. rpc_search_catalog's edition arm is
-- index-bound; adding an un-indexed `description ILIKE '%q%'` OR would force a
-- sequential scan of every edition on EVERY query and undo the 162ms -> 33ms
-- that idx_editions_team_name_trgm just bought. The correct order is:
-- populate -> measure coverage -> build a trigram index -> then extend the
-- search arm. Wiring it while the column is 100% NULL buys zero recall for
-- real latency.
--
-- Revert: ALTER TABLE public.editions DROP COLUMN IF EXISTS description;

ALTER TABLE public.editions ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.editions.description IS
  'Upstream prose description of the play/moment (the paragraph the Top Shot and All Day moment pages render). Nullable; populated by ingest where the upstream exposes it. NOT yet searched by rpc_search_catalog - needs a trigram index first, or the edition arm falls back to a seq scan.';
