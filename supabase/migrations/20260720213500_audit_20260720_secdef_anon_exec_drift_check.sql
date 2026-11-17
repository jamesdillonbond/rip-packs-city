-- Item 4 of the 2026-07-20 security-advisor cleanup handoff.
-- The existing check_secdef_anon_execute_violations() only watches a hardcoded
-- 9-function allowlist, so a NEWLY-created SECDEF fn that anon/authenticated can
-- execute is invisible to it (the 2026-07-19 incident: 17 anon-readable objects
-- drifted in undetected). This adds a general drift check: snapshot the current
-- (post-cleanup, vetted) anon/auth-executable SECDEF set as the approved
-- baseline, then surface anything new that appears later.
--
-- Revert:
--   DROP FUNCTION public.check_secdef_anon_exec_drift();
--   DROP TABLE public.secdef_anon_exec_allowlist;

CREATE TABLE IF NOT EXISTS public.secdef_anon_exec_allowlist (
  identity    text PRIMARY KEY,        -- p.oid::regprocedure::text, e.g. public.foo(integer)
  note        text,
  approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.secdef_anon_exec_allowlist ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.secdef_anon_exec_allowlist FROM anon, authenticated;

-- Seed the approved baseline from the current live set (73 fns as of 2026-07-20,
-- after the 07-19 anon-revoke cleanup). Idempotent.
INSERT INTO public.secdef_anon_exec_allowlist (identity, note)
SELECT (p.oid::regprocedure)::text, 'baseline 2026-07-20 (handoff item 4)'
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
ON CONFLICT (identity) DO NOTHING;

-- Returns SECDEF fns anon/authenticated can execute that are NOT in the approved
-- allowlist ([] = no drift). Callable by the daytime monitor / night pass via
-- service_role. Not a replacement for check_secdef_anon_execute_violations()
-- (that one guards known-sensitive fns against re-grant) — this catches NEW ones.
-- Deliberately NOT SECURITY DEFINER, so it never appears in its own result set.
CREATE OR REPLACE FUNCTION public.check_secdef_anon_exec_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object('identity', s.ident, 'anon', s.a, 'authenticated', s.au)
      ORDER BY s.ident
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT (p.oid::regprocedure)::text AS ident,
           has_function_privilege('anon', p.oid, 'EXECUTE')          AS a,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS au
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
           OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) s
  WHERE s.ident NOT IN (SELECT identity FROM public.secdef_anon_exec_allowlist);
$function$;

-- Strip the default PUBLIC EXECUTE grant so anon/authenticated can't call it
-- (REVOKE FROM anon/authenticated alone leaves the PUBLIC grant intact).
REVOKE ALL ON FUNCTION public.check_secdef_anon_exec_drift() FROM PUBLIC, anon, authenticated;
