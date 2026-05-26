# Rip Packs City — Project Health Report

**Date:** 2026-05-25
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Recent Sessions §) and a full-tree `TODO/FIXME/HACK/XXX` scan.
**Scope:** A single consolidated, themed view of open work — 17 tracked known-issue slots, 3 prioritized actions, and 23 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-05-22.md` (still in repo). This regeneration mirrors its structure.

> This is a snapshot. `CLAUDE.md` remains the source of truth; this doc reorganizes it for triage and adds an in-code TODO inventory `CLAUDE.md` does not track. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since the 2026-05-22 report — strategic pivot.** On 2026-05-24 the project committed to an **intelligence-first** framing: the goal is a product more useful than nbatopshot.com itself. As a direct result, **the entire "Critical path — revenue blockers" section of the prior report no longer applies.** Cart / in-app live-buy is **shelved** (Known issue #1); the Pro paywall, Stripe, and public launch are **tabled until RPC has 50+ weekly active users**. The new critical path is data-intelligence quality — chiefly the FMV pipeline. The prior report's §2.1 (Cart), §2.2 (Pro gate), and §2.3 (Trade Hub) are superseded by §2 below.

> **Platform events (May 2026) — still material context.** **(1) Flowty shut down its marketplace (~2026-05-13).** All Flowty-dependent infrastructure is dead weight pending teardown — see Prioritized action #1. **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked (#1–#17) | 17 | #17 is new this week — see §3 |
| Known issues — resolved | 8 | #2, #3, #5, #6, #8, #13, #16 + the fmv-recalc silent stall — see §6 |
| Known issues — open / partial | 7 | #7, #10, #11, #12, #14, #15, #17 — see §3 / §9 |
| Known issues — shelved by decision | 1 | #1 Cart — intelligence-first decision, not a defect |
| Known issues — retired | 1 | #9 Storefront audit pipeline — de-facto retired |
| Untracked open feature | 1 | Trade Hub / trade-escrow — stubbed, not in `CLAUDE.md` known-issues — see §3 |
| Prioritized next actions | 3 | All net data-intelligence / housekeeping; 0 revenue items by design |
| In-code TODO markers | 23 across 12 files | 1 additional match is a false positive — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** The platform is operationally stable — `CLAUDE.md` reports 0% failure across 23 active cron pipelines, and three Cowork DB sessions in the last 48h (May 24 ×2, May 25) hardened the FMV write path. Risk is now concentrated in **one place: FMV data quality**. A rogue FMV writer (`fmv_from_sales` / `sales_wap_v1`) was retired and dropped this week, and a multi-hour `fmv-recalc` silent stall was caught and fixed on May 25 — both good — but the underlying lever per `CLAUDE.md` is **throughput**: `fmv-recalc` is only ~13% through its first full sweep, having priced ~5,105 editions against ~9,273 traded in the last 30 days. Everything else (refactors, brand polish, page tune-ups) is genuinely secondary.

### Themes

| Theme | Items |
|---|---|
| Data-intelligence quality (the new critical path) | FMV pipeline throughput + stall watch (§2.1), spork-scan resolver / unmapped-sales backlog (#7, §2.2) |
| Housekeeping — dead infrastructure | Flowty teardown (Priority #1, §2.3), `special-serial-sweep` stub, `lib/pro/gate.tsx` dead scaffold |
| Tech debt / refactor | `/dashboard` migration (#10), monolith pages (#14), scratch fixtures (#15) |
| Page polish | Pack/Moment/Set tune-up (#17), brand punch list (#11), Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (untracked), Cart (#1, shelved by decision) |
| Deferred hardening (intentional) | Public INSERT-policy tables, `owner_key`→`user_id` migration, `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

With revenue work shelved by decision, the critical path is the data-intelligence surface that differentiates RPC from Top Shot's own site. Per `CLAUDE.md` Prioritized next actions (2026-05-24): harden the core intelligence surfaces, run the spork-scan resolver, and finish the Flowty teardown.

### 2.1 FMV pipeline — throughput is the lever — `Severity: High · Effort: Medium`

The FMV pipeline got significant attention this week and is now structurally cleaner, but quality is still throughput-bound:

- **`fmv_from_sales` rogue writer — fully retired and dropped (May 24–25).** It was an unfiltered `AVG(price_usd)` writer tagged `algo_version='sales_wap_v1'` with an upward bias, owning 242 of 760 HIGH-confidence editions with values up to ~759× off. Neutralized to a no-op on May 24, `DROP FUNCTION` on May 25, plus clobber-residue purges. `fmv-recalc` `'1.7.0'` is now the sole sales-path FMV owner. **No further action — this is done; listed here as context.**
- **`fmv-recalc` silent stall — resolved May 25 (`dd84526`).** The route stalled 2026-05-24 22:03 → 2026-05-25 14:53 (~17h) because an unchunked `.in("edition_id", …)` blew past PostgREST's URL cap and supabase-js surfaced it as a non-throwing error, exiting `after()` before `log_pipeline_run` — so the failure was invisible from every external signal. Fixed by chunking the `.in()` sites at 500 and adding `log_pipeline_run` to the fatal-catch path. **Worth a follow-up:** confirm `pipeline_runs` now records a row on the next induced failure, so a future stall surfaces within one cron tick.
- **Throughput is the open lever.** Per the 2026-05-24 platform pass, `fmv-recalc` has priced ~5,105 editions ever against ~9,273 traded in 30 days, and is ~13% through its first full sweep of 262,733 sales (~9 days to finish at current pace). `DEFAULT_LIMIT` was raised 1k→2.5k on 2026-05-24 (`43c8d9c`); recent-edition-first chunking and a faster cron cadence are still to do and are the single biggest FMV-quality win.

Suggested next step: accelerate the sweep (recent-edition-first ordering + faster cron), then verify the stall fix's logging actually fires.

### 2.2 Spork-scan resolver / unmapped-sales backlog (Known issue #7) — `Severity: High · Effort: Medium`

The `spork-proxy` worker exists (`infrastructure/spork-proxy-worker/`, `workers/spork-proxy/`). What remains is running the unified spork-scan resolver to drain the structurally-unresolvable `unmapped_sales` backlog — the May 25 session's smoke test reported `still_unresolved: 2580` (sales with no edition mapping yet). This is Prioritized action #2. The related `supabase/functions/special-serial-sweep/index.ts` ownership-lookup edge function is a no-op shell (4 TODO stubs, §5c) and `docs/code-todos.md` item 2 notes the Deposit-event ownership scanner is DB-scaffold-only — both are part of the same spork-dependent cluster.

### 2.3 Flowty teardown (Prioritized action #1) — `Severity: Medium · Effort: Small–Medium`

The May 23 reframe removed the Flowty *frontend* UI, and the May 24 session removed the Flowty leg of `sniper-feed` and the Flowty-sourced FMV inputs in route code. But the dead infrastructure itself is still in the tree: the `supabase/functions/flowty-proxy/` edge function plus ~10 `lib/` and `app/` Flowty helper files (`lib/markets/flowty.ts`, `lib/flowty/fetchOpenOffers.ts`, `lib/pinnacle/flowty.ts`, `app/api/admin/flowty-analytics/route.ts`, `app/api/admin/refresh-flowty-analytics/route.ts`, `lib/flowty-flags.ts`, `lib/flowty-username.ts`, `lib/analytics/flowty-links.ts`, `lib/cadence/make-offer-flowty.ts`, `app/out/flowty/[momentId]/route.ts`). `docs/audits/flowty-teardown-plan-2026-05.md` is the plan of record — Phases 2 and 3 are marked done; the remaining archive/delete pass is housekeeping, low-risk.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Data-intelligence quality

| # | Issue | Severity | Effort |
|---|---|---|---|
| 7 | Historical spork scan — partial. `spork-proxy` worker exists; the unified spork-scan resolver still needs to run to clear the `unmapped_sales` backlog (`still_unresolved: 2580` as of the May 25 smoke test). | High | Medium |
| — | FMV throughput — `fmv-recalc` ~13% through its first full sweep; accelerating it is the biggest FMV-quality win. Tracked in `CLAUDE.md` Recent Sessions / Architecture, not the numbered known-issues list. | High | Medium |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up — **new this week.** Brand-token consistency and a large batch of data-accuracy fixes shipped (commits `5c0af8a`→`8d8721e`→`2b7ce7f`→`61f5586`, plus a 2026-05-24 batch). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page), and tail Set/Moment/Pack V/D items. Point-in-time detail in `PACK_PAGES_AUDIT_2026-05-22.md` / `MOMENT_PAGES_AUDIT_2026-05-22.md` / `SET_PAGES_AUDIT_2026-05-22.md` (now partially superseded). | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — partial. 7 per-feature OG routes confirmed present (`/api/og/{collection,deal,default,fast-break,moment,pack,profile}`). Still missing: the `/home-fmv-preview.png` home screenshot (confirmed absent from `public/`). Fast Break / RTR / admin tokenize once stable. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, 198 lines, ~29 items) — shelved, still no UI. Confirmed: no file imports it. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = 1,751 lines (`CLAUDE.md` says ~1,750 — accurate). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` 2,896, `analytics/page.tsx` 2,208, `sniper/page.tsx` **2,073**. Note `CLAUDE.md` #14 still cites sniper at ~2,485 — **stale**; the May 23 reframe cut ~565 lines of cart/offer/banner code across three files and sniper is now ~2,073. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md`. | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — `CLAUDE.md` says 11 files still git-tracked. **Working-tree status has changed:** the `livetoken-portfolio*.json`, `test-gql.json`, `sniper.json`, and `nftlocker-*.json` files are no longer present anywhere in the working tree; only `flowty-locker-test.json` remains. Git-tracked status could not be confirmed (see §8 — the repo's `.git/index` is unreadable in this environment). | Low | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence in `lib/cadence/purchase-moment.ts` stays dormant and revivable. Not a defect — listed for completeness. | n/a (shelved) | n/a |
| — | Trade Hub / trade-escrow — **not in `CLAUDE.md` known-issues; recommend adding it.** All five trade transactions in `lib/trade-escrow/fcl-submit.ts` are TODO stubs (§5a) and `app/dashboard/trade-hub/TradeChainPanel.tsx` surfaces a literal "Cancel signing not wired yet" error. The off-chain plumbing — `app/api/trade-chain/{propose,execute,deposit-callback}`, `app/api/admin/reclaim-expired-trades` — is now present in the working tree and imports the stubs (prior `docs/trade-escrow/STATUS.md` described it as "local disk only"). Tracked separately in `docs/trade-escrow/STATUS.md`. | Medium | Large |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps via CHECK constraints, a `created_at` rate-limit column/trigger, a `bot_score` column from BotID, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); neither is referenced by any `/api` route. Migrate to `user_id` + RLS when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot healthy at 2,578/2,987 (~86%). Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`.

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied in earlier sessions, but the current concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — relevant if "harden the intelligence surfaces" (Priority #3) ever revisits alerting.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — archive the dead Flowty indexer / analytics MVs / `flowty-proxy` edge function / sniper buy-leg infrastructure. | §2.3 — housekeeping |
| 2 | Run the spork-scan resolver to clear the unresolved-sales backlog. | Known issue #7 — §2.2 |
| 3 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely differentiated from Top Shot's own site. | §2.1 + ongoing |

*Done — the Market/Sniper reframe to outbound "View Listing" links shipped 2026-05-23 (`b19d8f2`).*

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met — this is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A full-tree scan of `*.{ts,tsx,js,jsx,mjs,cdc}` (node_modules / .next / .git excluded) found **24 `TODO/FIXME/HACK/XXX` matches — 23 real markers across 12 files, plus 1 false positive** (see §8). `CLAUDE.md` does not track these; `docs/code-todos.md` covers only 2 follow-ups. Grouped by theme:

### 5a. Trade Hub / escrow — feature stubbed (8 markers, 2 files)

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 60, 69, 87, 94, 103) — the header block plus all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`. These stubs are imported and called by live API routes (`app/api/trade-chain/{propose,execute}`, `app/api/admin/reclaim-expired-trades`), which therefore return fake tx ids.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (×2, lines 186, 196) — cancel callback unwired; the UI sets the error string `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`.

→ Largest single cluster. See §3 (Stalled features).

### 5b. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file)

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. Related to Known issue #7 and `docs/code-todos.md` item 2 (the Deposit-event ownership scanner is DB-scaffold-only).

### 5c. Cadence test coverage gap (2 markers, 1 file)

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; it needs a second `NonFungibleToken`-conforming contract in the emulator test env. A single missing test, double-counted because the comment block both narrates it and tags `// TODO:`. (Not flagged in the prior report — either newly added or missed by the prior scan's file-type filter; see §8.)

### 5d. Marketing / home placeholders (2 markers, 1 file)

- `components/HomePageMarketing.tsx` (lines 200, 611) — homepage stat counters are hardcoded strings not wired to live data (`/api/health-check`); a placeholder card needs a real wallet-analytics screenshot. Overlaps Known issue #11.

### 5e. Pipeline calibration / migration (3 markers, 3 files)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5f. Smaller data-quality / polish TODOs (3 markers, 3 files)

- `app/(collections)/[collection]/collection/page.tsx:2665` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`.
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps Known issue #11.

### 5g. Monetization gate stub — dead scaffold (1 marker, 1 file)

- `lib/pro/gate.tsx:25` — `// TODO: wire Stripe subscription check`. The `ProGate` in this file is a pure pass-through, **but it is imported by nothing** — a grep for `pro/gate` finds only the file itself. The functional Pro gate is the separate `components/ProGate.tsx`, which already calls `/api/pro-status` and `/api/stripe/checkout` (a full Stripe stack now exists: `lib/stripe.ts`, `components/pricing/StripeSubscribeButton.tsx`, `app/api/stripe/{checkout,portal,webhook}`, `app/pricing/page.tsx`). So this TODO sits in **unused scaffold code** and is effectively a delete-candidate, not blocking work. The prior report listed it as a live monetization blocker — that is no longer accurate.

---

## 6. Resolved / no action needed

Verified against the codebase and `CLAUDE.md` Recent Sessions:

- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** ~17h stall on May 24–25; root cause an unchunked `.in()` exceeding PostgREST's URL cap, surfaced silently. Fixed by chunking at 500 and adding `log_pipeline_run` to the fatal-catch path. See §2.1 for the suggested verification follow-up.
- **#2 Sentry error capture — RESOLVED.** `NEXT_PUBLIC_SENTRY_DSN` confirmed set in Vercel env and redeployed; SDK wired (org `rip-packs-city`, project `javascript-nextjs`).
- **#3 Flowty event indexer "regression" — RESOLVED / reclassified.** Not a bug — `flowty_loan_events` went cold because Flowty shut down its marketplace (~2026-05-13). Expected behaviour; the follow-up is the teardown (Priority #1), not a fix.
- **#4 Pinnacle FMV — RESOLVED (verified 2026-05-24).** `pinnacle_fmv_snapshots` holds 425 editions (every Pinnacle edition traded in 90d), 84% HIGH+MEDIUM, recomputed daily by algo `pinnacle-1.0.0`. Pinnacle FMV lives in its own table, not the uuid-keyed `fmv_snapshots`. This corrects the prior report, which still listed #4 as partial.
- **#5 AllDay/UFC mis-categorized editions — RESOLVED.** Only 8 stray editions remain under the TopShot collection_id (all `disney_pinnacle`), not the ~454 originally claimed.
- **#6 WarmupContext key mismatch — RESOLVED.** `WarmupContext.tsx` now prefetches `/api/packs` into the key `PackPageClient` reads.
- **#8 NBA stats / projections — RESOLVED.** `nba_player_projections` is syncing again (no longer 0 rows/day).
- **#9 Storefront audit pipeline — RETIRED (verified 2026-05-24).** It is a manual script (`scripts/scan-historical-storefront.mjs`), not a deployed cron or route — cold simply because nobody runs it. De-facto retired; no operational action. `storefront_audit_wallets` is harmless (an optional drop candidate). This supersedes the prior report, which listed #9 as confirmed-cold open work.
- **#13 `flowty_archive` growth — RESOLVED.** Option-B prune + `VACUUM FULL`; total DB 13.8 → 6.5 GB.
- **#16 `flow test` CI gating — RESOLVED.** `.github/workflows/ci.yml` gates `tsc` + the Cadence harness; the `cadence-lint` job's missing `flow dependencies install` step was fixed 2026-05-22 (runs `continue-on-error`, non-blocking, pending a confirmed green run).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing — front-loads data quality, defers cosmetic debt:

1. **Accelerate `fmv-recalc` throughput (§2.1).** The single biggest intelligence-quality win — recent-edition-first chunking + a faster cron cadence to finish the first full sweep.
2. **Verify the fmv-recalc stall fix logs (§2.1).** Confirm `pipeline_runs` records a row on an induced failure, so the next silent stall surfaces within one cron tick. Small, high-leverage.
3. **Run the spork-scan resolver (#7 / §2.2).** Clears the ~2,580-row `unmapped_sales` backlog.
4. **Flowty teardown (Priority #1 / §2.3).** Low-risk housekeeping; removes ~11 dead files + the `flowty-proxy` edge function.
5. **Pack/Moment/Set tail items (#17).** Mostly shipped; finish modal a11y verification + the Set aggregate-RPC fix opportunistically.
6. **Tech-debt cleanup — scratch fixtures (#15), monolith refactor Phase 1 (#14).** #15 is trivial; #14 Phase 1 is a zero-risk leaf-component extraction.
7. **Trade Hub (untracked feature).** Large; only schedule if it becomes a product priority — and add it to `CLAUDE.md` known-issues first so it isn't lost between two trackers.
8. **Brand polish (#11, #12), `/dashboard` migration (#10).** Lowest priority.

Housekeeping: delete the unused `lib/pro/gate.tsx` scaffold (§5g) whenever convenient — it carries a misleading TODO.

---

## 8. Notes from verification

- **All file and doc paths cited in `CLAUDE.md`'s known-issues / prioritized-actions / recent-sessions sections were confirmed to exist** — including `docs/audits/cowork-platform-pass-2026-05-24.md`, `docs/handoff-2026-05-24.md`, `docs/audits/wmc-edition-key-corruption-2026-05-24.md`, `docs/audits/flowty-teardown-plan-2026-05.md`, `docs/audits/fmv-confidence-improvement-2026-05.md`, `docs/audits/purchase-moment-2026-05.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `PACK_PAGES_AUDIT_2026-05-22.md`, `MOMENT_PAGES_AUDIT_2026-05-22.md`, `SET_PAGES_AUDIT_2026-05-22.md`, `docs/sessions/2026-05.md`, `docs/sessions/2026-04.md`. **No stale doc references found.**
- **One TODO scan match is a false positive:** `lib/format.ts:6` — the regex matched `XXX` inside the format-string literal `"$X,XXX.XX"`. Excluded from the count of 23 (same false positive the prior report flagged).
- **TODO count delta vs. the prior report:** prior reported ~21 real markers across 11 files; this scan finds 23 across 12. The +2 / +1 is `cadence/tests/RPCTradeEscrow_test.cdc` (the Cadence test-coverage gap, §5c) — either newly added or missed by the prior scan's file-type filter. All other markers match the prior inventory.
- **Verified line counts** (`wc -l`): `app/(collections)/[collection]/collection/page.tsx` 2,896 · `app/(collections)/[collection]/analytics/page.tsx` 2,208 · `app/(collections)/[collection]/sniper/page.tsx` **2,073** · `app/dashboard/page.tsx` 1,751 · `lib/blazers-trivia.ts` 198. `CLAUDE.md` #14's sniper figure (~2,485) is stale post the May 23 reframe — flagged in §3.
- **`livetoken-portfolio*.json` (#15):** the fixtures are no longer present in the working tree (only `flowty-locker-test.json` remains); `.gitignore` lists all of them. Whether they are still git-*tracked* could not be verified — **git operations are unavailable in this environment** (`git status`, `git ls-files` all fail with `fatal: .git/index: index file smaller than expected`). This is most likely a sandbox mount artifact, not a repo defect, but it means git-tracked status and uncommitted-change state could not be checked for any file in this report. Treat #15 as "removed from working tree, tracking unconfirmed."
- **`lib/pro/gate.tsx` (§5g)** was confirmed unimported via grep; its TODO is dead scaffold, not a live blocker. The functional Pro gate is `components/ProGate.tsx`.
- **DB-side facts** (FMV sweep coverage, `unmapped_sales: 2580`, pipeline failure rate, Pinnacle FMV row counts) are reported as stated in `CLAUDE.md` Recent Sessions — they were **not independently verified** against the production Supabase in this run (no DB access was used).
- This report did not edit `CLAUDE.md` or any source file and did not touch git, per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-05-25)

Every `#1–#17` slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `CLAUDE.md` Open #1 (2026-05-24 intelligence-first decision); `lib/cadence/purchase-moment.ts` retained dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN confirmed in Vercel env; SDK wired |
| 3 | Flowty event indexer regression | Resolved | **Resolved / reclassified** — Flowty shut down ~2026-05-13; cold by design | `CLAUDE.md` Resolved §; Flowty teardown is the follow-up |
| 4 | Pinnacle FMV | Resolved | **Resolved** | `pinnacle_fmv_snapshots` 425 editions, 84% HIGH+MEDIUM, algo `pinnacle-1.0.0` (per `CLAUDE.md` 2026-05-24) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray (`disney_pinnacle`) | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | Historical spork scan | Open (partial) | **Open — partial** | `infrastructure/spork-proxy-worker/` + `workers/spork-proxy/` present; resolver not yet run (`unmapped_sales: 2580`) |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired | **Retired** — manual script, not a cron/route | `scripts/scan-historical-storefront.mjs` exists; nothing schedules it |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = 1,751 lines | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — partial** — 7 OG routes exist; `home-fmv-preview.png` missing | `ls app/api/og/`; `public/home-fmv-preview.png` absent |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | grep — no file imports it |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,896 / analytics 2,208 / sniper **2,073** (`CLAUDE.md` cites sniper ~2,485 — stale) | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Open | **Open — working tree cleaned; tracking unconfirmed** | fixtures absent from working tree; git unavailable (§8) |
| 16 | `flow test` in CI | Resolved | **Resolved** | `.github/workflows/ci.yml` gates it |
| 17 | Pack/Moment/Set page tune-up | Open (new) | **Open — mostly shipped** | brand-token + data-accuracy batches landed (`5c0af8a`→`61f5586`); a11y + Set-RPC tail remains |

**Tally:** 8 resolved (#2, #3, #4, #5, #6, #8, #13, #16) · 1 shelved by decision (#1) · 1 retired (#9) · 7 open or partial (#7, #10, #11, #12, #14, #15, #17).

**Bottom line for `CLAUDE.md`:** the known-issues list is in good shape — it was reconciled on 2026-05-23 and the Resolved subsection is accurate. Two small drift points to correct on the next pass: (a) #14 still cites `sniper/page.tsx` at ~2,485 lines, but it is ~2,073 after the May 23 reframe; (b) #15 says "11 files still git-tracked" — the fixtures are gone from the working tree, so this is at least partially stale (git-tracked status unverifiable here). Separately, **Trade Hub / trade-escrow remains untracked in the known-issues list** despite being a partially-built feature with 8 in-code TODO stubs and live routes returning fake tx ids — the prior report recommended adding it; that recommendation stands.
