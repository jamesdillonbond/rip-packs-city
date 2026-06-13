# Handoff 2026-06-12 — seed-refresh wave pacing v2 (cohort split)

DBSAT-IO-EXHAUSTION-0612 mitigation 3b from docs/handoff-2026-06-12-overnight-pass.md Section 1. One route change + a coordinated cron-job.org change (the cron side is Cowork/operator work AFTER this deploys — do not do it in this session).

Context (what is already live vs what this covers)

Cowork shipped nothing code-side for this item; this handoff is the whole change. IMPORTANT PREMISE CORRECTION vs the overnight handoff: the overnight pass's recommendation said "spreading dispatches over 30-60 min would flatten the IO spike" as if no pacing existed. In fact app/api/seed-wallet-refresh/route.ts ALREADY paces (the 2026-06-10 DBSAT load-shed): dispatchPaced() with DISPATCH_BATCH_SIZE=6, TARGET_SPREAD_MS=9min, MAX_PAUSE_MS=20s, MAX_RUN_MS=720s. The 06-11 and 06-12 IO-exhaustion windows happened WITH that 9-minute spread live — so the existing in-lambda pacing is insufficient, and it CANNOT simply be widened: maxDuration=800s (the Vercel Pro hard cap; anything higher silently ERRORs the deploy) bounds the whole after() phase to ~13 minutes. A 30-60 min spread is impossible inside one lambda. Hence the cohort design below.

Item 1 — cohort parameter on the orchestrator

File: app/api/seed-wallet-refresh/route.ts (verified by direct read this session; ~300 lines; the after() body builds a flat tasks[] from seeded_wallets where is_active=true, then awaits dispatchPaced(tasks)).

Change: accept optional query params cohort (integer K) and of (integer N, default 1). When of > 1, filter the seeded_wallets rows to those where (row.id % N) === K before building tasks. Validate: 0 <= K < N, N <= 8; on invalid input return 400 before the after() block. When the params are absent, behavior is byte-identical to today (single full wave) so the existing cron entry keeps working until the cron side is switched. Log the cohort in the existing done-line (add cohort=K/N to the console.log summary) so pipeline_runs-side debugging can tell cohorts apart. Keep dispatchPaced, all constants, and the force-full / username-resolution logic untouched — each cohort still self-paces over up to 9 minutes internally.

Why: the herd is ~252 active seeded wallets -> ~252 multicollection orchestrators -> ~1,260 collection children hitting the 60-conn pool. The 06-10 fix spread that over ~9 min; three consecutive daytime IO-exhaustion windows (06-10/11/12, the 12Z wave grinding 33-57 min per backfill on 06-12) show the aggregate IO of the whole wave still depletes the disk-IO budget. Splitting into 4 cohorts fired 15 min apart spreads the same work over ~45-54 min (4 x 15 min offsets + 9 min in-cohort pacing) without touching the lambda budget: each cohort lambda handles ~63 wallets, well inside MAX_RUN_MS.

Optional hardening while in the file (CC judgment): resolveUsernameToAddress falls back to https://public-api.nbatopshot.com/graphql when TS_PROXY_URL is unset — that hostname Cloudflare-blocks Vercel egress (CLAUDE.md API contracts), so the fallback can only fail. Replacing the fallback with an early null return (and a log line) removes a misleading code path. Skip if you want the diff minimal.

Revert path: git revert the commit. With the params absent the route is unchanged, so a revert is also safe while the cron side is already split (each cohort entry would just fire the full wave 4x — wasteful but idempotent; skip_cached makes repeats cheap).

Verification: npx tsc --noEmit clean. Deploy READY. Then one manual probe per shape: curl the route with no params (expect 202, log line shows cohort=0/1 or no cohort marker), with ?cohort=1&of=4 (expect 202, done-line processed count ~1/4 of active wallets), with ?cohort=5&of=4 (expect 400). pipeline_runs for wallet-backfill-multicollection should show dispatch timestamps clustered per cohort window once the cron side lands.

Item 2 — cron side (NOT this session — Cowork/operator, after Item 1 is READY)

Recorded for coordination only: replace the single 6h "RPC Seed Wallet Refresh" cron-job.org entry with 4 entries at staggered minutes within the same 6h cycle, each calling the route with cohort=0..3&of=4 (15 min apart, keeping the existing off-anchor stagger discipline and the Bearer-header auth). Cowork drives this via the established cron-job.org console recipe; the old entry is disabled, not deleted, until one full day of 4-cohort waves verifies clean. Verify metric: the 00/06/12/18Z wave hours in pipeline_runs spread into 4 sub-clusters; the wave-hour fail count and the per-backfill elapsed_ms distribution drop vs the 06-12 baseline (33-57 min grinds).

Guardrails (repeat every handoff)

Direct-to-main, no branches, no PRs (CLAUDE.md non-negotiable); if a claude/* branch is pre-checked-out, switch to main first. Commit via PowerShell git on Windows (Git Bash git commit can silently no-op); re-verify the push with git rev-list --count origin/main..HEAD expecting 0. curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest. Vercel Pro maxDuration hard cap is 800s — do not raise it. CRLF: no string-replace patching; full-file writes or findIndex on split lines.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — adapt to the actual file shape.

Expected end state: one commit on main, deploy READY, route honoring cohort/of with unchanged no-param behavior; after the separate cron split lands, the 6h wave's instantaneous pool load drops ~4x further and the daytime IO-exhaustion windows stop recurring (re-baseline DBSAT after).
