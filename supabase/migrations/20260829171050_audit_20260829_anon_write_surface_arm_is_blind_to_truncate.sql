-- audit_20260829_anon_write_surface_arm_is_blind_to_truncate
--
-- Metadata only. Installs the FIRST comment on public.check_anon_write_surface()
-- (it had none). No signature change, no grants, no behaviour, no data.
--
-- REVERT (restores the exact pre-migration state -- the function carried NO comment):
--   COMMENT ON FUNCTION public.check_anon_write_surface() IS NULL;

DO $mig$
DECLARE v_oid oid; v_new text; v_read text;
BEGIN
  SET LOCAL lock_timeout = '5s';

  SELECT p.oid INTO v_oid
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'check_anon_write_surface'
    AND pg_get_function_identity_arguments(p.oid) = '';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRE-STATE FAILED: public.check_anon_write_surface() not found';
  END IF;

  IF obj_description(v_oid, 'pg_proc') IS NOT NULL THEN
    RAISE EXCEPTION
      'PRE-STATE FAILED: this function already carries a comment (% chars) -- '
      'this migration only installs a FIRST comment and will not clobber one',
      length(obj_description(v_oid, 'pg_proc'));
  END IF;

  v_new :=
'WHAT THIS ARM CAN AND CANNOT SEE. Read this before quoting "check_anon_write_surface() = 0 rows"
as evidence that the anon write posture is clean. Zero rows is the CLEAN reading for this arm
(unlike check_secdef_anon_execute_violations(), which returns ONE ROW CONTAINING AN ARRAY and so
reads count 1 when clean -- read that one''s VALUE and check it is []).

=== 2026-08-29 17:1xZ (10:1x PT) -- MEASURED BLIND SPOT: TRUNCATE ===

This arm filters privilege_type IN (''INSERT'',''UPDATE'',''DELETE'') and then requires a PERMISSIVE
RLS policy on the same table before it will report anything. TRUNCATE is in neither test, and those
are TWO INDEPENDENT reasons it can never see a TRUNCATE grant:
  (1) TRUNCATE is not in the privilege list, and
  (2) TRUNCATE IS NOT GOVERNED BY RLS AT ALL, so the policy join is the wrong backstop for it.

MEASURED 2026-08-29 17:09Z over 379 public base tables (pg_class.relkind IN (''r'',''p'')), while
this arm returned 0 rows:
    anon holds TRUNCATE on  146 tables
    anon holds INSERT   on   19
    anon holds UPDATE   on   13
    anon holds DELETE   on   13
    anon holds TRIGGER  on  165
The DML numbers are small because they were deliberately narrowed. The TRUNCATE number is not.
Among the 146: sales, sales_2026, sales_2025, editions, collections, wallet_moments_cache,
pack_rips, pipeline_runs, user_wishlists. Read the ACL directly to confirm -- pg_class.relacl on
public.sales_2026 reads anon=rDxtm/postgres, where D is TRUNCATE and m is MAINTAIN.

WHERE THE RESIDUE COMES FROM, AND THE ONE SENTENCE IN THE LEDGER THAT IS WRONG. The 2026-06-24 /
2026-06-28 entries fixed this GOING FORWARD -- ALTER DEFAULT PRIVILEGES now leaves a new
postgres-created table with anon SELECT/REFERENCES/MAINTAIN only -- and swept 55 existing VIEWS.
They deliberately left the existing BASE TABLES, on this recorded rationale: "base TABLES untouched
-- RLS backstops their write grants". THAT RATIONALE IS TRUE FOR INSERT/UPDATE/DELETE AND FALSE FOR
TRUNCATE. So the 146 are pre-June residue that the stated backstop does not actually cover, and this
arm is the instrument that would have to notice -- and structurally cannot.

*** THIS IS A LATENT MISCONFIGURATION TODAY, NOT AN OPEN HOLE. SAY IT THAT WAY. ***
Measured in the same minute: ZERO anon-executable functions in schema public contain a TRUNCATE in
prosrc (pg_proc where has_function_privilege(''anon'', oid, ''EXECUTE'') and prosrc ~* ''\mtruncate\M''
=> empty), and PostgREST does not emit TRUNCATE -- it exposes SELECT/INSERT/UPDATE/DELETE and RPC.
check_secdef_anon_execute_violations() reads [] the same minute. So there is no reachable path from
an anonymous caller to a TRUNCATE right now. What is missing is the DEFENCE IN DEPTH: the only thing
standing between the grant and a wipe of public.sales is a property of today''s function set, which
is re-established every time someone adds a function -- and CLAUDE.md''s own rule records how easily
that slips (CREATE OR REPLACE FUNCTION with a changed signature creates a NEW overload with default
PUBLIC EXECUTE, silently re-granting what a prior REVOKE removed).

THE FIX IS QUEUED, NOT SHIPPED, AND DELIBERATELY SO. A 146-table REVOKE crosses a scope boundary the
ledger records as a deliberate decision taken with Trevor''s explicit "Proceed", so it is not a
Cowork self-approval even though its rationale is refuted for TRUNCATE. The scoped statement, for
whoever takes it:
    REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon;
    -- revert: GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO anon;
It cannot break the June carve-outs by construction: those are anon-INSERT paths
(email_subscribers, outbound_clicks, portfolio_snapshots, support_conversations) and none of them
truncates. Verify after: the anon TRUNCATE count above must read 0, and the public boards must still
render for an anonymous caller (a broken read path fails by returning NOTHING, so a clean invariant
alone is not evidence).

=== IF YOU EXTEND THIS ARM RATHER THAN REVOKING ===
Adding TRUNCATE to the privilege list ALONE will not work: the pg_policies join would still filter
every row away. A TRUNCATE check has to bypass the policy join entirely, because there is no such
thing as a TRUNCATE policy. And be aware that making this arm see the 146 flips it from 0 rows to
146 in one step, which every downstream reader treats as an incident -- revoke first, then extend.';

  EXECUTE format('COMMENT ON FUNCTION public.check_anon_write_surface() IS %L', v_new);

  -- Post-state readback inside the same transaction.
  v_read := obj_description(v_oid, 'pg_proc');
  IF v_read IS NULL OR v_read <> v_new THEN
    RAISE EXCEPTION 'POST-STATE FAILED: comment readback does not match what was written';
  END IF;
END
$mig$;
