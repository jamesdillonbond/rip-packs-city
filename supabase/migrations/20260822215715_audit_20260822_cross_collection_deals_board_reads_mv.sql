-- Point the public board view at the materialized copy. Column names, order and types
-- were verified identical first (20/20, zero name or type mismatches) because
-- CREATE OR REPLACE VIEW cannot rename or reorder columns and fails 42P16 if they drift.
--
-- ⚠ WITH (security_invoker = on) is RESTATED DELIBERATELY. A CREATE OR REPLACE VIEW with
-- no WITH clause RESETS reloptions and silently strips security_invoker — four recorded
-- occurrences in this repo. Omitting it here would turn a public board into a
-- SECURITY DEFINER view.
--
-- ⚠ THE is_active PREDICATE IS NOT DECORATION. The old body read `editions`, whose RLS
-- policy is `collection_id IN (SELECT c.id FROM collections WHERE c.is_active IS TRUE)`,
-- so an anon reader could never see rows for a deactivated collection. A materialized
-- view is not RLS-governed, so materialising without this guard would mean a collection
-- deactivated tomorrow keeps serving rows out of the MV until the next refresh — the
-- swap would have quietly widened what the board exposes. Restating the predicate here
-- keeps the old semantics under BOTH roles: anon gets it from collections' own RLS,
-- service_role (which bypasses RLS) gets it from this explicit WHERE.
CREATE OR REPLACE VIEW public.cross_collection_deals_board
WITH (security_invoker = on) AS
SELECT m.*
FROM public.mv_cross_collection_deals m
WHERE m.collection_slug IN (
  SELECT c.slug FROM public.collections c WHERE c.is_active IS TRUE
);
