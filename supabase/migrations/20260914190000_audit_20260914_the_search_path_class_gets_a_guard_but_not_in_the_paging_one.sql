-- ─────────────────────────────────────────────────────────────────────────────
-- Register #115's stated EXIT is to add a `function_search_path_mutable` kind to
-- `check_public_security_invariants()`. ⛔ MEASURED FIRST, AND THAT IS THE WRONG
-- PLACE — so this ships the instrument the item wants, somewhere it belongs.
--
-- TWO REASONS, both checked rather than argued:
--   1. THE SMOKE GATE HARD-FAILS ON ANY ROW that function returns
--      (app/api/smoke-test/route.ts: `passed = violations.length === 0`, and a
--      failure pages). `function_search_path_mutable` is a supabase advisor
--      **WARN** on SECURITY INVOKER routines. Putting it there escalates a WARN
--      into a paging hard failure — the cry-wolf shape this estate has twice had
--      to rescue a board from.
--   2. IT WOULD FALSIFY THE PROBE'S OWN NAME. That arm is called
--      **"public base tables: RLS on + no anon write"**. A function's search_path
--      is neither a base table nor an anon write, and this repo already names the
--      defect of a check whose title promises more than its assertion keeps.
--
-- So: a SEPARATE ban-at-zero, read through `rpc_ops_snapshot()` (a READER) rather
-- than through the paging gate. Same treatment as the two guards added earlier
-- today, and batched with the snapshot rewire so both cost ONE PGRST002 burst.
--
-- ── THE POPULATION IS FUNCTIONS, NOT ROUTINES, AND THE EXCLUSION IS MEASURED ──
-- ⛔ PROCEDURES ARE EXCLUDED because the property is NOT TRUE OF THEM. A `SET`
-- clause makes a procedure unable to do transaction control: migration
-- `20260914053000` pinned all four unpinned routines this morning and pg_cron
-- **jobid 259 failed on its first tick** with `invalid transaction termination`;
-- `20260914055000` reverted the two procedures 20 minutes later. A guard that
-- demanded a pin on those two would be permanently red for a reason production
-- has already refused.
-- ⚠ THAT IS A NAMED BLIND SPOT, not a free pass: public holds **3** procedures
-- and **one of them IS pinned**, so a future procedure that does no transaction
-- control still should be — by hand, because nothing here will ask.
-- ⚠ EXTENSION-OWNED functions (`pg_depend.deptype = 'e'`, **5** today) are also
-- excluded: we cannot ALTER them, and a guard that reds on something unfixable
-- teaches the operator to skim the board.
--
-- POPULATION AT INSTALL, measured 2026-09-14: **754** functions in `public`,
-- 5 extension-owned, **749 ours, 0 unpinned** — so the ban holds at zero the day
-- it ships, and the advisor is no longer the only instrument that can see the class.
--
-- REVERT:
--   DROP FUNCTION public.check_function_search_path_drift();
--   -- and re-apply 20260914163000's rpc_ops_snapshot body (this one minus the key).
-- ─────────────────────────────────────────────────────────────────────────────

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
     );
$function$;

-- anon-exec: NOT intentional for check_function_search_path_drift — ops-only guard, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.check_function_search_path_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_function_search_path_drift() TO postgres, service_role;

COMMENT ON FUNCTION public.check_function_search_path_drift() IS
  'Ban at zero: every FUNCTION in public that is ours (not extension-owned) must pin search_path. '
  'Returns a jsonb ARRAY — clean is jsonb_array_length() = 0, NOT count(*) = 1. PROCEDURES are '
  'excluded because a SET clause breaks transaction control (jobid 259, 2026-09-14) — a named blind '
  'spot: 3 procedures exist and 1 is pinned. Population at install: 754 functions, 5 extension-owned, '
  '749 ours, 0 unpinned. Deliberately NOT part of check_public_security_invariants(), whose rows '
  'hard-fail the paging smoke gate.';

-- ⚠ FULL-BODY WRITE. Re-read from the LIVE object immediately before this file was
-- written (length 4551, md5 a1399dcc…, both keys added at 16:0xZ present), so a
-- concurrent session's edit cannot be silently reverted.
CREATE OR REPLACE FUNCTION public.rpc_ops_snapshot()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'db_size_mb', round((pg_database_size(current_database())/1024.0/1024.0)::numeric, 0),
    'security', jsonb_build_object(
      'invariants', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'object_name', object_name)), '[]'::jsonb)
                     FROM public.check_public_security_invariants()),
      'secdef_anon_violations', public.check_secdef_anon_execute_violations(),
      'rls_off_base_tables', (SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb)
                              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                              WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity=false),
      'anon_write_holes', (SELECT coalesce(jsonb_agg(DISTINCT g.table_name), '[]'::jsonb)
                           FROM information_schema.role_table_grants g
                           JOIN pg_class c ON c.relname=g.table_name AND c.relnamespace='public'::regnamespace
                           WHERE g.table_schema='public' AND g.grantee IN ('anon','authenticated')
                             AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
                             AND c.relrowsecurity=false AND c.relkind IN ('r','p'))
    ),
    'stalled_pipelines', public.detect_stalled_pipelines(),
    -- Added 2026-09-14. Both are BAN-AT-ZERO and both return a jsonb ARRAY:
    -- clean is jsonb_array_length() = 0, never count(*) = 1.
    'suppression_parked_claim_drift', public.check_suppression_parked_claim_drift(),
    'backward_cursor_rewinds', public.check_backward_cursor_rewind(),
    -- Added 2026-09-14. Also a jsonb ARRAY, also clean at length 0.
    'function_search_path_drift', public.check_function_search_path_drift(),
    'pipeline_alerts', public.get_pipeline_alerts(),
    -- `fails` still counts EVERY failure. `upstream` is the subset carrying the Cloudflare
    -- origin-down signature, and the ORDER puts the pipelines whose failures are OURS first, so one
    -- upstream outage across seven pipelines can no longer bury a real one.
    'pipeline_fails_24h', (SELECT coalesce(jsonb_agg(jsonb_build_object('pipeline', z.pipeline, 'fails', z.n, 'upstream', z.u)
                                                     ORDER BY (z.n - z.u) DESC, z.n DESC), '[]'::jsonb)
                           FROM (SELECT pipeline, count(*) AS n,
                                        count(*) FILTER (
                                          WHERE error ~* '(failed with 530|http\s*530|530\s*error code|error code:\s*1033)'
                                        ) AS u
                                 FROM public.pipeline_runs
                                 WHERE ok=false AND started_at > now()-interval '24 hours'
                                 GROUP BY pipeline) z),
    'trust_health', (SELECT coalesce(jsonb_agg(jsonb_build_object('metric', metric, 'value', value, 'breach_at', breach_at, 'status', status) ORDER BY metric), '[]'::jsonb)
                     FROM public.v_rpc_trust_health),
    'trust_health_breaches', (SELECT coalesce(jsonb_agg(metric ORDER BY metric), '[]'::jsonb)
                              FROM public.v_rpc_trust_health WHERE status <> 'ok'),
    'sentinel_ts_uuid_editions_48h', (SELECT count(*) FROM public.editions
                                      WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd'
                                        AND external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'
                                        AND created_at > now()-interval '48 hours'),
    'editions_by_collection', (SELECT jsonb_object_agg(slug, n)
                               FROM (SELECT col.slug, count(*) n FROM public.editions e
                                     JOIN public.collections col ON col.id=e.collection_id GROUP BY col.slug) q),
    'fmv_by_collection', (
      SELECT jsonb_object_agg(c.slug, fmv.counts)
      FROM (VALUES
        ('nba_top_shot','95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid),
        ('nfl_all_day','dee28451-5d62-409e-a1ad-a83f763ac070'::uuid),
        ('laliga_golazos','06248cc4-b85f-47cd-af67-1855d14acd75'::uuid),
        ('ufc_strike','9b4824a8-736d-4a96-b450-8dcc0c46b023'::uuid),
        ('disney_pinnacle','7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid)
      ) AS c(slug,cid),
      LATERAL (SELECT coalesce(jsonb_object_agg(s.confidence, s.count),'{}'::jsonb) AS counts
               FROM public.sentinel_fmv_confidence_rows(c.cid) s) fmv
    )
  );
$function$;

-- anon-exec: unchanged for rpc_ops_snapshot — a REPLACE of an existing function, and CREATE OR REPLACE does not reset an ACL, so a revoke here would CHANGE production while pretending to be a wiring-only edit.

-- ── verification, same transaction ───────────────────────────────────────────
DO $verify$
DECLARE
  v jsonb;
  v_pop int;
BEGIN
  SELECT count(*) INTO v_pop
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind = 'f'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');
  -- Assert the count the guard INSPECTED, not only that it passed. A collapse to
  -- zero here would be a guard that went blind, reading identically to a clean one.
  IF v_pop < 700 THEN
    RAISE EXCEPTION 'inspected population is % public functions, expected ~749 — the guard is looking at the wrong set', v_pop;
  END IF;

  IF jsonb_array_length(public.check_function_search_path_drift()) <> 0 THEN
    RAISE EXCEPTION 'unpinned public functions at install: %', public.check_function_search_path_drift()::text;
  END IF;

  v := public.rpc_ops_snapshot();
  IF NOT (v ? 'function_search_path_drift' AND v ? 'suppression_parked_claim_drift'
          AND v ? 'backward_cursor_rewinds' AND v ? 'security' AND v ? 'pipeline_alerts'
          AND v ? 'pipeline_fails_24h' AND v ? 'trust_health' AND v ? 'fmv_by_collection'
          AND v ? 'stalled_pipelines' AND v ? 'editions_by_collection'
          AND v ? 'sentinel_ts_uuid_editions_48h' AND v ? 'trust_health_breaches'
          AND v ? 'db_size_mb' AND v ? 'generated_at') THEN
    RAISE EXCEPTION 'the snapshot lost a key in the replace: %', (SELECT jsonb_agg(k) FROM jsonb_object_keys(v) k);
  END IF;
  IF jsonb_array_length(v->'function_search_path_drift') <> 0 THEN
    RAISE EXCEPTION 'the new guard is not clean through the snapshot';
  END IF;
END
$verify$;
