# Rip Packs City — Project Health Report

**Date:** 2026-07-06
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Recent Sessions §), `docs/overnight/ledger.md` (630 KB, last written 2026-07-05 21:13) + `docs/overnight/metrics-latest.json` (same timestamp) + `docs/overnight/focus.md` (stale, dated 2026-06-24), a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-29.md` (7 days ago). This regeneration mirrors its structure. `_2026-06-22.md`, `_2026-06-15.md`, `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all ten reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-06-29 — the heaviest product-shipping week in the report's history.** **269 commits since 2026-06-29** — but unlike prior weeks (where docs/automation dominated the *substance* too), this week the code-bearing work is unusually large: **~106 code commits (67 `fix` / 32 `feat` / 7 `perf`, 0 `refactor`)** under the 116 `docs` + 25 `ops` + 5 `chore` + 4 `monitor` + 2 `night pass` process commits. Five headline stories: **(1) Edition-page overhaul + a matching perf pass — the week's most visible user-facing work.** New parallel tier-pill switcher (`38baa51`), a Sales | Offers Activity toggle (`5370bb0`), a percent-listed pricing metric (`2b9bcbc`), plus five RPC-bundling / Suspense-streaming perf commits (`e0afec3`, `6ebcc8f`, `705fb20`, `3940753`, `e46249e`) that collapse the edition page's many reads into single bundled RPCs. **(2) The TopShot subedition / parallel-conflation program continued and deepened.** An F9 conflated-editions drain pipeline (`ab670f5`), collision-knot resolution wired into the drain orchestrator (`1bc4732`), a Population-B base-resident parallel probe (`128e2a7`), a per-parallel ASK floor for STALE `::` subeditions (`656b506`), and a `?p8=1` drain mode for F1-corrupt source moments (`24fec11`). This is the direct continuation of June's parallel de-conflation work and is why TopShot editions rose to **18,144** (all `::subID` parallels being cataloged — explicitly *not* a writer leak, per the 07-06 night pass). **(3) A jersey / serial FMV pricing engine went live.** A 7-arg `serial_fmv_estimate` jersey overload + weekly cron (`4c5963e`), a "what drives the remaining EV" pack panel wiring the jersey caller (`9b619fb`), and a Pinnacle render-keyed serial-premium FMV model + serial value ladder (`7d216ec`). **(4) Pack-EV reality calibration extended from TopShot to AllDay.** AllDay pack lifecycle + pull-provenance + a model-vs-reality board (`bced12e`), AllDay pack-OPEN event ingestion into `pack_rips` (`cd0c71a`), odds/median-corrected EV in the UI + on OG cards (`f5595fa`, `d279d83`), plus new sealed-pack-secondary-market surfaces for both TopShot (`de3531c`) and AllDay (`c653e23`). **(5) A genuine SEO / discoverability push** — query-first value-led titles + answer-led descriptions on edition/set/player pages (`ea5cb40`), a crawlable FMV valuation sentence on edition pages (`d23f5e6`), and an `/insights/account-value` landing page (`d193778`). Given the standing traction concern (§2.1), this is the first week in a while with concrete *acquisition-surface* work.

> **A1 partially unblocked — TopShot special-serial owner display is now live.** The `special-serial-sweep` edge function's TopShot ownership lookup was implemented this week (`ef80868`, 2026-07-05, "wire TopShot owner resolver — Path B: `getMintedMoment.owner`"). It routes a single-moment `getMintedMoment` call through the topshot-proxy and returns the real holder. This is a workaround for the long-standing A1 block (the *batch* `searchMintedMoments` capability is still unavailable), and it drops the in-code TODO count by one (§5c: 4 → 3 markers). The AllDay / Golazos / UFC legs of the same sweep remain `console.log` stubs.

> **Plus continued intelligence + activation work:** **4 new public `/insights` surfaces** (`allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, `account-value`) — the hub is now **25 surfaces** (was 21), and the per-surface insights OG set grew **20 → 24**; real collection-aware badge art incl. NFL All Day badge SVGs (`9b3cf64`, `0c70791`) + special-serial category glyphs (`3ce52b0`); Pinnacle intraday render-floor refresh (`105c9e9`) + render Recent-Sales + FMV-history chart (`7fb73d5`); TopShot @usernames instead of raw wallets in pack sales history (`726a103`); and a `perf(classify-acq)` batch-cap fix (`795d99b`) that directly addresses the carried CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT queue item.

> **Safety posture held; operational reality was noisy.** The destructive-op circuit-breaker (`rpc_guard_block_destructive`) and per-collection FMV-freshness tripwires shipped last week stayed live; trust-health grew **13/13 → 16/16** (more per-collection checks, all green) and security stayed **0/0/0/0** through every migration. The night passes ran every night 06-30 → 07-06 and shipped **0 production changes each** — several were correctly monitor-mode (off-hours or clock-skewed sandboxes), each verifying the dense daytime waves DB-clean. The 07-06 pass caught a ~16h-stale sandbox clock and correctly shipped nothing.

> **Traction reality (carried forward — no fresh user-count snapshot this run).** The last logged traction read (2026-05-31, ledger) remains **~13 total users, 0 signups in 7 days, 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** No signups-moved-off-zero measurement appears in this week's commits — though the SEO push (§2.1) is the first acquisition-surface work in weeks. Monetization stays tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* and *measurement*. **Cost/storage remains the one concrete financial pressure:** the deep-history + subedition-cataloging waves pushed the **DB to ~8,159 MB** (07-06 night pass) — up ~1.8 GB from last week's 6,391 MB, and ~3 GB in two weeks. That growth rate is benign per the passes but is now the clearest cost line to watch.

> **Platform context (unchanged, still material).** **(1) Flowty shut its marketplace (~2026-05-13)** — Flowty-dependent infra frozen; teardown DECISION is "keep frozen, close Priority #1" (`docs/cleanup-decisions-2026-06-01.md`). **(2) NFL All Day ended primary pack sales** — AllDay pack-EV is historical-only (this week's AllDay pack-reality work is secondary-market analysis of that history). **(3) Chain-two (Candy / Solana) prebuild is inert** and was gated on a **July-8 Candy data tripwire** — that tripwire is now **2 days out**; the 17-line Candy/Solana discovery-placeholder block (§5g) is unchanged and still unfilled. **(4) The Panini WC2026 Prizm "Plane-A" ingest scaffold remains inert** — repo-only, writes nothing, gated on a per-mode discovery capture (§5h).

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **absent right now = no freeze active.** **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Net-new shipped features (not numbered) | **9+** | Edition-page overhaul (NEW); jersey/serial FMV pricing engine (NEW); AllDay pack-EV reality board (NEW); TopShot special-serial owner display (NEW, A1 partial unblock); **4 new `/insights` surfaces**; SEO title/description + account-value push (NEW); real AllDay badge art; Pinnacle intraday floor + render sales chart; omni-channel alerts (LIVE, 1 sub) — §2.1 / §2.2 / §2.3 |
| Open overnight operational items | **~8 active + ~5 deferred** | Carried: **VERCEL cost family**; ALLDAY-V1-UNMAPPED-DRIFT; CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (batch-cap fix shipped, watch); THIN-FMV-GUARD-CONTENTION; `refresh-conflated-editions` cron (operator); PIN-FMV-REKEY waves 2/3; A1-WORKER-PASSTHROUGH-CLEANUP; ULTIMATE-FMV-RECALC-V1-MISSED-TICK (new, LOW); BADGE-CATALOG-STALE-429 (new, LOW). Deferred: WEEKLY-SURFACE-QA-PROSE, ALLDAY-PACK-OPENS-BACKFILL-404, IPFS ×2 — see §2.6 |
| Net-new structural workstream | 3 | Multi-chain chain-abstraction (Phases A–F complete; 18 shim TODOs) + the inert Candy/Solana chain-two prebuild (17 TODOs, July-8 gate now imminent) + the inert Panini WC2026 Plane-A scaffold (10 TODOs) (§2.8) |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) recommended-closed (keep frozen). Activation-measurement + cost-right-sizing still arguably belong here. |
| In-code TODO markers | **65 real lines / 38 files** (+3 false positives) | **−1 vs last week's 66.** The drop is the implemented TopShot special-serial owner lookup (§5c). No new clusters this week. — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A *build-heavy, correctness-and-discovery-led* week — the busiest shipping week in the report's run, and unusually skewed toward user-facing product (edition pages, pack-EV reality, jersey FMV, SEO surfaces) rather than the pure back-office correctness of recent weeks. The subedition / parallel-conflation program is the connective thread: it is why TopShot editions climbed to 18,144 (parallel cataloging, not a leak), why the jersey/serial FMV engine matters (per-parallel pricing needs it), and why the edition page got a parallel tier-pill switcher. Operationally the platform reads GREEN through the week (per the 07-04 and 07-06 night passes: security **0/0/0/0**, **trust-health 16/16** breaches `[]`, `detect_stalled_pipelines()` / `check_pgcron_recent_failures()` empty or benign-INFO, FMV improving/reconciling, editions' growth explained, Sentry **0** unresolved/24h). The dominant concern is unchanged: **activation/traction** (≈13 users at last read, now with even more live surface area) — though the SEO push is a genuine step toward it. Descending, concentrated risk: **(1)** cost/storage right-sizing (the carried Vercel cluster **plus** DB now ~8.2 GB, +~3 GB in two weeks); **(2)** the FMV-correctness tails (Pinnacle per-render waves 2/3; deep-history + subedition convergence; the jersey engine soak); **(3)** two new LOW operator items (an Ultimate-tier FMV missed cron tick; a badge-catalog 429). Chain-foundation cleanup tails (18 shims + 17 Candy + 10 Panini intentional TODOs) and the monolith/brand/page-polish items remain secondary.

### Themes

| Theme | Items |
|---|---|
| Data-intelligence correctness + surface build (the headline this week) | Edition-page overhaul + perf pass; TopShot subedition/parallel-conflation program (F9 drain, collision-knot, Population-B probe, per-parallel ASK floor); jersey/serial FMV engine; AllDay pack-EV reality board + sealed-pack secondary markets; Pinnacle intraday floor + render sales; TopShot special-serial owner display (§2.2 / §2.3) |
| Conversion / activation (the real critical path) | **SEO push (query-first titles, crawlable FMV sentence, `/insights/account-value`)** — first acquisition-surface work in weeks; **omni-channel alerts (LIVE, 1 sub)**; Rewards economy (DIAL-IN). **Verify `funnel_events` accumulates; measure whether signups / alert sign-ups move off zero.** (§2.1) |
| Safety / reliability hardening (held) | Destructive-op circuit-breaker + per-collection FMV freshness stayed live; trust 13/13 → 16/16; classify-acq batch-cap fix (`795d99b`) addressing the statement-timeout flap (§2.4) |
| Security / dependency hygiene | `check_public_security_invariants()` **0** through every migration this week; `next` / `eslint-config-next` hold at **16.2.9**; 4 residual transitive HIGHs are the onflow→viem→ws chain (monitor-only). (§2.4) |
| Cost / operational right-sizing (carried + growing fast) | Vercel cost family carried (no new invoice logged); **DB now ~8,159 MB** (+~1.8 GB this week, +~3 GB in two weeks) from the backfill + subedition-cataloging waves — the clearest cost line. (§2.6) |
| Operational / overnight queue | Vercel cost cluster; ALLDAY-V1-UNMAPPED-DRIFT; CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (fix shipped, watch); THIN-FMV-GUARD-CONTENTION; `refresh-conflated-editions` cron (operator); PIN-FMV-REKEY waves 2/3; A1-WORKER-PASSTHROUGH-CLEANUP; ULTIMATE-FMV-RECALC-V1-MISSED-TICK; BADGE-CATALOG-STALE-429; ALLDAY-PACK-OPENS-BACKFILL-404 (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete (18 shim TODOs); Candy/Solana chain-two prebuild inert (17 TODOs, **July-8 gate now 2 days out**); Panini WC2026 Plane-A scaffold inert (10 TODOs) (§2.8 / §5a / §5g / §5h) |
| Tech debt / refactor | `/dashboard` migration (#10, **2,013 lines — DOWN 136**); monolith pages (#14 — collection **2,870** (+3), sniper **2,191** (+25); the analytics figure in `CLAUDE.md` remains stale, see §8) |
| Page polish | Pack/Moment/Set tune-up (#17 — edition-page overhaul + AllDay pack-reality landed this week); brand punch list (#11 — token sweep complete); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded); Cart (#1, shelved by decision); special-serial owner lookup (TopShot now unblocked via Path B; AllDay/Golazos/UFC still API-edge-blocked) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id` migration; `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. This week the intelligence-build + edition-page + SEO work led; activation and measurement still lead what's *next*, paired with the now-fast-growing cost/storage line.

### 2.1 Conversion / activation — machinery built, SEO push added, still unmeasured — `Severity: High · Effort: Medium (shipped, unmeasured)`

The funnel has been open for weeks; this week added the first genuine **acquisition-surface** work in a while:

- **SEO / discoverability push (NEW).** Query-first, value-led titles + answer-led descriptions on edition/set/player pages (`ea5cb40`), a crawlable FMV valuation sentence on edition pages (`d23f5e6`), value-led team/series titles + an FMV live-ask reword (`d23f5e6`, `d193778`), and a new `/insights/account-value` landing page (`d193778`). This is a real bet on organic discovery — the cheapest possible acquisition channel for a ≈13-user product. **Worth measuring: does crawl/impression volume move?** (No analytics snapshot this run.)
- **4 new public `/insights` surfaces** — `allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, and `account-value`. All shipped with the server-render / OG / canonical / sitemap treatment; the hub is now **25** (see §2.2).
- **Omni-channel alerts remain LIVE with 1 active subscription** (Trevor's go-live test); the next step is still to open it to the allow-list and watch sign-ups. **Known limitation (carried):** serial / jersey / last-mint / never-sold filters enforce at the *edition* level until a per-serial live-listing feed lands.
- **Rewards points economy** (live, carried, status **DIAL-IN**) — store stocking still awaits Trevor's Moment picks; raffle still held pending legal review. No code blocker.

Suggested next step (unchanged and still the highest-leverage work): confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND the alerts loop (sign-ups, channel links, deliveries); open alerts to the allow-list; **and now, watch whether the SEO surfaces move impressions.** Then watch whether signups move off zero. Worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — expanded to 25 — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — now 25 surfaces** (verified against `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir, which agree at 25): `squeeze`, `pack-reality`, `allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, `pack-sniper`, `rookies`, `rookie-board`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `allday-scarcity`, `market`, `offer-spread`, `deals`, `trophies`, `top-sales`, `serial-premiums`, `new-collectors`, `underpriced-serials`, `pack-drops`, `squeeze-check`, `tc-report`, `account-value`. **+4 this week** (`allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, `account-value`).
- **Edition page overhaul** (07-05) — the single most-trafficked template gained a parallel tier-pill switcher, a Sales | Offers Activity toggle, and a percent-listed pricing metric, all behind bundled RPCs (see §2.3).
- **OG cards** — **14 top-level routes** plus **24 per-surface `/api/og/insights/*` cards** (grew 20 → 24, matching the 4 new surfaces) + 1 shared fallback.

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV / data-intelligence correctness — the week's main event — `Severity: was High (correctness) · Effort: large, mostly landed`

- **Edition-page overhaul + perf pass (07-05).** New parallel tier-pill switcher (`38baa51`), Sales | Offers Activity toggle (`5370bb0`), percent-listed metric (`2b9bcbc`), and five perf commits that bundle the page's many reads into single RPCs / Suspense streams: `e0afec3` (high_offer + subedition ladder + IPFS assets → one RPC), `6ebcc8f` (`computeHighMediumPct` via per-edition LATERAL not full-history DISTINCT ON), `705fb20` (insight-links bundle), `3940753` (stream Top Sales), `e46249e` (drop dead `special_serial_holders` query).
- **TopShot subedition / parallel-conflation program (continued).** F9 conflated-editions drain pipeline (`ab670f5`, seed→resolve→catalog→split), collision-knot resolution wired into the drain orchestrator (`1bc4732`), a Population-B base-resident parallel probe (`128e2a7`, edge fn + 15m Vercel cron), a per-parallel ASK floor for STALE `::` subeditions (`656b506`), and a `?p8=1` drain mode for F1-corrupt source moments (`24fec11`). TopShot editions rose to **18,144** — 100% `::subID` parallel catalog rows, explicitly *not* a writer leak (07-06 night pass verified the sentinel TS-UUID-leak 48h = 0).
- **Jersey / serial FMV pricing engine (NEW live).** A 7-arg `serial_fmv_estimate` jersey overload + weekly cron (`4c5963e`), a "what drives the remaining EV" pack panel wiring the jersey caller (`9b619fb`), and a Pinnacle render-keyed serial-premium FMV model + serial value ladder (`7d216ec`).
- **AllDay pack-EV reality calibration (extends June's TopShot work).** AllDay pack lifecycle + pull-provenance + model-vs-reality board (`bced12e`), AllDay pack-OPEN event ingestion into `pack_rips` (`cd0c71a`), odds/median-corrected EV in the UI + on OG cards (`f5595fa`, `d279d83`); plus new sealed-pack-secondary-market surfaces for TopShot (`de3531c`) and AllDay (`c653e23`) with authoritative depletion.
- **Pinnacle per-render FMV (PIN-FMV-REKEY).** Carried — engine `pinnacle-2.0.0-render` (table `pinnacle_fmv_history`) is primary; this week added an intraday render-floor refresh (`105c9e9`) and render Recent-Sales + FMV-history chart (`7fb73d5`). **Remaining (Trevor-sequenced): waves 2/3** then retire any legacy readers.

Suggested next step: watch the subedition + deep-history backfill converge; keep `v_fmv_sanity_flags` + the per-collection `*_fmv_stale_hours` tripwires in the weekly health check; let the jersey FMV engine soak (confirm the weekly cron fires and `fmv_sanity_flags` stays 0); finish PIN-FMV-REKEY waves 2/3; confirm the AllDay realized-EV views stay fresh.

### 2.4 Safety / reliability + dependency hygiene — `Severity: Medium (held) · Effort: mostly done`

Last week's hardening stayed live; this week added a targeted contention fix:

- **Destructive-op circuit-breaker — still LIVE.** `rpc_guard_block_destructive` (thresholds in `rpc_delete_guard_config`) continues to block bulk/cross-cutting deletes on irreplaceable tables. No new incident this week.
- **Per-collection FMV freshness — grew.** `v_rpc_trust_health` now runs **16 checks (was 13)**, all green with breaches `[]`, so a single-collection FMV outage pages directly.
- **`perf(classify-acq)` batch-cap fix (`795d99b`).** Capped the AllDay leg of `classify-acquisitions-multicollection` from 300 → 80 to stop the statement-timeout flap — directly addresses the carried CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT operator item (still watch: the leg duration was creeping back as `allday_studio_history_v1` fills).
- **Security invariants held 0.** `check_public_security_invariants()` stayed **0** through every migration in a very migration-heavy week (F9 drain, subedition catalog/split, jersey FMV, AllDay pack-open ingest).
- **Dependencies hold at `next` / `eslint-config-next` 16.2.9.** The 4 residual transitive HIGHs (`defu`/`fast-uri`/`ws`/`viem` via the onflow chain) stay **monitor-only** — their only fix path is a build-breaking `@onflow/*` bump. `stripe@^22` present but dormant (monetization tabled).

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The overnight/monitor passes continued routine hygiene all week: drained inbox files, archived spent entries, refreshed `metrics-latest.json` (last 2026-07-05 21:13), and ran post-ship regression watches on each heavy daytime wave (all DB-clean, 0 reverts). The night passes shipped 0 production changes 06-30 → 07-06 (each a correct "green/monitor-mode night"). Artifacts: 15 active in the manifest, none flagged broken or repaired this week. **Note (carried):** `docs/overnight/focus.md` is still dated **2026-06-24** — 12 days stale; worth a refresh so the passes steer on current priorities.

### 2.6 Overnight operational queue — cost-led, plus the carried data/ops tail — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue this week closed several items as the daytime waves shipped and added two new LOW ones. **Closed/reconciled since the last report:** TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS-BREACH (self-resolved as per-parallel circ backfill caught up), SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (fixed 06-30 by a 600s statement_timeout), TOPSHOT-FMV-POPULATE-MISSED-TICK (self-healed), and the 07-05 daytime subedition wave post-ship watch (all DB-clean). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **VERCEL cost family** | Carried (FLUID-RIGHTSIZE, CRON-CADENCE, SPEND-PAUSE backstop, OBSERVABILITY-SAMPLING, FLUID-CONCURRENCY). No new invoice figure logged. **Compounded by DB now ~8,159 MB** (+~1.8 GB this week; +~3 GB in two weeks) from the backfill + subedition-cataloging waves. | Med | Mostly Trevor (dashboard) + operator. The SPEND-PAUSE backstop (set a monthly cap) is the do-regardless one. |
| **CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT** | The `nfl_all_day` leg of `classify-acquisitions-multicollection` flaps at its 90s statement_timeout. Batch-cap fix `795d99b` (300→80) bought headroom but the leg is creeping back as `allday_studio_history_v1` fills. | Low–Med | CC/operator: re-measure after the studio backfill finishes, or bound the candidate CTE to a recent window. Not FMV/user-facing. |
| **ULTIMATE-FMV-RECALC-V1-MISSED-TICK** (new) | Ultimate-tier FMV recalc ran clean daily 06-28→07-04 then missed the 07-05 tick (~41.5h silent). Ultimate-tier FMV only. | Low | Watch the 07-06 06:35Z self-heal; if it misses again the `RPC_ADMIN_TOKEN` cron is the operator lever. |
| **BADGE-CATALOG-STALE-429** (new) | `badge-catalog` last ran 07-04 21:38Z ok=false (429), none since. Cosmetic/enrichment. | Low | GHA/operator re-fire. |
| **ALLDAY-V1-UNMAPPED-DRIFT** | Open AllDay `unmapped_sales` are `source=onchain_dapper_v1` (`v1_tx_decode_budget_exhausted`); correctly held out of `sales`. Hard tail unresolvable. | Low | Operator: classify the residual as permanent or wire the recover cron. |
| **PIN-FMV-REKEY waves 2/3** | Last Pinnacle per-render reader cutover + legacy retirement. | Med | Trevor-sequenced (price-display change). |
| **`refresh-conflated-editions` cron** | The daily honesty-guard refresh still pending operator wiring (covers conflation + thin-FMV guards). | Low | Operator. |
| **A1-WORKER-PASSTHROUGH-CLEANUP** | Residual probe from the earlier special-serial owner-lookup unblock attempt. (Note: TopShot owner display is now live via a *different* path — Path B `getMintedMoment`.) | Low | CC. |
| THIN-FMV-GUARD-CONTENTION | `rpc-refresh-thin-fmv-guard` occasionally times out under a ~13:30Z / overnight micro-contention window. | Low | CC: planner/timeout fix if it recurs. |
| ALLDAY-PACK-OPENS-BACKFILL-404 | `allday-pack-opens-backfill` stuck re-attempting a sub-spork-floor event range (permanent 404); the forward path is healthy. | Low (deferred) | CC/operator: pass `?floor=…` override or raise `DEFAULT_FLOOR`. Historical enrichment only. |
| WEEKLY-SURFACE-QA-PROSE / IPFS ×2 | Cosmetic prose strings in the `rpc-live-health` artifact; two deliberately-deferred IPFS catalog-freshness / image-resilience items. | Low (deferred) | Explicit triggers in the ledger; do not build now. |

### 2.7 Pack EV / pack-viz — actively improved this week — `Severity: Low · Effort: shipped`

Like last week, pack-EV was a live product surface: the reality-calibration program extended to AllDay (model-vs-reality board, observed lifecycle via pack-OPEN ingestion, odds/median-corrected EV in the UI and on OG cards), and both TopShot and AllDay gained sealed-pack-secondary-market surfaces with authoritative depletion. No open pack-EV defects; the one queue item is the LOW ALLDAY-PACK-OPENS-BACKFILL-404 historical-enrichment stall (§2.6).

### 2.8 Chain foundation — abstraction complete; two inert chain scaffolds; July-8 gate imminent — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F are complete** (Phase F shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged, bulletproof by design. **Trap:** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`.
- **Candy / Solana chain-two prebuild is inert — and its gate is now imminent.** `collections` seeded (`candy_mlb` / `panini_blockchain`, `is_active=false`), `helius-proxy` scaffolded. It writes nothing until the five discovery placeholders are filled (§5g). **The July-8 Candy data tripwire is 2 days out (from 2026-07-06); watch for whether ≥30 days of Candy Solana sales history materializes** — that's the documented trigger to start chain-two code. Until then, do **not** fill the placeholders.
- **Panini WC2026 Prizm "Plane-A" ingest scaffold is inert** (`ec82db1`) — repo-only, writes nothing until a per-mode discovery capture (CryptoSlam API contract or the `/onepanini` request format) is filled in (§5h). Also inert: a Dune-backed TopShot ownership index (Pipeline A).

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (SEO push NEW; omni-channel alerts LIVE; Rewards economy; 4 new `/insights` surfaces) shipped; **verify `funnel_events` is recording and measure whether signups / alert sign-ups / SEO impressions move off zero.** | High | Medium (shipped, unmeasured) |

### Data-intelligence correctness (the headline this week)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Edition-page overhaul | Edition page had many un-bundled reads + no parallel switcher. **Shipped** — parallel tier-pill switcher + Activity toggle + percent-listed metric + 5-commit RPC/Suspense perf pass. | was Medium | (landed) |
| Subedition / parallel-conflation | Parallel `::` moments conflated onto base editions. **Shipped + draining** — F9 drain pipeline, collision-knot resolution, Population-B probe, per-parallel ASK floor. TopShot editions 18,144 (cataloged parallels, not a leak). | Medium | Medium (in progress) |
| Jersey / serial FMV engine | Per-parallel + jersey serials had no dedicated pricing. **Shipped LIVE** — 7-arg `serial_fmv_estimate` jersey overload + weekly cron; Pinnacle serial-premium model. | was Medium | (landed, soaking) |
| AllDay pack-EV reality | AllDay pack EV was model-only, no observed lifecycle. **Shipped** — lifecycle + pull-provenance + model-vs-reality board + corrected EV. | was Medium | (landed) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary; intraday floor + render sales added; waves 2/3 + legacy retirement queued (Trevor-sequenced). | Medium | Medium |

### Safety / reliability hardening

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Destructive-op guard | Bulk/cross-cutting deletes on irreplaceable tables could corrupt silently. **LIVE** (`rpc_guard_block_destructive`), no new incident. | was High | (landed) |
| Per-collection FMV freshness | A single-collection FMV outage was masked by the global check. **LIVE** — trust-health now 16/16. | was Medium | (landed) |
| classify-acq statement-timeout | AllDay classify leg flapped at 90s. **Batch-cap fix shipped** (`795d99b`); creeping back as studio history fills — watch. | Low–Med | Small (watch) |

### Cost / operational right-sizing (carried + growing fast)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Vercel cost family | Carried (uncapped Spend-Management + Fluid/cron/observability levers). No new invoice this run. | Medium | Small–Medium (mostly dashboard + cron config) |
| DB storage growth | Backfill + subedition-cataloging waves grew the DB ~1.8 GB this week (6,391 → ~8,159 MB); ~3 GB in two weeks. Benign per the passes; **watch the rate — now the clearest cost line.** | Medium | Small (monitor + decide retention) |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |
| Candy chain-two | 17-line discovery-placeholder block in the inert Candy/Solana ingest path — **July-8 gate now 2 days out.** Do not fill until the ≥30-day sales-history tripwire is met. Intentional. | Low | Medium (gate imminent) |
| Panini WC2026 | 10-marker block in the inert Panini "Plane-A" scaffold — unfillable until a per-mode discovery capture lands. Repo-only, writes nothing. Intentional. | Low | Medium (gated) |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. This week: the edition-page overhaul (parallel switcher / Activity toggle / percent-listed) + AllDay pack-reality board landed. Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, present) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — the light/dark theme tokenization sweep completed. Phase-1 token sweep + CI guard (`scripts/check-brand-tokens.mjs`) remain in place. This week added real collection-aware badge art (NFL All Day SVGs) + special-serial category glyphs — a polish gain. Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin), tracked not gated. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,013 lines** (verified; **DOWN 136** from 2,149 last week — the file was trimmed this week). Big lift still, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,870** (+3), `sniper/page.tsx` **2,191** (+25). **The `analytics/page.tsx` figure in `CLAUDE.md` #14 (~2,128/2,208) is STALE** — the actual `/analytics` route page (`app/(analytics)/analytics/page.tsx`) is **495 lines** and is already split into ~14 subroute pages. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (analytics already split) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01).** `ensureLive()` throws unless `RPC_TRADE_ESCROW_ADDRESS` is set (verified in `lib/trade-escrow/fcl-submit.ts`); `/api/trade-chain/*` return 503; `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx` (verified present). 8 in-code stub TODOs persist (§5b). | Medium (shelved) | Large |
| A1 | Special-serial owner lookup — **PARTIALLY UNBLOCKED this week.** TopShot ownership now resolves via Path B (single-moment `getMintedMoment.owner`, `ef80868`); the `special-serial-sweep` TopShot leg is implemented. The AllDay / Golazos / UFC legs remain stubs (§5c) and the *batch* `searchMintedMoments` capability is still blocked at the TS API edge. `A1-WORKER-PASSTHROUGH-CLEANUP` is carried in the operator queue. | Low–Medium (TopShot unblocked; rest blocked externally) | Medium |

### Net-new features not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Edition-page overhaul | **Shipped (07-05)** — parallel switcher + Activity toggle + percent-listed + perf pass. Worth a numbered slot. | n/a (shipped) | Medium |
| Jersey/serial FMV engine | **Shipped LIVE** — 7-arg `serial_fmv_estimate` jersey overload + weekly cron; Pinnacle serial-premium model. | n/a (live, soaking) | Medium |
| AllDay pack-EV reality board | **Shipped** — lifecycle + provenance + model-vs-reality + corrected EV. | n/a (shipped) | Medium |
| TopShot special-serial owner display | **Shipped** — Path B `getMintedMoment.owner`; A1 partial unblock. | n/a (shipped) | Medium |
| SEO / account-value push | **Shipped** — value-led titles/descriptions + crawlable FMV sentence + `/insights/account-value`. | n/a (shipped) | Medium |
| Omni-channel alerts | **LIVE (06-18)** — 1 active subscription; dialing in. Worth a numbered slot. | n/a (live) | Medium |
| Rewards | Off-chain points economy — live, DIAL-IN. Non-code blockers: store stocking; raffle legal review. | n/a (live) | Medium (non-code) |
| Candy chain-two / Panini | Inert prebuilds — see §2.8 / §5g / §5h. Candy gated on July-8 (imminent); Panini on discovery capture. | n/a (gated) | Medium |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives. (The 06-23 anon-DML defense-in-depth revoke already narrowed this surface — anon write grants 482 → 46.)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (`funnel_events` follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate when a real consumer arrives.
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Note: this week's real AllDay per-moment badge art may change the AllDay picture — verify before building.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts — partly superseded by the alerts system.** `CLAUDE.md` Architecture notes still flag the old watchlist/alert tables + routes as partially decommissioned. The omni-channel alerts feature is a *separate* implementation (`alert_subscriptions` / `notification_channels` / `lib/alerts.ts`, verified present); verify whether the old watchlist tables are now dead or should be reconciled before reactivating either.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop. The remaining action is to formally close the priority in `CLAUDE.md`. | §2.5 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via the edition-page overhaul, the subedition/parallel-conflation program, the jersey/serial FMV engine, AllDay pack-EV reality, TopShot special-serial owner display, and 4 new `/insights` surfaces. | §2.2 + §2.3 |

*Implicit priorities surfaced and still un-promoted:* **(a) activation/conversion + its measurement** (§2.1 — ≈13 users; machinery now includes a live alerts loop, new filter UI, AND a fresh SEO push, all still unmeasured); **(b) cost + storage right-sizing** (§2.6 — the carried Vercel family + DB now ~8.2 GB after +~3 GB in two weeks; set the Spend-Management cap regardless, and decide a retention posture for the deep-history/subedition data). Both are arguably worth promoting to explicit `CLAUDE.md` actions.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** This is why §1 reports 0 active revenue-blocking items. (`stripe@^22` is in `package.json` but dormant.)

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`, substring match on `TODO|FIXME|HACK|XXX` to also catch the `TODO_N`-style named placeholders) returned **68 raw matches across 41 files**. Excluding **3 false positives** (see §8) leaves **65 real marker lines across 38 files** — **−1 vs last week's 66.** The single-marker drop is the implemented TopShot special-serial owner lookup (§5c: 4 → 3). No new clusters this week. `CLAUDE.md` does not track these. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest single cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs (`submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`). Fronted by `ensureLive()` so the stubs throw rather than return fake tx ids when the contract is unset.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup — TopShot now IMPLEMENTED (3 markers, 1 file) — **−1 this week**

- `supabase/functions/special-serial-sweep/index.ts` (lines 170, 176, 182) — the AllDay / Golazos / UFC ownership lookups remain no-op stubs (`console.log` a `TODO` line, return null holder). **The TopShot leg was implemented this week** (`ef80868`, `lookupTopShotOwner` now does a real `getMintedMoment.owner` call via topshot-proxy), removing the fourth marker. The three remaining legs need per-collection owner-resolution paths (AllDay/Golazos/UFC on-chain reads or GQL). See §3 (A1).

### 5d. Pipeline calibration / migration (3 markers, 3 files) — unchanged

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files) — unchanged (one line-shift)

- `app/(collections)/[collection]/collection/page.tsx:2662` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`. (Line shifted 2659→2662 with the collection-page edits; same marker.)
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11 / #17.
- `scripts/ingest-topshot-active-listings.mjs:126` — `TODO: set the real dapper.market listing URL once its format is confirmed.`

### 5f. Cadence test coverage gap (2 markers, 1 file) — unchanged

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

### 5g. Candy / Solana chain-two discovery placeholders (17 lines, 3 files) — unchanged; **July-8 gate imminent**

The inert chain-two prebuild wraps **5 named discovery placeholders** unfillable until Candy secondary trading opens (gated on the July-8 tripwire, now 2 days out):

- `lib/chains/solana/normalize.ts` (14 lines — `:5,10,27,29,31,33,35,37,39,40,64,158,162,166`) — the `DISCOVERY TODOs` block: `TODO_1` (Metaplex Core collection mint → `CANDY_MLB_COLLECTION_ADDRESS`), `TODO_2` (Magic Eden symbol → `CANDY_MLB_ME_SYMBOL`), `TODO_3`/`TODO_4` (serial / edition-size attribute keys), `TODO_5` (stable per-edition key), plus the `.startsWith("TODO_")` route-guard checks.
- `app/api/ingest/candy-editions/route.ts` (`:8`, `:72`) + `app/api/candy-sales-indexer/route.ts` (`:111`) — inert-ingest notes that short-circuit the routes until the placeholders are filled.

→ Intentional, gated debt. The routes write nothing while the placeholders are unfilled.

### 5h. Panini WC2026 Prizm "Plane-A" discovery placeholders (10 markers, 6 files) — unchanged

The inert Panini WC2026 Prizm ingest scaffold (`ec82db1`) — repo-only, writes nothing — wraps a per-mode discovery capture not yet performed:

- **Live scaffold (5 markers, 3 files):** `lib/chains/panini/feed.ts` (lines 64, 70, 80 — `TODO(go-live discovery)` for the CryptoSlam NFT API contract + the `/onepanini` request format), `app/api/cron/panini-circulation-refresh/route.ts:107` and `app/api/cron/panini-fmv-recalc/route.ts:82` (both `TODO(go-live)` short-circuit notes).
- **Reference drafts under `docs/drafts/panini/` (5 markers, 3 files):** `ingest-panini-runner.mjs` (lines 16, 29, 33), `panini-ingest-route.ts:137`, `panini-proxy/index.js:19`.

→ Intentional, gated debt — the same shape as the Candy block (§5g). The routes are inert until `paniniFeedEnabled()` is satisfied and the per-mode discovery TODO is filled. Do **not** wire a cron / watchlist until then.

> **Net change since last week:** **−1 marker / same file count** — the TopShot leg of §5c was implemented (`ef80868`). The §5a, §5b, §5d–§5h markers are otherwise content- and line-identical to the 2026-06-29 inventory (modulo the one line-shift on the §5e `collection/page.tsx` marker, 2659→2662).

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md` / `metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set), #3 (Flowty event indexer — reclassified, Flowty shut down), #4 (Pinnacle FMV — resolved + per-render-enhanced), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` prefetches `/api/packs`), #7 (AllDay `unmapped_sales` — resolver rewritten; the V1-budget *drift* is the separate LOW operator item ALLDAY-V1-UNMAPPED-DRIFT), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — fully blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **Edition-page overhaul — SHIPPED** (parallel tier-pill switcher + Sales|Offers Activity toggle + percent-listed metric + 5-commit RPC/Suspense perf pass). A major user-facing upgrade. (§2.3)
- **Jersey / serial FMV pricing engine — SHIPPED LIVE** (7-arg `serial_fmv_estimate` jersey overload + weekly cron; Pinnacle serial-premium model). (§2.3)
- **AllDay pack-EV reality calibration — SHIPPED** (lifecycle + pull-provenance + model-vs-reality board + corrected EV + pack-OPEN ingest + sealed-pack secondary markets). (§2.3)
- **TopShot special-serial owner display — SHIPPED** (`ef80868`, Path B `getMintedMoment.owner`) — A1 partial unblock; §5c dropped 4 → 3 markers.
- **SEO / account-value push — SHIPPED** (value-led titles/descriptions + crawlable FMV sentence + `/insights/account-value`).
- **4 new `/insights` surfaces — SHIPPED** (`allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, `account-value`); OG insights set 20 → 24.
- **Real collection-aware badge art — SHIPPED** (`9b3cf64` NFL All Day SVGs, `0c70791` collection-scoped grid badges, `3ce52b0` special-serial glyphs).
- **`perf(classify-acq)` batch-cap fix — SHIPPED** (`795d99b`) — addresses CLASSIFY-ACQ-ALLDAY-STATEMENT-TIMEOUT (watch as studio history fills).
- **Trust-health grew 13/13 → 16/16** (more per-collection FMV-freshness checks, all green).
- Ledger closures this week: TOPSHOT-IMPOSSIBLE-PARALLEL-SERIALS-BREACH (self-resolved), SERIAL-FMV-POWER-MODEL-WEEKLY-TIMEOUT (600s fix, 06-30), TOPSHOT-FMV-POPULATE-MISSED-TICK (self-healed), the allday-pack-opens cursor false-positive (silenced), plus all daytime post-ship watches DB-clean.

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation and cost/storage both promoted given the week's events:

1. **Measure the activation machinery you've built (§2.1) — now including the SEO push.** Cheapest, highest-leverage — confirm `funnel_events` records anon top-of-funnel; instrument the Rewards loop AND alerts (sign-ups, channel links, deliveries); open alerts to the allow-list; watch whether the new value-led titles / `/insights/account-value` move crawl impressions. Then watch whether signups move off zero.
2. **Let the FMV-correctness + subedition work soak (§2.3).** Watch the subedition/deep-history backfill converge; confirm the jersey FMV weekly cron fires and `fmv_sanity_flags` stays 0; keep the per-collection `*_fmv_stale_hours` tripwires in the weekly health check; finish PIN-FMV-REKEY waves 2/3; confirm the AllDay realized-EV views stay fresh.
3. **Right-size cost + storage (§2.6) — now the clearest financial line.** Do the Spend-Management cap backstop regardless; **decide a retention posture for the deep-history/subedition data** given DB is ~8.2 GB (+~3 GB in two weeks); then the Fluid/cron levers.
4. **Clear the small operator items (§2.6).** Watch ULTIMATE-FMV-RECALC-V1-MISSED-TICK self-heal + re-fire BADGE-CATALOG-STALE-429; wire (or classify) ALLDAY-V1-UNMAPPED-DRIFT; wire the `refresh-conflated-editions` daily-guard cron; do A1-WORKER-PASSTHROUGH-CLEANUP; re-measure the classify-acq leg after the studio backfill finishes.
5. **Prep the July-8 Candy tripwire (§2.8 / §5g).** Decide in advance: if ≥30 days of Candy Solana sales history materializes on/after July 8, that's the trigger to fill the 5 discovery placeholders and start chain-two; if not, leave it inert.
6. **Formally close Priority #1 (Flowty, §2.5)** — record the keep-frozen decision in `CLAUDE.md`.
7. **Chain-foundation cleanup as capacity allows (§2.8 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` trap). Deferrable. Panini stays inert until a discovery capture.
8. **Pack/Moment/Set tail (#17 — edition + pack EV largely done), brand Phase-2 (#11, largely done), `/dashboard` migration (#10, now 2,013 lines), monolith refactor (#14 — note analytics is already split).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run.** HEAD = `c2918b6` (2026-07-05 22:56, "docs(ledger): record 2026-07-06 daytime CC audit-followup drain"). `git log --since=2026-06-29` returned **269 commits** — ~106 code-bearing (67 `fix` / 32 `feat` / 7 `perf`, **0 `refactor`**), the rest process/automation (116 `docs` / 25 `ops` / 5 `chore` / 4 `monitor` / 2 `night pass`, + ~11 un-prefixed/merge). The very high `fix`+`docs` counts reflect the heavy 07-05 daytime CC subedition/collision session plus the daily overnight-pass ledger/handoff commits.
- **Report-location is clean.** `ls PROJECT_HEALTH*` at the repo root returns nothing; `docs/health/` holds the nine prior reports + this one (ten total).
- **No active freeze.** `docs/FREEZE.md` is absent (it exists only while a freeze is active).
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,870** (+3 from 2,867) · `sniper/page.tsx` **2,191** (+25 from 2,166) · `dashboard/page.tsx` **2,013** (**DOWN 136** from 2,149) · `lib/blazers-trivia.ts` **198** (unchanged) · `app/(analytics)/analytics/page.tsx` **495** (unchanged).
- **Stale figure carried (unchanged) — the analytics monolith.** `CLAUDE.md` #14 still lists `analytics/page.tsx` at ~2,128/2,208 lines. The actual `/analytics` route page is **495 lines** and is already split into ~14 subroute pages. The genuine remaining monoliths are `collection/page.tsx` (2,870) and `sniper/page.tsx` (2,191). Recommend correcting #14 in `CLAUDE.md`.
- **TODO scan: 68 raw matches / 41 files → 65 real markers / 38 files** (after excluding 3 false positives). **−1 vs last week's 66** — the TopShot leg of the special-serial-sweep (§5c) was implemented (`ef80868`), removing one marker. By cluster: 18 chain-rename shims (§5a) · 8 Trade Hub stubs (§5b) · 3 special-serial-sweep stubs (§5c, was 4) · 3 pipeline-calibration (§5d) · 4 smaller polish (§5e) · 2 Cadence-test gap (§5f) · 17 Candy/Solana placeholders (§5g) · 10 Panini placeholders (§5h) = 65.
- **Three TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"`; `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_...`; and `supabase/migrations/20260624162548_recover_golazos_video_url_from_thumbnail_key.sql:6` — `XXX` inside the format note `numeric_numeric_recXXX` (a record-key shape illustration). All three excluded from the 65.
- **`/insights` surfaces: 25** — confirmed by `INSIGHT_ROUTES` in `app/sitemap.ts` and the `app/insights/` dir (they agree at 25). **+4 since last week's 21:** `allday-pack-reality`, `allday-pack-market`, `topshot-pack-market`, `account-value`. **Per-surface OG cards: 24** (grew 20 → 24, matching the new surfaces); 14 top-level OG routes.
- **Dependency facts:** `next` and `eslint-config-next` are pinned to **16.2.9** (unchanged); `stripe@^22` present but dormant (monetization tabled).
- **Cited-path spot check:** all expected-present known-issue paths verified present — `lib/chains/flow/cadence/purchase-moment.ts` (#1), `app/api/profile/verify-challenge/check/route.ts` (#0), `app/dashboard/trade-hub/TradeHubClient.tsx` + `lib/trade-escrow/fcl-submit.ts` (#3), `supabase/functions/special-serial-sweep/index.ts` (A1/§5c), `scripts/check-brand-tokens.mjs` (#11), `docs/audits/refactor-plan-monolith-pages-2026-05.md` (#14), `docs/cleanup-decisions-2026-06-01.md` (Flowty), `.github/workflows/ci.yml` (#16), `lib/warmup/WarmupContext.tsx` (#6), `lib/blazers-trivia.ts` (#12), `docs/archive/audits/PACK_PAGES_AUDIT_2026-05-22.md` (#17), `lib/alerts.ts` (alerts), `lib/chains/panini/feed.ts` + `lib/chains/solana/normalize.ts` (chain scaffolds), and `docs/reference/schema-truth.md`. Intentionally-deleted paths remain correctly absent (`scripts/cleanup-storefront-wallets.mjs`, root `cleanup.cdc`, `components/PinnacleSniper.tsx`).
- **DB-side facts** (FMV counts, trust-health 16/16, security 0/0/0/0, editions counts incl. TopShot 18,144, DB size ~8,159 MB) are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` (630 KB) / `docs/overnight/metrics-latest.json` (both 2026-07-05 21:13) / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports. The 07-06 night pass fired against a ~16h-stale sandbox and correctly shipped nothing; live prod deploy at the last clean read was `c09f9693` READY. `focus.md` is 12 days stale (2026-06-24); `ledger.md` is the authoritative live record.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-07-06)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired; 0 unresolved/24h |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved; Trade Hub shelved + guarded | `ensureLive()` + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary; intraday floor + render sales chart added this week | `pinnacle_fmv_history` (live) |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** (V1-budget *drift* is the separate LOW operator item) | `CLAUDE.md` + ledger |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — manual script; cleanup driver deleted; payer wallet/cron paused | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` correctly gone |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,013** lines (**DOWN 136** this week) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — theme sweep complete; real badge art + glyphs added this week; CI guard in place | `git log`; `scripts/check-brand-tokens.mjs` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection **2,870** (+3) / sniper **2,191** (+25); **the analytics figure is STALE — actual `/analytics` page is 495 lines, already split into subroutes** | `wc -l` + dir |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | `git ls-files` (prior runs) |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — edition page substantially upgraded this week** | parallel switcher / Activity toggle / percent-listed + AllDay pack-reality landed; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **edition-page overhaul**, **jersey/serial FMV engine**, **AllDay pack-EV reality board**, **TopShot special-serial owner display**, **SEO/account-value push**, **omni-channel alerts**, and **Rewards** features, the 4 new `/insights` surfaces, and the gated Candy + Panini chain prebuilds.

**Bottom line for `CLAUDE.md`:** the known-issues numbering is unchanged from last week and several recurring recommendations still stand: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **give the live edition-page overhaul, jersey FMV engine, pack-EV reality board, alerts + Rewards features numbered slots**; (c) Prioritized Action #1 (Flowty) can be **closed** (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 chain-rename shims, the 17-line Candy block, and the 10-line Panini block are intentional debt worth a one-line note; **(e) correct the #14 analytics line count** — `analytics/page.tsx` is ~495 lines (already split), not ~2,128/2,208, so the two genuine monoliths are `collection` (2,870) and `sniper` (2,191); (f) **update the A1 note** — TopShot special-serial owner display is now LIVE via Path B (`getMintedMoment`), so only the AllDay/Golazos/UFC sweep legs remain blocked. And, as every recent report has said: given ≈13 users and a now-larger stack of live-but-unmeasured activation machinery (now plus a fresh SEO bet), **promote activation + its measurement** — and, newly this week, **cost/storage right-sizing** (DB ~8.2 GB, +~3 GB in two weeks) — to top-line priorities.
