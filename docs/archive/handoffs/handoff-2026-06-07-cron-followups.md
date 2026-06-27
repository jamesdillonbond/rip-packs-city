# Handoff 2026-06-07 (late) — cron follow-ups: two 202 wraps + docs/ledger reconcile

CONTEXT

The full cron stagger is DONE (Cowork drove all 21 cron-job.org edits via Chrome, verified server-side; GHA staggers + trims were your 306a7ed/c9b6a04). docs/operations/cron-schedule.md was regenerated tonight from the verified dashboard — treat it as current. The weekly-maintenance DB fn was fixed live (audit_20260607_weekly_maintenance_wmc_walletscoped_delete — the old single-statement wmc DELETE seq-scanned 1.58M rows and timed out every run since at least last week; now wallet-scoped, ran clean in 8.6s, missed week caught up, grants verified service_role+postgres only). The 5 Sentry smoke transients are resolved with regression auto-reopen. Three small items remain, all yours. Claude Code's direct file inspection wins over this doc on any disagreement.

ITEM 1 (P1) — /api/admin/analytics-smoke: 202 + after() + pipeline_runs logging
The cron-job.org entry (13,43 * * * *) fails EVERY run at the client 30s cap; the route takes >30s and logs nothing to pipeline_runs, so server-side success is invisible. Apply the established CRON-30S pattern (precedent 36eee2f): auth-check → log start → return 202 immediately → after() runs the existing smoke work → log_pipeline_run with ok + per-check extra. Keep RPC_ADMIN_TOKEN auth exactly as-is. The DB fn analytics_smoke_run is fast (CC-verified post-Wave-3) — the slowness is the route's additional HTTP checks, which is fine once it's fire-and-forget.
Verify: next cron run shows Successful (sub-second) on cron-job.org; a pipeline_runs row with pipeline='analytics-smoke' (or the name you pick — then add it to this doc) appears per tick.
Revert: git revert.

ITEM 2 (P2) — /api/cron/lock-check-batch: same 202 wrap
Server-side it ALWAYS succeeds (pipeline_runs ok=true, 17-20s typical) but hit 33.5s once tonight — over the cron 30s cap, shown as Failed. As data grows this gets worse, and persistently-failing entries risk cron-job.org auto-disable (the silent-kill class). Same 202+after() treatment; it already logs pipeline_runs, so no logging change.
Verify: cron shows Successful; pipeline_runs cadence unchanged at 8,38.
Revert: git revert.

ITEM 3 (P2) — docs + ledger reconcile commit (no code)
docs/overnight/ledger.md Queued section is stale; mark these CLOSED with one-line outcomes: TFP-WATCH (shipped, watchlist row live at 480m), PACKEV-THROUGHPUT (closed — cron-frequency lever sufficient, staleness converging, batch raise stays declined), SMOKE-MARKET-EMPTY (shipped 0320f92 + Sentry resolved), PIN-SER (closed — unfillable rows), CROSS1 (obsolete — refresh runs via the Cowork scheduled task; the HTTP route is dead, see wmc-cohort-refresh-perf), I1 (RESOLVED — root cause was :00/:20/:40 anchor pile-up; full stagger applied 2026-06-07 across cron-job.org + GHA; histogram verification due ~2026-06-08 evening). Add a CLAUDE.md Recent sessions entry for tonight covering: the 21-job stagger (verified), the token-hygiene completion, weekly-maintenance fn fix + manual catch-up run, the wmc last_seen_at index (idx_wmc_last_seen_at, 11MB), Sentry 5x resolved, cron-schedule.md regenerated, and the two pending 202 wraps. Also note in the ledger Shipped block: audit_20260607_weekly_maintenance_wmc_walletscoped_delete (revert: restore prior fn body — it's in git history of this doc's session or pg_proc history; the prior body was the single-statement DELETE version) and the new index (revert: DROP INDEX CONCURRENTLY idx_wmc_last_seen_at).

WATCH (no action unless it trips)
- RPC Pipeline Runs Cleanup (weekly Sat): fn is fixed; if Saturday's run STILL fails, the entry's stored apikey is the anon key (fn is service_role-only) → then fold a weekly-gated supabaseAdmin.rpc('run_weekly_db_maintenance') into /api/cron/prune-logs and tell Trevor to delete the REST entry. Do NOT widen the fn's grants.
- DUPE1 → Tier-B remain gated on sentinel <250 (your existing sequence).

GUARDRAILS (standard)
Direct-to-main, no branches/PRs; PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0); tsc + smoke after deploy; maxDuration cap 800s; full-file replacements.

END STATE: both cron entries show green on cron-job.org with observable pipeline_runs; ledger/CLAUDE.md reflect reality; the weekly cleanup either proves itself Saturday or gets its route home.
