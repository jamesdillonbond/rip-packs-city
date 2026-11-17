-- DB invariant: public.check_function_search_path_drift() — the search_path ban-at-zero and its
-- one curated exemption (2026-10-25). Claims:
--
--   1. An ordinary function with no search_path pin is reported (positive control).
--   2. A pinned function is not reported.
--   3. An inlined SQL helper carrying a 'search_path-exempt (inlined SQL helper):' comment and no
--      anon/authenticated EXECUTE is NOT reported — the recent_low_usd case (a SET clause stopped
--      inlining: 27-36 ms -> 366-375 ms over 61k rows).
--   4. The exemption is a CHECKED claim: the same comment on a plpgsql function, on an SQL function
--      anon can execute, or a different comment, is still reported.
--   5. A procedure is out of scope (a SET clause breaks a COMMIT).
--
-- The function DDL below is VERBATIM from the committed migration
-- (supabase/migrations/20261026001535_audit_20261025_search_path_guard_exempts_an_inlined_sql_helper_by_named_claim.sql).
-- __tests__/db-invariants-drift-guard.test.ts fails CI on drift.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.check_function_search_path_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', 'function_search_path_mutable',
           'object_name', (p.oid::regprocedure)::text,
           'security_definer', p.prosecdef,
           'detail', 'This function in public has no search_path in proconfig, so it resolves '
                  || 'unqualified names against the CALLER''s search_path. '
                  || CASE WHEN p.prosecdef
                          THEN 'It is SECURITY DEFINER, which makes that an escalation path.'
                          ELSE 'It is SECURITY INVOKER, so this is a correctness and advisory '
                            || '(function_search_path_mutable) issue rather than an escalation.'
                     END
                  || ' Fix with ALTER FUNCTION ... SET search_path = public, pg_temp — an ALTER, '
                  || 'not a CREATE OR REPLACE, so only proconfig changes and no body is rewritten.'
                  || ' (A per-row SQL helper: a SET clause stops inlining — measure first, and see the '
                  || 'search_path-exempt comment rule in 20261026001400.)'
         ) ORDER BY (p.oid::regprocedure)::text), '[]'::jsonb)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     -- FUNCTIONS only. See the header: a SET clause breaks a procedure that
     -- COMMITs, and production has already refused that pin.
     AND p.prokind = 'f'
     -- Not ours to ALTER.
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}'::text[])) cfg
        WHERE split_part(cfg, '=', 1) = 'search_path'
     )
     -- 2026-10-25: an INLINED SQL helper may be exempted by a named claim (its comment), and
     -- only while nobody but the definer-side callers can execute it (20261026001400).
     AND NOT (
       p.prolang = (SELECT l.oid FROM pg_language l WHERE l.lanname = 'sql')
       AND COALESCE(obj_description(p.oid, 'pg_proc'), '') LIKE 'search_path-exempt (inlined SQL helper):%'
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
$function$;

-- Fixtures. Default privileges grant EXECUTE to PUBLIC, so "revoked" is explicit below.
CREATE FUNCTION public.zz_plain(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
CREATE FUNCTION public.zz_pinned(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $f$ SELECT x $f$;
CREATE FUNCTION public.zz_exempt(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
REVOKE EXECUTE ON FUNCTION public.zz_exempt(numeric) FROM PUBLIC;
COMMENT ON FUNCTION public.zz_exempt(numeric) IS 'search_path-exempt (inlined SQL helper): fixture';
CREATE FUNCTION public.zz_exempt_but_plpgsql(x numeric) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $f$ BEGIN RETURN x; END $f$;
REVOKE EXECUTE ON FUNCTION public.zz_exempt_but_plpgsql(numeric) FROM PUBLIC;
COMMENT ON FUNCTION public.zz_exempt_but_plpgsql(numeric) IS 'search_path-exempt (inlined SQL helper): fixture';
CREATE FUNCTION public.zz_exempt_but_public(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
COMMENT ON FUNCTION public.zz_exempt_but_public(numeric) IS 'search_path-exempt (inlined SQL helper): fixture';
CREATE FUNCTION public.zz_exempt_but_authenticated(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
REVOKE EXECUTE ON FUNCTION public.zz_exempt_but_authenticated(numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.zz_exempt_but_authenticated(numeric) TO authenticated;
COMMENT ON FUNCTION public.zz_exempt_but_authenticated(numeric) IS 'search_path-exempt (inlined SQL helper): fixture';
CREATE FUNCTION public.zz_other_comment(x numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $f$ SELECT x $f$;
REVOKE EXECUTE ON FUNCTION public.zz_other_comment(numeric) FROM PUBLIC;
COMMENT ON FUNCTION public.zz_other_comment(numeric) IS 'an ordinary helper';
CREATE PROCEDURE public.zz_proc() LANGUAGE sql AS $f$ SELECT 1 $f$;

CREATE TEMP VIEW zz_reported AS
  SELECT x->>'object_name' AS fn FROM jsonb_array_elements(public.check_function_search_path_drift()) x
  WHERE x->>'object_name' LIKE 'zz\_%';

SELECT _assert_eq((SELECT string_agg(fn, ',' ORDER BY fn) FROM zz_reported),
  'zz_exempt_but_authenticated(numeric),zz_exempt_but_plpgsql(numeric),zz_exempt_but_public(numeric),zz_other_comment(numeric),zz_plain(numeric)',
  'reported: unpinned plain + every broken exemption claim; not the pinned one, not the true exemption, not the procedure');
SELECT _assert(NOT EXISTS (SELECT 1 FROM zz_reported WHERE fn = 'zz_exempt(numeric)'), 'an inlined SQL helper with the claim and no public EXECUTE is exempt');
SELECT _assert(EXISTS (SELECT 1 FROM zz_reported WHERE fn = 'zz_plain(numeric)'), 'positive control: an unpinned function is still reported');
-- The claim stops holding the moment anon can execute it.
GRANT EXECUTE ON FUNCTION public.zz_exempt(numeric) TO anon;
SELECT _assert(EXISTS (SELECT 1 FROM zz_reported WHERE fn = 'zz_exempt(numeric)'), 'granting anon EXECUTE voids the exemption');

SELECT '✓ check_function_search_path_drift: all assertions passed' AS result;

ROLLBACK;
