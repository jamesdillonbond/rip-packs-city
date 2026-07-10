# Handoff 2026-06-27 — carried-cluster drain + Vercel build-cost fix

Packaged from the 2026-06-27 Cowork ops session. These are the low/medium-risk items the nightly autonomous pass keeps carrying because they touch off-limits route/seed logic or deploy config it can't verify unattended. **Re-measure each figure against the live DB before acting — the ledger lags.** Each item has a revert path. None touch FMV/pricing/auth/secrets.

---

## 1. VERCEL-DEPENDABOT-PREVIEW-BUILDS — the cost fix (highest $ leverage)

**Diagnosis (live 2026-06-27, Vercel dashboard).** On-demand charges are **69% Build CPU** ($44.63 of ~$65/cycle; the rest: Fluid provisioned memory $9.07, Observability $6.30, Fluid active CPU $3.11, ISR/etc small). The "Recent Previews" list is **~7 dependabot PRs** (#9–#15: setup-node, checkout, uuid, eslint-visitor-keys, debug, react-redux, get-tsconfig), each triggering a **preview build** that burns Build CPU. The current `vercel.json` `ignoreCommand` only skips docs-only diffs, so dependabot PRs (which change `package.json`/lock) build every time.

**Fix — extend `ignoreCommand` to also skip PREVIEW builds on `dependabot/*` branches. Production is byte-for-byte unchanged.**

Current:
```
"ignoreCommand": "git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'"
```
Proposed:
```
"ignoreCommand": "if [ \"$VERCEL_ENV\" = \"preview\" ] && case \"$VERCEL_GIT_COMMIT_REF\" in dependabot/*) true;; *) false;; esac; then exit 0; else git diff --quiet HEAD^ HEAD -- . ':(exclude)docs/**' ':(exclude)*.md' ':(exclude)*.mdx'; fi"
```
`exit 0` = skip build, non-zero = build. The `else` branch is the existing command verbatim, so production and all non-dependabot previews behave exactly as today.

**VERIFY (don't ship blind — this is why it's a CC item, not a Cowork one):** after the deploy is READY, the next dependabot PR must show **"Skipped"** (not a build), and a real code commit to `main` must still build + deploy READY + pass smoke. **REVERT:** restore the prior one-line `ignoreCommand`.

**Quicker partial alternative (no code):** merge or close the 7 open dependabot security PRs (they're CI-gated) so their previews stop — but they recur, so the `ignoreCommand` is the durable fix.

**Trevor-only billing decisions (not CC):**
- The **$60 on-demand cap is 76% used at cycle midpoint** (Jun 13–Jul 13) → at this run-rate projects PAUSE ~early July. Raise the cap (Billing → Spend Management → Configure) or accept the pause. Backstop (Pause Projects) is already ON — good.
- Cron cadence: `vercel.json` has **15 crons**, several `*/3h` sales-history backfills — that's the Fluid-compute lever if you want to trim it (slows backfill; deliberate program, so it's a judgment call).

---

## 2. BUYERBF-PERINVOCATION-WORK [MED · CC route + operator cron]

Since `7a70a31` (~04:40Z 06-19) the `topshot-buyer-backfill` cron fires ~4×/hr in pairs ~10 min apart and the runs now **overlap** (two concurrent lambdas self-contend); each fills the ~800s budget (observed max ~710s). `maxDuration` is already at the Pro hard cap (800s), so the lever is **stop the overlap or cap rows-per-invocation**, not raise maxDuration. Options: lower `BATCH` so a run finishes well under the cron interval; add a lock/guard so an overlapping invocation no-ops; or reduce the cron-job.org frequency. File: `app/api/admin/backfill-topshot-buyers/route.ts` (+ operator cron cadence). **Revert:** restore the prior BATCH / remove the guard.

## 3. TS-WMC-UUID-FOSSILS [LOW · CC canonical-merge, off-limits to night pass]

~1,683 `wallet_moments_cache` rows are keyed to merged/deleted UUID-form editions (`edition_key` not a canonical int-pair). Known/stable and **inert** (don't affect FMV or insights). Cleanup = remap those wmc rows onto their canonical editions (respect the `wmc.edition_key = editions.external_id` contract) or delete the fossils. **Re-measure first:** count TS wmc rows whose `edition_key` fails `^[0-9]+:[0-9]+(::[0-9]+)?$`. **Revert:** per-row audit table before any delete/remap.

## 4. UFC-EDITIONS-SEED-GAP [LOW · CC/operator seed-ingest]

~72 distinct UFC editions are held by tracked wallets (present in wmc) but **absent from the `editions` catalog** → they surface as gaps. Seed them via the same UFC edition-ingest path that filled the 446→518 batch on 06-22. **Re-measure the gap count first.** **Revert:** `DELETE` the newly-seeded UFC edition rows by `created_at`.

## 5. ALLDAY-V1-UNMAPPED-DRIFT [LOW · operator cron OR CC classify-permanent]

AllDay open `unmapped_sales` holds ~244 V1-Dapper **decode-budget-exhausted** fossils (price-known, edition-unmapped — likely old burned moments). The recover route `/api/admin/recover-v1-budget-exhausted` exists but has **0 cron**. Decide: wire it on a low cadence to drain, OR classify these as a permanent residual (they're correctly held OUT of `sales` — no corruption) and stop flagging. **Revert:** remove the cron entry if wired.

---

## Already resolved — for ledger closure, NOT action

Verified this session:
- **get_user_top_owned_moments 3-arg orphan → CLOSED.** Only the canonical 4-arg overload `(p_user_id, p_limit, p_league, p_collection_id)` remains (pg_proc, 06-27).
- **VERCEL-SPEND-PAUSE → RESOLVED.** Pause Projects ON + $60 on-demand cap live (dashboard, 06-27).

Per CLAUDE.md (confirm + remove from the ledger Queued section):
- HISTORY-BACKFILL-WATCHLIST (resolved 06-26), REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (durably resolved 06-22), BADGE-CATALOG-CRONJOB-DUP (dup cron deleted 06-22), SERIAL-FMV-MULT-CRON (by-design, do not re-queue, 06-19).

In-progress (monitor only, no action): **HISTORY-BACKFILL-UNMAPPED-SPIKE** is being drained by `topshot-flowty-unmapped-drain` (now watchlisted 90m/medium, 06-27); backlog fell 2370→724.
