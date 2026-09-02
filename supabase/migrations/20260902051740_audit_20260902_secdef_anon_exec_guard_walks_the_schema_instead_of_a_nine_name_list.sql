-- audit_20260902_secdef_anon_exec_guard_walks_the_schema_instead_of_a_nine_name_list
-- anon-exec: check_secdef_anon_execute_violations — SECURITY DEFINER, unchanged signature and ACL
-- (CREATE OR REPLACE preserves it). This function is the guard ITSELF; its own exposure is unchanged.
--
-- 🚨 THE GUARD THAT WATCHES FOR ANON-EXECUTABLE SECURITY DEFINER FUNCTIONS WAS LOOKING AT NINE
-- HARDCODED NAMES, AND THE SCHEMA HAS 559 SECDEF FUNCTIONS.
--
-- It was structurally blind to every SECDEF function outside that list — including every one created
-- after it was written, which is every one created in the last three months. It returned `[]`,
-- `rpc_ops_snapshot` published that as `security.secdef_anon_violations`, the smoke test hard-passed
-- on it and would have Sentry-alerted on anything else, and the daytime monitor's health line read
-- "security 0/0/0/0".
--
-- ⭐ **Found by asking a DIFFERENT instrument the same question.** Supabase's own advisor reports
-- `anon_security_definer_function_executable` ×3 and `authenticated_…` ×4. The in-repo guard reported
-- zero. Two instruments, same question, opposite answers — and the one that was wrong was ours.
--
-- ⛔ NOTHING IS ACTUALLY EXPOSED. All four reachable rows are deliberate, and each was read before
-- being suppressed rather than assumed:
--   • `get_trophy_slab_data_by_username(text)` — resolves `profile_bio.username` → user_id and returns
--     `get_trophy_slab_data()`. A public profile page must be callable by anon.
--   • `serial_fmv_estimate(...)` ×2 overloads — the serial-premium calculator behind the public
--     insights boards; reads the pooled market model and edition/player metadata, no user-scoped data.
--   • `get_my_fan_teams()` — **authenticated only, anon has no EXECUTE**, and the body scopes itself
--     with `WHERE uft.user_id = auth.uid()`, so SECDEF bypassing RLS does not widen what a caller
--     sees. That predicate is WHY it is suppressed; if it is ever removed the entry is wrong.
--
-- THE CHANGE: a TREE WALK with a curated SUPPRESSION list, which is CLAUDE.md's own rule —
-- *"prefer a tree walk over a curated list and a ban at zero over an allowlist; make SUPPRESSION the
-- curated list."* The nine names it used to iterate are all still locked down; they are no longer
-- listed because the walk covers them.
--
-- ⚠ SUPPRESSION IS KEYED ON THE FULL SIGNATURE, not the name, so a NEW OVERLOAD of a deliberately
-- public function is reviewed rather than inherited. `args` is added to the output for the same
-- reason: a name alone cannot identify an overload, and this guard now sees them.
--
-- ⚠⚠ AND THE FIRST APPLY FAILED, WHICH IS THE BEST EVIDENCE THE OLD GUARD WAS BLIND. I built the
-- suppression list from the three functions the ADVISOR named and the post-state rejected it: the walk
-- returned a fourth, `get_my_fan_teams`, which is authenticated-only and which I had skipped while
-- reading for anon. **Build a suppression list from the WALK'S OWN OUTPUT, never from your reading of
-- another instrument's summary.** The migration aborted transactionally; nothing partially applied.
--
-- NON-VACUITY, asserted rather than assumed: the post-state requires the walk to see ≥50 SECDEF
-- functions (it sees 559) — a rewrite that inspected nothing would also return `[]` and look perfect —
-- and requires EXACTLY 4 reachable rows, so a stale suppression entry cannot rot in silence.
--
-- PROOF THE SUPPRESSION IS WHAT REMOVES THEM, run read-only after applying: the same walk with the
-- suppression list dropped returns exactly those four rows, in that order.
--
-- CONSUMERS: `rpc_ops_snapshot` (`security.secdef_anon_violations`) and `app/api/smoke-test`, which
-- hard-fails + Sentry-alerts on a non-empty array and reads the `function` key. Both keep working —
-- the return shape is the same jsonb array of objects, with `args` added alongside.
--
-- REVERT: re-apply the previous body (the nine-name `p.proname = ANY(ARRAY[...])` version). ⛔ Do not,
-- except to unbreak something: it would restore a guard that inspects 9 of 559 functions and reports
-- a zero that means almost nothing.

CREATE OR REPLACE FUNCTION public.check_secdef_anon_execute_violations()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- ⚠ THIS WALKS THE SCHEMA. It used to iterate a hardcoded list of NINE function
  -- names, which made it structurally blind to every SECURITY DEFINER function
  -- outside that list — including every one created after it was written. It
  -- reported "0 violations" while FOUR anon/authenticated-executable SECDEF rows
  -- existed that it never looked at, and rpc_ops_snapshot published that zero as
  -- the schema's security state.
  --
  -- The repo's own standing rule: prefer a TREE WALK over a curated list, and make
  -- SUPPRESSION the curated list. That is what this is now.
  --
  -- ⓘ The nine it originally named — refresh_cross_collection_cohort_step1/step2,
  -- close_expired_cached_listings, activate_pro_from_payment, save_user_wallet,
  -- upsert_wallet_moments, classify_acquisition, query_sql, pinnacle_upsert_nft_map
  -- — are all still locked down. They are no longer LISTED because the walk covers
  -- them; nothing about their status changed.
  WITH deliberate(sig, why) AS (
    VALUES
      -- Public trophy page keyed by username: resolves profile_bio.username to a
      -- user_id and returns get_trophy_slab_data(). An anon visitor to a public
      -- profile must be able to call it.
      ('get_trophy_slab_data_by_username(p_username text)',
       'public profile surface — anon must read it'),
      -- The serial-premium calculator behind the public insights boards. Reads the
      -- pooled market model and edition/player metadata; no user-scoped data.
      ('serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text, p_edition_fmv numeric, p_confidence text)',
       'public pricing calculator — market model only'),
      ('serial_fmv_estimate(p_collection_id uuid, p_serial integer, p_circulation integer, p_tier text, p_edition_fmv numeric, p_confidence text, p_jersey_number integer)',
       'public pricing calculator — market model only, jersey overload'),
      -- authenticated ONLY (anon has no EXECUTE), and the body scopes itself with
      -- `WHERE uft.user_id = auth.uid()`, so SECDEF bypassing RLS does not widen
      -- what a caller can see. That predicate is the reason it is suppressed — if
      -- it is ever removed this entry is wrong.
      ('get_my_fan_teams()',
       'per-caller: filters on auth.uid(), anon has no EXECUTE')
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'function', v.proname,
        -- Additive: an overload is not identifiable by name alone, and this guard
        -- now sees overloads. Existing readers key on `function` and are unaffected.
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
           p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
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
  -- Suppression is by FULL SIGNATURE, not by name: a new overload of a deliberately
  -- public function is a new decision and must be reviewed, not inherited.
  WHERE v.sig NOT IN (SELECT sig FROM deliberate);
$function$;

COMMENT ON FUNCTION public.check_secdef_anon_execute_violations() IS
  'Every public SECURITY DEFINER function that anon or authenticated can EXECUTE, minus a curated '
  'SUPPRESSION list of the four deliberately-reachable ones. Returns a jsonb ARRAY — read its LENGTH; '
  '[] is clean. '
  '⚠ REWRITTEN 2026-09-02 FROM A NINE-NAME ALLOWLIST TO A TREE WALK. The old version iterated nine '
  'hardcoded function names and was therefore structurally blind to everything else, including every '
  'function created after it was written. It reported 0 violations while FOUR anon/auth-executable '
  'SECDEF rows existed that it never looked at — and rpc_ops_snapshot published that zero as the '
  'schema''s security state, and the smoke test passed on it. '
  '👉 The rule this now follows, from CLAUDE.md: prefer a TREE WALK over a curated list, and make '
  'SUPPRESSION the curated list. '
  '⛔ Adding an entry to the suppression list is a SECURITY DECISION: it needs a reason in the VALUES '
  'row saying why the role may call it, and it is keyed by FULL SIGNATURE so a new overload of a public '
  'function is reviewed rather than inherited. '
  'Consumers: rpc_ops_snapshot (security.secdef_anon_violations) and the smoke test, which hard-fails '
  'and Sentry-alerts on a non-empty array and reads the `function` key. `args` was added alongside it '
  'because a name alone cannot identify an overload.';

DO $mig$
DECLARE
  v_res jsonb;
  v_pop int;
  v_exposed int;
BEGIN
  v_res := public.check_secdef_anon_execute_violations();

  IF jsonb_typeof(v_res) <> 'array' THEN
    RAISE EXCEPTION 'POST-STATE FAILED: the guard must return a jsonb ARRAY, got %', jsonb_typeof(v_res);
  END IF;

  IF jsonb_array_length(v_res) <> 0 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: guard is not clean — %', v_res::text;
  END IF;

  -- ⛔ NON-VACUITY, and this is the assertion that matters most: the walk must actually INSPECT a
  -- population. A rewrite that looked at nothing would also return [] and look perfect.
  SELECT count(*) INTO v_pop
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef;
  IF v_pop < 50 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: only % SECDEF functions found — the walk is not seeing the schema', v_pop;
  END IF;

  -- The suppression list must be EARNING its keep: if it suppresses nothing, the entries are stale
  -- and should be deleted rather than left to rot. Exactly 4 rows are reachable today.
  SELECT count(*) INTO v_exposed
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  IF v_exposed <> 4 THEN
    RAISE EXCEPTION 'POST-STATE FAILED: expected exactly 4 anon/auth-executable SECDEF rows, found % — re-derive the suppression list before shipping', v_exposed;
  END IF;

  RAISE NOTICE 'post-state ok: walk sees % SECDEF functions, % reachable by anon/authenticated, all four suppressed with a stated reason, 0 violations',
    v_pop, v_exposed;
END
$mig$;
