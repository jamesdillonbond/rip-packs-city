# Handoff 2026-06-10 — DAYTIME-DBSAT follow-ups (weekly-maintenance fold + fmv-recalc step3 observability)

## Context

A daytime DB IO-saturation window (~10:00–15:30Z today) was root-caused to populate_wmc_image defeating its partial index and seq-scanning the 1.66M-row wallet_moments_cache twice per 5-min tick (43–111s per call, continuously). Cowork shipped the durable fix live: migration audit_20260610_populate_wmc_image_partial_index_fast_path (p_force branched into static SQL; hot path matches idx_wmc_image_url_null exactly; verified 2–554 ms post-fix vs 43–111 s pre-fix). Ledger entry exists (docs/overnight/ledger.md, top of Shipped). Recovery is gradual as the disk IO budget refills. HEAD at writing: 4cd1a31 (plus one ledger/handoff docs commit after it).

This handoff covers the two CODE items Cowork cannot ship (no git push of route code from the scheduled sandbox; interactive pushes used git plumbing for docs only).

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

## Item 1 (primary) — fold run_weekly_db_maintenance into /api/cron/prune-logs; retire the broken REST cron entry

File: app/api/cron/prune-logs/route.ts (77 lines, verified exists; GET handler, Bearer INGEST_SECRET_TOKEN, maxDuration 60, logs pipeline_runs as prune-log-tables).

Why: the cron-job.org entry "RPC Pipeline Runs Cleanup" (direct REST call to /rest/v1/rpc/run_weekly_db_maintenance, Saturdays) failed AGAIN last Saturday (HTTP error, 8.43s) — second consecutive confirmed failure, matching the CLAUDE.md June-7 WATCH note: the entry's stored apikey is the anon key, and the fn is deliberately service_role-only. The documented plan is exactly this fold. Do NOT widen the fn's grants.

What to change in route.ts:
- After the existing prune_log_tables flow (leave it untouched), add a weekly-gated leg: query pipeline_runs for pipeline = 'weekly-db-maintenance' with ok = true in the last 6 days; if none, call supabaseAdmin.rpc('run_weekly_db_maintenance') and log a pipeline_runs row (p_pipeline 'weekly-db-maintenance', ok from the rpc error state, error message on failure, summary jsonb into p_extra if the fn returns one — inspect the fn's return shape with a one-off read if needed).
- The fn ran clean in 8.6s after the 2026-06-07 wallet-scoped rewrite, but to be safe against growth run the weekly leg inside after() from next/server (the CRON-30S pattern; the daily prune response stays sync and unchanged). If you prefer sync, raise maxDuration to 300 — never above 800 (Vercel Pro hard cap; higher silently ERRORs the deploy).
- The 6-day-dedupe gate (rather than a day-of-week check) makes it self-healing: a missed Saturday gets caught by the next daily tick.

Operator step AFTER this deploys and the first weekly leg logs ok=true: disable or delete the cron-job.org entry "RPC Pipeline Runs Cleanup" (jobId 7491767). Until then it keeps failing harmlessly every Saturday.

Revert: git revert the commit; re-enable the cron-job.org entry. No DB change involved.

Verify: npx tsc --noEmit clean; deploy READY; first run after deploy shows the normal prune-log-tables row, and (since there has been no ok weekly run in >6 days) also a weekly-db-maintenance row with ok=true in pipeline_runs.

## Item 2 — fmv-recalc step3_delete_chunk_failed: surface the underlying error; conditional retry

File: app/api/fmv-recalc/route.ts, Step 3 block at approximately lines 692–732 (the DEL_CHUNK = 500 loop; locate by searching for step3_delete_chunk_failed).

State: fmv-recalc failed every run 10:08Z→15:28Z today with the generic p_error 'step3_delete_chunk_failed' (153s runs). The underlying deleteError.message goes only to console.error — invisible to pipeline_runs scans, which cost diagnosis time today. The failures are saturation-class (they predate today's e3aee28 deploy), and are expected to self-heal as IO refills.

First CHECK pipeline_runs: if fmv-recalc runs after ~17:00Z today are ok=true, the failure mode is gone and only the observability change below is warranted. If it is STILL failing on a calm DB, treat it as a real Step-3 regression and diagnose before patching anything.

What to change (observability, ship regardless):
- In the chunkFailed log_pipeline_run call, change p_error from the constant 'step3_delete_chunk_failed' to include the captured deleteError.message (keep the constant as a prefix so existing scans still match, e.g. step3_delete_chunk_failed: <message>), and add the failing chunk offset + delStatus into p_extra alongside the existing algo_version/stage. You will need to hoist the last deleteError/delStatus/chunk index into variables visible at the log site (currently scoped inside the loop).
- Optional hardening (your call): one retry of a failed chunk after a short sleep before declaring chunkFailed — mirrors the SMOKE-RETRY/rpcRetry pattern used elsewhere in the repo. Do not loop more than once; the cursor already stays put on failure so the page is retried next tick anyway.

Revert: git revert the commit.

Verify: npx tsc --noEmit clean; deploy READY; next fmv-recalc failure (if any) carries the real PG error text in pipeline_runs.error.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push with: git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher silently ERRORs the deploy.
- CRLF: no string-replace patches on Windows; full-file writes or findIndex on split lines.
- Note: a phantom .git/index.lock may exist (sandbox-mount artifact, dated 06-09 23:33). If git ops fail on it from Trevor's machine too, delete C:\Users\TDill\rip-packs-city\.git\index.lock first.

## Out of scope here (already tracked elsewhere)

- SMOKE-EDITION-TIMEOUT checkUrl per-fetch budget fix — already queued for CC in the 06-10 overnight ledger entry.
- Badge catalog cron wiring + e3aee28 FMV wave-watch — operator items in the e3aee28 ledger entry; the wave-watch starts once fmv-recalc completes clean sweeps.
- One-time image_url '' → NULL probe/sweep — queued for the night pass (DB-side, post-recovery).

## End state

One or two commits on main, deploy READY, weekly DB maintenance self-firing from the daily prune tick (broken REST entry retired by operator), and fmv-recalc failures carrying real error text in pipeline_runs.
