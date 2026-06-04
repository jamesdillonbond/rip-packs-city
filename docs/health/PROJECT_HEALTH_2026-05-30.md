# Rip Packs City — Project Health Report

**Date:** 2026-05-30
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §) and a full-tree, gitignore-aware `TODO/FIXME/HACK/XXX` scan.
**Scope:** A single consolidated, themed view of open work — 17 tracked known-issue slots, 2 prioritized actions, and 42 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-05-25.md` (5 days ago, still in repo). This regeneration mirrors its structure; `PROJECT_HEALTH_2026-05-22.md` is also still present.

> This is a snapshot. `CLAUDE.md` remains the source of truth; this doc reorganizes it for triage and adds an in-code TODO inventory `CLAUDE.md` does not track. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since the 2026-05-25 report — a new strategic workstream + a critical-path item cleared.** Two things moved this week. **(1) Multi-chain thesis confirmed (2026-05-30).** RPC is now explicitly framed as a *sports / IP digital collectibles intelligence platform* with Flow as "chain one of N," and the chain-abstraction groundwork (Phases C/D/E) shipped — a `collection_chains` view, a two-field `ChainType` model in `lib/collections.ts`, and a Flow-primitives reorg under `lib/chains/flow/` behind re-export shims. This is net-new since last week and introduces a new (intentional, low-risk) debt tail — see §2.3 / §5a. **(2) The spork-scan / `unmapped_sales` critical-path item (old §2.2) is resolved.** Known issue #7 was reclassified — the backlog was never spork-era data; it was a starved AllDay resolver, fixed 2026-05-25. So the prior report's two-item critical path is now effectively one (FMV) plus housekeeping. Separately, a **large FMV hardening wave** landed (Step 6 self-perpetuating NO_DATA cycle fixed, batched upsert RPCs, NO_DATA recovery).

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — all Flowty-dependent infrastructure is dead weight pending teardown (now the #1 prioritized action). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only.

> **New operational reality — autonomous Cowork tasks.** Two scheduled tasks now run against this repo: `rpc-daytime-monitor` (read-only health sweeps, ~every 3h, appends to `docs/overnight/inbox/`) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 genuinely-low-risk changes to `main`, each independently verified, with auto-revert). Shared state lives in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). A `docs/FREEZE.md` halts all autonomous shipping. This means some items below may move without a human in the loop — check `docs/overnight/ledger.md` before acting.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked (#1–#17) | 17 | Same slate as last week |
| Known issues — resolved | 9 | #2, #3, #4, #5, #6, #7, #8, #13, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | 6 | #10, #11, #12, #14, #15, #17 — see §3 / §9 |
| Known issues — shelved by decision | 1 | #1 Cart — intelligence-first decision, not a defect |
| Known issues — retired | 1 | #9 Storefront audit pipeline — de-facto retired |
| Untracked open feature | 1 | Trade Hub / trade-escrow — stubbed, not in `CLAUDE.md` known-issues — see §3 |
| Net-new workstream | 1 | Multi-chain chain-abstraction — Phases C/D/E shipped; Phase F gated — see §2.3 |
| Prioritized next actions | 2 | Down from 3 — the spork resolver is done. Both are data-intelligence / housekeeping; 0 revenue items by design |
| In-code TODO markers | 42 across 31 files | +19 vs last week (almost all Phase-D shims). 2 additional matches are false positives — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** The platform is operationally stable — `CLAUDE.md` reports 0% failure across 23 active cron pipelines, and the FMV write path took a substantial hardening pass this week (the self-perpetuating Step-6 NO_DATA cycle was fixed, the two `upsert_*_marketplace_fmv` RPCs were rewritten set-oriented to kill connection-pool timeouts, and ~146 perpetually-NO_DATA editions were recovered). Risk is now concentrated in three places, in descending order: **(1) FMV throughput** — still the lever, with `fmv-recalc` only ~13% through its first full sweep per `CLAUDE.md`; **(2) the chain-abstraction cleanup tail** — 18 re-export shims each carry a "repoint callers and delete" TODO; and **(3) Flowty teardown** — pure housekeeping. Everything else (refactors, brand polish, page tune-ups) remains genuinely secondary.

### Themes

| Theme | Items |
|---|---|
| Data-intelligence quality (the critical path) | FMV throughput + batched-RPC production verification (§2.1); `topshot_squeeze_board` / `/insights/squeeze` shipped this week |
| Multi-chain foundation (net-new) | Chain-abstraction Phases C/D/E shipped; Phase-D shim cleanup (18 chain-rename TODOs, §5a); Phase F gated on Phase D (§2.3) |
| Housekeeping — dead infrastructure | Flowty teardown (Priority #1, §2.2); `special-serial-sweep` stub; `lib/pro/gate.tsx` dead scaffold |
| Tech debt / refactor | `/dashboard` migration (#10), monolith pages (#14), scratch fixtures (#15) |
| Page polish | Pack/Moment/Set tune-up (#17), brand punch list (#11), Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (untracked), Cart (#1, shelved by decision) |
| Deferred hardening (intentional) | Public INSERT-policy tables, `owner_key`→`user_id` migration, `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

With revenue work shelved by decision and the spork/unmapped-sales item resolved, the critical path narrows to FMV quality plus two housekeeping/structural workstreams. Per `CLAUDE.md` Prioritized next actions (2026-05-24 framing, still current): finish the Flowty teardown and harden the core intelligence surfaces.

### 2.1 FMV pipeline — throughput is the lever — `Severity: High · Effort: Medium`

The FMV pipeline got a heavy hardening pass this week and is the strongest it has been, but quality is still throughput-bound:

- **Step 6 self-perpetuating NO_DATA cycle — FIXED (`14ae144`).** `fmv-recalc` Step 6 ("stale freshness touch") filtered `computed_at < now() - 24h` *before* the `DISTINCT ON (edition_id) ORDER BY computed_at DESC`, so for a mixed-history edition (HIGH this week, NO_DATA last week) it grabbed the old NO_DATA row and re-stamped it forward as today — a durable cycle across cron ticks. Rewritten as a `latest` CTE (true latest-per-edition first), then filter `confidence <> 'NO_DATA'`. Live validation: touches 5,550 editions correctly, excludes 5,707 stale NO_DATA rows the old query re-cycled. **Done — context only.**
- **Batched `upsert_*_marketplace_fmv` RPCs — SHIPPED (TS + AllDay).** Both were rewritten from row-by-row PL/pgSQL loops into 5-step set-oriented transactions, fixing the 113–295s connection-pool / statement-timeout failures seen ~3× in 14d. The AllDay rewrite also fixed a latent correctness bug (an unordered `LIMIT 1` confidence read). **Open follow-up:** `CLAUDE.md` flags that the batched RPC is *still pending verification under production load* (next `topshot-fmv-populate` cron tick) — confirm a clean run in `pipeline_runs`.
- **NO_DATA recovery — SHIPPED (146 + round-2 editions).** Editions with 30+ recent sales but perpetual NO_DATA were repriced; TS HIGH+MED jumped 724→778. A residual ~44 actively-traded editions (5–29 sales/30d, below the 30+ threshold) still sit at NO_DATA and heal as the main sweep reaches them — not a regression.
- **Throughput is the remaining open lever.** Per the 2026-05-24 platform pass, `fmv-recalc` has priced ~5,105 editions ever against ~9,273 traded in 30 days and is ~13% through its first full sweep of 262,733 sales. `DEFAULT_LIMIT` was raised 1k→2.5k (`43c8d9c`); recent-edition-first chunking + a faster cron cadence are still to do and remain the single biggest FMV-quality win.

Suggested next step: verify the batched RPC's next production tick, then accelerate the sweep (recent-edition-first ordering + faster cron).

### 2.2 Flowty teardown (Prioritized action #1) — `Severity: Medium · Effort: Small–Medium`

The Flowty *frontend* UI was removed in the May 23 reframe and the Flowty leg of `sniper-feed` + the Flowty-sourced FMV inputs were removed in route code (May 24). The dead infrastructure itself is still in the tree: the `supabase/functions/flowty-proxy/` edge function plus ~10 `lib/` and `app/` Flowty helper files (`lib/markets/flowty.ts`, `lib/flowty/fetchOpenOffers.ts`, `lib/pinnacle/flowty.ts`, `app/api/admin/flowty-analytics/route.ts`, `app/api/admin/refresh-flowty-analytics/route.ts`, `lib/flowty-flags.ts`, `lib/flowty-username.ts`, `lib/analytics/flowty-links.ts`, `lib/cadence/make-offer-flowty.ts`, `app/out/flowty/[momentId]/route.ts`). `docs/audits/flowty-teardown-plan-2026-05.md` (confirmed present) is the plan of record — Phases 2 and 3 are marked done; the remaining archive/delete pass is low-risk housekeeping and is now the #1 prioritized action.

### 2.3 Chain-abstraction follow-through (net-new) — `Severity: Low–Medium · Effort: Medium`

The multi-chain groundwork shipped this week and is intentional, tracked, and low-risk — listed here because it is the largest *new* body of structural work and the source of most of this week's TODO growth:

- **Shipped:** `collection_chains` view + `idx_collections_chain` (migration `audit_20260530_collection_chains_view_and_chain_index`); Phase C two-field `ChainType` model in `lib/collections.ts` (`dbChain` on the 5 published collections); Phase D Flow-primitives reorg under `lib/chains/flow/` (canonical files confirmed present, e.g. `lib/chains/flow/flow.ts`, `lib/chains/flow/cadence/purchase-moment.ts`); Phase E chain-aware-reads audit (168 code surfaces classified; only 3 need chain-dispatch).
- **Open tail:** the Phase-D reorg left **18 re-export shims** at the old import paths (`lib/flow.ts`, `lib/topshot.ts`, etc.), each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a). The shims are bulletproof by design (zero caller breakage across 833 `@/lib/...` imports), so this is deferrable cleanup, not a bug. **Trap to remember (from `CLAUDE.md`):** `lib/flow.ts` is the only file with `export default`; its shim must keep `export { default }` alongside `export *` or default-importers break.
- **Gated:** Phase F (`ALTER TABLE collections ALTER COLUMN chain DROP DEFAULT`) is explicitly gated on Phase D completing. A `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql` placeholder exists (its `audit_2026XXXX_…` name is a date placeholder — see the §8 false-positive note). Chain two (Solana/Candy) is gated on a July 8 data tripwire — do not start chain-two code early.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Data-intelligence quality

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | FMV throughput — `fmv-recalc` ~13% through its first full sweep; recent-edition-first chunking + faster cron is the biggest FMV-quality win. Tracked in `CLAUDE.md` Recent Sessions / Architecture, not the numbered list. | High | Medium |
| — | Batched FMV RPC — verify the rewritten `upsert_topshot_marketplace_fmv` under production load on the next `topshot-fmv-populate` tick. | Medium | Trivial (watch) |

### Multi-chain foundation (net-new)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Intentional, low-risk. | Low | Medium |
| Phase F | `ALTER COLUMN chain DROP DEFAULT` — gated on Phase D finishing. Placeholder SQL committed. | Low | Small |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. Brand-token consistency + a large batch of data-accuracy fixes shipped (`5c0af8a`→`8d8721e`→`2b7ce7f`→`61f5586`, plus a 2026-05-24 batch). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page), and tail V/D items. Point-in-time detail in `PACK_PAGES_AUDIT_2026-05-22.md` / `MOMENT_PAGES_AUDIT_2026-05-22.md` / `SET_PAGES_AUDIT_2026-05-22.md` (partially superseded). | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — partial. 7 per-feature OG routes confirmed present (`collection`, `deal`, `default`, `fast-break`, `moment`, `pack`, `profile`). Still missing: `public/home-fmv-preview.png` (confirmed absent this run). Fast Break / RTR / admin tokenize once stable. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, 198 lines verified) — shelved, still no UI. Confirmed no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **1,751 lines** (verified; `CLAUDE.md` says ~1,750 — accurate). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,917**, `analytics/page.tsx` **2,218**, `sniper/page.tsx` **2,073**. `CLAUDE.md` #14 still cites sniper at ~2,485 — **stale** (the May 23 reframe cut it to ~2,073). Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — `CLAUDE.md` says 11 files still git-tracked. **Working tree is clean:** only `flowty-locker-test.json` remains; the `livetoken-portfolio*.json`, `test-gql.json`, `sniper.json`, and `nftlocker-*.json` files are gone. Git-*tracked* status unconfirmed (see §8). | Low | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence in `lib/cadence/purchase-moment.ts` (now a Phase-D shim → `lib/chains/flow/cadence/purchase-moment.ts`) stays dormant and revivable. Not a defect. | n/a (shelved) | n/a |
| — | Trade Hub / trade-escrow — **still not in `CLAUDE.md` known-issues; recommend adding it.** All five trade transactions in `lib/trade-escrow/fcl-submit.ts` are TODO stubs (§5b) and `app/dashboard/trade-hub/TradeChainPanel.tsx` surfaces the literal error `"Cancel signing not wired yet"`. Live API routes import the stubs, so they return fake tx ids. Tracked separately in `docs/trade-escrow/STATUS.md` (present). | Medium | Large |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps via CHECK constraints, a `created_at` rate-limit column/trigger, a `bot_score` column from BotID, possibly an edge rate-limiter. (Note: `outbound_clicks` instrumentation went live 2026-05-30, so it now has a real consumer.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); neither is referenced by any `/api` route. Migrate to `user_id` + RLS when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot healthy at 2,578/2,987 (~86%). Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`.

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied in earlier sessions, but the current concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — relevant if "harden the intelligence surfaces" (Priority #2) ever revisits alerting.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — archive the dead Flowty indexer / analytics MVs / `flowty-proxy` edge function / sniper buy-leg infrastructure. | §2.2 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely differentiated from Top Shot's own site. | §2.1 + ongoing |

*Done since last report — the AllDay `unmapped_sales` resolver was rewritten + un-starved (2026-05-25), which retired the prior report's spork-scan prioritized action; the `topshot_squeeze_board` view + `/api/public/insights/squeeze` route shipped (2026-05-30), advancing Priority #2.*

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met — this is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A full-tree, gitignore-aware scan of `*.{ts,tsx,js,jsx,mjs,cdc,sql}` found **44 `TODO/FIXME/HACK/XXX` matches — 42 real markers across 31 files, plus 2 false positives** (see §8). That is **+19 real markers vs. last week's 23** — almost entirely the Phase-D chain-rename shims (§5a). `CLAUDE.md` does not track these; `docs/code-todos.md` (present) covers only 2 follow-ups. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — NEW

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Largest cluster this week. Intentional, low-risk; the cleanup is "repoint 833 imports, then delete." See §2.3. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed (8 markers, 2 files)

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 60, 69, 87, 94, 103) — the header block plus all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`. Imported and called by live API routes (`app/api/trade-chain/{propose,execute}`, `app/api/admin/reclaim-expired-trades`), which therefore return fake tx ids.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI sets the error string `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`.

→ See §3 (Stalled features).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file)

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. Related to `docs/code-todos.md` item 2 (the Deposit-event ownership scanner is DB-scaffold-only).

### 5d. Pipeline calibration / migration (3 markers, 3 files)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files)

- `app/(collections)/[collection]/collection/page.tsx:2665` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`.
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps Known issue #11.
- `lib/pack-urls.ts:19` — `TODO(2026-05-26)`: verify the pack URL still resolves for sold-out drops. **NEW since last report.**

### 5f. Marketing / home placeholders (2 markers, 1 file)

- `components/HomePageMarketing.tsx` (lines 203, 653) — homepage stat counters are hardcoded strings not wired to live data (`/api/health-check`); a placeholder card needs a real wallet-analytics screenshot. Overlaps Known issue #11. (Lines shifted from last week's 200/611 — file edited, same 2 markers.)

### 5g. Cadence test coverage gap (2 markers, 1 file)

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; it needs a second `NonFungibleToken`-conforming contract in the emulator test env. Narrated once + tagged `// TODO:` once.

### 5h. Monetization gate stub — dead scaffold (1 marker, 1 file)

- `lib/pro/gate.tsx:25` — `// TODO: wire Stripe subscription check`. The `ProGate` in this file is a pure pass-through, **but it is imported by nothing**. The functional Pro gate is the separate `components/ProGate.tsx` (confirmed present). So this TODO sits in unused scaffold code and is a delete-candidate, not blocking work.

---

## 6. Resolved / no action needed

Verified against the codebase and `CLAUDE.md` Recent Sessions:

- **#7 AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25 (NEW this week).** Reclassified: the backlog was never spork-era data — all 2,550 NFL All Day rows were under 6 weeks old, starved by the resolver running at `batch_size: 5` against a Flowty-only lookup. Fixed by a GQL-primary edge-function rewrite + `batch_size 5→200`. This retires the prior report's §2.2 critical-path item and prioritized action.
- **fmv-recalc Step 6 self-perpetuating NO_DATA cycle — RESOLVED (`14ae144`, NEW this week).** See §2.1.
- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** ~17h stall on May 24–25; root cause an unchunked `.in()` exceeding PostgREST's URL cap, surfaced silently. Fixed by chunking at 500 + adding `log_pipeline_run` to the fatal-catch path.
- **#2 Sentry error capture — RESOLVED.** `NEXT_PUBLIC_SENTRY_DSN` set in Vercel env; SDK wired.
- **#3 Flowty event indexer "regression" — RESOLVED / reclassified.** Not a bug — `flowty_loan_events` went cold because Flowty shut down (~2026-05-13). Follow-up is the teardown (Priority #1), not a fix.
- **#4 Pinnacle FMV — RESOLVED (verified 2026-05-24).** `pinnacle_fmv_snapshots` holds 425 editions, 84% HIGH+MEDIUM, recomputed daily by `pinnacle-1.0.0`. Lives in its own table, not the uuid-keyed `fmv_snapshots`.
- **#5 AllDay/UFC mis-categorized editions — RESOLVED.** Only 8 stray editions remain under the TopShot collection_id (all `disney_pinnacle`).
- **#6 WarmupContext key mismatch — RESOLVED.** `WarmupContext.tsx` prefetches `/api/packs` into the key `PackPageClient` reads.
- **#8 NBA stats / projections — RESOLVED.** `nba_player_projections` is syncing again.
- **#9 Storefront audit pipeline — RETIRED (verified 2026-05-24).** A manual script (`scripts/scan-historical-storefront.mjs`, confirmed present), not a cron/route. De-facto retired; no operational action.
- **#13 `flowty_archive` growth — RESOLVED.** Option-B prune + `VACUUM FULL`; total DB 13.8 → 6.5 GB.
- **#16 `flow test` CI gating — RESOLVED, now fully BLOCKING (strengthened this week).** `.github/workflows/ci.yml` gates `tsc` + the Cadence harness; the cadence-lint job's `continue-on-error` was **removed** this week (it now exits 0 with 2 allowed warnings), and the lint harness was repointed off the Phase-D shim to the canonical `lib/chains/flow/cadence/purchase-moment.ts`. The lingering "non-blocking, pending a green run" caveat from the last two reports is now closed.

**Also shipped this week (not in the numbered list):** `topshot_squeeze_board` view + `/api/public/insights/squeeze` route (the squeeze board, identified in research as Top Shot's biggest under-told story); CI Node 20→24 + lockfile regeneration; dependabot tightened to security-only; 3 new Cowork skills (`rpc-migration`, `rpc-handoff`, `rpc-data`) + several live artifacts; the `rpc-weekly-health-check` §7 anon-write query false-positive fix. The TS GQL ingest UUID fallback shipped (`9368ade`); the residual UUID-write source has flipped to `compute-topshot-pack-ev` (monitored by the sentinel tripwire, kept inert by the dedup trigger — not a fire).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing — front-loads data quality, defers cosmetic debt:

1. **Verify the batched FMV RPC under production load (§2.1).** Cheap, high-leverage — confirm the next `topshot-fmv-populate` tick logs a clean run in `pipeline_runs`.
2. **Accelerate `fmv-recalc` throughput (§2.1).** The single biggest intelligence-quality win — recent-edition-first chunking + a faster cron cadence to finish the first full sweep.
3. **Flowty teardown (Priority #1 / §2.2).** Low-risk housekeeping; removes ~11 dead files + the `flowty-proxy` edge function.
4. **Chain-abstraction cleanup as capacity allows (§2.3 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` default-export trap); unblocks Phase F. Deferrable — the shims are safe.
5. **Pack/Moment/Set tail items (#17).** Mostly shipped; finish modal a11y verification + the Set aggregate-RPC fix opportunistically.
6. **Tech-debt cleanup — scratch fixtures (#15), monolith refactor Phase 1 (#14).** #15 is trivial; #14 Phase 1 is a zero-risk leaf-component extraction.
7. **Trade Hub (untracked feature).** Large; only schedule if it becomes a product priority — and add it to `CLAUDE.md` known-issues first so it isn't lost between two trackers.
8. **Brand polish (#11, #12), `/dashboard` migration (#10).** Lowest priority.

Housekeeping: delete the unused `lib/pro/gate.tsx` scaffold (§5h) whenever convenient — it carries a misleading TODO.

---

## 8. Notes from verification

- **All file and doc paths cited in `CLAUDE.md` (known-issues, prioritized actions, chain-strategy, recent sessions) were confirmed to exist this run** — including the net-new chain-strategy docs (`docs/strategy/multi-chain-thesis-2026-05-30.md`, `docs/migrations/chain-abstraction-plan-2026-05-30.md`, `docs/handoff-phase-d-lib-chains-flow-reorg.md`), `docs/audits/flowty-teardown-plan-2026-05.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/audits/purchase-moment-2026-05.md`, `docs/code-todos.md`, `docs/trade-escrow/STATUS.md`, `docs/overnight/ledger.md`, the new `app/api/public/insights/squeeze/route.ts`, both Phase-D canonical targets (`lib/chains/flow/flow.ts`, `lib/chains/flow/cadence/purchase-moment.ts`), `components/ProGate.tsx`, and `lib/pro/gate.tsx`. **No stale doc references found.**
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"` (same FP the last two reports flagged); and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_collections_chain_drop_default`. Both excluded from the count of 42 real markers.
- **TODO count delta vs. last week:** 23 → 42 real markers (+19), 12 → 31 files. The increase is the **18 Phase-D chain-rename shims** (§5a) plus `lib/pack-urls.ts:19` (§5e). All other markers match last week's inventory (some line numbers shifted from edits — e.g. `HomePageMarketing.tsx` 200/611 → 203/653).
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,917** · `analytics/page.tsx` **2,218** · `sniper/page.tsx` **2,073** · `dashboard/page.tsx` **1,751** · `lib/blazers-trivia.ts` **198**. `collection` and `analytics` grew slightly vs last week (2,896 / 2,208); `CLAUDE.md` #14's sniper figure (~2,485) remains **stale** — flagged in §3.
- **OG routes:** 7 present (`collection`, `deal`, `default`, `fast-break`, `moment`, `pack`, `profile`); `public/home-fmv-preview.png` confirmed **missing** — #11 remains partial.
- **`livetoken-portfolio*.json` (#15):** confirmed gone from the working tree (only `flowty-locker-test.json` remains). Git-*tracked* status could not be verified — this environment's `git` index reads as truncated, so `git ls-files` is unreliable. Treat #15 as "removed from working tree, tracking unconfirmed."
- **TODO raw-count caveat:** a naïve `grep -r` over `app lib components workers scripts` returns ~724 hits because **14 per-worker `node_modules/` directories** live under `workers/*`. The gitignore-aware scan (44 matches) is the authoritative figure used in this report; the naïve number is noise.
- **DB-side facts** (FMV sweep coverage, HIGH/MED counts, pipeline failure rate, Pinnacle FMV row counts, the `topshot_squeeze_board` row count) are reported **as stated in `CLAUDE.md`** — they were **not independently re-queried** against production Supabase in this run.
- **Autonomous-task caveat:** because `rpc-nightly-autonomous-pass` ships to `main` overnight, the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record of what shipped/declined.
- This report did not edit `CLAUDE.md` or any source file and did not touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-05-30)

Every `#1–#17` slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/cadence/purchase-moment.ts` retained as a Phase-D shim → dormant `lib/chains/flow/cadence/purchase-moment.ts` |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set in Vercel; SDK wired |
| 3 | Flowty event indexer regression | Resolved | **Resolved / reclassified** — Flowty shut down ~2026-05-13 | Teardown is the follow-up |
| 4 | Pinnacle FMV | Resolved | **Resolved** | `pinnacle_fmv_snapshots` 425 editions, 84% HIGH+MED (per `CLAUDE.md`) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray (`disney_pinnacle`) | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` (was "historical spork scan") | **Resolved 2026-05-25** | **Resolved** — resolver rewritten GQL-primary + `batch_size 5→200`; reclassified (not spork-era) | `CLAUDE.md` Open #7 + 2026-05-25 session; `spork-proxy` worker still present but no longer blocking |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired | **Retired** — manual script, not a cron/route | `scripts/scan-historical-storefront.mjs` present; nothing schedules it |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = 1,751 lines | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — partial** — 7 OG routes exist; `home-fmv-preview.png` missing | `ls app/api/og/`; `public/home-fmv-preview.png` absent |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | grep |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,917 / analytics 2,218 / sniper **2,073** (`CLAUDE.md` cites sniper ~2,485 — stale) | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Open | **Open — working tree cleaned; tracking unconfirmed** | fixtures absent from working tree (only `flowty-locker-test.json` remains); git unavailable (§8) |
| 16 | `flow test` in CI | Resolved | **Resolved — now fully blocking** | `.github/workflows/ci.yml`; `continue-on-error` removed this week, lint repointed to canonical Cadence path |
| 17 | Pack/Moment/Set page tune-up | Open | **Open — mostly shipped** | brand-token + data-accuracy batches landed (`5c0af8a`→`61f5586`); a11y + Set-RPC tail remains |

**Tally:** 9 resolved (#2, #3, #4, #5, #6, #7, #8, #13, #16) · 1 shelved by decision (#1) · 1 retired (#9) · 6 open or partial (#10, #11, #12, #14, #15, #17).

**Bottom line for `CLAUDE.md`:** the known-issues list is in good shape and broadly self-consistent. Three small drift points to correct on the next pass: (a) #14 still cites `sniper/page.tsx` at ~2,485 lines, but it is **2,073** post the May 23 reframe; (b) #15 says "11 files still git-tracked," but the fixtures are gone from the working tree (tracking unverifiable here); (c) the in-code TODO inventory is not tracked anywhere in `CLAUDE.md` — the 18 Phase-D chain-rename shims in particular are intentional debt worth a one-line note so a future reader does not mistake them for breakage. Separately, **Trade Hub / trade-escrow remains untracked in the known-issues list** despite being a partially-built feature with 8 in-code TODO stubs and live routes returning fake tx ids — the last two reports recommended adding it; that recommendation stands.
