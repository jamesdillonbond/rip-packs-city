-- Snapshot migration: public.resolve_canonical_owner(text).
--
-- This function was applied to prod historically via the Supabase MCP with no
-- committed migration file, which made it UNPINNABLE — the DB-invariant drift
-- guard has nothing to compare a test copy against, and `npm run db:pins:check`
-- has no committed body to diff live `prosrc` against. This migration commits
-- the CURRENT LIVE definition verbatim (pulled via pg_get_functiondef on
-- 2026-08-01) so the function can carry a pinned invariant test. Applying it is
-- a no-op against prod (it is byte-identical to what already runs there).
--
-- What it does: resolves an address to its canonical (parent) owner for
-- leaderboard/analytics de-duplication of hybrid-custody linked wallets. A child
-- address with an ACTIVE link returns its most-recently-linked parent; anything
-- else returns the address unchanged. Load-bearing for analytics_sales_resolved
-- and every leaderboard that collapses parent+child wallets.

CREATE OR REPLACE FUNCTION public.resolve_canonical_owner(addr text)
 RETURNS text
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(
    (SELECT parent_addr
     FROM linked_accounts
     WHERE child_addr = addr AND active = TRUE
     ORDER BY last_event_at DESC
     LIMIT 1),
    addr
  );
$function$;
