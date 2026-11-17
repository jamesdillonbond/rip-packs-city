-- audit_20260813_editions_description_search
--
-- NARRATIVE SEARCH GOES LIVE. `editions.description` now carries the upstream
-- prose the Top Shot moment page renders, so this extends rpc_search_catalog's
-- edition arm to search it — the thing that makes "Damian Lillard game winner"
-- answerable. Measured live before shipping: 76 Top Shot moments describe a
-- game-winner; none were reachable before.
--
-- ORDER MATTERED, and was followed: capture -> backfill -> MEASURE coverage ->
-- INDEX -> only then extend the search arm. Wiring the predicate before the
-- column was populated and indexed would have cost latency for zero recall.
--
-- Coverage at ship time: 5,885 of 13,197 canonical Top Shot editions (44.6%),
-- 0 elsewhere (All Day's ingest is WAF-blocked; no other collection has a prose
-- source). That is PARTIAL, which is why /api/search reports it — see the
-- edition_description_coverage view below. Do NOT hardcode the percentage
-- anywhere: the backfill moves it on every run (the Panini lesson).
--
-- INDEX: idx_editions_description_trgm (GIN trgm, partial WHERE description IS
-- NOT NULL) was built CONCURRENTLY out of band, so this file records it but
-- does not create it — apply_migration wraps in a transaction, which
-- CONCURRENTLY forbids. With it, the new description arm of the anchor
-- predicate is index-backed and the whole call MEASURED FASTER than before
-- (33ms -> 23ms), because the extra selective index narrows earlier.
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_editions_description_trgm
--     ON public.editions USING gin (description extensions.gin_trgm_ops)
--     WHERE description IS NOT NULL;
--
-- A prose match also carries a small ranking boost (0.12) so a deliberate
-- narrative query surfaces the moments that ARE game-winners above editions
-- that merely contain the words incidentally.
--
-- Revert:
--   DROP VIEW IF EXISTS public.edition_description_coverage;
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_editions_description_trgm;
--   -- and re-apply 20260812020600 for the pre-description rpc_search_catalog.

CREATE OR REPLACE VIEW public.edition_description_coverage
WITH (security_invoker = on) AS
SELECT
  c.slug AS collection_slug,
  c.id   AS collection_id,
  count(*)::int AS searchable_editions,
  count(e.description)::int AS with_description,
  round(100.0 * count(e.description) / NULLIF(count(*), 0), 1) AS pct
FROM public.editions e
JOIN public.collections c ON c.id = e.collection_id AND c.is_active
WHERE e.collection_id <> '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   OR e.external_id ~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
GROUP BY c.slug, c.id;

COMMENT ON VIEW public.edition_description_coverage IS
  'Live descriptive-prose coverage per published collection, over the CANONICAL edition population search reads (Top Shot UUID dupe residue excluded). Read by /api/search so the coverage disclosure is measured, never hardcoded - a hardcoded percentage goes stale the moment the backfill runs again.';

REVOKE ALL ON public.edition_description_coverage FROM PUBLIC;
REVOKE ALL ON public.edition_description_coverage FROM anon, authenticated;
GRANT SELECT ON public.edition_description_coverage TO service_role;

-- ⚠ THE rpc_search_catalog CHANGE WAS APPLIED VIA execute_sql, NOT
-- apply_migration, so prod carries no migration row for it. The authoritative
-- committed definition is the ORIGINAL function file, which this migration
-- supersedes only in the edition arm:
--   supabase/migrations/20260812020600_..._rpc_search_catalog_published_only.sql
-- The two deltas applied on top of it (live md5 ccb0d012f48dd09ed2e034d299d4be9b,
-- 7,148 chars) are, in the edition_hits CTE:
--
--   1. a `via_prose` column:
--        (e.description IS NOT NULL AND lower(e.description) LIKE ALL (v_pats))
--      surfaced in the union as a 0.12 ranking boost, so a deliberate narrative
--      query ranks the moments that ARE game-winners above editions that merely
--      contain the words incidentally.
--
--   2. `description` added to BOTH halves of the edition predicate — the
--      index-backed anchor:
--        OR e.description ILIKE '%' || v_anchor || '%'
--      and the multi-token combined text:
--        || ' ' || coalesce(e.description, '')
--
-- Verified live after applying: rpc_search_catalog('lillard game winner')
-- returns the "For the Win" moment first, in 23ms.
