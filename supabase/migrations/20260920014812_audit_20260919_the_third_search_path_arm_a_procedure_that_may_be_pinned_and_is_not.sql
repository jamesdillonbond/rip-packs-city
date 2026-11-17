-- audit 2026-09-19 — close register #115's NAMED BLIND SPOT: the procedure that
-- SHOULD be pinned and is not. This is the third and last arm of the search_path
-- class, and the only one nothing asserted.
--
-- ── WHAT WAS ALREADY THERE, re-derived live before writing a line of this ─────
-- #115's stated EXIT ("add a function_search_path_mutable kind to
-- check_public_security_invariants()") is ALREADY DISCHARGED, and deliberately
-- somewhere else — 20260914190000 argued, with reasons, that putting a WARN-level
-- advisory into the function whose rows HARD-FAIL the paging smoke gate would
-- manufacture a cry-wolf. Measured live 2026-09-19:
--   check_function_search_path_drift()                → []   (arm A: unpinned FUNCTION)
--   check_procedure_transaction_control_pin_drift()   → []   (arm B: pinned COMMITting PROCEDURE)
--   both wired into rpc_ops_snapshot()                → true
--   population 765 public functions (749 at install — it has GROWN, so neither
--   guard has gone blind), 5 extension-owned, 3 procedures.
--
-- ── THE ARM THAT WAS MISSING ─────────────────────────────────────────────────
-- Arm A excludes PROCEDURES entirely ("the property is not true of them") and arm B
-- only fires on a procedure that DOES transaction control. So a procedure that does
-- NO transaction control and carries NO pin is outside BOTH. 20260914190000's own
-- comment says so in as many words:
--
--     "a named blind spot: 3 procedures exist and 1 is pinned — by hand, because
--      nothing here will ask."
--
-- This is what asks. The exclusion is the SAME measured property arm B uses, not a
-- name list, so the two cannot drift apart: a procedure is out of scope here exactly
-- when it is in scope there.
--
-- ⚠ COMMENTS ARE STRIPPED BEFORE MATCHING, and the expression below is COPIED
-- VERBATIM from arm B for that reason. Arm B's first draft flagged a comment reading
-- "Do NOT add COMMIT here" and would have been permanently red on a correct object;
-- the inverse mistake here is worse, because it fails SILENT rather than loud —
-- `reconcile_all_seeded_wallet_stats` matches COMMIT on its RAW body (1 line) and on
-- its STRIPPED body (0 lines), so a raw match would have declared the ONLY in-scope
-- procedure out of scope and left this guard inspecting NOTHING while reading green.
--
-- ── POPULATION AT INSTALL, measured 2026-09-19, never assumed ────────────────
--   public procedures, ours:                    3
--   with transaction control (out of scope):    2   reconcile_all_saved_wallet_stats (3 COMMITs)
--                                                   rpc_trust_health_precompute_refresh_p (8 COMMITs)
--   without (IN SCOPE for this guard):          1   reconcile_all_seeded_wallet_stats
--   of those, unpinned (violations):            0   ← the ban holds at zero the day it ships
--
-- ⚠ THE TWO OUT-OF-SCOPE PROCEDURES ARE A PERMANENT SUPABASE ADVISOR WARN, and that
-- is worth stating because it is the thing a future reader will try to "fix": the
-- advisor's `function_search_path_mutable` reads count=2 naming exactly those two,
-- and it can never reach 0 — production has refused the pin three times (R14
-- 2026-08-22/23 WONTFIX; 20260914053000 -> 20260914055000 after pg_cron jobid 259
-- died in 0.5 s with 2D000; 20260918225909 -> 20260919002535). ⛔ Do NOT pin them.
-- With this guard installed the advisor is no longer the only instrument, and its
-- irreducible 2 is now the EXPECTED reading rather than an open finding.
--
-- REVERT:
--   DROP FUNCTION public.check_procedure_search_path_unpinned_drift();
--   -- and drop the single 'procedure_search_path_unpinned' line from rpc_ops_snapshot().

CREATE OR REPLACE FUNCTION public.check_procedure_search_path_unpinned_drift()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $function$
  WITH candidates AS (
    SELECT p.oid,
           p.proconfig,
           -- VERBATIM from check_procedure_transaction_control_pin_drift(). The two
           -- guards partition the same population and must classify it identically.
           regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'), '--[^\n]*', ' ', 'g') AS body
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       -- PROCEDURES only. Unpinned FUNCTIONS are check_function_search_path_drift().
       AND p.prokind = 'p'
       -- Not ours to ALTER.
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'kind', 'procedure_search_path_unpinned',
           'object_name', (c.oid::regprocedure)::text,
           'detail', 'This PROCEDURE in public does NO transaction control (no COMMIT or '
                  || 'ROLLBACK statement, comments excluded) and carries no search_path in '
                  || 'proconfig, so it resolves unqualified names against the CALLER''s '
                  || 'search_path. Unlike a COMMITting procedure, this one CAN be pinned '
                  || 'safely. Fix with ALTER PROCEDURE ... SET search_path = public, pg_temp '
                  || '— an ALTER, not a CREATE OR REPLACE, so only proconfig changes and no '
                  || 'body is rewritten. ⛔ If you are about to ADD transaction control to '
                  || 'this procedure instead, do NOT pin it: see '
                  || 'check_procedure_transaction_control_pin_drift(), which bans the pin in '
                  || 'that case, and pin nothing until the body is settled.'
         ) ORDER BY (c.oid::regprocedure)::text), '[]'::jsonb)
    FROM candidates c
   WHERE NOT (c.body ~* '\mcommit\M\s*;|\mrollback\M\s*;')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(c.proconfig, '{}'::text[])) cfg
        WHERE split_part(cfg, '=', 1) = 'search_path'
     );
$function$;

-- anon-exec: NOT intentional for check_procedure_search_path_unpinned_drift — ops-only guard, revoked on the next line.
REVOKE EXECUTE ON FUNCTION public.check_procedure_search_path_unpinned_drift() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_procedure_search_path_unpinned_drift() TO postgres, service_role;

COMMENT ON FUNCTION public.check_procedure_search_path_unpinned_drift() IS
  'Ban at zero: a PROCEDURE in public that does NO transaction control must pin search_path. '
  'The third arm of the search_path class and the last one nothing asserted — '
  'check_function_search_path_drift() excludes procedures outright, and '
  'check_procedure_transaction_control_pin_drift() only fires on a COMMITting procedure that IS '
  'pinned, so a non-COMMITting UNPINNED procedure was outside both (20260914190000 called it a '
  'named blind spot: "by hand, because nothing here will ask"). Scope is the SAME measured '
  'property as its sibling, comments stripped with the identical expression, so the two partition '
  'the population and cannot drift apart. Returns a jsonb ARRAY: clean is jsonb_array_length() = 0, '
  'NOT count(*) = 1. Population at install 2026-09-19: 3 procedures, 2 with transaction control '
  '(out of scope, and a PERMANENT advisor WARN that must NOT be "fixed"), 1 in scope, 0 unpinned.';

-- ── wire it into the reader ──────────────────────────────────────────────────
-- ⚠ GUARDED TRANSFORM of the LIVE definition, not a retyped body. rpc_ops_snapshot()
-- is a large shared SECURITY DEFINER function that concurrent sessions edit; a
-- full-body CREATE OR REPLACE written from a dump taken minutes ago silently reverts
-- whatever landed in between. This transforms whatever is actually live and RAISEs
-- unless the anchor matches EXACTLY ONCE, so it cannot clobber an edit it did not
-- anticipate and cannot mis-transcribe 6 KB of body.
-- Live at authoring time: 6277 chars, md5 9b69de095d13de2abc5e295779feaa2d, 22 keys.
--
-- anon-exec: unchanged for rpc_ops_snapshot — a REPLACE of an existing function, and
-- CREATE OR REPLACE does not reset an ACL, so a revoke here would CHANGE production
-- while presenting itself as a wiring-only edit.
DO $mig$
DECLARE
  v_def     text;
  v_anchor  text := $a$    'procedure_txn_control_pins', public.check_procedure_transaction_control_pin_drift(),$a$;
  v_add     text := $a$    -- Added 2026-09-19. The THIRD arm of the same class, same jsonb-ARRAY
    -- reading. Arm A above flags a FUNCTION missing a pin; the line above flags a
    -- PROCEDURE that must NOT have one; this flags a PROCEDURE that may and should.
    'procedure_search_path_unpinned', public.check_procedure_search_path_unpinned_drift(),$a$;
  v_hits    int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
   WHERE p.proname = 'rpc_ops_snapshot' AND p.pronamespace = 'public'::regnamespace;
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'rpc_ops_snapshot() not found — refusing to guess at its body';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'anchor matched % times, expected exactly 1 — the live body moved; re-read it', v_hits;
  END IF;
  IF position('procedure_search_path_unpinned' in v_def) > 0 THEN
    RAISE EXCEPTION 'rpc_ops_snapshot() already carries the key — refusing to double-wire';
  END IF;

  EXECUTE replace(v_def, v_anchor, v_anchor || E'\n' || v_add);
END
$mig$;

-- ── verification, same migration ─────────────────────────────────────────────
DO $verify$
DECLARE
  v_procs     int;
  v_txn       int;
  v_in_scope  int;
  v_pinned_in_scope int;
  v          jsonb;
  v_keys_before text[] := ARRAY[
    'generated_at','db_size_mb','security','stalled_pipelines',
    'suppression_parked_claim_drift','backward_cursor_rewinds',
    'function_search_path_drift','procedure_txn_control_pins','pipeline_alerts',
    'pipeline_fails_24h','trust_health','trust_health_breaches',
    'sentinel_ts_uuid_editions_48h','editions_by_collection','fmv_by_collection',
    'cross_collection_mat_staleness'
  ];
  k text;
BEGIN
  WITH c AS (
    SELECT regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'), '--[^\n]*', ' ', 'g') AS body,
           p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname='public' AND p.prokind='p'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')
  )
  SELECT count(*),
         count(*) FILTER (WHERE body ~* '\mcommit\M\s*;|\mrollback\M\s*;'),
         count(*) FILTER (WHERE NOT (body ~* '\mcommit\M\s*;|\mrollback\M\s*;')),
         count(*) FILTER (WHERE NOT (body ~* '\mcommit\M\s*;|\mrollback\M\s*;')
                            AND EXISTS (SELECT 1 FROM unnest(COALESCE(proconfig,'{}'::text[])) cfg
                                         WHERE split_part(cfg,'=',1)='search_path'))
    INTO v_procs, v_txn, v_in_scope, v_pinned_in_scope
    FROM c;

  -- ASSERT THE COUNT THE GUARD INSPECTED, not merely that it passed. A collapse to
  -- an empty population reads IDENTICALLY to a clean one.
  IF v_procs < 3 THEN
    RAISE EXCEPTION 'inspected % public procedures, expected >= 3 — wrong population', v_procs;
  END IF;
  IF v_in_scope < 1 THEN
    RAISE EXCEPTION 'guard is VACUOUS: % procedures in scope. Every procedure was classified as '
                    'doing transaction control, which is how a raw (un-stripped) match fails.', v_in_scope;
  END IF;

  -- POSITIVE CONTROL for the PIN half, on the dimension the guard keys on: at least
  -- one in-scope procedure must actually BE pinned. If none were, "0 violations"
  -- could equally mean the proconfig test never matches anything.
  IF v_pinned_in_scope < 1 THEN
    RAISE EXCEPTION 'no in-scope procedure is pinned — the proconfig test is unproven, so a 0 here is not evidence';
  END IF;

  IF jsonb_array_length(public.check_procedure_search_path_unpinned_drift()) <> 0 THEN
    RAISE EXCEPTION 'unpinned non-transactional procedures at install: %',
      public.check_procedure_search_path_unpinned_drift()::text;
  END IF;

  -- The two guards must PARTITION the population: in scope here == out of scope there.
  IF v_txn + v_in_scope <> v_procs THEN
    RAISE EXCEPTION 'the two guards do not partition: % txn + % in-scope <> % total', v_txn, v_in_scope, v_procs;
  END IF;

  -- The snapshot kept every key it had and gained exactly the one.
  SELECT jsonb_object_agg(q.key, 'x') INTO v
    FROM (SELECT m[1] AS key
            FROM pg_proc p
            CROSS JOIN LATERAL regexp_matches(pg_get_functiondef(p.oid),
                                              E'^\\s*''([a-z0-9_]+)'',', 'gn') m
           WHERE p.proname='rpc_ops_snapshot'
             AND p.pronamespace='public'::regnamespace) q;
  IF v IS NULL THEN
    RAISE EXCEPTION 'could not read back the snapshot key list';
  END IF;
  FOREACH k IN ARRAY v_keys_before LOOP
    IF NOT (v ? k) THEN
      RAISE EXCEPTION 'the wire-in LOST key %', k;
    END IF;
  END LOOP;
  IF NOT (v ? 'procedure_search_path_unpinned') THEN
    RAISE EXCEPTION 'the wire-in did not add the key';
  END IF;
END
$verify$;
