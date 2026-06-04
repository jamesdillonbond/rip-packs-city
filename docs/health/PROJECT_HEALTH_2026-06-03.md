# Rip Packs City — Project Health Report

**Date:** 2026-06-03
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §), `docs/overnight/ledger.md` (live autonomous-pass state), a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the 17 tracked known-issue slots (now with a Trade Hub item sharing slot #3), the prioritized actions, the overnight operational queue (Q/N/P/S/L/PIN/F-items), and 39 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-01.md` (2 days ago). This regeneration mirrors its structure. `PROJECT_HEALTH_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also still present in the repo root.

> **Report location change.** Per the scheduled-task brief, this report is written to `docs/health/` (folder created this run) rather than the repo root, to keep the root uncluttered. **Caveat (verified):** the four prior `PROJECT_HEALTH_*.md` reports are *still in the repo root* in the working tree — the relocation the brief references has not actually happened here. I did not move them (out of scope: I only create the new file). See §8.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since the 2026-06-01 report — a focused 2-day window (≈30 commits, ≈17 code / ≈13 docs/ops) that pivoted FMV toward data-integrity and finished several housekeeping decisions.** Six things moved: **(1) FMV gained a "mis-key sweep"** (`f3011d9`) — a defensive `serial > circulation_count` recalc guard (F3), a STALE split out of the headline portfolio total (F4), a destructive 8:62 Cosmic→Clamps sale/moment re-map (F2 Tier A), and a scoped Step-5b NO_DATA recovery (F5); a new `v_fmv_sanity_flags` v2 monitoring view backs it. The framing shifted from "throughput vs structural" to "a mis-keyed-mint-block data-corruption class" (F1 still open). **(2) The `/insights` hub grew 10 → 12 surfaces** — `/insights/deals` (Below FMV) and `/insights/offer-spread` (Bid vs Floor) shipped end-to-end (`2f26044`), each backed by a new secured view (`topshot_deals_vs_fmv`, `topshot_offer_ask_spread`). **(3) Trade Hub was formally tracked + shelved** (`e246f22`) — it is now `CLAUDE.md` known-issue **#3**, guarded by `ensureLive()` (the five `fcl-submit` stubs throw unless `RPC_TRADE_ESCROW_ADDRESS` is set), the three live `/api/trade-chain/*` routes return **503**, and `/dashboard/trade-hub` `notFound()`s via a new `TradeHubClient.tsx` split. **(4) The storefront-cleanup machinery was deleted** (`d8cc6c2`) — `scripts/cleanup-storefront-wallets.mjs` + root `cleanup.cdc` removed (verified gone), killing the sole FLOW drain on the Cadence payer wallet `0x73f55c4450b8d466`; that wallet is now intentionally empty and its `cadence-payer-balance-check` cron is paused. **(5) `lib/pro/gate.tsx` was deleted** — last week's recommended cleanup of the misleading dead Stripe-gate scaffold landed (this is the entire −1 TODO-marker delta). **(6) Entity pages went collection-aware** (`dadcc57`, H1–H6) — collection-aware ask/offer cells + AllDay `cross_market_ask`, closing the AllDay best-offer "data gap" framing from the 06-01 audit.

> **Traction reality (carried forward — no fresh snapshot this run).** The last logged traction read (2026-05-31, in the ledger) was **~13 total users, 0 signups in 7 days (last May 9), 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** RPC is deeply pre-traction. The funnel/SEO/insights work that targets this all post-dates that snapshot; whether signups have moved off zero is **not yet measured**. Monetization remains explicitly tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation*.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — Flowty-dependent infra is frozen. The teardown DECISION has now effectively been made: `docs/cleanup-decisions-2026-06-01.md` recommends **KEEP FROZEN and close Priority #1** (the `flowty_*`/`offers` tables back live admin Flowty-analytics surfaces; ~45MB inert, not a dead pair). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping. The 2026-06-03 night pass fired **in-window but NO-PUSH** (scheduled sandbox has no GitHub creds; the bot clone is unmounted), shipping **1 DB monitoring-config migration** (`audit_20260603_watchlist_destall_paused_payer_and_hourly_pinnacle`) via the Supabase connector and writing all repo outputs uncommitted. **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked (#1–#17) | 17 | **#3 is now double-assigned** — "Flowty event indexer" (resolved) + "Trade Hub" (newly shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | 5 | #10, #11, #12, #14, #17 — **#15 dropped off** (now resolved) — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; **#3 Trade Hub (new this week — now tracked + guarded)** |
| Known issues — retired | 1 | #9 Storefront audit pipeline — cleanup machinery **deleted** 2026-06-03 |
| Untracked open feature | 0 | Trade Hub is now tracked (#3) — the prior reports' standing recommendation is resolved |
| Net-new shipped features (not numbered) | 2 | `/insights/deals` + `/insights/offer-spread` (hub 10→12); the FMV mis-key sweep (F2–F5) — see §2.2 / §2.3 |
| Open overnight operational items | ~9 | Q5, Q6 (code fix shipped), Q7, Q8, N2, N3, L1, PIN1, Q2 (watch) + F1 (FMV data-corruption) — see §2.5 |
| Net-new structural workstream | 1 | Multi-chain chain-abstraction — Phases C/D/E shipped, F gated; 18 Phase-D shim TODOs remain — see §2.6 |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; **Priority #1 (Flowty) now recommended-closed (keep frozen)** |
| In-code TODO markers | **39 across 29 files** | **−1 / −1 vs last week** (`lib/pro/gate.tsx` deleted). 2 false positives excluded — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** Operationally stable; a tidy, decision-closing 2-day window. The platform's dominant concern is unchanged: **activation/traction** (13 users at last read) over any single code defect. Code-quality risk is concentrated in four places, descending: **(1) FMV** — still the core intelligence asset, and the risk lens shifted this week from coverage to *correctness* (mis-keyed mint blocks poisoning WAP; F3 now defends the whole class, F2 fixed the flagship 8:62 case, F1 is the open broader-batch investigation); **(2) the overnight operational queue** — now ~9 open Q/N/L/PIN items, mostly low/medium, plus the git-lock infra fragility (Q7) and the re-opened hydrator-timeout (N2); **(3) the chain-abstraction cleanup tail** — 18 unchanged re-export shims; **(4) Flowty** — no longer a teardown task, just a standing "keep frozen" decision to formally close. Everything else (monolith refactors, brand polish, page tune-ups) remains genuinely secondary.

### Themes

| Theme | Items |
|---|---|
| Conversion / activation (the real critical path) | Funnel leak fixed prior week; this week: honest onboarding polish (`eda078c`), `/signup` stale-rule drop (`9ace049`), moment-modal best offer (`5081589`). Verify `funnel_events` is accumulating. (§2.1) |
| Data-intelligence quality | FMV mis-key sweep F2–F5 + `v_fmv_sanity_flags` (§2.3); `/insights` deals + offer-spread (hub 10→12); entity collection-aware ask/offer + AllDay `cross_market_ask` (§2.2) |
| Housekeeping — dead infrastructure | Flowty teardown DECISION = keep frozen, close Priority #1 (§2.4); storefront-cleanup machinery deleted + payer wallet/cron paused (#9); `lib/pro/gate.tsx` deleted (§5g) |
| Operational / overnight queue | Q5 smoke-lag, Q6 evm-Base-429 (code fix shipped), Q7 git-locks, Q8 badge-sync row-grain, N2 hydrator-timeout, N3 payer-wallet, L1 league-drift cron, PIN1 NEXTJS-15 gate (§2.5) |
| Multi-chain foundation (net-new) | Chain-abstraction Phases C/D/E shipped; 18 Phase-D shim TODOs (§5a); Phase F gated (§2.6) |
| Tech debt / refactor | `/dashboard` migration (#10, now 1,780 lines), monolith pages (#14), scratch fixtures (#15, resolved) |
| Page polish | Pack/Moment/Set tune-up (#17), brand punch list (#11), Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded), Cart (#1, shelved by decision) |
| Deferred hardening (intentional) | Public INSERT-policy tables, `owner_key`→`user_id` migration, `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

The framing remains intelligence-first with revenue shelved by decision, and the just-fixed **conversion/activation** leak (prior week) still leads pending measurement, followed by FMV correctness and the usual housekeeping/structural workstreams.

### 2.1 Conversion / activation funnel — `Severity: High · Effort: Medium (mostly shipped)`

The primary leak (logged-out CTAs → `/login`) was fixed the prior week; `/share`, `/overview`, `/api/collection-stats`, entity pages and `/api/og/*` are anon-public, and the live sitemap emits ~33K URLs. This week added conversion polish on top:

- **Honest onboarding (`eda078c`, prior-week tail):** pricing CTA → "Request beta access"; fabricated home stats replaced with verified figures; `HomeFmvPreview` now pulls live `/api/fmv/demo` instead of a styled mock; `ShareEmptyState` retries on empty `/share`.
- **This week:** dropped a stale `/signup` public-path rule that pointed at a non-existent page (`9ace049`); moment modal now shows best offer and gates CSV export to the allowlist (`5081589`); removed a no-op `+Cart` CTA from the concierge now that Cart is shelved (`396cef9`).
- **Open follow-on (operator/CC, packaged):** verify `funnel_events` is actually accumulating anon top-of-funnel rows; finish the conversion-polish + wallet-paste-onboarding handoffs (`docs/handoff-2026-05-31-{next-block,wallet-paste-onboarding}.md`); complete Search Console verification per `docs/operations/seo-gsc-checklist-2026-05-31.md`.

Suggested next step: confirm `funnel_events` is recording and watch whether the unblocked funnel + live sitemap move signups off zero.

### 2.2 Public intelligence surfaces — still expanding — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2. Net-new and live this week:

- **`/insights` hub — 12 surfaces** (was 10): added `/insights/offer-spread` (Bid vs Floor) and `/insights/deals` (Below FMV), each shipped route + client page (mobile-safe overflow) + SEO layout + live OG + sitemap card (`INSIGHT_ROUTES` now 12) in `2f26044`. Backing views `topshot_offer_ask_spread` (v3, `par_distance` ranking) and `topshot_deals_vs_fmv` are `security_invoker=on`, anon SELECT-only, gated `low_ask>=5` so penny-floor ratio artifacts don't headline ("rank, not price"). Full surface list: `cross-collection`, `deals`, `first-mint`, `market`, `offer-spread`, `pack-reality`, `pinnacle-scarcity`, `rookies`, `set-squeeze`, `squeeze`, `squeeze-check`, `tc-report`.
- **Entity pages went collection-aware (`dadcc57`, H1–H6):** collection-aware ask/offer cells (no more "Top Shot ask" on NFL pages), AllDay `cross_market_ask` surfaced (2,446 editions previously omitted by the standard `get_edition_detail` path), best-offer hidden when no source exists. This closes the 06-01 audit's AllDay best-offer finding (a *data* gap, not a code defect — `get_edition_high_offer` is collection-agnostic and correct).
- **SEO JSON-LD hardened (`f8fe90b`, `6e90f3f`):** edition/pack Product JSON-LD always carries image + description + length-safe sku + offers (low_ask fallback when FMV absent); `offers.price` is omitted when FMV confidence is STALE. Clears the Search Console criticals surfaced once the 33K pages began crawling.
- **Packs polish (`64e3f4a`):** cheapest-secondary auto-sort default + clickable thumbnails / pull cards.

No open defects tracked here; listed because it is the week's largest body of *shipped* product work.

### 2.3 FMV pipeline — the risk lens shifted to data-integrity — `Severity: Medium · Effort: Medium`

The FMV story matured again this week, away from coverage and toward correctness:

- **Mis-key sweep shipped (`f3011d9`, Claude Code, preview-first):** **F3** — a defensive Step-2a-ter guard in `app/api/fmv-recalc/route.ts` drops sales whose `serial_number > circulation_count` before WAP (impossible serials = a mis-keyed mint block of a different moment; 102 impossible sales / 26 editions in the live 30d window). **F2 Tier A** — a destructive re-map moved the 22 sales + 16 moments wmc-confirmed off Cosmic 8:62 (circ 49) to De'Andre Hunter "Clamps" 226:7541 (exact revert row-ids captured in the ledger). **F4** — `get_wallet_collection_stats` now excludes STALE from the headline `fmv_total` and surfaces `fmv_stale_total` + `stale_count` separately (dashboard shows a footnote). **F5** — a NO_DATA-scoped Step-5b recovery tags recovered rows SALES_ONLY/STALE (avoiding the 2026-05-30 Step-6 re-clobber class). **F6** — no action (double-discount premise confirmed false).
- **New monitoring view `v_fmv_sanity_flags` v2** (`audit_20260603_..._v2_sales_only_baseline`) — sales-only set-median baseline + absolute-$50-gap + confident-cheap gates; drops the 74:2650 false positive, keeps 8:62. **Operator TODO (in ledger): wire `SELECT * FROM v_fmv_sanity_flags;` into `rpc-weekly-health-check` and alert on any row.**
- **F1 still open (data corruption, broader batch):** the `serial > circulation` detector finds ~15 TS editions with ≥5 impossible sales; a clean RARE/LEGENDARY sub-batch (127:4681, 127:4683, 29:907, 64:2375, 29:897…) shares 8:62's single-target-wmc signature and could get the same Tier-A re-map; the messy Base COMMONs + stale-circ false positives need per-edition analysis. **Root cause to find: the moments-edition writer that mis-keyed contiguous mint blocks.** (`wmc` is canonical over `moments`/`sales` for nft_id→edition.)
- **Carryover (still valid):** NO_DATA remains *structural* (per the 05-31 finding: of 5,352 TS NO_DATA editions only 40 have any 90-day sale) — the real coverage lever is a primary listings/ask feed, not throughput. The ask-over-WAP (`65421e2`), Step-6 cycle fix (`14ae144`), batched `upsert_*` RPCs, and silent-stall fix (`dd84526`) all remain shipped.

Suggested next step: finish the F1 mis-key cleanup (Tier-A re-map the clean sub-batch, per-edition the messy tail) and find the writer root cause; treat a primary listings/ask feed as the separate coverage roadmap item.

### 2.4 Flowty teardown (Prioritized action #1) — DECISION made: keep frozen — `Severity: Low · Effort: n/a`

This is no longer a teardown task. `docs/cleanup-decisions-2026-06-01.md` and the A-D close-out both conclude **KEEP FROZEN and close Priority #1**: the `flowty_*` tables (~40–45MB) and the `offers` RPC back *live* admin Flowty-analytics surfaces, so they are not a dead pair and nothing is safe to drop. `marketplace_offers` (585K rows of frozen Flowty history, `edition_id` NULL on every row) must not be used as an offer source. The suggested action is now simply to formally close Priority #1 in `CLAUDE.md`. `docs/audits/flowty-teardown-plan-2026-05.md` remains as the historical plan of record.

### 2.5 Overnight operational queue — ~9 open items — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue has churned. **Resolved since the last report:** **P1** (evm-transfers-ingest watchlist 60→150m, live 06-02), **S1** (revoke anon on `v_moments_needing_hydration`, live 06-02), **N1** (`snapshot-institutional-wallets` self-recovered 06-02), **Q10** (listing-cache watchlist, re-verified). **Shipped 06-03 (night pass):** **C-PAYER + C-PIN** — `audit_20260603_watchlist_destall_paused_payer_and_hourly_pinnacle` cleared two `detect_stalled_pipelines()` false positives (`cadence-payer-balance-check` → `is_active=false`; `pinnacle-metadata-backfill` `max_silent_minutes` 90→200). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| Q5 | Smoke `analytics_pipeline_health.sales` lag threshold (30m < ~2h indexer cadence) → intermittent false `degraded`. | Medium | Partially addressed by `detect_stalled_pipelines()` + smoke A6 retry; the proper fix (compute lag from last *successful* run) is operator/CC. |
| Q6 | `evm-transfers-ingest` Base-429. | Low | **Code fix shipped** (`8605c43`: getLogs 10k→5k + 4th retry) and the watchlist false-positive fixed (P1); the ledger entry just wasn't restamped RESOLVED. Effectively addressed. |
| Q7 | Recurring `.git/index.lock`/`HEAD.lock` orphaned by the scheduled sandbox sharing Trevor's real working `.git`. | Infra | Bot clone created + push-verified, but scheduled-sandbox reachability is **negative** and the Windows↔sandbox bridge intermittently NUL-corrupts git reads. Wound down pending a sandbox-native clone decision. |
| Q8 | `badge-sync` upsert poisons ~40% of batches (`onConflict:"id"` collides with `UNIQUE(external_id,collection_id)` on parallels). | Medium | Cap lifted (`bd8f663`); needs a row-grain decision (one-row-per-play vs per-parallel) + Trevor review. **Moot for offers** (`edition_offers` decoupled). |
| N2 | `v_moments_needing_hydration` candidate-read still exceeds `statement_timeout` under peak cron-rush contention (re-open of C2). | Medium | The materialized-CTE fix is net-positive — **do NOT revert.** Deeper fix (statement_timeout bump / supporting index / further view-cost reduction) is operator/CC; fold `security_invoker=on` (ex-S1) into the same `CREATE OR REPLACE`. |
| N3 | Payer wallet `0x73f55c4450b8d466` gas drain (storefront-cleanup) + `cadence-payer-balance-check` noise. | Low | Monitoring slice shipped (C-PAYER) + drain driver deleted (`d8cc6c2`). Operator-only remainder: confirm no out-of-repo scheduler still runs the (now-deleted) cleanup; re-fund + re-enable only when reviving a gas-write feature. |
| L1 | `league-drift-detection` cron-wiring intent unconfirmed (ran exactly once 05-31; not watchlisted). | Low | Operator/CC: wire a cron + generous watchlist row if recurring, else record as one-shot in `cron-schedule.md`. |
| PIN1 | `NEXTJS-15` Pinnacle listing-indexer Sentry gate counts `cadence_capped` deferrals toward the spike threshold → transient warnings. | Low | Operator/CC: exclude `cadence_capped` from the spike count (count only terminal `edition_key_unmapped`), or raise the per-tick cadence budget. |
| Q2 | `compute-laliga-pack-ev` cron cadence. | Watch | Downgraded — ran 05-31, appears active; Golazos has no confirmed primary pack path. |

Plus **F1** (FMV mis-key data corruption, §2.3) is effectively a queued investigation. The ledger's **Declined — do not re-suggest** section is currently empty.

### 2.6 Chain-abstraction follow-through (net-new, unchanged this week) — `Severity: Low–Medium · Effort: Medium`

Static since last report. Shipped: `collection_chains` view + index; Phase C two-field `ChainType` in `lib/collections.ts`; Phase D Flow-primitives reorg under `lib/chains/flow/` (canonical files confirmed: `lib/chains/flow/flow.ts`, `lib/chains/flow/cadence/purchase-moment.ts`); Phase E chain-aware-reads audit; **Phase F shipped 2026-06-01** (`audit_20260601_collections_chain_drop_default` — `ALTER COLUMN chain DROP DEFAULT`), so the chain-abstraction workstream (Phases A–F) is complete. **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged count. Bulletproof by design (zero caller breakage across 833 `@/lib/...` imports); deferrable cleanup, not a bug. **Trap (from `CLAUDE.md`):** `lib/flow.ts` is the only shim with `export default` — it must keep `export { default }` alongside `export *`. Chain two (Solana/Candy) is gated on a July 8 data tripwire — do not start chain-two code early.

> **Note:** the prior report listed Phase F as "gated"; it actually shipped 2026-06-01. Updated here.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| — | Activation funnel — primary leak FIXED (prior week); this week added onboarding polish + stale-rule cleanup. Residual conversion-polish + wallet-paste onboarding UX packaged in handoffs. **Verify `funnel_events` is recording.** | High | Medium (mostly done) |

### Data-intelligence quality

| Item | Issue | Severity | Effort |
|---|---|---|---|
| — (F1) | FMV mis-keyed-mint-block data corruption — F2/F3 fixed/defended the flagship 8:62 case; F1 (broader ~15-edition batch + writer root cause) open. Tracked in the ledger, not the numbered list. | Medium | Medium |
| — | FMV NO_DATA tail confirmed *structural*; coverage lever is a primary listings/ask feed (not throughput). | Medium | Medium |

### Multi-chain foundation (net-new)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. Brand-token + data-accuracy + mojibake batches shipped; this week added moment-modal best-offer + packs cheapest-secondary sort + clickable thumbnails. Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page), entity-hero dead-CDN thumbnail `onError` fallback. Audit docs (`PACK_/MOMENT_/SET_PAGES_AUDIT_2026-05-22.md`) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — OG routes hold at **13**; brand literals continue to be tokenized (`ce36102` did the static pages). The home renders the live `<HomeFmvPreview />`; `public/home-fmv-preview.png` is unreferenced in code (moot). Remaining: Fast Break / RTR / admin tokenize once stable. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **1,780 lines** (verified; grew ~29 from last week's 1,751, likely the F4 STALE footnote). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,895**, `analytics/page.tsx` **2,208**, `sniper/page.tsx` **2,070**. `CLAUDE.md` #14 still cites sniper at ~2,485 — **stale** (it's 2,070 post the May 23 reframe). Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED.** `CLAUDE.md` now marks this resolved; `git ls-files` shows none tracked (only an untracked `flowty-locker-test.json` in the tree). | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence in `lib/chains/flow/cadence/purchase-moment.ts` stays dormant and revivable. Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01, `e246f22`); now tracked as `CLAUDE.md` #3.** `ensureLive()` throws unless `RPC_TRADE_ESCROW_ADDRESS` is set; `/api/trade-chain/{propose,execute,deposit-callback}` + `/api/admin/reclaim-expired-trades` return 503; `/dashboard/trade-hub` `notFound()`s via the new `TradeHubClient.tsx` split. The 8 in-code stub TODOs (§5b) persist in the dormant code. The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To revive: deploy `RPCTradeEscrow`, set the env var, replace stub bodies. | Medium (shelved) | Large |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps via CHECK constraints, a `created_at` rate-limit column/trigger, a `bot_score` column from BotID, possibly an edge rate-limiter. (The `funnel_events` table follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped via `audit_20260601_funnel_events_anon_insert_size_caps` — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); neither is referenced by any `/api` route. Migrate to `user_id` + RLS when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Related to Q8's badge-sync row-grain work.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied earlier but the current concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — relevant if "harden the intelligence surfaces" (Priority #2) ever revisits alerting.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop (the `flowty_*`/`offers` tables back live admin surfaces). The remaining action is just to formally close the priority in `CLAUDE.md`. | §2.4 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced again this week** via the FMV mis-key sweep, `/insights` deals + offer-spread, collection-aware entity cells, and SEO JSON-LD hardening. | §2.2 + §2.3 |

*Implicit priority surfaced two weeks ago and still un-promoted:* **activation/conversion** (§2.1). Given ~13 users and the just-fixed funnel leak, it is arguably the highest-leverage work right now and worth promoting to an explicit `CLAUDE.md` action.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met — this is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql}` across `lib/ app/ components/ workers/ supabase/ cadence/ scripts/`, plus a full-tree sweep confirming no markers live outside those dirs) found **41 raw matches → 39 real markers across 29 files, plus 2 false positives** (see §8). That is **−1 real marker / −1 file vs last week's 40 / 30**, entirely because `lib/pro/gate.tsx` was **deleted** (its lone Stripe-gate TODO and the whole dead scaffold are gone — last week's §5g recommendation, now executed). `CLAUDE.md` does not track these; `docs/code-todos.md` covers only 2 follow-ups. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.6. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but now guarded (8 markers, 2 files)

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`. **Now fronted by `ensureLive()`** (line 51) so the stubs throw rather than return fake tx ids when the contract is unset. Line numbers shifted from last week (60/69/87/94/103 → 75/85/104/112/122) — the guard added lines.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI sets `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page itself now `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file)

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. Related to `docs/code-todos.md` item 2.

### 5d. Pipeline calibration / migration (3 markers, 3 files)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files)

- `app/(collections)/[collection]/collection/page.tsx:2667` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line drifted 2672 → 2667 — file edited, same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- `lib/pack-urls.ts:19` — `TODO(2026-05-26)`: verify the pack URL still resolves for sold-out drops.

### 5f. Cadence test coverage gap (2 markers, 1 file)

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

> **Resolved since last week (1 file, 1 marker):** `lib/pro/gate.tsx` — the entire file (with its `// TODO: wire Stripe subscription check`) was **deleted**. The functional Pro gate remains the separate `components/ProGate.tsx`. This is the full −1 marker delta. (Section 5g from last week is now empty.)

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md`:

**Known-issue slate:**
- **#2 Sentry error capture — RESOLVED.** DSN set in Vercel; SDK wired.
- **#3 Flowty event indexer "regression" — RESOLVED / reclassified.** Flowty shut down ~2026-05-13. (Note: slot #3 is now also occupied by the newly-shelved Trade Hub — see §9.)
- **#4 Pinnacle FMV — RESOLVED.** `pinnacle_fmv_snapshots` ~425 editions, 84% HIGH+MED, daily `pinnacle-1.0.0`. Own table, not the uuid-keyed `fmv_snapshots`.
- **#5 AllDay/UFC mis-categorized editions — RESOLVED.** Only 8 stray (all `disney_pinnacle`).
- **#6 WarmupContext key mismatch — RESOLVED.**
- **#7 AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** Resolver rewritten GQL-primary + `batch_size 5→200`.
- **#8 NBA stats / projections — RESOLVED.** `nba_player_projections` syncing.
- **#13 `flowty_archive` growth — RESOLVED.** Prune + `VACUUM FULL`; DB 13.8 → 6.5 GB.
- **#15 scratch fixtures — RESOLVED.** `CLAUDE.md` now marks resolved; none git-tracked (verified via `git ls-files`).
- **#16 `flow test` CI gating — RESOLVED, fully blocking.** `continue-on-error` removed; lint repointed to canonical Cadence path.
- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** Unchunked `.in()` exceeding PostgREST's URL cap; fixed by chunking + `log_pipeline_run` on the fatal path.

**Newly resolved this week:**
- **`lib/pro/gate.tsx` deleted** — the dead Stripe-gate scaffold removed (the prior reports' standing housekeeping recommendation, now done).
- **Trade Hub formally tracked + guarded (`e246f22`)** — the prior reports' standing "add Trade Hub to known-issues" recommendation is resolved; it's now #3 and shelved/guarded.
- **Storefront-cleanup machinery deleted (`d8cc6c2`)** — `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` removed (verified gone); the FLOW payer-wallet gas drain is killed at source. Under #9.
- **Phase F shipped 2026-06-01** — `ALTER COLUMN chain DROP DEFAULT`; chain-abstraction Phases A–F complete.
- **Overnight items:** P1 (evm watchlist 60→150m), S1 (anon revoke on `v_moments_needing_hydration`), N1 (institutional-wallets self-recovered), Q10 (listing-cache watchlist) — all resolved/verified; C-PAYER + C-PIN destall-false-positive tuning shipped 06-03; Q6 code fix shipped (`8605c43`).

**Also shipped this week (not in the numbered list):** `/insights/deals` + `/insights/offer-spread` (hub 10→12) + `topshot_deals_vs_fmv` / `topshot_offer_ask_spread` views; FMV mis-key sweep F2–F5 + `v_fmv_sanity_flags` v2; entity collection-aware ask/offer + AllDay `cross_market_ask` (H1–H6); SEO JSON-LD always-image/description (`f8fe90b`) + STALE-price omission (`6e90f3f`); packs cheapest-secondary sort + clickable thumbnails (`64e3f4a`); moment-modal best offer + CSV gate (`5081589`); concierge `+Cart` removal (`396cef9`); brand-token static pages (`ce36102`); RTR overflow fix (`da11697`); stale `/signup` rule drop (`9ace049`); smoke soft-fail on the dead `cached_listings` check (`0e1da2d`).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation promoted given the traction reality:

1. **Confirm the funnel fix is working (§2.1).** Cheapest, highest-leverage — verify `funnel_events` is recording anon top-of-funnel and that the live ~33K-URL sitemap is being crawled (GSC steps in `docs/operations/seo-gsc-checklist-2026-05-31.md`). Then finish the conversion-polish + wallet-paste-onboarding handoffs.
2. **Finish the FMV mis-key cleanup (§2.3 / F1).** Tier-A re-map the clean RARE/LEGENDARY sub-batch, per-edition the messy tail, and find the moments-edition writer that mis-keyed contiguous mint blocks. Separately, wire `v_fmv_sanity_flags` into the weekly health check (operator TODO).
3. **Drain the overnight queue (§2.5).** Q5 (smoke-lag rebase) is small; N2 (hydrator statement-timeout) and Q8 (badge-sync row-grain) need decisions; PIN1/L1 are small operator/CC items; Q6 is effectively done; Q7 (git-lock infra) stays wound-down pending a native-clone call.
4. **Formally close Priority #1 (Flowty, §2.4).** The decision is made (keep frozen); just record it in `CLAUDE.md`.
5. **Chain-abstraction cleanup as capacity allows (§2.6 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` default-export trap). Deferrable.
6. **Pack/Moment/Set tail (#17)** — modal a11y verification + the Set aggregate-RPC fix + the dead-CDN thumbnail `onError` fallback, opportunistically.
7. **Tech-debt — monolith refactor Phase 1 (#14).** Zero-risk leaf-component extraction. (#15 is done.)
8. **Brand polish (#11 tail, #12), `/dashboard` migration (#10).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run** — `git log` returned 30 commits in the window since the prior report (≈17 code, ≈13 docs/ops; a handful overlap the 06-01-AM close-out already covered last week). The net-new code work is summarized in §6.
- **Report-location caveat:** the scheduled-task brief states the older root-level `PROJECT_HEALTH_*` reports "were relocated into `docs/health/` on 2026-06-03." **This has not happened in the working tree** — `PROJECT_HEALTH_2026-05-22/-05-25/-05-30/-06-01.md` are all still in the repo root. I created `docs/health/` and wrote this report there per the brief, but did **not** move the prior four (out of scope — the brief says only create the new file). A future pass or operator may want to actually relocate them.
- **All file/doc paths cited in `CLAUDE.md` and the prior report were confirmed to exist** — including `docs/audits/flowty-teardown-plan-2026-05.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/audits/purchase-moment-2026-05.md`, `docs/code-todos.md`, `docs/trade-escrow/STATUS.md`, `docs/overnight/ledger.md` + `metrics-latest.json`, `app/api/public/insights/squeeze/route.ts`, both Phase-D canonical targets, `components/ProGate.tsx`, and `scripts/scan-historical-storefront.mjs`. **The only two "missing" cited paths are the intentionally-deleted `scripts/cleanup-storefront-wallets.mjs` and root `cleanup.cdc`** — `CLAUDE.md`'s #9 note documents the deletion (past tense), so these are correct, not stale references.
- **`lib/pro/gate.tsx` confirmed deleted** (the prior report flagged it as a delete-candidate); `lib/pro/` no longer contains it and nothing imports it.
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"` (same FP the last several reports flagged); and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_collections_chain_drop_default` (the in-source-dirs scan excludes `docs/`, but I confirmed this file/line still exists for week-over-week comparability). Both excluded from the 39 real markers.
- **TODO count delta vs. last week:** 40 → 39 real markers (−1), 30 → 29 files (−1). The entire delta is `lib/pro/gate.tsx`'s deletion. All other markers match last week's inventory; several line numbers shifted from edits (`fcl-submit.ts` 60/69/… → 75/85/… after the `ensureLive` guard; `collection/page.tsx` 2672 → 2667).
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,895** · `analytics/page.tsx` **2,208** · `sniper/page.tsx` **2,070** · `dashboard/page.tsx` **1,780** · `lib/blazers-trivia.ts` **198**. `CLAUDE.md` #14's sniper figure (~2,485) remains **stale** — it's 2,070.
- **OG routes:** **13 present** (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `team`) — unchanged from last week.
- **`/insights` surfaces:** **12** API routes + 12 page dirs (`deals` and `offer-spread` are new since last week's 10), confirmed by directory listing and the `INSIGHT_ROUTES` array in `app/sitemap.ts`.
- **Trade Hub guard verified live in source:** `ensureLive()` present in `lib/trade-escrow/fcl-submit.ts`; `/api/trade-chain/{propose,execute,deposit-callback}/route.ts` each return 503 "Trade Hub is not available yet."; `app/dashboard/trade-hub/TradeHubClient.tsx` exists (the server-gate split).
- **DB-side facts** (FMV counts, NO_DATA structural finding, traction numbers, view row counts, pipeline health) are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports. (The Supabase MCP was available; a live DB audit is out of scope for a repo-health regeneration.)
- **Autonomous-task caveat:** because the daytime monitor and night pass run against this repo, the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record. The 06-03 night pass was NO-PUSH (no sandbox git creds); a fresh monitor inbox file (`docs/overnight/inbox/2026-06-04T00-24-37Z.md`) was observed mid-run.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-03)

Every `#1–#17` slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 is double-assigned** — Flowty indexer resolved; Trade Hub newly shelved + guarded | `ensureLive()` + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved** | `pinnacle_fmv_snapshots` (per `CLAUDE.md`) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** | `CLAUDE.md` + 2026-05-25 session |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted 2026-06-03 | **Retired** — manual script; cleanup driver deleted | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` gone (verified) |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = 1,780 lines | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — 13 OG routes; brand literals tokenized; home placeholder moot | `ls app/api/og/`; `git log` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,895 / analytics 2,208 / sniper **2,070** (`CLAUDE.md` cites sniper ~2,485 — stale) | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved 2026-06-01 | **Resolved** — none git-tracked | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — mostly shipped** | brand/data/mojibake + moment-modal + packs batches landed; a11y + Set-RPC + thumbnail-`onError` tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 5 open or partial (#10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.)

**Bottom line for `CLAUDE.md`:** the known-issues list is in good shape and several prior-report recommendations landed (Trade Hub now tracked; `lib/pro/gate.tsx` deleted; storefront-cleanup removed; #15 marked resolved). Drift points to correct on the next pass: (a) **resolve the #3 numbering collision** — Trade Hub reuses the slot of the resolved "Flowty event indexer" item; give Trade Hub a fresh number (e.g. #18) so the two don't share #3; (b) #14 still cites `sniper/page.tsx` at ~2,485 lines — it is **2,070**; (c) Prioritized Action #1 (Flowty teardown) can be **closed** per `docs/cleanup-decisions-2026-06-01.md` (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 Phase-D chain-rename shims especially are intentional debt worth a one-line note. Finally, given the traction reality (~13 users at last read), consider promoting **activation/conversion** to an explicit prioritized action now that the funnel leak is fixed.
