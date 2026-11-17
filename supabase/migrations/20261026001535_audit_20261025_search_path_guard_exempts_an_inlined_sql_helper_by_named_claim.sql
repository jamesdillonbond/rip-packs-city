-- 2026-10-25 (PT) — the search_path guard gets a CURATED exemption for an inlined SQL helper,
-- instead of the ALTER it prescribes, because that ALTER is a 13x regression on recent_low_usd.
--
-- WHY. The 10-25 daytime monitor (inbox 2026-10-26T0006Z) found check_function_search_path_drift()
-- non-empty for the first time: public.recent_low_usd(numeric, numeric) (20261025221903) has no
-- search_path in proconfig, and proposed `ALTER FUNCTION ... SET search_path = public, pg_temp`.
-- Measured before applying it (10-25 ~5:15 PM PT, rolled-back scratch copy, 61,372 rows of
-- edition_fmv_current, same sum both ways): the inlined function 27-36 ms, a SET-pinned copy
-- 366-375 ms. A SET clause makes a SQL function NON-INLINABLE, so every row pays a function call.
-- This helper runs per edition inside the series rollup, the team totals (25 s cap) and the team
-- cheapest entry (8 s cap) — the pin buys nothing there and costs ~13x.
--
-- WHY THE PIN BUYS NOTHING. An inlined SQL function's body is planned in the CALLER, under the
-- caller's search_path. Every caller of recent_low_usd is SECURITY DEFINER with
-- SET search_path TO 'public', and EXECUTE is revoked from PUBLIC/anon/authenticated, so nobody
-- with a chosen search_path can call it directly. Its body names only CASE, numeric literals and
-- comparison/arithmetic operators.
--
-- WHAT. check_function_search_path_drift() skips a function only when ALL of these hold, so the
-- exemption is a checked claim, not a free pass:
--   1. LANGUAGE sql (the only kind Postgres inlines);
--   2. its COMMENT starts with 'search_path-exempt (inlined SQL helper):' followed by the reason
--      (the curated list is the set of such comments — grep pg_description, never an allowlist here);
--   3. neither anon nor authenticated can EXECUTE it.
-- A plpgsql function, an uncommented one, or one that is publicly executable is still reported.
-- Everything else in the body is unchanged; signature, SECURITY DEFINER, search_path and ACL
-- unchanged (CREATE OR REPLACE). Base re-checked live: md5(prosrc) 966813e8e0321e324f6c7478aa4202e7
-- = the 20260914190000 body.
-- anon-exec: unchanged (check_function_search_path_drift) — CREATE OR REPLACE of an existing fn; ACLs preserved.
--
-- Pin: supabase/tests/check_function_search_path_drift.sql.
-- ⓘ The body and the recent_low_usd comment say "20261026001400": the drafted file name. Prod recorded
-- this migration as 20261026001535 (this file); both names mean this migration.
-- Revert: re-apply the body from 20260914190000; COMMENT ON FUNCTION public.recent_low_usd(numeric, numeric) IS NULL.

DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.check_function_search_path_drift()'::regprocedure) IS DISTINCT FROM '966813e8e0321e324f6c7478aa4202e7' THEN
    RAISE EXCEPTION 'check_function_search_path_drift changed since the splice base -- re-splice';
  END IF;
END
$guard$;

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

COMMENT ON FUNCTION public.recent_low_usd(numeric, numeric) IS
  'search_path-exempt (inlined SQL helper): called per edition inside SECURITY DEFINER readers that pin '
  'search_path (get_set_detail, get_player_detail, get_series_detail, refresh_series_detail_rollup, '
  'get_team_detail, get_team_sets); EXECUTE revoked from PUBLIC/anon/authenticated; body is CASE + numeric '
  'operators only. A SET search_path clause would stop inlining: measured 10-25 at 27-36 ms inlined vs '
  '366-375 ms pinned over 61,372 rows. Do NOT ALTER ... SET search_path (20261026001400). '
  'Returns the floor when > 0 and <= 3x FMV (or FMV unknown), else NULL (20261025221903).';
