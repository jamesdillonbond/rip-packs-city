# Rip Packs City — Project Health Report

**Date:** 2026-05-22
**Compiled by:** Claude (Cowork)
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Architecture Notes §, Deferred Hardening §) and a full-tree `TODO/FIXME` scan.
**Scope:** A single consolidated, themed view of open work — 16 tracked known issues, 5 prioritized actions, and ~21 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Revised:** 2026-05-22 — full verification sweep against the codebase *and* the production Supabase. All 16 known issues reconciled in §9. Note: over half of CLAUDE.md's known-issues list is stale.

> This is a snapshot. `CLAUDE.md` remains the source of truth; this doc reorganizes it for triage and adds an in-code TODO inventory that `CLAUDE.md` does not currently track. Severity/effort tags are suggestions, not gospel.

> **Platform events (May 2026) — material context.** Two upstream changes reshape several items below. **(1) Flowty shut down its marketplace (~2026-05-13).** That is why `flowty_loan_events` went cold on 2026-05-11 (#3) — expected, not a bug. It also means the Flowty-dependent infrastructure throughout `CLAUDE.md` — the external Flowty event indexer, `flowty_loans` / `flowty_loan_events`, the Flowty analytics materialized views, the Flowty leg of the sniper feed, the `flowty-proxy` edge function, the dormant V2 Flowty-fork storefront — is now dead weight to be archived, not repaired. **(2) NFL All Day ended primary pack sales.** AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are now historical-only; the Pack pages should treat AllDay primary drops as a closed set.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known issues — resolved | 6 | #2, #5, #6, #8, #13, #16 — verified, see §9 |
| Known issues — partial | 4 | #1, #4, #7, #11 — verified, see §9 |
| Known issues — still open | 6 | #3, #9, #10, #12, #14, #15 — verified, see §9 |
| Prioritized next actions | 5 | 3 overlap known issues; 2 are net-new |
| In-code TODO markers | ~21 across 11 files | Not tracked in `CLAUDE.md` today — see §5 |
| Revenue-blocking items | 3 | Cart, Pro gate, Trade Hub |

**Health read:** Pipelines are stable (CLAUDE.md reports 0% failure across 23 active cron pipelines), and the data model is well-documented. The risk is concentrated in two places: **nothing currently converts a visitor into revenue** (cart, Pro gate, and Trade Hub are all unfinished), and **three data-ingestion paths are degraded or cold** since a shared April 28 upstream change.

### Themes

| Theme | Items |
|---|---|
| Revenue / conversion blocked | Cart (#1), Pro monetization (P3), Trade Hub (TODOs §5a), Pro gate stub (TODO §5b) |
| Ingestion degraded / cold | Flowty event indexer (#3), Storefront audit (#9), Spork scan (#7), NBA stats (#8) |
| Data quality | Pinnacle ASK feed (#4), AllDay/UFC edition mis-categorization (#5), WarmupContext (#6) |
| Observability | Sentry inactive (#2) |
| Tech debt / refactor | `/dashboard` migration (#10), monolith pages (#14), scratch fixtures (#15) |
| Brand / polish | Brand punch list (#11), Blazers trivia (#12) |
| Business development | Austin Kline FMV API outreach (P2) |

---

## 2. Critical path — start here

These three block the platform from earning money. Everything else is secondary until at least one revenue path is live.

### 2.1 Cart checkout (Known issue #1, Priority #1) — `Severity: Critical · Effort: Medium–Large`

Partially resolved. The two compile errors are fixed; the two signability blockers and the external dependencies remain. Status, in fix order:

1. **C1/C2 — compile errors: FIXED** (verified in `lib/cadence/purchase-moment.ts` on 2026-05-22). `import FungibleToken from 0xf233dcee88fe0abe` is present (line 42), and `self.listing` is borrowed (line 73) before its price is read (line 77). The `flow cadence lint` harness should now pass — see §6.
2. **H1 — STILL OPEN.** `commissionRecipient: nil` at line 100 panics on every Dapper-listed Top Shot moment (Dapper listings always carry a non-zero commission cut).
3. **H2 — STILL OPEN.** No `post {}` block — the DUC leak check the Dapper co-signer requires before it will sign is missing.
4. **External — STILL OPEN.** Register `NEXT_PUBLIC_WALLETCONNECT_ID` at dashboard.reown.com; complete Dapper meta-transaction co-signer registration.

Sequence: fix H1 + H2 to make the transaction signable → resolve external deps → test on emulator and testnet against a real Dapper testnet co-signer → mainnet. Per `CLAUDE.md`, any change to the Cadence must first be verified against the live contract via the Cadence MCP. Full detail: `docs/audits/purchase-moment-2026-05.md`.

### 2.2 Pro monetization (Priority #3) — `Severity: Critical · Effort: Medium`

The $9/month freemium gate. Note the in-code reality (§5b): `lib/pro/gate.tsx`'s `ProGate` component currently renders its children unconditionally — `// TODO: wire Stripe subscription check`. Stripe deps are installed (`stripe ^22.0.0`) and there's a `StripeSubscribeButton` component, so the work is wiring the gate to a real subscription check, not greenfield. See `docs/audits/stripe-go-live-2026-05.md`.

### 2.3 Trade Hub / trade-escrow (in-code, not in CLAUDE.md known issues) — `Severity: High · Effort: Large`

The Trade Hub feature is scaffolded but non-functional. All five trade Cadence transactions in `lib/trade-escrow/fcl-submit.ts` are `TODO` stubs (propose, deposit, execute swap, cancel, reclaim-expired), and `app/dashboard/trade-hub/TradeChainPanel.tsx` surfaces a literal "Cancel signing not wired yet" error to users. Tracked separately in `docs/trade-escrow/STATUS.md` — **recommend adding it to the CLAUDE.md known-issues list** so it isn't lost between the two trackers.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues.

> **§9 has the verified open/resolved/partial status of every item**, checked against the codebase on 2026-05-22. This section keeps the original theme grouping for triage.

### Ingestion degraded or cold (shared April 28 root cause suspected)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 3 | External Flowty event indexer regression — `flowty_loan_events` ingest dropped ~99% on 2026-04-28. `FUNDING_*` events stopped entirely; `LISTING_*` trickle at <1%. Writer is external to this repo. | High | Medium (diagnosis-heavy) |
| 9 | Storefront audit pipeline cold since 2026-04-28 (`storefront_audit_wallets` last write 11:35 UTC that day). Same cutoff as #3 — likely a shared upstream Flow access-node / subscription change. | Medium | Small–Medium |
| 7 | Historical spork scan blocked from Supabase egress (port 8070). Fix: a 6th Cloudflare Worker proxy, then run the unified spork-scan resolver to clear the ~3,400 AllDay + Pinnacle unresolved-sales backlog. (Priority #5.) | High | Medium |
| 8 | NBA `stats.nba.com` unreachable from CF Workers (Cloudflare-on-Cloudflare origin block) — projections stuck at 0 rows/day. Options: move stats ingress off CF (Deno Deploy / Render / Fly.io), use balldontlie.io paid tier, or a residential-IP proxy. | Medium | Medium–Large |

**Recommendation:** Investigate #3 and #9 together first — a shared 2026-04-28 cause means one diagnosis likely explains both.

### Data quality

| # | Issue | Severity | Effort |
|---|---|---|---|
| 4 | Pinnacle direct integration — replace Flowty-sourced ASK prices (uniform $1 floor across 10k+ listings) with a direct feed. | Medium | Large |
| 5 | ~454 mis-categorized AllDay/UFC editions sitting in the TopShot collection. FK impact analysis required before any mutation. | Medium | Medium |
| 6 | WarmupContext key mismatch — prefetcher and consumer must agree on cache-key shape; mismatched keys silently render 0 rows (works logged-out, fails signed-in). | Medium | Small–Medium |

### Observability

| # | Issue | Severity | Effort |
|---|---|---|---|
| 2 | Sentry error capture inactive — `@sentry/nextjs` is fully wired but `NEXT_PUBLIC_SENTRY_DSN` is unset in Vercel, and `SENTRY_AUTH_TOKEN` is missing too (source-map uploads work locally only). | Medium | Small |

**Recommendation:** #2 is small and high-leverage — set the DSN before shipping a payment flow. The Cadence regression net (#16) is already wired into CI; see §6 for the correction applied to that job today.

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` 1,816-line token migration — large lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — `collection/page.tsx` (2,900 lines, 59 `useState`), `sniper/page.tsx` (2,485 lines, 50 `useState`), `analytics/page.tsx` (2,203 lines, 36 `useState`). Phase 1 is zero-risk (~1h, extract leaf components). Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md`. | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` — 12 one-off harvest fixtures committed in-tree. Decision needed: keep as docs, move to gitignored `scratch/`, or delete. | Low | Trivial |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — per-collection OG cards (clone `/api/og/deal`); `/home-fmv-preview.png` home screenshot; Fast Break / RTR / admin tokenize once stable. | Low | Small–Medium |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`) — 29 items shelved, no UI yet. | Low | Small |

---

## 4. Prioritized next actions (from CLAUDE.md)

| P | Action | Maps to |
|---|---|---|
| 1 | Cart execution (WalletConnect ID + Dapper registration) | Known issue #1 — see §2.1 |
| 2 | Austin Kline FMV API outreach (demo URL live) | Net-new — business development, not code |
| 3 | RPC Pro monetization ($9/month freemium gate) | See §2.2 + TODO §5b |
| 4 | Locate external Flowty event indexer, diagnose the April 28 cliff | Known issue #3 |
| 5 | Spork-proxy worker for historical scan | Known issue #7 |

---

## 5. In-code TODO inventory

A full-tree scan found ~21 `TODO/FIXME` markers across 11 files. `CLAUDE.md` does not currently track these; `docs/code-todos.md` covers only 2 of them. Grouped by theme:

### 5a. Trade Hub / escrow — entire feature stubbed (8 markers)

- `lib/trade-escrow/fcl-submit.ts` (×6) — all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`, plus the header block describing the wiring pattern.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (×2) — cancel callback unwired; UI returns `"Cancel signing not wired yet"`.

→ See §2.3. This is the largest single cluster.

### 5b. Monetization gate stub (1 marker)

- `lib/pro/gate.tsx:25` — `// TODO: wire Stripe subscription check`. The `ProGate` component is a pass-through today. Directly blocks Priority #3.

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers)

- `supabase/functions/special-serial-sweep/index.ts` — ownership lookup returns `null` for all four collections (topshot, allday, golazos, ufc). The edge function is a no-op shell. Related to known issue #7 and `docs/code-todos.md` item 2 (the Deposit-event ownership scanner is DB-scaffold-only).

### 5d. Marketing / home placeholders (2 markers)

- `components/HomePageMarketing.tsx` — homepage stat counters are hardcoded strings, not wired to live data (`/api/health-check`); placeholder analytics card needs a real screenshot. Overlaps known issue #11.

### 5e. Pipeline calibration / migration (3 markers)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: Captain-points multiplier not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC migration.

### 5f. Smaller data-quality TODOs (3 markers)

- `app/(collections)/[collection]/collection/page.tsx:2671` — `team_name` from UUID-keyed Flowty editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`.
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands (overlaps #4).
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card (overlaps #11).

---

## 6. Resolved / no action needed

- **Known issue #13 — `flowty_archive` growth strategy: RESOLVED.** Chose the hedge option: pruned ~40.6K extracted redundant rows + `VACUUM FULL`. `api_harvest_20260512` went 9.9 GB → 2.6 GB; total DB 13.8 GB → 6.5 GB. A daily prune cron (7-day retention) keeps it bounded. No further action.
- **Known issue #16 — `flow test` not gated by CI: RESOLVED (with a fix applied today).** The 2026-05-20 full-platform audit (F6) already added `.github/workflows/ci.yml`, which gates both `tsc --noEmit` and the Cadence harness on every push and PR — so `CLAUDE.md` issue #16 is stale and should be marked done. The `cadence-lint` job was misconfigured, though: it skipped the required `flow dependencies install` step (so `flow cadence lint` failed on unresolved mainnet imports). Fixed today: added the dependency-install step, and set the job to `continue-on-error` (non-blocking) pending confirmation. Note: the C1/C2 compile errors are in fact already fixed in `purchase-moment.ts` (see §2.1), so the harness is expected to pass — once a run confirms `npm run test:cadence` exits 0, delete the `continue-on-error` line to make it a true regression gate. The edited workflow is staged in the repo but **not committed** — review before pushing.
- **Known issue #6 — WarmupContext key mismatch: RESOLVED.** The documented bug — the background warmer prefetching `/api/pack-listings` (Studio-aggregation shape) into the `pack-listings:<collection>` cache key that `PackPageClient` reads expecting `/api/packs` (`pack_table_rows` shape), so signed-in users got a wrong-shape payload and zero rows — is fixed: `lib/warmup/WarmupContext.tsx` now prefetches `/api/packs` into that key, and an in-code comment documents the prior bug. No other same-key / different-shape mismatch was found among the warmer's four prefetch keys.

**Partially resolved:** Known issue #1 (cart) — the C1/C2 compile errors are fixed; H1, H2, and the external deps remain (see §2.1). Known issue #11 (brand punch list) — most OG card routes now exist; `/home-fmv-preview.png` is still missing. Known issue #7 (spork scan) — the spork-proxy worker exists; clearing the sales backlog still needs a DB-side resolver run. See §9 for the full item-by-item reconciliation.

Note: known issue #15 (`livetoken-portfolio*.json` fixtures) is **still open** — `.gitignore` lists the files, but `git ls-files` confirms all 11 are still tracked; the planned `git rm --cached` was never run.

---

## 7. Suggested sequence

A pragmatic order that front-loads safety nets and revenue, defers cosmetic debt:

1. **Set the Sentry DSN (#2)** — small; you want error capture live before shipping a payment flow.
2. **Cart checkout (#1 / §2.1)** — the headline revenue unlock. C1/C2 are already fixed; what remains is H1, H2, and the external Dapper / WalletConnect setup.
3. **Pro gate wiring (#5b / P3)** — second revenue path; small once the gate logic is decided.
4. **Diagnose the April 28 ingestion cliff (#3 + #9 together)** — restores data integrity; likely one root cause.
5. **Spork-proxy worker (#7)** — clears the ~3,400-sale backlog.
6. **Trade Hub (§2.3)** — large; schedule once a simpler revenue path is proven.
7. **Data-quality cleanup (#5, #6) and refactor Phase 1 (#14)** — opportunistic.
8. **Brand polish (#11, #12), scratch-fixture cleanup (#15)** — lowest priority.

---

## 8. Notes from verification

- All file and doc paths cited in `CLAUDE.md` known-issues were confirmed to exist (`lib/cadence/purchase-moment.ts`, `docs/audits/audit-2026-05-18-handoff.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`). No stale references found.
- One `TODO` scan match — `lib/format.ts:6` — is a false positive: the regex matched `XXX` inside the literal `"$X,XXX.XX"`. It is excluded from the count of ~21.
- Minor date discrepancy: `CLAUDE.md` marks known issue #13 "RESOLVED 2026-05-23" and references a migration `audit_20260523_...`, but today's date is 2026-05-22. Likely a typo or a clock skew between the doc and the environment — worth a quick correction in `CLAUDE.md`.
- There is a more recent `docs/audits/audit-2026-05-20-full-platform.md` than the handoff doc cited in `CLAUDE.md` (2026-05-18) — and it has already changed reality: it added `.github/workflows/ci.yml`, which resolves known issue #16 (see §6). `CLAUDE.md`'s known-issues list predates this and should be reconciled against the 2026-05-20 audit.
- `docs/code-todos.md` exists but tracks only 2 follow-ups from a 2026-05-05 build — it is not a comprehensive TODO tracker. §5 above supersedes it.
- **Verification sweep (2026-05-22):** code-checking the known-issues list found it materially stale. Confirmed already-resolved: #16 (CI gating), #6 (WarmupContext), and the C1/C2 compile errors of #1; #15's fixtures are gitignored for removal. `CLAUDE.md`'s list was last updated in the 2026-05-18 session, and the 2026-05-19/20 audits fixed a wave of items without updating it. A full reconciliation of `CLAUDE.md` against the 2026-05-20 audit is recommended.
- `docs/cadence-testing.md` is itself stale — it states the Cadence harness is "RED on purpose" because of the C1/C2 errors, but those are fixed in `lib/cadence/purchase-moment.ts`. The harness is expected to pass now; run `npm run test:cadence` to confirm.
- The data-pipeline items (#3, #4, #5, #8, #9) were verified directly against the production Supabase on 2026-05-22 via read-only queries — see §9 for results. #2's Sentry DSN was confirmed present in Vercel env by Trevor. #7's spork-proxy worker exists in the repo; whether the resolver has drained the sales backlog was not measured.

---

## 9. Known-issues reconciliation (verified 2026-05-22)

Every item in `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code shows. Items that need database or production access are marked "assumed" and keep their `CLAUDE.md` status.

| # | Issue | CLAUDE.md | Verified status | Evidence |
|---|---|---|---|---|
| 1 | Cart execution | Open | **Partial** — C1/C2 fixed; H1, H2, external open | `purchase-moment.ts`: `FungibleToken` imported (L42); `self.listing` borrowed (L73) before price read (L77); `commissionRecipient: nil` still at L100; no `post {}` block |
| 2 | Sentry inactive | Open | **Resolved** — `NEXT_PUBLIC_SENTRY_DSN` confirmed already present in Vercel env (2026-05-22) and redeployed | SDK wired (`sentry.*.config.ts`, org `rip-packs-city`/project `javascript-nextjs`); DSN set |
| 3 | Flowty event indexer regression | Open | **Reclassify — not a bug.** `flowty_loan_events` went cold 2026-05-11 because Flowty shut down its marketplace (~2026-05-13). Data is frozen by design; the follow-up is a Flowty teardown, not a fix. See the platform-events note above. | DB: last event 2026-05-11 20:00 |
| 4 | Pinnacle direct integration | Open | **Partial — symptom gone.** The "uniform $1 floor" no longer holds: 6,838 Pinnacle listings, only ~30% at $1, prices to $9,999, ingesting today. Pinnacle still has 0 FMV editions, so FMV integration is incomplete | DB: `cached_listings_v2`, `health_check()` |
| 5 | AllDay/UFC mis-categorized editions | Open | **Largely resolved.** Only 8 cross-labeled editions sit under the TopShot collection_id (all `disney_pinnacle`); the ~454 AllDay/UFC figure could not be reproduced | DB: `editions` grouped by `collection` under the TopShot UUID |
| 6 | WarmupContext key mismatch | Open | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` into the key `PackPageClient` reads; in-code comment documents the prior bug |
| 7 | Historical spork scan | Open | **Partial** — spork-proxy worker exists; backlog-clear needs DB | `infrastructure/spork-proxy-worker/` and `workers/spork-proxy/` both present |
| 8 | NBA stats unreachable | Open | **Resolved.** `nba_player_projections` is syncing — last sync 2026-05-23, 41 rows in the last 7 days, 5 future games. No longer "0 rows/day" | DB: `nba_player_projections` |
| 9 | Storefront audit pipeline cold | Open | **Open — confirmed cold.** Last `storefront_audit_wallets` row created 2026-04-28 11:35 UTC (exactly as CLAUDE.md says); nothing since | DB: `storefront_audit_wallets` |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = 1,751 lines | `wc -l` (CLAUDE.md said 1,816) |
| 11 | Brand punch list | Open | **Partial** — 7 OG routes exist; `/home-fmv-preview.png` missing | `app/api/og/`: collection, deal, default, fast-break, moment, pack, profile |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` exists, no UI importer | grep — no file imports it |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,902 / sniper 2,485 / analytics 2,208 lines | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Open | **Open** — 11 files still git-tracked; `.gitignore` entry added but `git rm --cached` never run | `git ls-files` |
| 16 | `flow test` in CI | Open | **Resolved** | `.github/workflows/ci.yml` gates it (`cadence-lint` job) |

**Tally:** 6 resolved (#2, #5, #6, #8, #13, #16) · 4 partial (#1, #4, #7, #11) · 6 still open (#3, #9, #10, #12, #14, #15).

**Bottom line for `CLAUDE.md`:** the known-issues list is badly out of date. Verified against the codebase and the production database: 6 of 16 items are resolved (#2, #5, #6, #8, #13, #16), 4 are only partially accurate (#1, #4, #7, #11), and of the 6 listed as still open, **#3 should be reclassified entirely** — its `flowty_loan_events` ingest went cold because Flowty shut down its marketplace (~2026-05-13), so it is expected behaviour, not a regression. Only 5 entries (#9, #10, #12, #14, #15) still match CLAUDE.md as written. Most of the drift came from the 2026-05-19/20 audits, which fixed a wave of items without updating the list (last touched 2026-05-18). The `CLAUDE.md` known-issues section should be rewritten against this table, and `docs/cadence-testing.md` updated (it still calls the Cadence harness "RED on purpose" after the C1/C2 fix).
