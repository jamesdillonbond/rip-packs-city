# RPC QA Loop — operations runbook

The scheduled QA funnel for Rip Packs City. Five cadence layers run the same **sense → triage → fix → verify → report** loop, all feeding one ledger (`docs/overnight/ledger.md`) and one glance surface (the `rpc-qa-scorecard` artifact). Stood up 2026-06-04; see the proposal in `docs/qa-loop-buildout-2026-06-04.md`.

## Schedule (local / Pacific time)

| Cadence | Task | When | What it checks | May ship |
|---|---|---|---|---|
| Continuous | `rpc-daytime-monitor` | every ~3h, 8am–11pm | pipelines, sentinel, Sentry, advisors, deploys, artifact validity; harvests candidates to the inbox | read-only |
| Daily | `rpc-nightly-autonomous-pass` | 1am | drains inbox + its review, auto-ships ≤4 low-risk, post-ship regression watch w/ auto-revert | low-risk auto-ship |
| Weekly · Mon | `rpc-weekly-health-check` | Mon 12:36am | ops digest (pipelines/FMV/security/traction) + `v_fmv_sanity_flags` + review of what the night pass shipped | read-only |
| Weekly · Mon | `rpc-weekly-health-report` | Mon 3:03am | code-health report → `docs/health/PROJECT_HEALTH_<date>.md` + TODO inventory | doc only |
| Weekly · Tue | `rpc-data-quality-sweep` | Tue 9:25am | FMV + offer sanity views, integrity (orphans / wmc contract / unmapped), freshness, offer-indexer liveness | additive monitoring config |
| Weekly · Thu | `rpc-surface-qa` | Thu 9:16am | artifact freshness + brand, live-page + 390px-mobile Chrome spot-check, fabricated-data / brand greps, SEO sample | artifact refresh + handoffs |
| Bi-weekly | `rpc-dependency-advisory-digest` | 2nd + 16th, 10am | security/perf advisors (catalog SQL), unused-index + bloat, npm/dependabot CVEs | strictly-safe index drops |
| Monthly | `rpc-monthly-memory-consolidation` | 1st, 9am | Cowork memory hygiene (merge/prune/fix) | memory files |
| Monthly | `rpc-monthly-strategy-review` | 1st, 11am | traction (50-WAU gate), funnel drop-offs, competitive glance, next-build priorities | doc only |
| One-time | `candy-audit-interim-june22` / `-firm-tripwire-july8` | Jun 22 / Jul 8 | chain-two (Solana/Candy) data-availability tripwires | read-only |

## The 5 stages (every layer runs all five)

SENSE (detect a signal) → TRIAGE (classify; queue to the ledger) → FIX (auto-ship within the layer's boundary, else package a Claude-Code handoff) → VERIFY (post-ship watch / fresh-subagent re-check) → REPORT (digest + ledger entry + scorecard).

## Auto-ship boundaries (what each layer may change LIVE)

**Off-limits to every autonomous layer** — always route to a human / Claude-Code handoff: hot & payer wallet, secrets/env, auth (`proxy.ts`), destructive SQL, and FMV / ingest / pricing / pack-EV / concierge / sniper route logic, plus any gated work.

- `nightly-pass`: ≤4 genuinely-low-risk, collision- + CI- + typecheck-gated, each independently subagent-verified.
- `data-quality-sweep`: additive monitoring config only (watchlist rows, freshness thresholds). Mispricing/integrity → ledger + handoff, never a live FMV patch.
- `surface-qa`: artifact refresh (`update_artifact`) + additive doc fixes; any route/.tsx/worker fix → handoff.
- `dependency-digest`: strictly-safe index drops only (a non-unique duplicate whose columns prefix a UNIQUE index, or a dead/frozen-table index, 0 lifetime scans) with the recreate statement recorded in the ledger.

## Escalation triggers

- `detect_stalled_pipelines()` nonzero → re-fire the cron (operator) or it's a route crash (handoff).
- `v_fmv_sanity_flags` / `v_offer_sanity_flags` rows → mispricing. Offers: a `GREATEST`-based `edition_offers` raise (never clobber down). FMV: review, never live-patch.
- Security must hold 0/0/0 (RLS-off base tables / anon-write holes / anon-readable definer views) + no destructive SECDEF anon-executable. Any nonzero is alert-grade.
- `docs/FREEZE.md` halts all autonomous shipping — create it before a launch or a risky refactor; both passes drop to read-only while it exists.

## Surfaces

- **Ledger** — `docs/overnight/ledger.md`: shipped / queued / declined, each shipped item with its revert path. The "Declined — do not re-suggest" heading is Trevor's.
- **Scorecard** — `rpc-qa-scorecard` artifact: one-glance red/amber/green roll-up across all QA domains.
- **Domain dashboards** — `rpc-live-health`, `rpc-security-drift`, `rpc-pipeline-reliability`, `rpc-insights-health`, `rpc-offers-intelligence`, `rpc-fmv-watch`, `rpc-traction`, `rpc-deploys-and-cost`, `rpc-cross-collection`, `rpc-trophy-ladder`, `rpc-my-wallet`, `rtr-pack-finder`.
- **Reusable logic** — each sweep's checklist lives inline in its task prompt; the standing skills `rpc-data`, `rpc-migration`, `rpc-handoff`, `rpc-insights-qa` back interactive work. Extract a sweep's checklist into a standalone skill if you start running it by hand often.

## Maintenance

- Adjust a task's prompt/schedule with `update_scheduled_task` (not by editing the SKILL.md — those files aren't writable from a session).
- Hit "Run now" on a new task once to pre-approve its connector/Chrome permissions so future runs don't pause.
- Reconcile this table whenever a task is added/removed.
