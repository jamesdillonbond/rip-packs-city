# Handoff 2026-06-13 — Cut the Vercel bill (REAL invoice data: Build CPU is 57%)

Read from the live Vercel invoices (Trevor's Individual Org, project rip-packs-city). Pro includes $20/cycle of usage credit; bills are seat + on-demand overage past that. Trajectory: Apr ~$20 (seat only, ~$0 overage) → May $168.29 → Jun $218.87. The overage exploded May→June with the autonomous/dev ramp (cron armada + frequent deploys + heavy build-out).

## June 2026 invoice — actual line items ($218.87)

- Build CPU Minutes — $125.68  (57%)  ← #1 BY FAR
- Fluid Provisioned Memory — 5,201.63 GB-Hrs — $55.15  (25%)
- Observability Events — $23.77  (11%)
- Fluid Active CPU — $11.19  (5%)
- ISR Writes $1.41 · Function Invocations 1,040,803 → $1.20 · Fast Origin Transfer 7.17 GB → $0.43 · ISR Reads/Edge/Fast Data Transfer ~$0
- Subtotal $218.85 − $20.00 credit = $198.86 on-demand; + Pro seat $20.00 + Observability Plus $0.00 = $218.87
- Image Optimization: $0 (not used — ignore)

So three lines are ~98% of the on-demand: Build CPU ($125.68), Fluid compute ($55.15+$11.19=$66.34), Observability ($23.77). Function Invocations at 1.04M cost only $1.20 — invocation count is NOT the problem; build minutes + provisioned memory-hours + observability events are.

## Item 1 (biggest, $125.68/mo, 57%) — stop rebuilding prod on every commit, esp. docs-only

$125/mo of Build CPU = a large number of full builds of a big app. The autonomous machinery (nightly pass, daytime monitor every ~3h, plus ledger/focus/inbox/handoff commits) pushes frequent DOCS-ONLY commits to main, and every push to main triggers a full production build for zero production change. Plus the heavy human/CC deploy cadence.

Fix A — Ignored Build Step (skip docs-only builds). vercel.json: `"ignoreCommand": "git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md'"` (or Project → Settings → Git → Ignored Build Step). Exit 0 = no app-file changes (docs-only) = SKIP build; exit 1 = app changed = build. Handle the HEAD^ edge: `git rev-parse HEAD^ >/dev/null 2>&1 || exit 1` guard. Verify a docs-only push shows "Build skipped" and a code push still builds READY. This alone likely removes a big fraction of the $125 (the monitor commits ~6 docs files/day, the night pass daily, etc.).

Fix B — deploy less. Batch commits; don't push docs separately from code; consider whether the monitor/night-pass need to commit on every run or can append+commit less often.

## Item 2 ($66.34/mo) — right-size the Fluid function compute

Fluid Provisioned Memory bills GB-hours = (memory allocated) × (time running). 5,201 GB-hrs means long-running, high-memory functions running often — the cron armada (wallet-backfill family, fmv-recalc, the 6h seed-refresh wave, etc.) with maxDuration up to 800s.
- Lower per-function memory in vercel.json `functions` config / route configs — many cron routes don't need a high memory tier; halving memory halves their GB-hr cost.
- Reduce maxDuration where a route finishes faster than its cap (provisioned memory bills for the wall-clock it's alive).
- Reduce cron FREQUENCY where cadence is overkill, and shrink the seed-refresh wallet-backfill fan-out.
- Check the Fluid Compute settings (is provisioned/always-warm concurrency on? if so it bills even when idle).
Target the few highest (memory × duration × frequency) routes first.

## Item 3 ($23.77/mo) — cut Observability event volume

Observability Events scale with invocations × emitted events/logs. 1.04M invocations each logging = $23.77. Reduce per-invocation console/log volume on the high-frequency cron routes, or lower Vercel Observability sampling (Project → Observability). (The "Observability Plus" add-on is $0 — not subscribed — good; this is base event volume.)

## Backstop — Spend Management is currently NOT capping you

Found in Billing → Spend Management: On-Demand Budget $0/$1, Notifications ON, but **Pause Projects: OFF**. With pause off, on-demand usage is billed with NO ceiling — that's how it reached $218 despite a "$1 budget." Turn Pause Projects ON with a sensible monthly on-demand budget so a runaway can't produce another surprise invoice. TRADEOFF: when the cap is hit, Vercel pauses the project (the live site goes down until the cycle resets or you raise it) — so set the budget above normal monthly usage but below catastrophe (Trevor's risk call; for a pre-revenue site a cap in the low-tens is reasonable as a circuit breaker). This is a backstop, not the fix — Items 1-3 reduce the actual usage.

## Guardrails

- Commit directly to main, no branches/PRs; PowerShell git; re-verify push count 0.
- The Ignored Build Step must NEVER skip a build with real app changes — test the diff command on a code commit before trusting it.
- Claude Code's direct inspection wins — confirm vercel.json shape + the heaviest routes' current memory/maxDuration before changing them.

End state: docs-only commits stop triggering prod builds (kills most of the $125 Build CPU), the heaviest crons are right-sized in memory/duration/frequency (cuts the $66 Fluid line), observability volume is trimmed ($24), and Spend Management's pause is a hard backstop against another surprise. Goal: on-demand back toward the $20 included credit.
