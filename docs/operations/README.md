# RPC Operations Map

One page to orient any session — human, Cowork, or Claude Code — before touching anything. If a referenced doc disagrees with live state, live state wins; update the doc. Last regenerated 2026-06-08.

## The deploy split (who ships what)

| Surface | Owner | Mechanism |
|---|---|---|
| DB migrations, edge functions, Cowork artifacts, scheduled-task prompts | Cowork | Supabase MCP (`apply_migration` / `deploy_edge_function`), `update_artifact`, `update_scheduled_task` |
| Route/.tsx/lib code, GHA workflows, workers/* | Claude Code on Trevor's machine | direct-to-`main` commits (NO branches/PRs), workers via `wrangler` |
| cron-job.org schedules, Stripe, registrar, power settings | Trevor (or Cowork via Chrome, Common tab only) | dashboards |

Cowork→CC work moves via handoff docs (`docs/handoff-YYYY-MM-DD-<topic>.md`, plain text, iPhone-pasteable — the `rpc-handoff` skill owns the format). Destructive SQL (DROP/TRUNCATE/bulk DELETE) ships from Cowork with backups, never from CC.

## The autonomous loop

- `rpc-daytime-monitor` (every ~3h, 8am–11pm): READ-ONLY sweep; harvests candidates into `docs/overnight/inbox/` (one new file per run).
- `rpc-nightly-autonomous-pass` (1:02 AM): drains the inbox, ships ≤4 verified low-risk changes, writes `docs/handoff-<date>-overnight-pass.md` + morning digest. Off-limits set lives in its prompt; FMV/pricing/auth/wallet/destructive-SQL always queue.
- Shared state in `docs/overnight/`: `ledger.md` (rolling queued/shipped/declined — the "Declined — do not re-suggest" section is Trevor's), `focus.md` (steer tonight's pass), `metrics-latest.json` (baseline), `.lock` (concurrency), `inbox/`.
- `docs/FREEZE.md` existing = ALL autonomous shipping stops (read-only) until removed.

## The QA loop (weekly cadence)

Tue `rpc-data-quality-sweep` · Thu `rpc-surface-qa` (owns artifact freshness + live-page/mobile spot-checks incl. the pack/moment history surfaces) · bi-weekly `rpc-dependency-advisory-digest` · monthly `rpc-monthly-strategy-review` + `rpc-monthly-memory-consolidation` · Mon `rpc-weekly-health-check` + `rpc-rewards-weekly-pulse` · daily `rpc-trust-health-watch`, `rpc-cross-collection-refresh`, `rpc-pending-signups-watch`. Runbook: `docs/operations/qa-loop.md`.

## Scheduling & cron truth

`docs/operations/cron-schedule.md` = the verified schedule reference (regenerated from the live dashboard 2026-06-07 after the full stagger). Rules: never schedule on minutes 0/1/20/21/40/41; >30s routes must 202+`after()`; auth via `Authorization: Bearer` header on `www.` URLs only; throughput lever = cron frequency, not batch. Console automation: COMMON tab only (Advanced holds secrets) — the `rpc-cron-ops` skill has the full recipe.

## Verification standards (every ship)

`npx tsc --noEmit` + corruption-guard before push · deploy polled to READY · smoke test after · DB end-state re-measured read-only in a SEPARATE step from the doc that records it · revert path written down with the ship · health fns (`detect_stalled_pipelines` etc.) return a SINGLE jsonb row — read the value, never count rows · `git rev-list --count origin/main..HEAD` = 0 after push · stage by exact path, never `git add -A`.

## Skills (Cowork, installable from docs/cowork-skills/)

`rpc-data` (warehouse context — UUIDs, vocabularies, canonical-edition predicate, history RPCs) · `rpc-migration` (DB safety checklist) · `rpc-handoff` (CC packaging format) · `rpc-insights-qa` (public-surface pre-ship checklist) · `rpc-cron-ops` (scheduling + console recipe). Update pattern: edit the source here, re-zip as `<name>.skill`, Trevor reinstalls via Settings.

## Where decisions live

Strategy + product decisions: `CLAUDE.md` (top sections + Recent sessions) and `docs/strategy/`. Operational incidents + fixes: `docs/audits/` and the dated handoffs. Current gates at a glance: the ledger's Queued section. Standing rules that bite: intelligence-first (no cart/live-buy) · no paywall until 50+ WAU · no promo until Trevor says · never auto-price zero-sale editions · FMV writer logic changes always get review.

## Operator quarterly checklist (Trevor, ~10 min)

Supabase dashboard: confirm backups/PITR healthy + restore point exists · registrar: domain renewal date · Vercel: spend within plan · Stripe: still dormant while pre-launch · rotate any proxy secret older than ~6 months (three independent rotation surfaces — see CLAUDE.md "Worker auth surfaces").
