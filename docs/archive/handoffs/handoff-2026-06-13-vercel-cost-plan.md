# Plan 2026-06-13 — Vercel cost reduction (Item 1 shipped; 2/3/backstop on hold)

Companion to the two `docs/handoff-2026-06-13-vercel-cost-reduction.md` handoffs (the second carries the real June invoice). Item 1 shipped this session; Items 2/3 + the Spend backstop are **deliberately held** (Trevor's call) until the cohort-split wave pacing has a few clean days — cutting compute now risks re-triggering DBSAT-IO-EXHAUSTION-0612, resolved only 2026-06-13.

## June 2026 invoice (actual): $218.87

| Line | $ | % of on-demand | Lever | Owner |
|---|---|---|---|---|
| Build CPU Minutes | 125.68 | 57% | **SHIPPED** — skip docs-only builds | CC ✅ |
| Fluid Provisioned Memory (5,201 GB-hrs) | 55.15 | 25% | frequency + fan-out (NOT memory) | operator |
| Observability Events | 23.77 | 11% | sampling rate | Trevor (dashboard) |
| Fluid Active CPU | 11.19 | 5% | same as provisioned mem | operator |
| ISR / Invocations (1.04M=$1.20) / transfer | ~$4 | ~2% | n/a — invocation count is NOT the problem | — |

Image Optimization $0 (unused). Subtotal $218.85 − $20 credit = $198.86 on-demand + $20 seat.

Trajectory: Apr ~$20 (seat, ~$0 overage) → May $168.29 → Jun $218.87. The overage tracks the autonomous/dev ramp.

## Item 1 — SHIPPED & verified (commit `0e7e627`)

`vercel.json` gained:
```
"ignoreCommand": "git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'"
```
Vercel skips the build on exit 0 (only `docs/**` + `*.md`/`*.mdx` changed), builds on exit 1. Mixed code+docs commits build. A missing `HEAD^` errors non-zero → builds (safe). **Live-verified**: code commit `0e7e627` → READY; docs-only commit `275830b` → CANCELED (build skipped). This removes the bulk of the $125 line — the daytime monitor (~6 docs files / run, every ~3h), nightly pass, and all ledger/focus/handoff writes were each triggering a full prod build for zero production change. Revert: `git revert 0e7e627`.

**Fix B (deploy less) is now largely moot for Build CPU** — the docs-only churn is skipped regardless of batching. Remaining Build CPU is legitimate code deploys (human + CC + night-pass ships). A secondary lever if it's still high: batch code commits rather than pushing several small ones in a row.

## Item 2 — Fluid compute ($66/mo) — HELD. Why memory-cutting is the WRONG lever here

Inspected all routes: **there is no `functions` memory block in `vercel.json`** — every function runs at the project-default tier. The 5,201 GB-hrs is dominated by the long heavy crons:
- **`seed-wallet-refresh`** (`maxDuration=800`) — the 6h wave fans out ~1,260 child backfill lambdas, each running ~580–838s (see memory [[seed-wave-saturation-elapsed-uncorrelated]]). Order-of-magnitude: ~1,260 × ~700s × ~2GB ≈ **~490 GB-hrs per wave** × 4/day × 30d → this single pipeline plausibly accounts for most of the 5,201.
- `wallet-backfill-multicollection` (800), `wallet-backfill-allday`/`-pinnacle` (600), and ~20 crons at 300s on ~20-min cadence.

**On Fluid, CPU scales with allocated memory.** Provisioned GB-hr = memory × wall-clock. Halving a DB-bound backfill route's memory lowers its CPU → it runs *longer* → wall-clock rises, so the GB-hr saving is small (~15%) AND it re-introduces the exact IO/CPU pressure that caused DBSAT-IO-EXHAUSTION-0612. Net: **memory cuts on these routes are a bad trade.**

The lever that cuts the Fluid line AND helps DBSAT (aligned, not opposed) is **fewer invocations × duration**:
1. **Shrink the seed-refresh fan-out / cadence** — the herd is every active `seeded_wallets` row re-walked every 6h. Levers: widen the refresh interval (6h → 12/24h for low-priority wallets), or split the herd so only a fraction re-walks per wave. The cohort-split route param (`?cohort=K&of=N`, `eba6491`) already enables staggering; extend it to *thin* each wave, not just spread it. (operator + CC, data-aware)
2. **Drop cron frequency where cadence is overkill** — not every 300s cron needs ~20-min cadence (cron-job.org, operator).
3. **Check Fluid provisioned/always-warm concurrency** — Project → Functions. If provisioned concurrency is on, it bills even when idle. (Trevor, dashboard)
4. **Only then** consider a measured per-route memory floor — and only with real peak-memory data per route, never a blind guess, never on the DB-bound backfill/fmv/ingest/pack-EV routes.

Gate to revisit: 3–5 clean days post cohort-split (no DBSAT recurrence, waves <0.5% fail).

## Item 3 — Observability ($24/mo) — HELD

Scales with invocations × emitted events/logs (1.04M invocations each logging). Levers:
- **Lower Observability sampling** (Project → Observability) — operator/Trevor, dashboard. Biggest single move for this line.
- Per-route log trimming on the high-frequency crons is code, but it's $24 spread thin, and CLAUDE.md deliberately standardizes on `console.log` for diagnostics (`console.warn` isn't indexed by Vercel search). Trimming logs mid-incident-recovery trades real operational visibility for little — defer.
- "Observability Plus" add-on is $0 (not subscribed) — good, leave it.

## Backstop — Spend Management (Trevor, dashboard — do this regardless)

Billing → Spend Management currently: On-Demand Budget $0/$1, Notifications ON, **Pause Projects OFF**. With pause off, on-demand is billed with **no ceiling** — that's how a "$1 budget" reached $218. Turn **Pause Projects ON** with a monthly on-demand budget set **above normal usage but below catastrophe**. Tradeoff: when hit, Vercel pauses the project (live site down until the cycle resets or the cap is raised) — for a pre-revenue site, a low-tens cap is a reasonable circuit breaker (Trevor's risk number). This is a backstop, not a fix; Items 1–3 reduce the actual usage.

## Owner summary

- **CC (done)**: Item 1 build-skip.
- **CC (when un-gated)**: extend cohort-split to thin each wave; measured per-route memory floor *with data*.
- **operator (cron-job.org)**: cron cadence reductions; seed-refresh wave thinning.
- **Trevor (Vercel dashboard)**: Spend Management Pause ON + budget; Observability sampling; Fluid provisioned-concurrency check.

## Guardrails honored

Commit direct to main, no branches/PRs; PowerShell/Bash git; push count re-verified 0. No compute touched this session (DBSAT recovery is one day old). Item 1's ignoreCommand was validated against real history (docs `3456e6e` SKIP; code `bd8e05c`/`b08eb23`/`f073ae0` BUILD) and then live-verified before this plan was written.
