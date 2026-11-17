# Rip Packs City — Project Health Report

**Date:** 2026-06-22
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §), `docs/overnight/ledger.md` (live autonomous-pass state) + `docs/overnight/focus.md` (last interactive focus, 2026-06-18), a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-15.md` (7 days ago). This regeneration mirrors its structure. `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all eight reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-06-15 — a data-integrity / FMV-correctness week.** **175 commits since 2026-06-15** (≈81 code-bearing: 47 `feat` / 31 `fix` / 3 `perf`; the rest process/automation: 43 `docs` / 36 `monitor` / 11 `chore` / 1 `overnight` / 1 `ops` / 1 `ci`). Notably **0 `style` and 0 `refactor` commits** — last week's light-mode tokenization wave is over. Four headline stories: **(1) The Top Shot sales mis-attribution bug — CLOSED OUT.** A multi-day data-integrity program (06-20 → 06-21) eliminated a long-standing class of bug where `sales.edition_id` was keyed onto the wrong (often UUID-dupe) edition: the **conflation guard went 44 → 0, all-time same-serial collisions 1,322 → 0, and sales-on-UUID-dupe-editions 9,218 → 0.** It took a writer fix (`f796447`, then the *last* leak in `/api/ingest` closed `6b9e89a`), an on-chain `getMintedMoment` drain (`f908c83`, ~10,276 sales + 1,458 moments re-keyed), and a daily Vercel cron to converge the untracked-wallet residual. **(2) The parallel-conflation / subedition program (06-20).** Top Shot "parallels" (Standard / Hexwave / Jukebox / Omega …) were being blended into one edition; a four-phase program resolved **247,129 moments on-chain → 34,442 parallels**, cataloged **1,374 `::subID` editions**, remapped 17,052 sales + 29,027 wmc + 11,651 moments onto them, shipped parallel-aware edition pages, and added authoritative per-parallel circulation + a re-fit serial-FMV model — de-blending FMV per printing (e.g. a Traoré Standard went from a blended $45.83 to ~$19). **(3) Omni-channel alerts shipped end-to-end (06-16) and went LIVE (06-18).** LiveToken-style deal/FMV alerts with Telegram + Discord bots and a SoldPacks command — a genuinely new user-facing activation/retention surface. **(4) The 06-22 asset-audit close-out** moved the special-serial-owners MV refresh onto `pg_cron` (fixing a daily false `ok=false`), shipped the **`next` 16.2.9 security bump** (clears the App-Router middleware/proxy-bypass CVE — directly relevant to `proxy.ts`), and cleaned up scheduled tasks / skills / artifacts / memory.

> **Plus continued intelligence + activation work:** **3 new public `/insights` surfaces** (`serial-premiums`, `underpriced-serials`, `pack-drops`) — the hub is now **18 surfaces** (was 15), each with its own dedicated OG card; the TS deal board now **flags thin-data / low-confidence FMV** and suppresses fake "51% off" alerts (06-21); SEO internal-linking closed the overview hub-fan-out gap (06-21); public profile holdings cards were **owner-scoped + made public** while spend stays private (06-18); AllDay deals got a working native "Buy on All Day" link (06-18); and a TS sales-completeness backfill drained the ASK_ONLY-with-0-sales tail (06-19).

> **A genuinely blocked item, still flagged — A1 / special-serial owner build.** Carried from last week: the browser-fingerprinted `topshot-proxy` attempt to unblock the Top Shot GQL `searchMintedMoments` query (who *owns* a given special serial — the capability the `special-serial-sweep` edge function stubs in §5c) was **recorded ineffective** and the probe removed. That owner-lookup capability remains blocked at the Top Shot API edge. `A1-WORKER-PASSTHROUGH-CLEANUP` is carried in the operator queue.

> **Traction reality (carried forward — no fresh user-count snapshot this run).** The last logged traction read (2026-05-31, ledger) was **~13 total users, 0 signups in 7 days, 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** No signups-moved-off-zero measurement appears in this week's commits. Monetization remains tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* and *measurement* of the surfaces already built — and this week added a major one (omni-channel alerts, now live with exactly **1** subscription: Trevor's own go-live test). **Cost** remains the one concrete financial pressure (the carried Vercel cost family), though no new invoice figure was logged this week.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — Flowty-dependent infra is frozen; the teardown DECISION is "keep frozen, close Priority #1" (`docs/cleanup-decisions-2026-06-01.md`). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and pack-EV are historical-only. **(3) Chain-two (Candy / Solana) prebuild landed inert (06-08)** and remains gated on a **July-8 Candy data tripwire** — not started early. It is the source of the 17-line Candy/Solana discovery-placeholder TODO block (§5g).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **absent right now = no freeze active.** The night pass is pushing reliably (sandbox-native clone flow). **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Net-new shipped features (not numbered) | **8** | Omni-channel alerts (LIVE); Rewards points economy (DIAL-IN); Pinnacle per-render FMV; TS + AllDay on-chain offers; TS parallel/subedition de-blending; **3 new `/insights` surfaces** (serial-premiums / underpriced-serials / pack-drops); unified transaction history; Candy chain-two prebuild (inert) — §2.2 |
| Open overnight operational items | **~8 active + ~4 deferred** | Carried: **VERCEL cost family**; ALLDAY-V1-UNMAPPED-DRIFT; BUYERBF-PERINVOCATION-WORK; UFC-EDITIONS-SEED-GAP; TS-WMC-UUID-FOSSILS; PIN-FMV-REKEY waves 2/3; PIN-SYNC-CRON; N1. Deferred: ANALYTICS-SMOKE leg-opt, IPFS ×2 — see §2.6 |
| Net-new structural workstream | 2 | Multi-chain chain-abstraction (Phases A–F complete; 18 shim TODOs) + the inert Candy/Solana chain-two prebuild (§2.8) |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) recommended-closed (keep frozen). Activation-measurement + cost-right-sizing still arguably belong here. |
| In-code TODO markers | **56 real lines / 32 files** (+2 false positives) | **+1 vs last week's 55.** The one new marker is `scripts/ingest-topshot-active-listings.mjs:126` (dapper.market URL) — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** This was a strong, *correctness-led* week — the kind that doesn't add users but quietly raises the trustworthiness of the core product. The Top Shot sales mis-attribution program and the parallel/subedition de-blending closed a real, multi-month class of FMV/deal-board corruption (fake discounts, blended parallel prices, sales keyed onto inert UUID editions) and drove the headline guards to **0**. On top of that, the platform shipped its first true engagement/retention loop — omni-channel alerts (Telegram/Discord/email) — and patched a security-relevant Next.js CVE in `proxy.ts`'s path. Operationally the platform reads GREEN (per `CLAUDE.md` / focus.md: security 0/0/0/0, trust-health 9/9, FMV reconciles exactly to edition counts, the 06-21 overnight pass shipped 0 and verified the heavy 06-20 wave clean). The dominant concern is unchanged: **activation/traction** (≈13 users at last read, now with even more live-but-unmeasured machinery to instrument). Code-quality risk is descending and concentrated: **(1) FMV correctness tails** — the Pinnacle per-render cutover (waves 2/3) and the parallel-conflation forward-keying convergence still need watching; **(2) cost/operational right-sizing** (the carried Vercel cluster); **(3)** the chain-abstraction + Candy chain-two cleanup tails (18 + 17 intentional TODOs). Monolith refactors, brand polish, and page tune-ups remain secondary.

### Themes

| Theme | Items |
|---|---|
| Data-intelligence correctness (the headline this week) | TS sales mis-attribution program — CLOSED (writer fix + on-chain drain + daily cron); TS parallel/subedition de-blending (Phases 1–4); thin-data fake-deal flagging on the deal board; Pinnacle per-render FMV waves; TS sales-completeness backfill draining ASK_ONLY (§2.3) |
| Conversion / activation (the real critical path) | **Omni-channel alerts (LIVE, 1 sub)**; Rewards points economy (DIAL-IN); new `/insights` surfaces; SEO internal-linking; profile owner-scoping; AllDay native buy links. **Verify `funnel_events` accumulates; measure whether signups / alert sign-ups move off zero.** (§2.1) |
| Cost / operational right-sizing (carried) | Vercel cost family carried (no new invoice logged); seed-refresh interval widened; docs-only build skip already shipped. (§2.6) |
| Security / dependency hygiene (NEW) | `next` 16.1.6 → **16.2.9** clears all Next.js advisories incl. the App-Router middleware/proxy-bypass `GHSA-26hh-7cqf-hhc6` (relevant to `proxy.ts`); 4 residual transitive HIGHs are the onflow→viem→ws chain (monitor-only — fix path is build-breaking). (§2.4) |
| Housekeeping — automation hygiene | 06-22 asset audit: special-serial-owners MV refresh → `pg_cron` (fixes a daily false `ok=false`); 14 spent one-off scheduled tasks deleted; 2 artifacts retired to tombstones; `rpc-data` skill predicate fixed + new `rpc-artifact-ops` skill. (§2.5) |
| Operational / overnight queue | Vercel cost cluster; ALLDAY-V1-UNMAPPED-DRIFT; BUYERBF-PERINVOCATION-WORK; UFC-EDITIONS-SEED-GAP; TS-WMC-UUID-FOSSILS; N1; ANALYTICS-SMOKE leg-opt; IPFS deferrals (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete (18 shim TODOs); Candy/Solana chain-two prebuild inert (17 discovery TODOs) (§2.8 / §5a / §5g) |
| Tech debt / refactor | `/dashboard` migration (#10, now **2,149 lines**); monolith pages (#14 — collection 2,938 / sniper 2,166; the analytics figure in prior reports was stale, see §8) |
| Page polish | Pack/Moment/Set tune-up (#17 — parallel-aware edition pages + thin-data caveats landed); brand punch list (#11 — light-mode wave complete); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded); Cart (#1, shelved by decision); A1 special-serial owner lookup (blocked at the TS API edge) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id` migration; `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. This week the intelligence-correctness work led (and largely closed); activation still leads what's *next* (the machinery exists, including a brand-new alerts loop, and needs measurement), paired with the carried cost right-sizing.

### 2.1 Conversion / activation — machinery built, now including a live alerts loop, still unmeasured — `Severity: High · Effort: Medium (shipped, unmeasured)`

The funnel has been open for weeks; this week added a genuine engagement surface plus more discovery/SEO:

- **Omni-channel alerts — shipped end-to-end (06-16) and LIVE (06-18).** LiveToken-style deal + FMV alerts with a `/alerts` configuration UI (player/set/team/tier/price/discount/badges/serial/cadence), three linkable channels (Telegram, Discord, email), and a SoldPacks bot command. New user-facing bots (`@`-distinct from the `@rpc_sentinel_bot` ops bot); Discord verified via Node's built-in Ed25519. **Currently 1 active subscription** (Trevor's go-live test) — the next step is opening it to the allow-list and watching whether anyone signs up. **Known limitation (surfaced in-UI):** the serial / jersey / last-mint / never-sold filters are saved but enforce only at the *edition* level until a per-serial live-listing feed lands.
- **3 new public `/insights` surfaces.** `serial-premiums`, `underpriced-serials`, and `pack-drops` shipped with the full server-render / OG / canonical / sitemap treatment (hub now **18**, see §2.2). The `serial-premiums` board passed the `rpc-insights-qa` checklist (backing views `security_invoker=on`, anon-SELECT, dedicated OG route).
- **SEO internal-linking (06-21)** — the high-authority `/<collection>/overview` page now fans out into the set / player / team / series **hubs** (not just 18 leaf editions), materially denser crawl equity.
- **Profile holdings owner-scoped + public (06-18)** — public profiles now render the profile owner's collection-breakdown / top-movers / tier-breakdown (anon/crawlers/link-previews previously saw empty cards), while cost-basis "Total Spent" stays private to the owner.
- **Rewards points economy** (live, carried, status **DIAL-IN**) — store stocking still awaits Trevor's Moment picks; raffle still held pending legal review. No code blocker.

Suggested next step (unchanged and still the highest-leverage work): confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND the new alerts loop (sign-ups, channel links, deliveries); open alerts to the allow-list. Then watch whether signups move off zero. Worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — expanded to 18 — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — now 18 surfaces** (verified against `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir): `squeeze`, `pack-reality`, `pack-sniper`, `rookies`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `market`, `offer-spread`, `deals`, `trophies`, `top-sales`, `serial-premiums`, `underpriced-serials`, `pack-drops`, `squeeze-check`, `tc-report`. **+3 this week** (`serial-premiums`, `underpriced-serials`, `pack-drops`).
- **Parallel-aware edition pages** (06-20, Phase 2) — `::subID` editions get self-canonical pages, a "Parallel Printings" ladder (Standard / Hexwave / Jukebox with de-blended per-parallel FMV), and subedition-aware offers. Sitemap auto-includes them.
- **TS deal board now flags low-confidence FMV** (06-21) — thin / high-variance editions render a muted amber "⚠ thin data — FMV uncertain" caveat and are suppressed from fake "51% off" push alerts.
- **OG cards** — 14 top-level routes (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `share`, `team`) **plus 17 per-surface `/api/og/insights/*` cards + 1 shared fallback** (only `tc-report` uses the fallback). The insights OG surface expanded substantially from last week's single shared route.

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV / data-intelligence correctness — the week's main event — `Severity: was High (correctness) · Effort: large, mostly landed`

- **TS sales mis-attribution — CLOSED OUT (06-20 → 06-21).** Sales were being keyed onto the wrong edition (often an inert UUID-dupe, or a same-player different-play edition), inflating FMV and manufacturing fake deals. End state (per `CLAUDE.md` / ledger): **conflation guard 0, all-time same-serial collisions 0, sales-on-UUID-dupe-editions 0.** Required a writer fix in the sales-indexer (`f796447`) and then the *last* forward-writer leak in `/api/ingest` (`6b9e89a` — the dominant ~30 rows/2h leak was a different file than first diagnosed), an on-chain `getMintedMoment` drain (`f908c83`, re-keying ~10,276 sales + 1,458 moments), and a daily Vercel cron (`0 11 * * *`) to converge the untracked-wallet stray residual. Security invariants stayed 0/[]; all data changes reversible via per-row audit tables.
- **Parallel / subedition de-blending (06-20, Phases 1–4).** Resolved **247,129 moments on-chain → 34,442 parallels**; cataloged **1,374 `::subID` editions**; remapped **17,052 sales + 29,027 wmc + 11,651 moments**; shipped authoritative per-parallel circulation (a Vercel-cron-driven GQL sweep) + a per-parallel owners MV + a re-fit serial-FMV power model (`perfect`-bucket n 41→142, r .737→.824). Interim conflation guards stay until forward-keying fully converges (Phase 4 teardown gate).
- **Pinnacle per-render FMV (PIN-FMV-REKEY).** Carried — the additive per-render engine and reader-cutover waves 1a/1b/2 are shipped; the render-FMV staleness tripwire (`pinnacle_fmv_stale_hours`) is live in `v_rpc_trust_health`. **Remaining (Trevor-sequenced): waves 2/3** then retire legacy `pinnacle_fmv_snapshots` at zero readers.
- **TS sales-completeness backfill (06-19).** A paced per-edition historical-sales backfill (`topshot-sales-history-backfill`) drains the ASK_ONLY-with-0-sales tail (broadened 784 → 9,091 targets, pre-seeded from `edition_offers` for ~98%); the multi-factor special-serial FMV model stays **deferred (data-gated)** until enough #1 / perfect-serial sales accumulate.

Suggested next step: finish PIN-FMV-REKEY waves 2/3 and retire legacy `pinnacle_fmv_snapshots`; watch the parallel-conflation forward-keying converge to ~0 so the Phase-4 guards can be torn down; keep `v_fmv_sanity_flags` wired into the weekly health check.

### 2.4 Security / dependency hygiene — `next` 16.2.9 (NEW) — `Severity: Medium (patched) · Effort: done`

The 06-22 audit shipped **`next` 16.1.6 → 16.2.9** (exact pin) + `eslint-config-next` 16.2.9 (both verified in `package.json`). This clears all Next.js advisories (count 16 → 0), including the App-Router **middleware/proxy bypass** `GHSA-26hh-7cqf-hhc6` and a proxy cache-poisoning issue — directly relevant to `proxy.ts`, which is the site-lockdown gate. The broad `npm audit fix` was deliberately **reverted** because it bumped the `@onflow/*` chain and broke the build (`@onflow/fcl` lost its bundled type declarations); the 4 residual transitive HIGHs (`defu`/`fast-uri`/`ws`/`viem` via the onflow chain) are therefore **monitor-only** — their only fix path is a build-breaking `@onflow/*` bump. Post-deploy verification recommended in `CLAUDE.md`: anon-exercise the `proxy.ts` auth path given the CVE class.

### 2.5 Automation / asset hygiene (06-22 close-out) — `Severity: Low · Effort: done`

The 06-22 Cowork asset audit + its Claude Code handoff (`docs/handoff-2026-06-22-cowork-asset-audit.md`):

- **Special-serial-owners MV refresh moved off cron-job.org HTTP onto `pg_cron`** (`audit_20260622_pgcron_refresh_special_serial_owners_mv`, job `rpc-refresh-special-serial-owners-mv` @ `13 4,16 * * *` UTC) — fixes the daily false `ok=false` (a ~120s API-gateway cap was killing the ~125s synchronous refresh) that was reddening `ts-backfill-drain-serial-fmv-watch`. The route is now a thin trigger; the SECDEF fn self-logs `pipeline_runs`.
- **Scheduled tasks:** `rpc-flow-ecosystem-watch` prompt fixed; **14 spent one-off tasks deleted**; all enabled tasks verified producing real output.
- **Artifacts:** retired `pack-drops-ev-check` + `rpc-ts-data-mission` to tombstones; fixed a stale footnote on `rpc-qa-scorecard`.
- **Skills:** `rpc-data` canonical-edition predicate fixed to `^[0-9]+:[0-9]+(::[0-9]+)?$` (the old form silently dropped ~1,775 / ~16% of canonical TS `::` parallels); new `rpc-artifact-ops` skill — both committed + installed.
- **Memory:** trimmed 12 over-budget `MEMORY.md` index lines back under the size cap.

### 2.6 Overnight operational queue — cost-led, plus the carried data/ops tail — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue this week is dominated by carries; the data-correctness program closed its own items as it shipped. **Closed/resolved since the last report:** REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT (now `pg_cron`), the MV-refresh ok-flag false-negative, the Next.js advisory cluster (`next` 16.2.9), ALLDAY-SERIAL-BACKFILL-CRON (watchlisted 06-20), and the TS sales mis-attribution / conflation items. Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **VERCEL cost family** | Carried from last week (FLUID-RIGHTSIZE, CRON-CADENCE, SPEND-PAUSE backstop, OBSERVABILITY-SAMPLING, FLUID-CONCURRENCY). No new invoice figure was logged this run. | Med | Mostly Trevor (dashboard) + operator (cron-job.org). The SPEND-PAUSE backstop (set a monthly cap) is the do-regardless one. |
| **BUYERBF-PERINVOCATION-WORK** | `topshot-buyer-backfill` now fills its ~800s budget (max ~710s) and **overlaps** at the ~4×/hr cadence (two concurrent lambdas self-contend). `maxDuration` is at the Pro hard cap, so the lever is stop-overlap / cap-rows-per-invocation. | Low–Med | CC route + operator cron. |
| **ALLDAY-V1-UNMAPPED-DRIFT** | Open AllDay `unmapped_sales` are `source=onchain_dapper_v1`, mostly `v1_tx_decode_budget_exhausted`; correctly held out of `sales` (no FMV corruption). | Low | The recover route exists (`/api/admin/recover-v1-budget-exhausted`); operator wires the cron or classifies the residual as permanent. |
| **UFC-EDITIONS-SEED-GAP** | ~72 UFC editions held by wallets but absent from the `editions` catalog (surfaced by `ufc-enrichment-drain`). | Low | CC / operator seed-ingest (off-limits to the night pass). |
| **TS-WMC-UUID-FOSSILS** | ~1,683 `wmc` rows keyed to merged/deleted UUID editions; known/stable. | Low | CC canonical-merge. |
| **PIN-FMV-REKEY waves 2/3 + PIN-SYNC-CRON** | Last Pinnacle per-render reader cutover + legacy-table retirement; wire the daily `pinnacle-sync` cron + watchlist. | Med | Trevor-sequenced (price-display change) + operator. |
| **N1 — `snapshot-institutional-wallets`** | Recurring external-cron drop (low impact, 0–3 rows/run). | Low | Operator: re-fire / move its slot off the 06:00Z rush. |
| ANALYTICS-SMOKE leg-opt | 5 slow `/analytics` dashboard fns existence-checked off the smoke path but still slow for users. | Low (optional) | CC, optional. Off the critical path. |
| IPFS-CIDSET-EVENT-LEG / IPFS-GATEWAY-FALLBACK | Two deliberately-deferred IPFS catalog-freshness / image-resilience items. | Low (deferred) | CC: do not build now; explicit triggers in the ledger. |

Other carried housekeeping noted in `CLAUDE.md`: `refresh-conflated-editions` daily-guard cron (now covers both honesty guards), `BADGE-CATALOG-CRONJOB-DUP`, `A1-WORKER-PASSTHROUGH-CLEANUP`, the `get_user_top_owned_moments` 3-arg orphan cleanup.

### 2.7 Pack EV / pack-viz — stable (no new defects) — `Severity: Low · Effort: n/a`

Carried — pack-dist math/honesty, PACKVIZ-GRID top-chases + exhausted split, and pack-ev v21 queue-unwedge all remain shipped; DQ4 (pack-EV inert-UUID re-mint) stayed closed (the mis-attribution writer fix this week reinforces it). The new `pack-drops` insights surface is the only pack-area addition. No open pack-EV defects.

### 2.8 Chain foundation — abstraction complete; Candy chain-two prebuilt inert — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F are complete** (Phase F shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged, bulletproof by design. **Trap:** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`.
- **Candy / Solana chain-two prebuild landed inert (06-08).** `collections` seeded (`candy_mlb` / `panini_blockchain`, `is_active=false`), `helius-proxy` scaffolded, an inert ingest path written. It writes nothing until five discovery placeholders are filled (§5g) and is gated on the **July-8 Candy data tripwire** — do **not** start chain-two code early.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (omni-channel alerts now LIVE; Rewards economy; new `/insights` surfaces; SEO internal-linking; profile owner-scoping) shipped; **verify `funnel_events` is recording and measure whether signups / alert sign-ups move off zero.** | High | Medium (shipped, unmeasured) |

### Data-intelligence correctness (the headline this week)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| TS mis-attribution | Sales keyed onto wrong / UUID-dupe editions → fake deals + inflated FMV. **CLOSED** — writer fix + on-chain drain + daily cron; guards at 0; reversible via audit tables. | was High | (closed) |
| TS parallels / subeditions | Parallels blended into one edition. **De-blended** — 1,374 `::` editions cataloged + remapped; per-parallel circulation + serial-FMV re-fit. Phase-4 guards stay until forward-keying converges. | was Medium | (mostly landed) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine + waves 1a/1b/2 shipped; waves 2/3 + legacy `pinnacle_fmv_snapshots` retirement queued (Trevor-sequenced). | Medium | Medium |
| TS-SALES-INGEST-GAP | ASK_ONLY ≈ editions whose sales were never captured. The cohort-cap idea is decided do-not-ship; the real fix (`topshot-sales-history-backfill`) is shipped and draining. | Medium | Medium (in progress) |

### Cost / operational right-sizing (carried)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Vercel cost family | Carried from 06-15 (uncapped Spend-Management + Fluid/cron/observability levers). No new invoice figure this run. | Medium | Small–Medium (mostly dashboard + cron config) |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |
| Candy chain-two | 17-line discovery-placeholder block (5 named `TODO_1`–`TODO_5` + 3 route notes) in the inert Candy/Solana ingest path — unfillable until Candy secondary trading opens (gated on July-8). Intentional. | Low | Medium (gated) |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. This week: parallel-aware edition pages (Parallel Printings ladder + subedition-aware offers); thin-data "FMV uncertain" caveat on the deal board. Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, present) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — the light/dark theme tokenization sweep completed last week (**0 `style` commits this week**). The phase-1 token sweep + CI guard (`scripts/check-brand-tokens.mjs`) remain in place. Remaining: the longer-tail surfaces (email HTML, Fast Break / RTR / admin), tracked not gated; `public/home-fmv-preview.png` unreferenced (moot — live `<HomeFmvPreview />`). | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,149 lines** (verified; **grew ~96 from last week's 2,053**). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,938** (+68), `sniper/page.tsx` **2,166** (+32). **The `analytics/page.tsx` figure in prior reports + `CLAUDE.md` #14 (~2,128/2,208) is STALE** — the actual `/analytics` route page (`app/(analytics)/analytics/page.tsx`) is **503 lines** and git shows it has been ≤503 since at least 2026-05-20; the analytics surface is already split into ~14 subroute pages. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (analytics already split) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01).** `ensureLive()` (verified, 6 refs in `lib/trade-escrow/fcl-submit.ts`) throws unless `RPC_TRADE_ESCROW_ADDRESS` is set; `/api/trade-chain/*` return 503; `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx` (verified present). 8 in-code stub TODOs persist (§5b). | Medium (shelved) | Large |
| A1 | Special-serial owner lookup — the `searchMintedMoments` unblock attempt was recorded ineffective and the probe removed; the owner-display capability — and the `special-serial-sweep` ownership lookups (§5c) — remain blocked at the TS API edge. `A1-WORKER-PASSTHROUGH-CLEANUP` is carried in the operator queue. | Low–Medium (blocked externally) | Medium (depends on TS API) |

### Net-new features not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Omni-channel alerts | **LIVE (06-18)** — deal/FMV alerts + Telegram/Discord bots + SoldPacks. 1 active subscription. Known limit: serial/jersey filters edition-level until a per-serial live feed lands. Worth a numbered slot in `CLAUDE.md`. | n/a (live, dialing in) | Medium |
| Rewards | Off-chain points economy — live, DIAL-IN. Non-code blockers: store stocking (Trevor's Moment picks); raffle legal review. Worth a numbered slot. | n/a (live, dialing in) | Medium (non-code) |
| New `/insights` | `serial-premiums`, `underpriced-serials`, `pack-drops` — live, no open defects. | n/a (shipped) | — |
| Candy chain-two | Inert prebuild — see §2.8 / §5g. Gated on July-8. | n/a (gated) | Medium |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (`funnel_events` follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate when a real consumer arrives. (Profile work has begun re-keying `owner_key`→`user_id` surface-by-surface.)
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`.

### Architecture note worth tracking

- **Watchlist + FMV Alerts — partly superseded by the new alerts system.** `CLAUDE.md` Architecture notes still flag the old watchlist/alert tables + routes as partially decommissioned (the concierge tool set dropped them). The new omni-channel alerts feature (§2.1) is a *separate* implementation (`alert_subscriptions` / `notification_channels` / `lib/alerts.ts`); verify whether the old watchlist tables are now dead or should be reconciled with the new system before reactivating either.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop. The remaining action is to formally close the priority in `CLAUDE.md`. | §2.5 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via the TS mis-attribution close-out, parallel/subedition de-blending, the deal-board honesty flag, the TS-sales backfill, and 3 new `/insights` surfaces. | §2.2 + §2.3 |

*Implicit priorities surfaced and still un-promoted:* **(a) activation/conversion + its measurement** (§2.1 — ≈13 users; machinery now includes a live alerts loop but is still unmeasured); **(b) cost right-sizing** (§2.6 — the carried Vercel family; set the Spend-Management cap regardless). Both are arguably worth promoting to explicit `CLAUDE.md` actions.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** This is why §1 reports 0 active revenue-blocking items. (`stripe@^22` is in `package.json` but dormant.)

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`) returned **58 raw matches across 34 files**. Excluding **2 false positives** (see §8) leaves **56 real marker lines across 32 files** — **+1 vs last week's 55** (the one new marker is `scripts/ingest-topshot-active-listings.mjs:126`). `CLAUDE.md` does not track these. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest single cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs (`submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`). Fronted by `ensureLive()` (6 refs) so the stubs throw rather than return fake tx ids when the contract is unset.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file) — unchanged, still A1-blocked

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. **This is the data-layer counterpart of the A1 block** — the owner-display feature needs the Top Shot GQL `searchMintedMoments` capability that A1 could not unblock (§3, A1).

### 5d. Pipeline calibration / migration (3 markers, 3 files) — unchanged

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files) — `ingest-topshot-active-listings.mjs:126` NEW (+1)

- `app/(collections)/[collection]/collection/page.tsx:2706` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line shifted 2692→2706 with the deal-board edits; same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- **NEW** `scripts/ingest-topshot-active-listings.mjs:126` — `TODO: set the real dapper.market listing URL once its format is confirmed.` (Added with the 06-19 dapper.market work — dapper.market was confirmed already-indexed via the shared Dapper storefront, so the listing-URL format is the only loose end.)

### 5f. Cadence test coverage gap (2 markers, 1 file) — unchanged

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Candy / Solana chain-two discovery placeholders (17 lines, 3 files) — unchanged

The inert chain-two prebuild (06-08) wraps **5 named discovery placeholders** unfillable until Candy secondary trading opens (gated on July-8):

- `lib/chains/solana/normalize.ts` (14 lines — `:5,10,27,29,31,33,35,37,39,40,64,158,162,166`) — the `DISCOVERY TODOs` block: `TODO_1` (Metaplex Core collection mint → `CANDY_MLB_COLLECTION_ADDRESS`), `TODO_2` (Magic Eden symbol → `CANDY_MLB_ME_SYMBOL`), `TODO_3`/`TODO_4` (serial / edition-size attribute keys), `TODO_5` (stable per-edition key), plus the `.startsWith("TODO_")` route-guard checks.
- `app/api/ingest/candy-editions/route.ts` (`:8`, `:72`) + `app/api/candy-sales-indexer/route.ts` (`:111`) — inert-ingest notes that short-circuit the routes until the placeholders are filled.

→ Intentional, gated debt. The routes write nothing while the placeholders are unfilled.

> **Net change since last week:** +1 (`scripts/ingest-topshot-active-listings.mjs:126`, §5e). The §5a–§5d, §5f, §5g markers are otherwise content- and line-identical to the 2026-06-15 inventory (modulo the one line-shift on the §5e `collection/page.tsx` marker).

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set), #3 (Flowty event indexer — reclassified, Flowty shut down), #4 (Pinnacle FMV — resolved + per-render-enhanced), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` prefetches `/api/packs`), #7 (AllDay `unmapped_sales` — resolver rewritten; the V1-budget *drift* is the separate LOW operator item ALLDAY-V1-UNMAPPED-DRIFT), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — fully blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **TS sales mis-attribution bug — CLOSED OUT.** Writer fix (`f796447`) + last `/api/ingest` leak (`6b9e89a`) + on-chain drain (`f908c83`) + daily Vercel cron; conflation guard 44→0, same-serial collisions 1,322→0, sales-on-UUID-editions 9,218→0. (§2.3)
- **TS parallel / subedition conflation — de-blended.** 1,374 `::` editions cataloged + remapped; per-parallel circulation + serial-FMV re-fit (Phases 1–4). (§2.3)
- **REFRESH-SPECIAL-SERIAL-OWNERS-MV-TIMEOUT — RESOLVED.** Moved off the cron-job.org HTTP entry onto `pg_cron`; fixes the daily false `ok=false`. (§2.5)
- **MV-refresh ok-flag false-negative — FIXED** (server-side self-logging fn).
- **Next.js security advisories — CLEARED** via `next` 16.2.9 (incl. the App-Router middleware/proxy-bypass CVE relevant to `proxy.ts`). (§2.4)
- **ALLDAY-SERIAL-BACKFILL-CRON — CLOSED** (watchlisted 06-20 after the on-chain serial source fix).
- **Omni-channel alerts — shipped + went live** (06-16 / 06-18); not a "resolved bug" but a major net-new feature.
- **14 spent one-off scheduled tasks deleted; 2 artifacts retired to tombstones** (06-22 asset audit). (§2.5)

**Also shipped this week (net-new, not numbered):** the 3 `/insights` surfaces (serial-premiums / underpriced-serials / pack-drops); parallel-aware edition pages; the deal-board thin-data honesty flag (06-21); SEO internal-linking overview fan-out (06-21); profile holdings owner-scoping (06-18); AllDay native buy link (06-18); the TS sales-completeness backfill (06-19); the `rpc-data` skill predicate fix + new `rpc-artifact-ops` skill (06-22).

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation and cost both promoted given the week's events:

1. **Measure the activation machinery you've built (§2.1) — now including the live alerts loop.** Cheapest, highest-leverage — confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND alerts (sign-ups, channel links, deliveries); open alerts to the allow-list; unblock the Rewards DIAL-IN. Then watch whether signups move off zero.
2. **Finish the FMV-correctness tails (§2.3).** Drive the parallel-conflation forward-keying to ~0 so the Phase-4 guards can be torn down; finish PIN-FMV-REKEY waves 2/3 and retire legacy `pinnacle_fmv_snapshots`; keep `v_fmv_sanity_flags` in the weekly health check; watch the TS-sales backfill drain ASK_ONLY.
3. **Right-size cost (§2.6).** Do the Spend-Management cap backstop regardless; then the Fluid/cron levers. Small effort, real money. Also resolve BUYERBF-PERINVOCATION-WORK (overlapping buyer-backfill invocations).
4. **Clear the small operator items (§2.6).** Wire (or classify) ALLDAY-V1-UNMAPPED-DRIFT; PIN-SYNC-CRON; re-fire N1; decide the optional ANALYTICS-SMOKE leg-opt; seed UFC-EDITIONS-SEED-GAP.
5. **Formally close Priority #1 (Flowty, §2.5)** — record the keep-frozen decision in `CLAUDE.md`.
6. **Chain-abstraction + Candy cleanup as capacity allows (§2.8 / §5a / §5g).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` trap). The Candy block stays until July-8. Deferrable.
7. **Pack/Moment/Set tail (#17), brand Phase-2 (#11, largely done), `/dashboard` migration (#10), monolith refactor (#14 — note analytics is already split).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run.** HEAD = `7a168e3` (2026-06-22, "docs(audit+roadmap): 2026-06-21 full platform audit handoff + updated roadmap"). `git log --since=2026-06-15` returned **175 commits** — ~81 code-bearing (47 `feat` / 31 `fix` / 3 `perf`), the rest process/automation (43 `docs` / 36 `monitor` / 11 `chore` / 1 `overnight` / 1 `ops` / 1 `ci`; the ~2 uncategorized are merge/other). **Notably 0 `style` and 0 `refactor` commits** — the light-mode wave that dominated last week is over.
- **Report-location is clean.** `ls PROJECT_HEALTH*` at the repo root returns nothing; `docs/health/` holds the seven prior reports + this one.
- **No active freeze.** `docs/FREEZE.md` is absent (it exists only while a freeze is active).
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,938** (UP from 2,870) · `sniper/page.tsx` **2,166** (UP from 2,134) · `dashboard/page.tsx` **2,149** (UP from 2,053) · `lib/blazers-trivia.ts` **198** (unchanged) · `app/(analytics)/analytics/page.tsx` **503**.
- **Stale figure corrected — the analytics monolith.** Prior reports and `CLAUDE.md` #14 list `analytics/page.tsx` at ~2,128/2,208 lines. The actual `/analytics` route page (`app/(analytics)/analytics/page.tsx`) is **503 lines**, and `git show` at historical commits shows it was 490 lines on 2026-05-20 and ≤503 throughout — it was **never** 2,128. There is no flat `app/analytics/page.tsx` in the tree (correctly absent). The analytics surface is already split into ~14 subroute pages (`sales/`, `loans/`, `wallets/`, `sets/`, `methodology/`, `api/`, …), the largest of which is the 503-line landing page. The genuine remaining monoliths are `collection/page.tsx` and `sniper/page.tsx`.
- **TODO scan: 58 raw matches / 34 files → 56 real markers / 32 files** (after excluding 2 false positives). **+1 vs last week's 55** — the new marker is `scripts/ingest-topshot-active-listings.mjs:126`. By cluster: 18 chain-rename shims (§5a) · 8 Trade Hub stubs (§5b) · 4 special-serial-sweep stubs (§5c) · 3 pipeline-calibration (§5d) · 4 smaller polish (§5e) · 2 Cadence-test gap (§5f) · 17 Candy/Solana placeholders (§5g) = 56.
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"`; and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_...` (a `.sql` under `docs/`, caught by the scan, confirmed not a real marker). Both excluded from the 56.
- **`/insights` surfaces: 18** — confirmed by `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir (+`serial-premiums`, `underpriced-serials`, `pack-drops` since last week's 15). **OG routes: 14 top-level + 17 per-surface `/api/og/insights/*` + 1 shared fallback** (the insights OG surface expanded from a single shared route).
- **Dependency facts:** `next` and `eslint-config-next` are pinned to **16.2.9** (the 06-22 security bump); `stripe@^22` present but dormant (monetization tabled).
- **Cited-path spot check:** all expected-present known-issue paths verified — `lib/chains/flow/cadence/purchase-moment.ts` (#1), `app/api/profile/verify-challenge/check/route.ts` (#0), `app/dashboard/trade-hub/TradeHubClient.tsx` + `lib/trade-escrow/fcl-submit.ts` (6 `ensureLive` refs) (#3), `supabase/functions/special-serial-sweep/index.ts` (A1/§5c), `scripts/check-brand-tokens.mjs` (#11), `docs/audits/refactor-plan-monolith-pages-2026-05.md` (#14), `docs/cleanup-decisions-2026-06-01.md` (Flowty), `.github/workflows/ci.yml` (#16), plus this week's `docs/handoff-2026-06-22-cowork-asset-audit.md`, `docs/scoping-2026-06-20-26-edition-misattribution.md`, `docs/roadmap-2026-06.md`, `docs/audits/full-platform-audit-2026-06-18.md`, and the omni-channel alerts surface (`lib/alerts.ts`, `app/alerts/page.tsx`, `app/api/alerts/{subscriptions,channels}/route.ts`, `app/api/bots/{telegram,discord}/route.ts`, `lib/alerts/{format,soldpacks,concierge-bridge}.ts`, `app/api/cron/alerts-{dispatch,send}/route.ts`). Intentionally-deleted paths remain correctly absent (`scripts/cleanup-storefront-wallets.mjs`, root `cleanup.cdc`, `components/PinnacleSniper.tsx`, `lib/pro/gate.tsx`).
- **One stale evidence-path note (not a defect):** prior report §9 cited `WarmupContext.tsx` (issue #6) without a directory — the file lives at `lib/warmup/WarmupContext.tsx` (not `components/`); issue #6 stays resolved.
- **DB-side facts** (FMV counts, mis-attribution guard numbers, conflation/remap counts, the parallel-resolution totals, traction numbers, pipeline/security health "0/0/0/0", trust-health 9/9) are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / `docs/overnight/focus.md` / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports. `focus.md` is dated 2026-06-18 (the last interactive-session focus); the `ledger.md` is the authoritative live record (277 KB).
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-22)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved; Trade Hub shelved + guarded | `ensureLive()` (6 refs) + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary for most readers | `pinnacle_catalog.fmv_*` |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** (V1-budget *drift* is the separate LOW operator item) | `CLAUDE.md` + 2026-05-25 session |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — manual script; cleanup driver deleted; payer wallet/cron paused | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` correctly gone |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,149** lines (GREW ~96) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — light/dark theme sweep complete (0 `style` commits this week); phase-1 token sweep + CI guard in place | `git log`; `scripts/check-brand-tokens.mjs` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection **2,938** / sniper **2,166**; **the analytics figure is STALE — actual `/analytics` page is 503 lines, already split into subroutes** | `wc -l` + `git show` history |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — mostly shipped** | parallel-aware edition pages + deal-board thin-data caveat landed; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **omni-channel alerts** + **Rewards** features, the 3 new `/insights` surfaces, and the gated Candy chain-two prebuild.

**Bottom line for `CLAUDE.md`:** the known-issues numbering is unchanged from last week and several recurring recommendations still stand: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **give the live omni-channel alerts + Rewards features numbered slots** (e.g. #19/#20); (c) Prioritized Action #1 (Flowty) can be **closed** (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 chain-rename shims and the 17-line Candy block are intentional debt worth a one-line note; **(e) correct the #14 analytics line count** — `analytics/page.tsx` is ~503 lines (already split into subroutes), not ~2,128/2,208, so the two genuine monoliths are `collection` (2,938) and `sniper` (2,166); (f) note A1 / the special-serial owner-lookup block so the `special-serial-sweep` stubs aren't mistaken for unfinished work that's actually waiting on a Top Shot API capability. And, as every recent report has said: given ≈13 users and a now-larger stack of live-but-unmeasured activation machinery (alerts now included), **promote activation + its measurement** to a top-line priority.
