# RPC overnight pass handoff — 2026-08-27 (01:0x PT)

> ⚠ **NO-PUSH cloud session.** This mount has no `remote.origin.pushurl`, the `url` fallback carries no PAT,
> and `git push --dry-run origin HEAD:refs/heads/main` fails with *"could not read Username for
> https://github.com"*. **This blocker is specific to THIS cloud Cowork session. Trevor's machine and
> Claude Code push normally via the PAT in `remote.origin.pushurl` — commit these output files as usual.**
> All outputs this run were written to the MOUNT (they persist on Trevor's machine and are picked up by
> future runs), uncommitted.

## Verdict

**Quiet honest night — nothing shipped.** Security is clean on all four invariants, no new regression
class, and every actionable item is either operator-only, off-limits, code work needing a push (already
packaged), or cuts against standing guidance. There was nothing clearly-safe + net-positive to ship as a
DB migration or artifact.

## Gates / setup

- **Clock:** DB `now()` = 2026-08-27 08:03:14Z = **01:03 PT**, inside the 00:00–06:00 overnight window.
  `max(ingested_at)` sales 08:03:07Z and `max(computed_at)` fmv 07:56Z bound real time from below → genuine
  overnight run (sandbox `date` was PDT and agreed).
- **FREEZE:** absent.
- **Lock:** prior lock was RELEASED (last night's run). Took it at 08:03:53Z as
  `night-20260827T080353Z-14039`; released at end of run.
- **Push capability:** UNAVAILABLE (see banner). Fresh `--filter=blob:none` clone succeeded and sits on
  `main`; reads came from the clone (origin) with mount fallback.
- **Inbox archiving:** none (append-only rule, enforced by
  `__tests__/inbox-is-append-only-since-the-rule.test.ts`).

## Health-drift findings + deltas (vs 2026-08-26 metrics)

- **Security:** invariants `[]`, anon_write_holes `[]`, rls_off_base_tables `[]`, secdef_anon_violations
  `[]`. All clean.
- **Trust health — 2 BREACH, both known-class, `trust_precompute_max_age_hours`=5.27 FRESH so both are real:**
  - `public_board_slow_count` **5 → 7** (candy-mlb boards timing out; IO-saturation collateral; direction not
    to be characterized on a ~1-day window per standing steer).
  - `unmapped_resolution_backlog_max` **348 → 357** (All Day permanent floor; 47,227 actionable, net-draining
    ~35 in / 52 out per 24h; do not raise `breach_at`).
- **pg_cron recent failures (3):** `rpc-refresh-allday-pack-realized` (3/4), `rpc-refresh-new-collectors`
  (1/1), `rpc-thin-sale-ask-disclosure-refresh` (1/1) — all `statement timeout` on MV refresh / cache INSERT.
  The board-MV 600s cron class (#27) and the inert-proconfig-timeout class (#42). Known.
- **Pipeline alerts:** all the same known saturation/structural set as 08-26 (topshot-active-listings-ingest
  egress_blocked #20/#30, topshot-pack-pool-backfill 93.8% #38, wallet-username-resolver pool timeout,
  allday-buyer/pack-opens backfills, lock-check-batch, populate-pinnacle-wmc-fmv, refresh_wmc_fmv_drift_active,
  run-insider-detectors, pinnacle-resolve-buyers cron_silent). Nothing new.
- **Vercel:** 50 runtime error groups / 24h, every one saturation-class (300s cron kills, connection-pool
  timeouts, candy-mlb board statement timeouts, pack-detail / edition / player 45s RPC timeouts degrading
  honestly to empty). `url.parse` DEP0169 is a benign longstanding node warning. **No new non-saturation
  class.**
- **Sentry:** still dark (0 unresolved issues against 50 live Vercel groups minutes old). Root settled 08-26:
  org error-quota exhausted. Dark-reporter, not a clean bill. Operator/billing-gated.
- **Editions:** 27,257 → **27,299** (Top Shot 19,849 → 19,891, rest flat). **DB size** 13,953 → **14,004 MB**.
  FMV HIGH+MED: Top Shot 7,631 → **7,502**, All Day 1,579 → **1,519** (both within normal recompute churn;
  `topshot_fmv_stale_hours`=0.1, `allday_fmv_stale_hours`=0.1 — fresh, not a coverage loss).
- **Artifacts:** 11 present, none flagged broken/stale, none updated since 08-16, fresh-on-open. No repair
  needed.

## Post-ship watch on the previous pass

Last night's night-pass shipped **nothing**, so there is no night-pass revert to watch. The 08-26 DB ships in
the ledger were **Claude Code interactive from Trevor's box**; re-measured for regression tonight:

- **`reconcile-saved-wallet-stats` duration_ms fix** — 17 fails/24h are the DESIGNED 10s soft-deadline bound
  (`soft_deadline_reached_partial_sweep_committed`), not a regression; the fix only corrected `duration_ms`
  accuracy with byte-identical `extra`. No regression.
- **pg17 partial-index repair (fmv_recalc path)** — `fmv-recalc` 10 fails/24h = normal wasteful-not-broken
  class, no new signature. No regression.
- No new Sentry issue, no new non-saturation Vercel class, security clean. **Clean post-ship watch.**

## Shipped

None.

## New finding this run (QUEUED — operator)

- 🚨 **`ufc-sales-indexer`'s cron-job.org trigger is dead — only the GHA backstop fires it, and the smoke
  alarm on `main` is CORRECT.** Measured: **11 runs/24h vs ~80–83** for the three healthy sales indexers
  (`topshot`/`allday`/`golazos`), silent **273m** at capture. The 16-ish daily runs match the
  `Sales Indexers Backstop` GHA workflow exactly, at ~77m gaps, so it periodically crosses the 240m smoke
  threshold and reds `Smoke Tests`. **Fix = recreate / re-enable the UFC entry in the cron-job.org console
  (operator; auth-gated).** ⛔ Do NOT silence the alarm. No sales are actually being lost (UFC has been
  dormant ~96 days), but a persistently-red smoke test masks other indexer failures. Filing:
  `inbox/2026-08-27T0250Z-ufc-sales-indexer-has-only-the-flaky-gha-backstop-left-and-the-backstop-delivers-a-third-of-its-schedule.md`.

## Queued (why not auto-shipped)

- **48 pg_cron jobs declare an inert `statement_timeout`** (proven by 4 probes, inbox 2026-08-27T0450Z);
  jobid 256 `rpc-thin-sale-ask-disclosure-refresh` dies daily at 600s. The real fix changes a function/job's
  execution behavior, and *raising* a timeout under an IO-saturated instance cuts directly against focus
  PRIORITY 3 ("never raise a timeout"). Needs a focused decision, not an unattended overnight ship.
- **Cron waste is SCHEDULE ALIGNMENT, not a load band** (inbox 2026-08-27T0430Z; 22.6% of 7d cron time
  wasted, 85% of it in 384 statement-timeout runs). Top burners (jobids 71/217/73, pack-EV) are
  `cron_heavy`-owned (no session-reachable role can reschedule) and pack-EV route logic (off-limits).
  Operator/decision.
- **Sentry ingestion dark** — org error-quota exhausted; operator/billing decision.
- **Unbounded-fetch class, 29 sites** (inbox 2026-08-27T0320Z) — code, needs a push; already packaged in
  `inbox/2026-08-27T0420Z-CLAUDE-CODE-HANDOFF.md`.
- **topshot-active-listings-ingest / topshot-pack-pool-backfill** (#20/#30/#38) — ingest + FMV-route logic,
  off-limits/operator.
- **#22 defeated credential-purge branch** `claude/todo-implementation-e4tib3` still live — operator: triage
  `ee94c8a2a` → GitHub-UI delete → ask Support to GC → **rotate regardless**.

## Failed / auto-reverted

None. No production shipping was attempted; no hard-stop triggered.

## Operator blockers (unchanged)

git push credentials in cloud Cowork · Sentry ingestion dark · atlas-proxy wrangler deploy (partial) ·
sports-proxy 403 (ESPN, measured dead) · #22 stale public branch `e4tib3`.
