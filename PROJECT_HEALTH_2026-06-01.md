# Rip Packs City — Project Health Report

**Date:** 2026-06-01
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §), `docs/overnight/ledger.md` (live autonomous-pass state), a full-tree gitignore-aware `TODO/FIXME/HACK/XXX` scan, and `git log` (available and reliable this run — unlike the last several reports).
**Scope:** A single consolidated, themed view of open work — the 17 tracked known-issue slots, the prioritized actions, the overnight operational queue (Q-items), and 40 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-05-30.md` (2 days ago, still in repo). This regeneration mirrors its structure. `PROJECT_HEALTH_2026-05-25.md` and `PROJECT_HEALTH_2026-05-22.md` are also still present.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since the 2026-05-30 report — a very active week (77 commits) that pivoted hard toward conversion + public intelligence surfaces.** Five things moved: **(1) The public `/insights` hub exploded** from a single squeeze board to **10 live surfaces** (cross-collection, first-mint, market "RPC Index", pack-reality, pinnacle-scarcity, rookies, set-squeeze, squeeze, squeeze-check, tc-report), backed by two new shipped views (`topshot_2025_rookie_index`, `topshot_market_index_daily`). This is the single biggest advance on Prioritized Action #2 (harden the intelligence surfaces). **(2) A brand-new Team Hub (`/my-teams`)** shipped Phases 1–5 — a cross-collection fan hub with a public Team Checklist (cost-to-complete), market activity, per-league Follow + live-game chips, and branded rosters. **(3) The activation funnel was found badly leaking and fixed (P0/P1):** the logged-out marketing homepage routed its primary CTAs to *auth-gated* pages, so every anon visitor hit `/login` at the activation moment — `/overview`, `/share`, `/api/collection-stats` were opened to anon and a `funnel_events` table was added to instrument the top of funnel. **(4) SEO went from invisible to live:** the production sitemap was emitting **0 entity URLs** (an embedded-join bug); it now emits **33,448 URLs**, pruned to anon-public, robots corrected. **(5) `/api/best-offers` was a fabricated MOCK** (hash-random bids on the authed grid) and now reads a real `edition_offers` cache. Entity detail pages also fully landed (404 fix, anon-open, JSON-LD, 5 new OG cards, hover-video).

> **Traction reality (new, and the most important number in this report).** Per the 2026-05-31 traction snapshot logged in the ledger: **~13 total users, 0 signups in the last 7 days (last on May 9), 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** RPC is deeply pre-traction — and crucially, all of that predates this week's funnel fix. Monetization remains explicitly tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the relevant lever is *activation*, which is exactly what this week's funnel/SEO/insights work targeted.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — all Flowty-dependent infrastructure is dead weight pending teardown (still a prioritized action; the teardown DECISION is queued in `docs/handoff-2026-05-31-next-block.md` item D). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping. **New this week:** `detect_stalled_pipelines()` + a `pipeline_cadence_watchlist` now catch absence-of-runs stalls (the gap that hid the TS sales-indexer stall — see §2.5). The git-lock contention that blocked autonomous pushes (Q7) is partially mitigated via a bot clone, but sandbox reachability is still negative — the night pass remains DB-migration + artifact + on-disk-docs best-effort. **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked (#1–#17) | 17 | Same slate as last week |
| Known issues — resolved | 9 | #2, #3, #4, #5, #6, #7, #8, #13, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | 6 | #10, #11, #12, #14, #15, #17 — #11 + #15 materially improved this week — see §3 / §9 |
| Known issues — shelved by decision | 1 | #1 Cart — intelligence-first decision, not a defect |
| Known issues — retired | 1 | #9 Storefront audit pipeline — de-facto retired |
| Untracked open feature | 1 | Trade Hub / trade-escrow — stubbed, still not in `CLAUDE.md` known-issues — see §3 |
| Net-new shipped features (not numbered) | 2 | Team Hub (`/my-teams`, Phases 1–5); the `/insights` hub expansion (10 surfaces) — see §2.2 |
| Open overnight operational items (Q-series) | 4 | Q5 (smoke lag), Q6 (evm Base-429), Q7 (git locks), Q8 (badge-sync row-grain) — see §2.5 |
| Net-new structural workstream | 1 | Multi-chain chain-abstraction — Phases C/D/E shipped; Phase D shim cleanup + Phase F gated — see §2.6 |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; 0 revenue items by design |
| In-code TODO markers | 40 across 30 files | **−2 vs last week** (HomePageMarketing resolved both its TODOs). 2 additional matches are false positives — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** Operationally stable and the busiest build week in this report series. The platform's risk has shifted: with the intelligence surfaces, entity pages, and funnel leaks all advanced this week, the dominant concern is now **activation/traction** (13 users, pre-funnel-fix) rather than any single code defect. Code-quality risk is concentrated in four places, descending: **(1) FMV** — still the core intelligence asset; the big TS `NO_DATA` tail is now confirmed *structural* (only 40 of 5,352 NO_DATA editions have any 90-day sale), so the real lever is a primary listings feed, not throughput, and "prefer fresh TS ask over stale WAP" shipped this week (`65421e2`); **(2) the overnight operational queue** — four open Q-items, mostly low/medium, plus the git-lock infra fragility (Q7); **(3) the chain-abstraction cleanup tail** — 18 unchanged re-export shims; **(4) Flowty teardown** — still pending a go/no-go decision. Everything else (monolith refactors, brand polish, page tune-ups) remains genuinely secondary.

### Themes

| Theme | Items |
|---|---|
| Conversion / activation (the real critical path) | Funnel leak fixed (anon → /login at activation); `/share` + `/overview` opened to anon; `funnel_events` instrumentation; SEO sitemap 0→33,448 URLs (§2.1) |
| Data-intelligence quality | FMV ask-over-WAP + structural NO_DATA finding (§2.3); the `/insights` hub (10 surfaces) + Team Hub (§2.2) |
| Housekeeping — dead infrastructure | Flowty teardown DECISION pending (Priority #1, §2.4); `special-serial-sweep` stub; `lib/pro/gate.tsx` dead scaffold |
| Operational / overnight queue | Q5 smoke-lag, Q6 evm-Base-429, Q7 git-locks, Q8 badge-sync row-grain (§2.5) |
| Multi-chain foundation (net-new) | Chain-abstraction Phases C/D/E shipped; 18 Phase-D shim TODOs (§5a); Phase F gated (§2.6) |
| Tech debt / refactor | `/dashboard` migration (#10), monolith pages (#14), scratch fixtures (#15, now verifiably untracked) |
| Page polish | Pack/Moment/Set tune-up (#17), brand punch list (#11, much improved), Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (untracked), Cart (#1, shelved by decision) |
| Deferred hardening (intentional) | Public INSERT-policy tables, `owner_key`→`user_id` migration, `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

The framing remains intelligence-first with revenue shelved by decision. But this week surfaced and largely fixed a genuine **conversion/activation** critical path — the leak that sent every logged-out visitor to `/login` — so that now leads, followed by FMV and the usual housekeeping/structural workstreams.

### 2.1 Conversion / activation funnel — `Severity: High · Effort: Medium (mostly shipped this week)`

This is the closest thing RPC has to a revenue/conversion blocker, and it was a real one. The audit found that the marketing homepage (shown only to logged-out users) routed its primary wallet-paste CTA and collection tiles to **auth-gated** pages (`/<collection>/collection`, `/<collection>/overview`), so every anonymous visitor hit `/login` at the exact activation moment, and the results card `/share/[wallet]` was itself not anon-public. Given the traction numbers (13 users, 0 signups in 7d), this plausibly throttled the entire top of funnel.

- **Shipped this week (`a79b778`, `b106a27`, `e93291e`, others):** opened `/<collection>/overview` + `/api/collection-stats` + read-only entity pages + `/api/entity/*` + `/share` + `/api/og/*` to anon in `proxy.ts`; repointed marketing CTAs/JSON-LD to the public `/share`; added a `funnel_events` table (RLS-on, anon INSERT-only, event-type allowlisted) to instrument home/share/insights views + wallet-paste.
- **SEO unblocked (`6c6950b`, `b20e483`, `7c1b81b`):** the live sitemap was emitting **0 entity URLs** (a PostgREST embedded-join returning `[]` in prod); it now emits **33,448 URLs** (≈23.5K editions / 5.2K packs / 3.5K players / 597 sets / 125 teams / 24 series / 11 insights), pruned to anon-public only, robots corrected. The prior SEO effort was invisible to crawlers until this landed.
- **Open follow-on (operator/CC, packaged, not auto-shipped):** conversion polish in `docs/handoff-2026-05-31-next-block.md` item B (messaging mismatch, hardcoded homepage stats, `/share` empty state) and the wallet-paste onboarding UX in `docs/handoff-2026-05-31-wallet-paste-onboarding.md`. Verify `funnel_events` is actually accumulating rows now that the route emits.

Suggested next step: confirm `funnel_events` is recording anon top-of-funnel, then watch whether the unblocked funnel + live sitemap move signups off zero.

### 2.2 Public intelligence surfaces — the product is materially more useful this week — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2. Net-new and live:

- **`/insights` hub — 10 surfaces** (was 1 last week): `cross-collection`, `first-mint`, `market` (the "RPC Index" — tier-segmented 120-day Top Shot market index, `4b5289a`), `pack-reality`, `pinnacle-scarcity`, `rookies` (`topshot_2025_rookie_index`), `set-squeeze`, `squeeze`, `squeeze-check`, `tc-report`. Two new backing views shipped + secured (`security_invoker=on`, anon SELECT-only).
- **Team Hub (`/my-teams`)** — Phases 1–5: branded hero + 30d activity, public Team Checklist with cost-to-complete + wallet-paste tracking, market activity / sets / squeeze & scarcity, per-league Follow + live-game chip, official WNBA logos.
- **Entity detail pages** — fully landed (404 colon-slug fix, anon-open for SEO, JSON-LD ×6, pack-contents grid, hero montages, branded OG cards, hover-video). OG routes went **7 → 13** (`+edition, +insights, +player, +series, +set, +team`).

No open defects tracked here; listed because it is the week's largest body of *shipped* product work and reframes where the platform stands.

### 2.3 FMV pipeline — the NO_DATA tail is now understood as structural — `Severity: Medium · Effort: Medium`

The FMV story matured this week:

- **`NO_DATA` is structural, not throughput-bound (confirmed 2026-05-31).** Of 5,352 TS `NO_DATA` editions, only **40** have any 90-day sale and **4** have ≥5 sales — there is no shippable bulk recovery; they heal in the normal `fmv-recalc` sweep. The real lever is a **primary Top Shot listings feed** (an ask source), which echoes the May-24 finding. Per the ledger: do not re-raise NO_DATA as a fixable gap.
- **Ask-over-WAP shipped (`65421e2`):** `fix(fmv): prefer fresh TS ask over stale WAP at the source (retire thin-sales-guard stopgap)` — a step toward ask-based pricing for thinly-traded editions.
- **Monitor freshness (as logged):** the 2026-05-31 21:13Z monitor recorded FMV HIGH+MED for TS ≈ **813**, AllDay ≈ **251** (up from the 776/… range last week). *DB-side figures are reported as logged by the in-repo monitor/ledger; not independently re-queried this run (see §8).*
- **Carryover from last week (still valid):** the Step-6 self-perpetuating NO_DATA cycle (`14ae144`), the batched `upsert_*_marketplace_fmv` RPCs, and the fmv-recalc silent-stall fix (`dd84526`) all remain shipped and stable.

Suggested next step: treat a primary listings/ask feed as the FMV roadmap item; routine throughput acceleration is now lower-leverage than it appeared last week.

### 2.4 Flowty teardown (Prioritized action #1) — `Severity: Medium · Effort: Small–Medium`

Unchanged structurally from last week: the Flowty frontend UI and the sniper-feed/FMV legs were already removed; the dead infrastructure (the `flowty-proxy` edge function + ~10 `lib/`/`app/` Flowty helpers) is still in the tree. `docs/audits/flowty-teardown-plan-2026-05.md` (confirmed present) is the plan of record. **New this week:** the explicit teardown *decision* (plus the `offers` table cleanup and `marketplace_offers` frozen-Flowty handling) is queued as item D in `docs/handoff-2026-05-31-next-block.md` — the audit confirmed **nothing is safe to auto-drop** yet (`flowty_*` ≈40MB frozen by the 2026-05-24 decision; `marketplace_offers` = 585K rows of Flowty history with `edition_id` NULL on every row — do NOT use as an offer source; `offers` = 0 rows but paired with a dead RPC). So this needs a deliberate go/no-go, not an autonomous sweep.

### 2.5 Overnight operational queue — four open Q-items — `Severity: Low–Medium · Effort: mixed`

New this report: the `docs/overnight/ledger.md` queue is now a meaningful part of "active work." Resolved this week: **Q1** (pack-reality views → `security_invoker`, last 3 of 14 SECDEF ERRORs cleared), **Q3** (TS sales-indexer stall — external cron resumed on its own; `detect_stalled_pipelines()` + watchlist added so the absence-of-runs gap is now caught), **Q4** (pinnacle-listings wrong-table resolver, `48f5a98`), and the `C1` allday-listings Sentry noise (`221ab64`). Still open:

| Q | Item | Severity | Notes |
|---|---|---|---|
| Q5 | Smoke `analytics_pipeline_health.sales` lag threshold (30m < ~2h indexer cadence) → intermittent false `degraded`. | Medium | Partially addressed by `detect_stalled_pipelines()`; the proper fix (compute lag from last *successful* run) + smoke A6 retry shipped, but the threshold rebase itself is operator/CC. |
| Q6 | `evm-transfers-ingest` Base-429 (6/21 fails/24h, "over rate limit"). | Low | Beezie/Base parallel plane, no product consumer, self-recovers. Add backoff/jitter or lower per-tick block range. |
| Q7 | Recurring `.git/index.lock`/`HEAD.lock` orphaned by the scheduled sandbox sharing Trevor's real working `.git`. | Infra | Bot clone created + push-verified, but scheduled-sandbox **reachability is negative** across 2 runs and the Windows↔sandbox bridge intermittently NUL-corrupts git reads. Wound down pending Trevor opting into a sandbox-native clone. Best-effort: clear the rare lock by hand on Windows. |
| Q8 | `badge-sync` upsert poisons ~40% of batches → coverage barely grows. | Medium | Cap lifted (`bd8f663`), but `onConflict:"id"` collides with the `UNIQUE(external_id,collection_id)` constraint on parallels → whole 50-row batches fail. Needs a row-grain decision (one-row-per-play vs per-parallel) + Trevor review — not auto-shippable. **Moot for offers** now that `edition_offers` is a decoupled table. |

Also: **`pinnacle-resolve-buyers` was flagged stalled** (284m vs 180m) — operator to confirm/re-fire its cron (same class as the TS stall). **Operator TODO closed:** the `offers-sweep` cron is now wired (a test run upserted 2,175 editions into `edition_offers`, 0 errors).

### 2.6 Chain-abstraction follow-through (net-new, unchanged this week) — `Severity: Low–Medium · Effort: Medium`

Static since last report. Shipped: `collection_chains` view + index; Phase C two-field `ChainType` in `lib/collections.ts`; Phase D Flow-primitives reorg under `lib/chains/flow/` (canonical files confirmed: `lib/chains/flow/flow.ts`, `lib/chains/flow/cadence/purchase-moment.ts`); Phase E chain-aware-reads audit. **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged count this week. Bulletproof by design (zero caller breakage across 833 `@/lib/...` imports); deferrable cleanup, not a bug. **Trap (from `CLAUDE.md`):** `lib/flow.ts` is the only file with `export default` — its shim must keep `export { default }` alongside `export *`. **Gated:** Phase F (`ALTER COLUMN chain DROP DEFAULT`) on Phase D completing; placeholder SQL at `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql` (its `audit_2026XXXX_…` name is a date placeholder — see the §8 false-positive note). Chain two (Solana/Candy) is gated on a July 8 data tripwire — do not start chain-two code early.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| — | Activation funnel — primary leak FIXED this week (anon CTAs → `/login`); residual conversion polish + wallet-paste onboarding UX packaged in `docs/handoff-2026-05-31-{next-block,wallet-paste-onboarding}.md`. Verify `funnel_events` is recording. | High | Medium (mostly done) |

### Data-intelligence quality

| Item | Issue | Severity | Effort |
|---|---|---|---|
| — | FMV — big `NO_DATA` tail confirmed *structural*; real lever is a primary listings/ask feed (not throughput). Ask-over-WAP shipped (`65421e2`). Tracked in `CLAUDE.md` Recent Sessions / ledger, not the numbered list. | Medium | Medium |

### Multi-chain foundation (net-new)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged count this week. Intentional, low-risk. | Low | Medium |
| Phase F | `ALTER COLUMN chain DROP DEFAULT` — gated on Phase D finishing. Placeholder SQL committed. | Low | Small |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. Brand-token consistency + data-accuracy batches shipped (`5c0af8a`→`61f5586`, plus 2026-05-24/31 batches incl. mojibake fixes in `a79b778`). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page), entity-hero dead-CDN thumbnail `onError` fallback (`docs/handoff-2026-05-31-entity-polish.md`). Audit docs (`PACK_/MOMENT_/SET_PAGES_AUDIT_2026-05-22.md`) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — **materially improved this week.** OG routes 7→**13** (entity cards added). The homepage placeholder-card TODO is gone — the home now renders the live `<HomeFmvPreview />` component, and **nothing in code references `public/home-fmv-preview.png` anymore** (the "missing screenshot" is moot; `a79b778` confirmed it's a styled mock, not a real asset gap). Bare brand literals tokenized to `var()` across several layouts. Remaining: Fast Break / RTR / admin tokenize once stable. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **1,751 lines** (verified; matches `CLAUDE.md` ~1,750). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,898**, `analytics/page.tsx` **2,208**, `sniper/page.tsx` **2,070** (all slightly smaller than last week's 2,917 / 2,218 / 2,073). `CLAUDE.md` #14 still cites sniper at ~2,485 — **stale** (it's 2,070 post the May 23 reframe). Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **now verifiably resolved on the tracking front.** `git ls-files` confirms **no** `livetoken-portfolio*`, `test-gql.json`, `sniper.json`, or `nftlocker-*` files are tracked (prior reports could not verify this — git was unavailable). Only `flowty-locker-test.json` sits in the working tree, and it too is **untracked**. `CLAUDE.md`'s "11 files still git-tracked" is stale. | Low (effectively resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence in `lib/cadence/purchase-moment.ts` (a Phase-D shim → `lib/chains/flow/cadence/purchase-moment.ts`) stays dormant and revivable. Not a defect. | n/a (shelved) | n/a |
| — | Trade Hub / trade-escrow — **still not in `CLAUDE.md` known-issues; recommend adding it.** All five trade transactions in `lib/trade-escrow/fcl-submit.ts` are TODO stubs (§5b), and `app/dashboard/trade-hub/TradeChainPanel.tsx` surfaces the literal `"Cancel signing not wired yet"`. **Verified this run:** live API routes `app/api/trade-chain/{propose,execute}` + `app/api/admin/reclaim-expired-trades` import the stubs, so they return fake tx ids. Tracked only in `docs/trade-escrow/STATUS.md` (present). | Medium | Large |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps via CHECK constraints, a `created_at` rate-limit column/trigger, a `bot_score` column from BotID, possibly an edge rate-limiter. (Note: the new `funnel_events` table follows the safer pattern — RLS-on, anon INSERT-only with no anon SELECT, event-type allowlisted + length-capped — a good template if these are ever revisited.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); neither is referenced by any `/api` route. Migrate to `user_id` + RLS when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Related to Q8's badge-sync row-grain work.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied earlier but the current concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — relevant if "harden the intelligence surfaces" (Priority #2) ever revisits alerting.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — archive the dead Flowty indexer / analytics MVs / `flowty-proxy` edge function / sniper buy-leg infrastructure. **Now blocked on a go/no-go decision** (item D in `docs/handoff-2026-05-31-next-block.md`); nothing is safe to auto-drop yet. | §2.4 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via the `/insights` hub (10 surfaces), Team Hub, entity pages, and FMV ask-over-WAP. | §2.2 + §2.3 |

*New, implicit priority surfaced this week:* **activation/conversion** (§2.1). It is not in the `CLAUDE.md` prioritized list yet, but given 13 users and the just-fixed funnel leak, it is arguably the highest-leverage work right now and worth promoting to an explicit action.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met — this is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A full-tree, gitignore-aware scan of `*.{ts,tsx,js,jsx,mjs,cdc,sql}` (using last week's non-word-boundary methodology for comparability) found **42 `TODO/FIXME/HACK/XXX` matches — 40 real markers across 30 files, plus 2 false positives** (see §8). That is **−2 real markers vs. last week's 42**, entirely because `components/HomePageMarketing.tsx` resolved **both** its TODOs this week (the stat-counter + placeholder-card markers are gone; the home now renders `<HomeFmvPreview />`). `CLAUDE.md` does not track these; `docs/code-todos.md` (present) covers only 2 follow-ups. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.6. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed (8 markers, 2 files)

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 60, 69, 87, 94, 103) — the header block plus all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`. **Verified imported/called** by live API routes (`app/api/trade-chain/{propose,execute}`, `app/api/admin/reclaim-expired-trades`), which therefore return fake tx ids.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI sets `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`.

→ See §3 (Stalled features).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file)

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. Related to `docs/code-todos.md` item 2.

### 5d. Pipeline calibration / migration (3 markers, 3 files)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files)

- `app/(collections)/[collection]/collection/page.tsx:2672` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line shifted from 2665 → 2672 — file edited, same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- `lib/pack-urls.ts:19` — `TODO(2026-05-26)`: verify the pack URL still resolves for sold-out drops.

### 5f. Cadence test coverage gap (2 markers, 1 file)

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Monetization gate stub — dead scaffold (1 marker, 1 file)

- `lib/pro/gate.tsx:25` — `// TODO: wire Stripe subscription check`. **Verified imported by nothing** this run (`rg "pro/gate"` returns only the file's own header). The functional Pro gate is the separate `components/ProGate.tsx` (present). This TODO sits in unused scaffold code and is a delete-candidate, not blocking work.

> **Resolved since last week (1 file, 2 markers):** `components/HomePageMarketing.tsx` — both the stat-counter TODO (was ~L203) and the placeholder-card TODO (was ~L653/710) are gone; the home now uses the live `<HomeFmvPreview />` component. This is the entire −2 marker delta.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md`:

**Known-issue slate (unchanged resolutions):**
- **#2 Sentry error capture — RESOLVED.** DSN set in Vercel; SDK wired.
- **#3 Flowty event indexer "regression" — RESOLVED / reclassified.** Flowty shut down ~2026-05-13. Follow-up is the teardown (Priority #1).
- **#4 Pinnacle FMV — RESOLVED.** `pinnacle_fmv_snapshots` ~425 editions, 84% HIGH+MED, daily `pinnacle-1.0.0`. Own table, not the uuid-keyed `fmv_snapshots`.
- **#5 AllDay/UFC mis-categorized editions — RESOLVED.** Only 8 stray (all `disney_pinnacle`).
- **#6 WarmupContext key mismatch — RESOLVED.**
- **#7 AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** Resolver rewritten GQL-primary + `batch_size 5→200`; reclassified (not spork-era).
- **#8 NBA stats / projections — RESOLVED.** `nba_player_projections` syncing.
- **#13 `flowty_archive` growth — RESOLVED.** Prune + `VACUUM FULL`; DB 13.8 → 6.5 GB.
- **#16 `flow test` CI gating — RESOLVED, fully blocking.** `continue-on-error` removed; lint repointed to canonical Cadence path.
- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** Unchunked `.in()` exceeding PostgREST's URL cap; fixed by chunking + `log_pipeline_run` on the fatal path.

**Newly resolved/upgraded this week:**
- **#15 scratch fixtures — tracking now VERIFIABLY clean.** `git ls-files` confirms none are tracked (see §3 / §8). Prior reports left this "unconfirmed" because git was unavailable.
- **#11 brand punch list — materially advanced.** OG routes 7→13; homepage placeholder TODOs removed (live `HomeFmvPreview`); `home-fmv-preview.png` no longer referenced; brand literals tokenized.
- **Overnight Q-items:** Q1 (pack-reality SECDEF views), Q3 (TS sales-indexer stall — self-resolved + now stall-detectable), Q4 (pinnacle-listings resolver), and `C1`/`P2`/`P3` Sentry-noise items all resolved (see §2.5).
- **`/api/best-offers` MOCK — FIXED (`a79b778`).** No longer fabricates hash-random bids; reads the real `edition_offers` cache (badge_editions fallback).
- **SEO sitemap 0→33,448 entity URLs; activation funnel leak opened to anon** (§2.1).

**Also shipped this week (not in the numbered list):** Team Hub `/my-teams` Phases 1–5; the `/insights` hub expansion (10 surfaces) + `topshot_2025_rookie_index` + `topshot_market_index_daily` views; entity detail pages (404 fix, anon-open, JSON-LD, 5 OG cards, hover-video); `funnel_events` instrumentation + `detect_stalled_pipelines()` + sales-indexer watchlist; FMV ask-over-WAP (`65421e2`); badge-sync cap lift (`bd8f663`); the `offers-sweep` cron wiring.

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation promoted given the traction reality:

1. **Confirm the funnel fix is working (§2.1).** Cheapest, highest-leverage right now — verify `funnel_events` is recording anon top-of-funnel and that the live 33,448-URL sitemap is being crawled (GSC steps in `docs/operations/seo-gsc-checklist-2026-05-31.md`). Then finish the conversion-polish + wallet-paste-onboarding handoffs.
2. **FMV primary-listings/ask feed (§2.3).** The NO_DATA tail is structural, so this — not throughput — is the FMV roadmap item. Ask-over-WAP already shipped; build on it.
3. **Drain the overnight Q-queue (§2.5).** Q5 (smoke-lag rebase) and Q6 (evm backoff) are small; Q8 (badge-sync row-grain) needs a Trevor decision; Q7 (git-lock infra) is wound down pending a native-clone call.
4. **Flowty teardown DECISION (Priority #1 / §2.4).** Make the go/no-go (handoff item D); the actual archive is low-risk once decided.
5. **Chain-abstraction cleanup as capacity allows (§2.6 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` default-export trap); unblocks Phase F. Deferrable.
6. **Pack/Moment/Set tail (#17)** — modal a11y verification + the Set aggregate-RPC fix + the dead-CDN thumbnail `onError` fallback, opportunistically.
7. **Tech-debt — monolith refactor Phase 1 (#14).** Zero-risk leaf-component extraction. (#15 is effectively done.)
8. **Trade Hub (untracked).** Large; only schedule if it becomes a product priority — and **add it to `CLAUDE.md` known-issues first** so it isn't lost between two trackers.
9. **Brand polish (#11 tail, #12), `/dashboard` migration (#10).** Lowest priority.

Housekeeping: delete the unused `lib/pro/gate.tsx` scaffold (§5g) whenever convenient — it carries a misleading TODO.

---

## 8. Notes from verification

- **Git was available and reliable this run** (unlike the last several reports), enabling verification the prior reports could not do — most notably #15's git-tracked status and a `git log` of the 77 commits since 2026-05-30.
- **All file/doc paths cited in `CLAUDE.md` and the prior report were confirmed to exist this run** — including `docs/audits/flowty-teardown-plan-2026-05.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/audits/purchase-moment-2026-05.md`, `docs/code-todos.md`, `docs/trade-escrow/STATUS.md`, `docs/overnight/ledger.md`, the three chain-strategy docs, `app/api/public/insights/squeeze/route.ts`, both Phase-D canonical targets, `components/ProGate.tsx`, `lib/pro/gate.tsx`, and `scripts/scan-historical-storefront.mjs`. **No stale doc references found.** (`CLAUDE.md` *content* drift — the stale sniper line-count in #14 and the stale "11 fixtures tracked" in #15 — is noted in §3/§9, but those are values, not broken paths.)
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"` (same FP the last three reports flagged); and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_collections_chain_drop_default`. Both excluded from the count of 40 real markers. (A word-boundary scan `-w` excludes the phase-f one automatically; the non-`-w` scan used here for week-over-week comparability includes it, then I subtract it.)
- **TODO count delta vs. last week:** 42 → 40 real markers (−2), 31 → 30 files (−1). The entire delta is `components/HomePageMarketing.tsx` resolving both its TODOs. All other markers match last week's inventory (some line numbers shifted from edits — e.g. `collection/page.tsx` 2665 → 2672).
- **Scan-stability caveat (mount flakiness):** consistent with `CLAUDE.md`'s documented Git-Bash mount instability, an early scan returned a *stale cached* read of `HomePageMarketing.tsx` showing a TODO at L710 that the file no longer contains (verified via the Read tool and by `stat` mtime 2026-05-31 15:11). The authoritative re-scan + direct read agree the file has **no** markers. Numbers in this report use the authoritative re-scan.
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,898** · `analytics/page.tsx` **2,208** · `sniper/page.tsx` **2,070** · `dashboard/page.tsx` **1,751** · `lib/blazers-trivia.ts` **198**. All three monolith pages shrank slightly vs last week; `CLAUDE.md` #14's sniper figure (~2,485) remains **stale** — flagged in §3.
- **OG routes:** **13 present** (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `team`) — up from 7. `public/home-fmv-preview.png` is still absent but **no longer referenced anywhere in code** — the home uses a live component, so #11's "missing screenshot" is moot.
- **`livetoken-portfolio*.json` (#15):** `git ls-files` returns **none tracked** (also no `test-gql.json`/`sniper.json`/`nftlocker-*`); only `flowty-locker-test.json` exists in the working tree and it too is untracked. #15 is effectively resolved.
- **DB-side facts** (FMV HIGH/MED counts, the NO_DATA structural finding, traction numbers, pipeline health, view row counts) are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports. The Supabase MCP was available but a live DB audit is out of scope for a repo-health regeneration.
- **Autonomous-task caveat:** because the daytime monitor and night pass run against this repo, the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record of what shipped/declined. Git-push from the scheduled sandbox remains best-effort (Q7).
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-01)

Every `#1–#17` slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/cadence/purchase-moment.ts` retained as a Phase-D shim → dormant `lib/chains/flow/cadence/purchase-moment.ts` |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired |
| 3 | Flowty event indexer regression | Resolved | **Resolved / reclassified** — Flowty shut down ~2026-05-13 | Teardown is the follow-up |
| 4 | Pinnacle FMV | Resolved | **Resolved** | `pinnacle_fmv_snapshots` (per `CLAUDE.md`) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray (`disney_pinnacle`) | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** — GQL-primary + `batch_size 5→200` | `CLAUDE.md` + 2026-05-25 session |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired | **Retired** — manual script, not a cron/route | `scripts/scan-historical-storefront.mjs` present; nothing schedules it |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = 1,751 lines | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — 13 OG routes; home placeholder gone; `home-fmv-preview.png` unreferenced | `ls app/api/og/`; `rg home-fmv-preview` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | grep |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,898 / analytics 2,208 / sniper **2,070** (`CLAUDE.md` cites sniper ~2,485 — stale) | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Open | **Effectively resolved** — none git-tracked (verified via `git ls-files`); only untracked `flowty-locker-test.json` in tree | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open | **Open — mostly shipped** | brand-token + data-accuracy + mojibake batches landed; a11y + Set-RPC + thumbnail-`onError` tail remains |

**Tally:** 9 resolved (#2, #3, #4, #5, #6, #7, #8, #13, #16) · 1 shelved by decision (#1) · 1 retired (#9) · 6 open or partial (#10, #11, #12, #14, #15, #17 — with #11 and #15 materially improved this week).

**Bottom line for `CLAUDE.md`:** the known-issues list is in good shape. Drift points to correct on the next pass: (a) #14 still cites `sniper/page.tsx` at ~2,485 lines — it is **2,070**; (b) #15 says "11 files still git-tracked" — none are tracked (verified); (c) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 Phase-D chain-rename shims especially are intentional debt worth a one-line note. Separately, **Trade Hub / trade-escrow remains untracked** despite being a partially-built feature with 8 in-code TODO stubs and live routes returning fake tx ids — the last three reports recommended adding it; that recommendation stands. Finally, given the traction reality (13 users, 0 signups in 7d), consider promoting **activation/conversion** to an explicit prioritized action now that the funnel leak is fixed.
