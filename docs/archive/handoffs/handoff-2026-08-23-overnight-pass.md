# Overnight autonomous pass — 2026-08-23 (~01:1x PT)

> ⚠ **Scope of the NO-PUSH blocker:** this was a **cloud Cowork session** whose `remote.origin.pushurl` is empty, so `git push` is unavailable. **This is a fact about this cloud session only — Trevor's machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. Commit the file below as usual.** DB migrations applied live via the Supabase MCP (they do not go through git); the migration file is mirrored to the mount UNCOMMITTED.

**Mode:** genuine overnight (sandbox `date -u` 08:02:20Z vs DB `now()` 08:02:33Z → 13s drift, not skewed; real local ~01:02 PT). Lock taken and released on the mount. Last night (08-22) shipped 0, so no post-ship regression to watch — except that tonight's ship is itself the remediation of a 08-22 ship (R14).

## Health-drift findings

- **Security: clean 3/3.** `check_secdef_anon_exec_drift` `[]`, `check_public_security_invariants` 0 rows, no public base table with RLS off, no anon/authenticated write grant on an RLS-off base table.
  - Note: the 05:10Z inbox finding (RLS invariant red on `series_detail_rollup`) is **already resolved** — a prior session enabled RLS on that table between 05:10Z and this run. Invariant back to 0 rows. Nothing to do.
- **Pipelines:** all high-severity failure-rate alerts are saturation-class (`canceling statement due to statement timeout` / `upstream request timeout` / `connection pool`) — the known structural disk-IO-budget root cause. The one non-saturation high-sev is `topshot-active-listings-ingest` (`egress_blocked`, atlas-proxy operator item). `apply-fmv-haircut` cron-silent >24h is the long-standing dead cron since 2026-05-11 (known, not new).
- **Sentry:** 0 new issues/24h — **but** the 08-23 0250Z inbox finding reports ingestion has been dark since 08-18, so "0 new" is likely an instrument-silence artifact, not proof of no errors. QUEUED (needs config/route work).
- **Cross-collection mats:** still stale (rpc-ccm-step1/2 timing out since 08-18). QUEUED night 4.

## SHIPPED (1 — DB migration; within the 4-cap)

### R14 regression-revert: RESET search_path on two COMMIT-ing procedures

- **Migration:** `20260823081000_audit_20260823_reset_searchpath_on_commit_procedures` (applied via Supabase MCP `apply_migration`, project `bxcqstmqfzmuolpuynti`). File mirrored to `supabase/migrations/` on the mount, UNCOMMITTED.
- **Root cause:** R14 (`20260823021500`, 2026-08-22) attached `SET search_path = public` to `reconcile_all_saved_wallet_stats(int,int,int)` and `rpc_trust_health_precompute_refresh_p()`. Both are PROCEDURES doing per-wallet `COMMIT`; an attached SET clause makes `COMMIT` raise `2D000 invalid transaction termination`. `reconcile-saved-wallet-stats` (pg_cron jobid 259, :44 hourly) failed every tick from ~02:15Z (04:44–07:44 all confirmed 2D000 at `line 30 at COMMIT`), freezing saved-wallet dashboard/profile/share cards. The 08-10 ledger already recorded that these procedures must carry NO SET clause; R14's 08-15 "verified harmless" pre-flight missed the COMMIT interaction.
- **Fix:** guarded `ALTER PROCEDURE … RESET search_path` on both. Config-only (NOT `CREATE OR REPLACE`) — bodies + `prosecdef=false` preserved; bodies already `public.`-qualify, so no real hardening lost.
- **Verification (independent):**
  - Both procs after: `proconfig=NULL`, `prosecdef=false`, `prokind='p'`.
  - Live `CALL reconcile_all_saved_wallet_stats(5,2,360)` returned with no error and wrote `pipeline_runs`: `upserted=4, wallets_done=1, rows_zeroed=0, error=soft_deadline_reached_partial_sweep_committed` — the DESIGNED soft-deadline signal (`ok=false` is health here; the point is it **committed**, impossible under 2D000).
  - Security post-flight clean (secdef-anon `[]`, invariants 0 rows).
  - **Fresh subagent (no prior context): PASS on all three checks.**
- **Target metric to re-check next pass:** `reconcile-saved-wallet-stats` ticks show `soft_deadline_reached_partial_sweep_committed` (committing) not `invalid transaction termination`; `oldest_cache_h` (339h — a deep pre-existing backlog from ~a week of statement-timeout truncation, NOT caused by this change) starts falling.
- **Revert:** `ALTER PROCEDURE public.reconcile_all_saved_wallet_stats(integer,integer,integer) SET search_path = public;` and the same for `rpc_trust_health_precompute_refresh_p()` (re-applies R14 — would re-break COMMIT; don't).

## QUEUED — needs Trevor / Claude Code (not shippable in NO-PUSH)

- **R21 edge-fn audit baseline (inbox 08-23 0555Z):** 29 deployed edge functions with no committed source (21 `verify_jwt:false`). Fix = commit their source (git, code lane). Name list is in the inbox file; it is the diff baseline for next pass, not a vuln list. Do NOT fetch deployed source into a transcript (echoes gate keys).
- **Sentry ingestion dark since 08-18 (inbox 08-23 0250Z):** "0 new/24h" is unreliable until fixed. Config/route lane.
- **Cross-collection mats stale since 08-18 (night 4):** rpc-ccm-step1/step2 INSERT…SELECT timing out; needs an expensive-refresh restructure in a quiet window.
- **Standing operator items (unchanged):** git push creds in cloud/desktop-Cowork sessions; atlas-proxy `wrangler deploy` + egress probe; sports-proxy 403 (ESPN slate-gated ~Oct); the 08-22 P0 defeated-credential-purge public branch.

## FAILED / AUTO-REVERTED

None.
