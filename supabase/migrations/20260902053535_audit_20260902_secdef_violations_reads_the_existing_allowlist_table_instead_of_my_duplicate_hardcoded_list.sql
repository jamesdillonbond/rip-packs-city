-- audit_20260902_secdef_violations_reads_the_existing_allowlist_table_instead_of_my_duplicate_hardcoded_list
-- anon-exec: check_secdef_anon_execute_violations — SECURITY DEFINER, unchanged signature and ACL.
--
-- ⛔⛔ A CORRECTION TO THE MIGRATION I APPLIED 18 MINUTES AGO. `20260902051740` rewrote this guard from
-- a nine-name allowlist into a tree walk — correctly — and then carried its own **hardcoded**
-- suppression list. **That duplicated a function this database has had since 2026-07-21:**
-- `check_secdef_anon_exec_drift()`, which walks the same population and subtracts
-- `public.secdef_anon_exec_allowlist` — a TABLE.
--
-- ⭐ I found the duplicate by running a one-line census of `check_*` functions **after** building mine.
-- Running it FIRST would have answered the question in seconds. The standing rule *"name the caller
-- before you touch the function"* has a sibling: **check whether the thing you are about to build
-- already exists.**
--
-- THE TABLE IS BETTER THAN MY LITERAL, in four specific ways, and this is why the correction is worth
-- a migration rather than a shrug:
--   1. It is operator-editable **without a migration**.
--   2. Each row carries a `note` and an `approved_at`, so a suppression is an auditable DECISION.
--   3. Its notes are better-researched than mine. Mine called `serial_fmv_estimate` a "public pricing
--      calculator". The table records the actual reason: it is reached **INDIRECTLY** through the
--      SECURITY INVOKER function `get_wallet_moments_with_fmv` and the anon-SELECTable
--      security_invoker view `topshot_underpriced_serials_board` — *"an invoker caller executes the
--      callee AS THE CALLER, so revoking breaks the wallet-moments read and the public board."*
--      **I had suppressed it without knowing why the grant was needed.**
--   4. It is RLS-protected with **no anon/authenticated SELECT or INSERT** (verified), so the guard
--      cannot be disarmed by the roles it watches — a property a literal in the body cannot have, but
--      also cannot lose.
--
-- ⚠ MATCHING IS ON `oid::regprocedure` — type names, NO parameter names — because that is the form the
-- allowlist stores (`serial_fmv_estimate(uuid,integer,integer,text,numeric,text)`).
-- `pg_get_function_identity_arguments` includes parameter names and does NOT match.
--
-- POST-STATE adds a CROSS-INSTRUMENT CONTROL that did not exist before: the two guards now share a
-- population and an allowlist, so they must return the same count. Disagreement means one is looking
-- somewhere the other is not — which is the failure that started this. It also refuses if the
-- allowlist holds more entries than there are reachable rows, so a stale suppression cannot rot.
--
-- 👉 FOLLOW-UP for whoever wants it: two functions still do this job. Retiring
-- `check_secdef_anon_execute_violations` in favour of the drift function means repointing
-- `rpc_ops_snapshot` and `app/api/smoke-test` (which reads the `function` key, while drift returns
-- `identity`). Left alone here — the duplicate LOGIC is gone, which was the defect; the duplicate
-- NAME is cosmetic and its consumers are load-bearing.
--
-- REVERT: re-apply 20260902051740's body (the hardcoded VALUES list). ⛔ Do not — it re-forks the
-- suppression list from the table that four other rows of evidence live in.

CREATE OR REPLACE FUNCTION public.check_secdef_anon_execute_violations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Every public SECURITY DEFINER function anon or authenticated can EXECUTE, minus
  -- public.secdef_anon_exec_allowlist.
  --
  -- ⚠ THE SUPPRESSION LIST IS A TABLE, NOT A LITERAL, and that is deliberate. It
  -- carries a `note` (which caller needs the grant, and why) and an `approved_at`,
  -- it is operator-editable without a migration, and it is RLS-protected with no
  -- anon/authenticated SELECT or INSERT — so the guard cannot be disarmed by the
  -- roles it is watching.
  --
  -- ⛔ HISTORY, because it explains why this function exists at all: it used to
  -- iterate NINE hardcoded function names and was blind to the other 550. It was
  -- rewritten as a tree walk earlier today — with a hardcoded suppression list,
  -- which duplicated `check_secdef_anon_exec_drift()`, a function that has done the
  -- walk against this very table since 2026-07-21. This version keeps the consumer
  -- contract (`function` key, jsonb array, [] is clean) and drops the duplicate.
  --
  -- ⚠ Matching is on `oid::regprocedure` — TYPE names, no parameter names — because
  -- that is the form the allowlist stores. `pg_get_function_identity_arguments`
  -- includes parameter names and will NOT match.
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'function', v.proname,
        'args', v.args,
        'anon', v.anon,
        'authenticated', v.authenticated
      )
      ORDER BY v.proname, v.args
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT p.proname::text AS proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           (p.oid::regprocedure)::text AS ident,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )
  ) v
  WHERE v.ident NOT IN (SELECT identity FROM public.secdef_anon_exec_allowlist);
$function$;

COMMENT ON FUNCTION public.check_secdef_anon_execute_violations() IS
  'Every public SECURITY DEFINER function that anon or authenticated can EXECUTE, minus '
  'public.secdef_anon_exec_allowlist. Returns a jsonb ARRAY — read its LENGTH; [] is clean. '
  '⚠ REWRITTEN 2026-09-02, TWICE. It first iterated NINE hardcoded function names and was structurally '
  'blind to the other 550 SECDEF functions — reporting 0 violations while four anon/auth-executable '
  'rows existed that it never looked at, which rpc_ops_snapshot published as the schema''s security '
  'state and the smoke test hard-passed on. It was then rewritten as a tree walk with a hardcoded '
  'suppression list, which DUPLICATED check_secdef_anon_exec_drift() — a function that has walked the '
  'same population against the same allowlist TABLE since 2026-07-21. This version reads the table. '
  '👉 Two lessons, in order: prefer a TREE WALK over a curated list and make SUPPRESSION the curated '
  'list — and CHECK WHETHER THE GUARD ALREADY EXISTS before writing it, which a one-line census of '
  'check_* functions would have answered in seconds. '
  '⛔ Suppression entries belong in the TABLE, with a note naming the caller that needs the grant and '
  'why. The table is RLS-protected with no anon/authenticated SELECT or INSERT, so the guard cannot be '
  'disarmed by the roles it watches. '
  '⚠ Matching is on oid::regprocedure (type names, no parameter names) — the form the allowlist stores. '
  'Consumers: rpc_ops_snapshot (security.secdef_anon_violations) and app/api/smoke-test, which '
  'hard-fails + Sentry-alerts on a non-empty array and reads the `function` key.';

DO $mig$
DECLARE
  v_res jsonb;
  v_drift jsonb;
  v_pop int;
  v_exposed int;
  v_allow int;
  v_covered int;
BEGIN
  v_res := public.check_secdef_anon_execute_violations();
  v_drift := public.check_secdef_anon_exec_drift();

  IF jsonb_typeof(v_res) <> 'array' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: must return a jsonb ARRAY, got %', jsonb_typeof(v_res);
  END IF;
  IF jsonb_array_length(v_res) <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: not clean — %', v_res::text;
  END IF;

  -- CROSS-INSTRUMENT CONTROL: the two guards now share a population and an allowlist, so they must
  -- agree. Disagreement means one of them is looking somewhere the other is not — which is exactly
  -- the failure that started this.
  IF jsonb_array_length(v_drift) <> jsonb_array_length(v_res) THEN
    RAISE EXCEPTION 'POST-STATE FAILED: drift says % violations, violations says % — they must agree',
      jsonb_array_length(v_drift), jsonb_array_length(v_res);
  END IF;

  -- NON-VACUITY: the walk must inspect a real population, and the allowlist must be what removes the
  -- reachable rows rather than the walk simply missing them.
  SELECT count(*) INTO v_pop
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef;
  IF v_pop < 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: only % SECDEF functions seen', v_pop;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE (p.oid::regprocedure)::text IN (SELECT identity FROM public.secdef_anon_exec_allowlist))
    INTO v_exposed, v_covered
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  IF v_exposed = 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: no reachable SECDEF functions at all — the allowlist would be untested';
  END IF;
  IF v_covered <> v_exposed THEN
    RAISE EXCEPTION 'POST-STATE FAILED: % of % reachable rows are NOT in the allowlist', v_exposed - v_covered, v_exposed;
  END IF;

  SELECT count(*) INTO v_allow FROM public.secdef_anon_exec_allowlist;
  IF v_allow <> v_exposed THEN
    RAISE EXCEPTION 'POST-STATE FAILED: allowlist holds % entries but only % are reachable — a stale entry is rotting', v_allow, v_exposed;
  END IF;

  RAISE NOTICE 'post-state ok: % SECDEF fns walked, % reachable, all % in the allowlist, both guards agree on 0',
    v_pop, v_exposed, v_allow;
END
$mig$;
