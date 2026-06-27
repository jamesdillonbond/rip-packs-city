# Claude Code handoff — CI gate + smoke hardening + cron reconciliation (2026-05-30)

Plain text, no code fences (iPhone copy-paste). Full-file edits, not diffs. Direct to main, no branches/PRs.

CONTEXT
Cowork shipped live this session: none (DB untouched). Cowork built four ops assets (3 skills + 4 artifacts incl. rpc-security-drift) and corrected the rpc-weekly-health-check scheduled task's §7 query. This handoff is the route/CI/docs work Cowork can't push. HEAD at write time: 50be23e (READY). Skim docs/overnight/ledger.md first; nothing here collides with queued items Q1/Q2.

Three items. 1 and 3 are low-risk and independent. 2 has a DB step (2a) and a route step (2b) — Cowork can ship 2a live instead if Trevor prefers (then skip 2a).

----------------------------------------------------------------
ITEM 1 — Make the Cadence lint CI job a real gate (only if it passes)
----------------------------------------------------------------
File: .github/workflows/ci.yml
Why: the cadence-lint job runs with continue-on-error: true, so it can never block a broken Cadence harness from reaching main. The ci.yml comment says to remove that line "once a real run confirms npm run test:cadence exits 0." docs/cadence-testing.md still calls the harness "RED on purpose" and is stale (it predates the C1/C2 fix).
Steps:
  1. Run npm run test:cadence locally (or trigger the CI job via workflow_dispatch) and confirm it exits 0.
  2. ONLY IF it exits 0: in ci.yml, delete the line "continue-on-error: true" under the cadence-lint job so it becomes blocking. Leave the typecheck job as-is (already blocking).
  3. If it does NOT exit 0: do not flip it. Instead open a one-line note in docs/cadence-testing.md with the actual failure and leave continue-on-error in place.
  4. Update docs/cadence-testing.md: remove the stale "RED on purpose" framing; state the harness is green-and-gating (or red-with-reason).
Revert: re-add "continue-on-error: true" to the cadence-lint job.
Verify: push to main; the CI run shows Cadence lint as a required, passing check; tsc job still green (~59s).

----------------------------------------------------------------
ITEM 2 — Add a hard security invariant to the smoke test (RLS + anon-write on base tables)
----------------------------------------------------------------
Why: app/api/smoke-test/route.ts already added a SECDEF-function guard today ("anon has no EXECUTE on destructive SECDEF functions", ~lines 573-595, calling rpc check_secdef_anon_execute_violations). The parallel invariants — no public BASE TABLE with RLS off, and no anon/authenticated write grant on an RLS-off base table — are still unguarded. Both are clean right now (Cowork verified 0 and 0 on 2026-05-30), so the assertion passes today and only fires on a real future regression. NOTE: do NOT assert on SECDEF views — 8 exist by design (3 are currently Supabase-ERROR by design for public /insights), so a view assertion would fail the build. The rpc-security-drift Cowork artifact tracks view drift as informational instead.

2a — DB function (apply as a migration; supabase-js can't read pg_catalog directly, so the smoke test needs an RPC). This is a pure read-only inspection function, same shape as check_secdef_anon_execute_violations. Migration name suggestion: audit_20260530_check_public_security_invariants.
SQL:
  CREATE OR REPLACE FUNCTION public.check_public_security_invariants()
  RETURNS TABLE(kind text, object_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_catalog AS $func$
    SELECT 'rls_off_base_table'::text, t.tablename::text
    FROM pg_tables t
    WHERE t.schemaname='public' AND t.rowsecurity=false
    UNION ALL
    SELECT 'anon_write_base_table'::text, g.table_name::text
    FROM information_schema.role_table_grants g
    JOIN pg_class c ON c.relname=g.table_name AND c.relnamespace='public'::regnamespace
    WHERE g.table_schema='public'
      AND g.grantee IN ('anon','authenticated')
      AND g.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
      AND c.relrowsecurity=false
      AND c.relkind IN ('r','p');
  $func$;
  REVOKE EXECUTE ON FUNCTION public.check_public_security_invariants() FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.check_public_security_invariants() TO postgres, service_role;
Expected live result today: 0 rows. (The relkind IN ('r','p') filter is mandatory — without it ~49 public views false-positive because RLS doesn't govern views.)
Revert: DROP FUNCTION public.check_public_security_invariants();

2b — Route assertion in app/api/smoke-test/route.ts. Mirror the existing check_secdef_anon_execute_violations block (~lines 573-595): call svc.rpc("check_public_security_invariants"); the test passes when error is null AND (data ?? []).length === 0; on a non-empty result, fail with a detail listing kind:object_name pairs. Name it "public base tables: RLS on + no anon write". Keep it a hard (non-soft) check.
Revert: remove that test block.
Verify: npx tsc --noEmit clean; deploy READY; POST /api/smoke-test returns the new check passing; the daily noon smoke-tests workflow stays green.

----------------------------------------------------------------
ITEM 3 — Reconcile docs/operations/cron-schedule.md with live reality, then 2 manual cron-job.org actions
----------------------------------------------------------------
Why: the doc has stale "pending" items that are actually live, plus two real cleanups. Verified from pipeline_runs (48h): drain-fmv-cold-tail (89 runs) and pinnacle-listings-reconcile (185 runs) are BOTH already firing — so the doc's "Pending additions" for those are done.
CC (repo) — edit docs/operations/cron-schedule.md:
  - Move "FMV cold-tail drain" and "Pinnacle listings reconcile" out of "Pending additions" into Active (both confirmed live in pipeline_runs).
  - Update the "Last verified" date to today and note the FMV-recalc accelerate/dial-back status (see manual action below).
Trevor (cron-job.org dashboard — CC cannot touch external crons):
  - Dial back "RPC FMV Recalc Force Stale" from the temporary 3,13,23,33,43,53 (every 10 min) to 8,28,48 (every 20 min) — but FIRST confirm the first full FMV-recalc sweep is complete (NO_DATA count flat run-over-run; cursor wrapped). fmv-recalc has run 308x/48h with 0 fails and Top Shot NO_DATA has fallen, so the sweep is likely done — verify before dialing back.
  - Confirm there is only ONE wmc-fmv-populate cron firing. The doc flags a possible duplicate (a Supabase edge-function URL entry + the Vercel route entry). Keep the Vercel route /api/wmc-fmv-populate; delete the edge-function URL entry if it exists. (No edge function named wmc-fmv-populate is currently deployed, so this may already be resolved — just verify the dashboard.)
Revert: git revert the doc commit; re-add the cron entries in the dashboard if needed.

----------------------------------------------------------------
GUARDRAILS (every item)
----------------------------------------------------------------
- Work on main. If a claude/* branch is pre-checked-out, switch to main first. No PRs.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). After push, confirm git rev-list --count origin/main..HEAD returns 0.
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest if you redeploy manually.
- Vercel Pro maxDuration hard cap is 800s — never set higher (silent ERROR deploy).
- CRLF: full-file writes, not string-replace patches.
- Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape (e.g. confirm the exact line numbers of the SECDEF guard block before inserting 2b next to it).

EXPECTED END STATE
One commit on main: ci.yml gates Cadence (if green), smoke-test asserts the RLS/anon-write base-table invariant (backed by the new RPC), and cron-schedule.md matches reality. Deploy READY, tsc clean, smoke green. Two manual cron-job.org tweaks done by Trevor.
