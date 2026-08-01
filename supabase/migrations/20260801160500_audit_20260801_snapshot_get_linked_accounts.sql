-- Snapshot migration: public.get_linked_parents(text) + public.get_linked_children(text).
--
-- Applied to prod historically via the Supabase MCP with no committed migration
-- file (making them UNPINNABLE). This commits the CURRENT LIVE definitions
-- verbatim (pulled via pg_get_functiondef on 2026-08-01) so they can carry pinned
-- invariant tests. Applying it is a no-op against prod (byte-identical).
--
-- What they do: return the ACTIVE parent (resp. child) addresses linked to a
-- given hybrid-custody address, newest-link-first, COALESCEd to an empty array
-- (never NULL) so array callers never NPE. Load-bearing for the account-linking
-- reads that de-duplicate parent+child wallets in portfolio/leaderboard views.

CREATE OR REPLACE FUNCTION public.get_linked_parents(addr text)
 RETURNS text[]
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(array_agg(parent_addr ORDER BY last_event_at DESC), ARRAY[]::TEXT[])
  FROM linked_accounts
  WHERE child_addr = addr AND active = TRUE;
$function$;

CREATE OR REPLACE FUNCTION public.get_linked_children(addr text)
 RETURNS text[]
 LANGUAGE sql
 STABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT COALESCE(array_agg(child_addr ORDER BY last_event_at DESC), ARRAY[]::TEXT[])
  FROM linked_accounts
  WHERE parent_addr = addr AND active = TRUE;
$function$;
