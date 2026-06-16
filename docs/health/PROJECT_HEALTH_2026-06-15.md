# Rip Packs City — Project Health Report

**Date:** 2026-06-15
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §), `docs/overnight/ledger.md` (live autonomous-pass state), `docs/overnight/focus.md`, a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-08.md` (7 days ago). This regeneration mirrors its structure. `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all seven reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-06-08 — an unusually consequential week dominated by an infrastructure incident, a cost blow-out, and a UI theming wave, on top of continued feature velocity.** **229 commits since 2026-06-08** (≈115 code-bearing: 45 `feat` / 54 `fix` / 6 `style` / 6 `refactor` / 4 `perf`; the rest process/automation: 72 `docs` / 23 `monitor` / 4 `night-pass` / 7 `chore` / 3 `cowork` / 3 `ops` / 1 `ci`). The four headline stories: **(1) The DBSAT-IO-EXHAUSTION-0612 incident — RESOLVED.** A three-day (06-10 / 06-11 / 06-12) daytime disk-IO starvation incident on the Supabase **Micro** tier — peaking in a total `pipeline_runs` telemetry blackout and intermittent public-page read errors on 06-12 — was decisively ended by Trevor upgrading Supabase **Micro → Small** (shared_buffers 512 MB / max_connections 90 / effective_cache_size 1.5 GB) plus cohort-split wave pacing (`eba6491`). Two-plus consecutive clean nights since; `metrics-latest.json` re-baselined on the new tier. **(2) A Vercel cost blow-out surfaced — the new dominant operational theme.** The June invoice hit **$218.87** (Build CPU $125.68 / 57%, Fluid $66.34, Observability $23.77) because Spend-Management pause was OFF (uncapped). The biggest lever shipped (`0e7e627` — skip prod builds on docs-only commits); five more cost levers are queued (§2.6). **(3) A light/dark theme system landed** via a large `style(light-mode)` tokenization sweep across modals, chrome, `/packs`, `/analytics`, the dashboard, and the three monolith pages — materially advancing brand-token consistency (#11). **(4) Three new public `/insights` surfaces** — `top-sales` (Whale Watch), `trophies` (Trophy Room), `pack-sniper` — bringing the hub to **15 surfaces** (was 12), each with the full server-render / OG / sitemap / canonical treatment.

> **Plus a dense run of intelligence + activation work:** unified personal transaction history (`/dashboard/history`, `503b836`); team-moment display fixed end-to-end (render team moments as `team + play` across every grid/page — **CLOSED**); UFC `wmc` NULL-`edition_key` fixed via a decoupled enrichment-drain cron (`fb2fbac` + operator wiring — **CLOSED** at the 2/4,584 fossil floor); TS marketplace buyer/seller backfill widened (`1d79539`/`83bb40f`); special-serial labeling finalized to `#1 / Jersey Match / Perfect Serial` (`893da9f`); real badge artwork on trophy slabs (`f5fff3c`); referral-loop wiring on profile + Top-Sales share; a smoke-test fix that stopped per-tick **paid concierge LLM calls** (`f073ae0`, ~$44/mo of Anthropic spend); and the Q8 badge-sync integer-pair grain made durable (`5fac76d`).

> **A genuinely blocked item to flag — A1 / special-serial owner build.** The last three commits (`3f77cd8` → `a126f44`) attempted a browser-fingerprinted `topshot-proxy` route to unblock the Top Shot GQL `searchMintedMoments` query (needed to show *who owns* a special serial — the same capability the `special-serial-sweep` edge function stubs in §5c). The unblock was **recorded as ineffective** and the probe removed; that owner-lookup capability remains blocked at the Top Shot API edge.

> **Traction reality (carried forward — no fresh user-count snapshot this run).** The last logged traction read (2026-05-31, ledger) was **~13 total users, 0 signups in 7 days, 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** A "launch-readiness" doc-fold appears in this week's commits (`2275d1b`), but no signups-moved-off-zero measurement is in the repo. Monetization remains tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* and *measurement* of the activation surfaces already built. **The one new financial reality is cost, not revenue:** the platform now demonstrably over-spends on Vercel (and a smaller amount on Anthropic concierge calls, since fixed) for ~13 users — so cost-right-sizing is this week's genuinely new pressure.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — Flowty-dependent infra is frozen; the teardown DECISION is "keep frozen, close Priority #1" (`docs/cleanup-decisions-2026-06-01.md`). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and pack-EV are historical-only. **(3) Chain-two (Candy / Solana) prebuild landed inert (06-08)** — collections seeded, `helius-proxy` scaffolded, an inert ingest path written; it adds a new 17-line Candy/Solana discovery-placeholder block to the TODO inventory (§5g). Chain-two code is gated on a **July-8 Candy data tripwire** — not started early.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **absent right now = no freeze active.** The night pass is now pushing reliably (the sandbox-native clone flow works — the long-running NO-PUSH/Q7 blocker is effectively resolved). **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Net-new shipped features (not numbered) | **7** | Rewards points economy (DIAL-IN); Pinnacle per-render FMV engine; TS + AllDay on-chain offers; **3 new `/insights` surfaces** (top-sales / trophies / pack-sniper); unified transaction history; trophy-slab badge artwork; Candy chain-two prebuild (inert) — §2.2 |
| Open overnight operational items | **~6 active + ~4 deferred** | **NEW dominant theme: Vercel cost** (FLUID-RIGHTSIZE, CRON-CADENCE, OBSERVABILITY-SAMPLING, SPEND-PAUSE, FLUID-CONCURRENCY); ALLDAY-V1-UNMAPPED-DRIFT; LISTCACHE cadence-confirm. Deferred: ANALYTICS-SMOKE leg-opt, IPFS ×2, ASK-ONLY/TS-SALES-INGEST-GAP Phase 2 — see §2.6 |
| Net-new structural workstream | 2 | Multi-chain chain-abstraction (Phases A–F complete; 18 shim TODOs) + the inert Candy/Solana chain-two prebuild (§2.8) |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) recommended-closed (keep frozen). Cost-right-sizing arguably belongs here now. |
| In-code TODO markers | **55 real lines / 31 files** (+2 false positives) | **+16 vs last week's 39.** The entire delta is the new Candy/Solana chain-two block; one stale marker (`pack-urls.ts:19`) resolved — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** Operationally the platform is in a *better* place than last week despite the drama: the three-day DBSAT incident that dominated 06-10→12 is resolved at the infrastructure level (Micro → Small), the overnight queue that held ~14 items on 06-08 has drained to a handful, and the night pass is pushing reliably again. The dominant concern remains **activation/traction** (≈13 users at last read) — but two genuinely new pressures appeared: **(1) cost** — a $218.87 Vercel month and a (now-fixed) ~$44/mo concierge-LLM smoke leak prove the platform over-spends for its user count, so right-sizing is real work, not hygiene; and **(2)** the platform's reliance on **external triggers and external APIs** showed its edges again — the DBSAT incident, the recurring cron-job.org auto-disable class, and the A1 Top-Shot-GQL block that couldn't be worked around. Code-quality risk is concentrated, descending: **(1) FMV correctness** (Pinnacle per-render waves still finishing; the ASK_ONLY / TS-sales-ingest gap is now understood to be a *coverage* problem, with a real backfill pipeline draining it); **(2) cost/operational right-sizing** (the Vercel cluster); **(3)** the chain-abstraction + Candy chain-two cleanup tails (18 + 17 intentional TODOs). Monolith refactors, brand polish, and page tune-ups remain secondary — though the light-mode wave quietly knocked down a lot of the brand-token debt.

### Themes

| Theme | Items |
|---|---|
| Conversion / activation (the real critical path) | Rewards points economy (live, DIAL-IN); wallet verification (#0); transaction history; referral-loop wiring; new `/insights` surfaces (top-sales / trophies); honest anon overview panels (`06454b9`). **Verify `funnel_events` accumulates; measure whether signups move off zero.** (§2.1) |
| Cost / operational right-sizing (NEW) | Vercel $218.87 month → 1 lever shipped (`0e7e627`), 5 queued (§2.6); concierge-LLM smoke leak fixed (`f073ae0`); seed-refresh interval widened 6h→24h (`0f3b8ca`); docs-only build skip. |
| Data-intelligence quality | Pinnacle per-render FMV waves (§2.3); TS + AllDay on-chain offers (`OFFER-SANITY-RAISE` hardened, SECDEF anon hole closed `5fac76d`/`60c1438`); TS marketplace buyer/seller backfill; TS-SALES-INGEST-GAP backfill draining ASK_ONLY (§2.3) |
| UI / theming (NEW) | Light/dark theme system via the `style(light-mode)` tokenization sweep — advances brand #11; trophy-slab real badge artwork; team-moment display fixed across all surfaces |
| Housekeeping — dead infrastructure | Flowty teardown DECISION = keep frozen (§2.5); storefront-cleanup machinery deleted + payer wallet/cron paused (#9) |
| Operational / overnight queue | Vercel cost cluster; ALLDAY-V1-UNMAPPED-DRIFT (operator cron); LISTCACHE cadence-confirm; ANALYTICS-SMOKE leg-opt; IPFS deferrals (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete (18 shim TODOs); Candy/Solana chain-two prebuild inert (17 discovery TODOs) (§2.8 / §5a / §5g) |
| Tech debt / refactor | `/dashboard` migration (#10, now **2,053 lines** — grew ~372 from the transaction-history add); monolith pages (#14) |
| Page polish | Pack/Moment/Set tune-up (#17 — special-serials, resilient hero media, team moments); brand punch list (#11 — big light-mode advance); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded); Cart (#1, shelved by decision); A1 special-serial owner lookup (blocked at the TS API edge) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id` migration; `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. Activation leads (the machinery exists and needs measurement), now paired with **cost right-sizing** (genuinely new this week), then FMV correctness and the usual operational workstreams.

### 2.1 Conversion / activation — machinery built, still unmeasured — `Severity: High · Effort: Medium (shipped, unmeasured)`

The funnel has been open for weeks; this week added more activation surface and polished the anon first-impression:

- **New public `/insights` surfaces.** `top-sales` (Top Sales / Whale Watch, `b623be2` + `7961e85`) and `trophies` (Trophy Room, `34b1543`) shipped with the full server-render / OG / canonical / sitemap treatment and @handle enrichment for crawl/SEO; `pack-sniper` added as a per-collection insights tab. Both new boards passed the `rpc-insights-qa` checklist (backing-view security `security_invoker=on`, anon-SELECT).
- **Referral loop wired** (`0eee25c`, `8347ae6`) — profile sharing and the Top-Sales copy-link now carry `ref=` into the rewards referral path.
- **Anon first-impression batch** (`06454b9`) — un-gated `GET /api/fmv/demo`, opened the collection-scoped `GET` of `/api/insider-signals` + `/api/marketplace-status` so the public `/<collection>/overview` panels render real data, fixed a duplicate `WebApplication` JSON-LD, and removed dead shelved-Cart chrome.
- **Profile SSR + $0-unfurl fix** (`8789568`) — `/profile/<username>` now server-renders (anon/crawlers/link-previews saw `PORTFOLIO FMV —` before); also fixed a `generateMetadata` query against a non-existent `owner_key` column that made **every** profile unfurl read `$0 / 0 moments`.
- **Rewards points economy** (live, carried from last week, status **DIAL-IN**) — store stocking still awaits Trevor's Moment picks; raffle still held pending legal review. No code blocker.

Suggested next step (unchanged and still the highest-leverage work): confirm `funnel_events` records anon top-of-funnel; instrument Rewards engagement (sign-ups, daily-visit earns, redemptions); unblock the Rewards DIAL-IN. Then watch whether signups move off zero. Worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — expanded to 15 — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — now 15 surfaces** (verified against `INSIGHT_ROUTES` in `app/sitemap.ts`): `squeeze`, `pack-reality`, `pack-sniper`, `rookies`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `market`, `offer-spread`, `deals`, `trophies`, `top-sales`, `squeeze-check`, `tc-report`. **+3 this week** (`pack-sniper`, `trophies`, `top-sales`).
- **Unified personal transaction history** (`503b836`, `/dashboard/history`) — new service-role `get_wallet_transaction_history()` (verified saved-wallet ownership gate; wallet-agnostic so it drops into the later any-wallet analytics view); titles resolve via `wallet_moments_cache` (~99.9% coverage). Grew the dashboard monolith to 2,053 lines (#10).
- **Trophy-case slab real badge artwork** (`f5fff3c`, `e26502e`, `720c313`) — real badge images on slabs + live public-profile trophy FMV/tier; the `/api/badge-image` route made anon-public so artwork loads logged-out (`226dab4`).
- **Team-moment display** fixed end-to-end — no-player "team moments" (WNBA Skyline, Season Rewind, etc.) now render `team_name + play_type` across the shared edition grid, team checklist, `TeamActivity`, `TeamSqueeze`, and `PopularOnCollection` (`1959c13` → `a3da7be`). **CLOSED.**
- **OG cards hold at 14 routes** (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `share`, `team`) — the new insights surfaces reuse `/api/og/insights`.

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV pipeline — per-render waves + a real coverage backfill — `Severity: Medium · Effort: Medium`

- **Pinnacle per-render FMV (PIN-FMV-REKEY).** Carried from last week — the additive per-render engine on `pinnacle_catalog` and reader-cutover waves 1a/1b/2 are shipped; the render-FMV staleness tripwire (`pinnacle_fmv_stale_hours`) is live in `v_rpc_trust_health`. **Remaining (Trevor-sequenced): waves 2/3** — the last entity/stats/route readers, then retire legacy `pinnacle_fmv_snapshots` at zero readers.
- **The ASK_ONLY tail is a *coverage* gap, now being drained.** The week's clearest FMV finding (ledger `ASK-ONLY-CAP`): ASK_ONLY ≈ the bucket of editions whose **sales were never captured** (68–78% of ASK_ONLY editions have 0 sales in the DB vs ~0% for LOW/MEDIUM/HIGH). Three "cap" fixes were tried and all failed the LiveToken acceptance gate — **the cohort-cap idea is DECIDED do-not-ship** (it guts legit rare-parallel grails). The real path shipped as **`topshot-sales-history-backfill`** (`37ad345`/`18fdf7e`): a paced per-edition historical-sales backfill from TS `searchMarketplaceTransactions`, draining the ~784 int-keyed ASK_ONLY-with-0-sales editions into `sales`; `fmv-recalc` re-labels them off real sales on its sweep.
- **Offers correctness hardened.** `raise_edition_offers_from_chain()` rewritten to edition-grain only (sub/serial offers can no longer raise the edition Best-Offer cell) **and** a SECDEF anon EXECUTE hole on it was closed (`60c1438`); the Q8 badge-sync integer-pair grain was made durable with a poison-blocking trigger (`5fac76d`).
- **FMV writer poison guards** (carried, `e3aee28` family) — grail-spike dampening + ask-over-sales precedence guard remain live; the DUPE1 inert-UUID re-mint that inflated NO_DATA is **effectively closed** — the pack-EV v20 int-pair re-key stopped the leak (verified 0 leak over 8 days, `e7b2816`) and recent monitors read sentinel UUID-leak `0`.

Suggested next step: finish PIN-FMV-REKEY waves 2/3 and retire legacy `pinnacle_fmv_snapshots`; watch the `topshot-sales-history-backfill` LiveToken acceptance gate as ASK_ONLY drains; keep `v_fmv_sanity_flags` wired into the weekly health check.

### 2.4 The DBSAT-IO-EXHAUSTION-0612 incident — RESOLVED — `Severity: was High (incident) · Effort: resolved`

A three-day daytime disk-IO starvation incident (06-10 / 06-11 / 06-12, worst on 06-12 with a total `pipeline_runs` telemetry blackout from ~13:02Z and intermittent public edition/set page read errors) was root-caused to genuine Supabase **Micro**-tier disk-IO budget exhaustion under the per-wallet backfill fan-out, **not** any single writer bug (it predated the week's ships, so no auto-revert was warranted). Resolution had two parts, both 06-13: Trevor upgraded **Micro → Small** (shared_buffers 512 MB / max_connections 90 / effective_cache_size 1.5 GB), and the seed-wave dispatch was cohort-split (`eba6491`, `?cohort=K&of=N`) into staggered sub-waves. The decisive 06:45–07:27Z cohort wave then absorbed 1,507 runs / 3 fails (0.2%); two-plus clean nights have followed. `metrics-latest.json` was re-baselined. Several knock-on items closed with it: `UFC-WMC-NULLKEY` (decoupled drain cron), `TFP-SLOT-WAVE-COLLISION` + `TFP-480-RESTORE`, `ANALYTICS-SMOKE-RESIDUAL` (restored to 60s), and `LISTCACHE-SILENT-0612` (liveness).

### 2.5 Flowty teardown (Prioritized action #1) — DECISION made: keep frozen — `Severity: Low · Effort: n/a`

Unchanged from last week. `docs/cleanup-decisions-2026-06-01.md` concludes **keep frozen, close Priority #1** — the `flowty_*` tables and the `offers` RPC back live admin surfaces, so nothing is safe to drop. The remaining action is to formally close Priority #1 in `CLAUDE.md`.

### 2.6 Overnight operational queue — much smaller, now cost-led — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue drained hard this week. **Closed/resolved since the last report:** DBSAT-IO-EXHAUSTION-0612, UFC-WMC-NULLKEY, LISTCACHE-SILENT-0612, TFP-SLOT-WAVE-COLLISION, TFP-480-RESTORE, ANALYTICS-SMOKE-RESIDUAL, TEAM-MOMENT-DISPLAY, TROPHIES-INSIGHTS-QA, MONITOR-ARTIFACT-ACCESS, OFFER-SANITY-RAISE, the Pinnacle reconcile/ FMV-watch items, PIN1 (Sentry NEXTJS-15 spike threshold raised), SMOKE-EDITION-TIMEOUT, and the Q7 NO-PUSH git-infra blocker (clone-flow now pushes). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **VERCEL-FLUID-RIGHTSIZE** | $66/mo Fluid line. Lever is **frequency + fan-out, not memory** (memory cuts lower CPU → slower → DBSAT risk). Dominant driver = the `seed-wallet-refresh` ~1,260-child wave ×4/day. | Med | **NEW.** CC, gated: extend the cohort-split to *thin* each wave (widen low-priority refresh 6h→12/24h — already partly done, `0f3b8ca`). Gate: 3–5 clean days post cohort-split. |
| **VERCEL-CRON-CADENCE** | Drop frequency where ~20-min cadence is overkill on the 300s crons. | Low | **NEW.** Operator (cron-job.org). Pairs with the Fluid line. |
| **VERCEL-SPEND-PAUSE** | Spend-Management → Pause Projects is **OFF** = uncapped (how a $1 budget hit $218). | Med | **NEW, backstop — do regardless.** Trevor (dashboard): set a monthly on-demand cap above normal / below catastrophe. Tradeoff: site pauses when hit. |
| **VERCEL-OBSERVABILITY-SAMPLING** | $24/mo Observability. | Low | **NEW.** Trevor (dashboard): lower sampling. |
| **VERCEL-FLUID-CONCURRENCY** | Check Project → Functions for provisioned/always-warm concurrency (bills idle). | Low | **NEW.** Trevor (dashboard). |
| **ALLDAY-V1-UNMAPPED-DRIFT** | All 246 open AllDay `unmapped_sales` are `source=onchain_dapper_v1`; 236 are `v1_tx_decode_budget_exhausted` (per-tick 25-call V1 decode budget overflow), accruing ~+23/day. Correctly held out of `sales` (no FMV corruption). | Low | **NEW.** The recover route exists (`/api/admin/recover-v1-budget-exhausted`) but has **0 cron**; the exact cron-job.org entry is already documented in `cron-schedule.md` Pending additions. Operator: wire it, or classify the budget-exhausted rows as a permanent residual. |
| LISTCACHE cadence-confirm | `topshot-listing-cache` is firing reliably (liveness CLOSED) but at ~2.5h vs historical ~20m. | Low | Operator: confirm the slower cadence is intended post-stagger, not interval drift. |
| ANALYTICS-SMOKE leg-opt | 5 slow `/analytics` dashboard fns (`data_quality_overview` >120s, etc.) are now existence-checked off the smoke path but still slow for users. | Low (optional) | CC, optional: `(collection_id, sold_at)` index + LATERAL rewrites. Off the critical path. |
| IPFS-CIDSET-EVENT-LEG / IPFS-GATEWAY-FALLBACK | Two deliberately-deferred IPFS catalog-freshness / image-resilience items. | Low (deferred) | CC: **do not build now**; explicit triggers documented in the ledger. |

The ledger has no formal **"Declined — do not re-suggest"** heading populated, but `ASK-ONLY-CAP` is effectively a decided do-not-ship (the cohort-cap idea fails its own acceptance test).

### 2.7 Pack EV / pack-viz — stable (no new defects) — `Severity: Low · Effort: n/a`

Carried from last week — pack-dist math/honesty (`5dcdee8`), PACKVIZ-GRID top-chases + exhausted split (`41dfae2`, formally CLOSED this week `bb6326a`), and pack-ev v21 queue-unwedge all remain shipped. DQ4 (pack-EV inert-UUID re-mint) was formally CLOSED this week (`e7b2816`, 0 leak over 8 days). No open pack-EV defects.

### 2.8 Chain foundation — abstraction complete; Candy chain-two prebuilt inert — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F are complete** (Phase F shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged, bulletproof by design (zero caller breakage across 833 imports). **Trap:** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`.
- **Candy / Solana chain-two prebuild landed inert (06-08).** `collections` seeded (`candy_mlb` / `panini_blockchain`, `is_active=false`), `helius-proxy` Cloudflare Worker scaffolded with its own auth surface, and an inert ingest path written (`lib/chains/solana/{das,normalize}.ts`, `app/api/ingest/candy-editions`, `app/api/candy-sales-indexer`, `app/api/wallet-backfill-candy`). It writes nothing until five discovery placeholders are filled (§5g) and is gated on the **July-8 Candy data tripwire** — do **not** start chain-two code early. This is the source of the new 17-line Candy TODO block.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (Rewards economy, new `/insights` surfaces, referral loop, anon-overview polish) shipped; **verify `funnel_events` is recording** and measure whether signups move off zero. | High | Medium (shipped, unmeasured) |

### Cost / operational right-sizing (NEW)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Vercel cost | June invoice $218.87 (uncapped Spend-Management). 1 lever shipped (`0e7e627` docs-only build skip); 5 queued (§2.6). | Medium | Small–Medium (mostly dashboard + cron config) |
| Concierge LLM | Per-tick smoke was making paid Sonnet+5-tool calls (~$44/mo, ~99.7% of Anthropic spend). **FIXED** (`f073ae0`, gated to a daily window). | Low (fixed) | Done |

### Data-intelligence quality

| Item | Issue | Severity | Effort |
|---|---|---|---|
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine + waves 1a/1b/2 shipped; waves 2/3 + legacy `pinnacle_fmv_snapshots` retirement queued (Trevor-sequenced). | Medium | Medium |
| TS-SALES-INGEST-GAP | ASK_ONLY editions are largely those whose sales were never captured. The cohort-cap idea is decided do-not-ship; the real fix (`topshot-sales-history-backfill`) is **shipped and draining** under its own LiveToken acceptance gate. | Medium | Medium (in progress) |
| DUPE1 | Inert TS UUID-dupe re-mint — **effectively closed.** The pack-EV v20 int-pair re-key stopped the leak (0 leak / 8d, `e7b2816`); badge-sync got a durable int-pair guard (`5fac76d`); sentinel UUID-leak reads 0. | Low | (closed at writer level) |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |
| Candy chain-two | 17-line discovery-placeholder block (5 named `TODO_1`–`TODO_5` + 3 route notes) in the inert Candy/Solana ingest path — unfillable until Candy secondary trading opens (gated on July-8). Intentional. | Low | Medium (gated) |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. This week: special-serial labeling finalized (`#1` / Jersey Match / Perfect Serial, `893da9f`); resilient edition/moment hero media (`bce3533`, `45f52bb`); team-moment display across all surfaces (CLOSED). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`PACK_/MOMENT_/SET_PAGES_AUDIT_2026-05-22.md`, archived) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — **big advance this week** via the light/dark theme system: a `style(light-mode)` tokenization sweep across modals/chrome, `/packs`, `/analytics`, the dashboard, and the three monolith pages (`ce3d2d3`, `6b4aca4`, `87f401a`, `b50a082`, `dd2be72`, `fa60e80`), plus a guard extension. The phase-1 token sweep + CI guard (`scripts/check-brand-tokens.mjs`) remain. Remaining: the longer-tail surfaces (email HTML, Fast Break / RTR / admin), still tracked not gated; `public/home-fmv-preview.png` unreferenced (moot — live `<HomeFmvPreview />`). | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,053 lines** (verified; **grew ~372 from last week's 1,681** via the transaction-history add, `503b836`). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,870**, `sniper/page.tsx` **2,134** (grew ~64 via the per-collection Pack Sniper tab), `analytics/page.tsx` **2,128**. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts`. Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01).** `ensureLive()` (verified present, 6 refs) throws unless `RPC_TRADE_ESCROW_ADDRESS` is set; `/api/trade-chain/*` return 503; `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx`. 8 in-code stub TODOs persist (§5b). | Medium (shelved) | Large |
| A1 | Special-serial owner lookup — an attempt to unblock the Top Shot GQL `searchMintedMoments` (browser-fingerprinted proxy route, `3f77cd8`) was **recorded ineffective** and the probe removed (`a126f44`). The owner-display capability — and the `special-serial-sweep` ownership lookups (§5c) — remain blocked at the TS API edge. | Low–Medium (blocked externally) | Medium (depends on TS API) |

### Net-new features not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Rewards | Off-chain points economy — **live, DIAL-IN.** Non-code blockers: store stocking (Trevor's Moment picks); raffle legal review. Worth a numbered slot in `CLAUDE.md` (e.g. #19). | n/a (live, dialing in) | Medium (non-code) |
| New `/insights` | `top-sales`, `trophies`, `pack-sniper` — live, no open defects. | n/a (shipped) | — |
| Candy chain-two | Inert prebuild — see §2.8 / §5g. Gated on July-8. | n/a (gated) | Medium |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (The `funnel_events` table follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate when a real consumer arrives. (The profile OG-card work already re-keyed `owner_key`→`user_id` surface-by-surface — the migration is starting to happen incrementally.)
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Note: badge *coverage* otherwise improved this week via the `?mode=catalog` sweep + the Q8 grain fix.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied earlier but the concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — adjacent to the Rewards earn-hook surface.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop. The remaining action is to formally close the priority in `CLAUDE.md`. | §2.5 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via per-render Pinnacle FMV, the TS-sales-ingest backfill, offers hardening, transaction history, and the three new `/insights` surfaces. | §2.2 + §2.3 |

*Implicit priorities surfaced and still un-promoted:* **(a) activation/conversion + its measurement** (§2.1 — ≈13 users, machinery live but unmeasured); **(b) cost right-sizing** (§2.6 — genuinely new this week; a $218.87 Vercel month for a pre-revenue site is itself a problem worth an explicit action, paired with the Spend-Management backstop). Both are arguably worth promoting to explicit `CLAUDE.md` actions.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** This is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`) returned **57 raw matches**. Excluding **2 false positives** (see §8) leaves **55 real marker lines across 31 files**. That is **+16 vs last week's 39** — and the entire delta is the new Candy/Solana chain-two block (§5g, 17 lines); one previously-tracked marker (`lib/pack-urls.ts:19`) was reworded away (−1). `CLAUDE.md` does not track these. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest single cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs (`submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`). Fronted by `ensureLive()` (6 refs) so the stubs throw rather than return fake tx ids when the contract is unset.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file) — unchanged, now more relevant

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. **This is the data-layer counterpart of the A1 block** — the owner-display feature needs the Top Shot GQL `searchMintedMoments` capability that A1 could not unblock (§3, A1).

### 5d. Pipeline calibration / migration (3 markers, 3 files) — unchanged

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (3 markers, 3 files) — `pack-urls.ts:19` resolved (−1)

- `app/(collections)/[collection]/collection/page.tsx:2692` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line moved 2667→2692 with the light-mode edits; same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- *(Resolved: `lib/pack-urls.ts:19` — the `TODO(2026-05-26)` sold-out-pack-URL marker was reworded into a plain comment; no longer a marker.)*

### 5f. Cadence test coverage gap (2 markers, 1 file) — unchanged

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Candy / Solana chain-two discovery placeholders (NEW — 17 lines, 3 files)

The inert chain-two prebuild (06-08) wraps **5 named discovery placeholders** that are unfillable until Candy secondary trading opens (gated on July-8):

- `lib/chains/solana/normalize.ts` (14 lines — `:5,10,27,29,31,33,35,37,39,40,64,158,162,166`) — the `DISCOVERY TODOs` block: `TODO_1` (Metaplex Core collection mint → `CANDY_MLB_COLLECTION_ADDRESS`), `TODO_2` (Magic Eden symbol → `CANDY_MLB_ME_SYMBOL`), `TODO_3`/`TODO_4` (serial / edition-size attribute keys), `TODO_5` (stable per-edition key), plus the `.startsWith("TODO_")` route-guard checks.
- `app/api/ingest/candy-editions/route.ts` (`:8`, `:72`) + `app/api/candy-sales-indexer/route.ts` (`:111`) — inert-ingest notes that short-circuit the routes until the placeholders are filled.

→ Intentional, gated debt — the chain-two analogue of the §5a shims. The routes write nothing while the placeholders are unfilled.

> **Net change since last week:** −1 (`pack-urls.ts:19` resolved), +17 (the Candy/Solana block). The §5a–§5f markers are otherwise content- and (modulo the one light-mode line-shift in §5e) line-identical to the 2026-06-08 inventory.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set), #3 (Flowty event indexer — reclassified, Flowty shut down), #4 (Pinnacle FMV — resolved + per-render-enhanced), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key), #7 (AllDay `unmapped_sales` — resolver rewritten), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — fully blocking), plus the fmv-recalc silent stall (`dd84526`).

**Newly resolved / closed this week:**
- **DBSAT-IO-EXHAUSTION-0612 — RESOLVED.** Three-day Micro-tier disk-IO incident ended by the Micro→Small upgrade + cohort-split wave pacing; two-plus clean nights since. (§2.4)
- **UFC-WMC-NULLKEY — CLOSED.** Decoupled `ufc-enrichment-drain` cron (`fb2fbac` + operator wiring) drained the backlog to the 2/4,584 fossil floor; watchlisted `@120m` (`audit_20260614_watchlist_ufc_enrichment_drain`).
- **TEAM-MOMENT-DISPLAY — CLOSED.** Team moments render `team + play` across every grid/page (`1959c13` → `a3da7be`).
- **TFP-SLOT-WAVE-COLLISION + TFP-480-RESTORE — CLOSED.** `topshot-fmv-populate` slot moved off the cohort wave (:15→:38); watchlist restored to 480 after clean ticks.
- **ANALYTICS-SMOKE-RESIDUAL — CLOSED.** Restored to a 60s timeout after the Small-tier upgrade; the 5 slow fns are existence-checked off the smoke path.
- **OFFER-SANITY-RAISE — CLOSED.** Edition-grain raise hardened + SECDEF anon EXECUTE hole closed (`60c1438`).
- **Q8 badge-sync grain — durable.** Integer-pair grain guard trigger + residue cleanup (`5fac76d`); `upsert_errors` 0.
- **DUPE1 / DQ4 — closed at the writer level.** Pack-EV v20 int-pair re-key stopped the inert-UUID re-mint (0 leak / 8 days, `e7b2816`); sentinel UUID-leak reads 0.
- **PIN1 / SMOKE-EDITION-TIMEOUT / LISTCACHE-SILENT-0612 / PINNACLE-RECONCILE-TIMEOUT / PIN-SYNC-FMV-WATCH** — all closed (Sentry spike threshold raised + reason classification; 25s SSR-page budget; cron liveness; 202+after() reconcile immunization + render-FMV tripwire).
- **Concierge-LLM smoke cost leak — FIXED** (`f073ae0`) — ~$44/mo of per-tick paid Sonnet calls gated to a daily window.
- **Q7 NO-PUSH git infra — effectively resolved** — the sandbox-native clone flow pushes reliably (night passes 06-13/06-14 fired in-window with push available).

**Also shipped this week (net-new, not numbered):** the three `/insights` surfaces (`b623be2`, `34b1543`, pack-sniper); unified transaction history (`503b836`); trophy-slab badge artwork (`f5fff3c`, `720c313`, `226dab4`); TS marketplace buyer/seller backfill (`1d79539`/`83bb40f`); special-serial finalization (`893da9f`); resilient hero media (`bce3533`, `45f52bb`); referral-loop wiring (`0eee25c`, `8347ae6`); profile SSR (`8789568`); anon first-impression batch (`06454b9`); the light/dark theme tokenization sweep (`ce3d2d3` → `fa60e80`); and the Vercel docs-only build-skip cost lever (`0e7e627`).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation and cost both promoted given the week's events:

1. **Measure the activation machinery you've built (§2.1).** Cheapest, highest-leverage — confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop; unblock the Rewards DIAL-IN (store stocking + raffle legal). Then watch whether signups move off zero.
2. **Right-size cost (§2.6) — the genuinely new work.** Do the **VERCEL-SPEND-PAUSE** backstop regardless (set a cap). Then the Fluid/cron levers gated on 3–5 clean DBSAT-free days. Small effort, real money.
3. **Finish the Pinnacle per-render FMV cutover (§2.3, waves 2/3)** and retire legacy `pinnacle_fmv_snapshots`; keep watching the `topshot-sales-history-backfill` LiveToken gate as ASK_ONLY drains; wire `v_fmv_sanity_flags` into the weekly health check.
4. **Clear the small operator items (§2.6).** Wire (or classify) ALLDAY-V1-UNMAPPED-DRIFT; confirm the LISTCACHE cadence; decide the optional ANALYTICS-SMOKE leg-opt.
5. **Formally close Priority #1 (Flowty, §2.5)** — record the keep-frozen decision in `CLAUDE.md`.
6. **Chain-abstraction + Candy cleanup as capacity allows (§2.8 / §5a / §5g).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` trap). The Candy block stays until July-8. Deferrable.
7. **Pack/Moment/Set tail (#17), brand Phase-2 (#11, largely done via light-mode), `/dashboard` migration (#10, now larger), monolith refactor (#14).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run.** HEAD = `a126f44` (2026-06-14, "record searchMintedMoments unblock as ineffective; remove probe"). `git log` returned **229 commits dated 2026-06-08 onward** — ~115 code-bearing (45 `feat` / 54 `fix` / 6 `style` / 6 `refactor` / 4 `perf`), the rest process/automation (72 `docs` / 23 `monitor` / 4 `night-pass` / 7 `chore` / 3 `cowork` / 3 `ops` / 1 `ci`; +1 uncategorized). Counts reconcile to 229. Busy week, though more split between feature work and incident/ops churn than the prior week's all-feature surge.
- **Report-location is clean.** `ls PROJECT_HEALTH*` at the repo root returns nothing; `docs/health/` holds the six prior reports + this one.
- **No active freeze.** `docs/FREEZE.md` is absent (it exists only while a freeze is active).
- **Cited-path spot check:** all new-feature and cited paths verified present — `app/insights/{top-sales,trophies,pack-sniper}/page.tsx`, `components/TrophySlab.tsx`, `app/api/cron/ufc-enrichment-drain/route.ts`, `lib/chains/solana/normalize.ts`, `app/api/candy-sales-indexer/route.ts`, `lib/trade-escrow/fcl-submit.ts` (6 `ensureLive` refs), `lib/rewards.ts`, `app/rewards/page.tsx`, `app/api/profile/verify-challenge/check/route.ts`, `docs/handoff-2026-06-13-vercel-cost-plan.md`, `docs/cleanup-decisions-2026-06-01.md`, `docs/strategy/rpc-rewards-program-2026-06-04.md`, `vercel.json`. Intentionally-deleted paths from prior weeks (`lib/pro/gate.tsx`, `scripts/cleanup-storefront-wallets.mjs`, root `cleanup.cdc`, `components/PinnacleSniper.tsx`) remain correctly absent.
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"`; and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_...` (a `.sql` under `docs/`, caught by the scan, confirmed not a real marker). Both excluded from the 55.
- **TODO count delta vs last week: +16** (39 → 55 real marker lines). The delta is entirely the NEW Candy/Solana chain-two block (§5g, 17 lines across 3 files), less one resolved marker (`lib/pack-urls.ts:19`). The §5a–§5f set is otherwise unchanged.
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,870** · `sniper/page.tsx` **2,134** · `analytics/page.tsx` **2,128** · `dashboard/page.tsx` **2,053** (UP from 1,681 — the transaction-history add) · `lib/blazers-trivia.ts` **198**.
- **`/insights` surfaces: 15** — confirmed by `INSIGHT_ROUTES` in `app/sitemap.ts` and the page-dir listing (+`pack-sniper`, `trophies`, `top-sales` since last week's 12). **OG routes: 14** — unchanged (the new boards reuse `/api/og/insights`).
- **Trade Hub guard verified live in source:** `ensureLive()` present in `lib/trade-escrow/fcl-submit.ts` (6 refs); `/api/trade-chain/*` return the 503 "not available yet" body; `TradeHubClient.tsx` gates the page.
- **DB-side facts** (FMV counts, Pinnacle render spreads, the DBSAT incident measurements, traction numbers, pipeline health, the Micro→Small tier params, the security posture "RLS on all 88 tables / 0 security ERRORs / security 0/0 in recent monitors") are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / `docs/overnight/focus.md` / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports.
- **The Vercel invoice figure ($218.87)** and its line-item split are reported as recorded in the ledger's 2026-06-13 Vercel-cost entry and `docs/handoff-2026-06-13-vercel-cost-plan.md`.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-15)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved; Trade Hub shelved + guarded | `ensureLive()` (6 refs) + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary for most readers | `pinnacle_catalog.fmv_*` |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** (a new V1-budget *drift* is a separate LOW operator item, §2.6) | `CLAUDE.md` + 2026-05-25 session |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — manual script; cleanup driver deleted; payer wallet/cron paused | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` gone |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,053** lines (GREW ~372 via transaction history) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — light/dark theme tokenization sweep this week; phase-1 token sweep + CI guard | `git log style(light-mode)`; `scripts/check-brand-tokens.mjs` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,870 / sniper 2,134 / analytics 2,128 | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — mostly shipped** | special-serials + resilient hero + team-moment display landed; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **Rewards** feature, the three new `/insights` surfaces, and the gated Candy chain-two prebuild.

**Bottom line for `CLAUDE.md`:** the known-issues numbering is unchanged from last week and several recurring recommendations still stand: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **give the live Rewards economy a numbered slot** (e.g. #19); (c) Prioritized Action #1 (Flowty) can be **closed** (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 chain-rename shims and the new 17-line Candy block are intentional debt worth a one-line note. New this week and worth a deliberate decision: **(e) promote cost right-sizing to an explicit action** (the $218.87 Vercel month + the Spend-Management backstop), and **(f) note A1 / the special-serial owner-lookup block** so the `special-serial-sweep` stubs aren't mistaken for unfinished work that's actually waiting on a Top Shot API capability. And, as every recent report has said: given ≈13 users and a stack of live-but-unmeasured activation machinery, **promote activation + its measurement** to a top-line priority.
