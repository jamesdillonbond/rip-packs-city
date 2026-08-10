# Rip Packs City — Project Health Report

**Date:** 2026-08-10
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Testing & CI §, Recent Sessions § — current through the 2026-08-09/10 entries), `docs/audits/deep-audit-register.md` (**NEW** — the persistent cross-audit findings register, created 2026-08-09), `docs/overnight/metrics-latest.json` (captured **2026-08-10T08:05:00Z**, same day), `docs/overnight/focus.md` (stale, dated 2026-06-24), `docs/overnight/ledger.md` (**1,181** `### ` entries), plus a first-hand `Grep` (ripgrep-backed) TODO scan and file-existence verification via the file tools.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the **new deep-audit register** (`D…` findings), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-08-03.md` (7 days ago). This regeneration mirrors its structure. `_2026-07-27.md` … `_2026-05-22.md` (fourteen prior reports) also live in `docs/health/`.

> **⚠ Tooling note — NO git / bash this run (again).** The Cowork sandbox VM is **down** (`useradd`: "no space left on device" on `/sessions` — now **three consecutive nights**, verified across resume/create/re-resume this session and recorded by the 08-10 overnight pass). So there is **no `git log`, no `wc -l`, no `ripgrep`-in-shell**. Every figure here comes from the **file tools** (Read/Glob/Grep) against the mounted working tree plus `metrics-latest.json` and `CLAUDE.md`. Consequently: **commit counts and diff-stats are omitted** (unmeasurable); DB-side facts come from `metrics-latest.json` (same-day) and `CLAUDE.md`'s dated entries, **not** re-queried against production this run. The TODO scan is a full `Grep` over the committed tree.

> **⚠ Date nuance.** The harness stamps today as **2026-08-10** (UTC); in Pacific (Trevor's operating zone) it is still **2026-08-09 ~23:32 PT**. This report is filed under **2026-08-10** per the weekly-regeneration convention (prior report was 08-03, exactly 7 days back). Ledger/session dates in `CLAUDE.md` are Pacific.

> **Report location stays clean.** All fifteen reports (this one included) live in `docs/health/`; the repo root holds none. Written there per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what shipped; `docs/audits/deep-audit-register.md` is now the source of truth for the deep-audit findings and their probes. This doc reorganizes all three for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-08-03 — a very heavy correctness/audit week on top of an otherwise-stable, still-near-zero-audience product.** Three stories dominate. **(1) A full DEEP AUDIT ran, and it now has a durable home.** `docs/audits/deep-audit-register.md` was created 2026-08-09 and drained hard across 08-09/08-10 — on the order of **~22 findings resolved** (D1–D38, incl. inverted-sign net-of-fees math, a fabricated bid-ask spread on the *public* Candy board, several "a failed read renders as data / HTTP 200" defects, the Set Tracker being dead on three collections via a non-sargable wallet predicate, and a family of stale-table-read defects), with **~17 still open** — including one **P0** (`D2b`: 8 pack-pipeline cron gate keys are in the public git history and the live keys are still the burned ones — **rotation is owed, operator/Trevor-only**). This is the week's real substance. **(2) The FMV confidence-accuracy program shipped (08-08).** Ask-ceiling caps + a volume-tier HIGH gate + a 90-day catch-up sweep drove the HIGH+MEDIUM confidence share up sharply: Top Shot **3,416 → 6,751** and All Day **394 → 1,550** priced-at-confidence editions (per `metrics-latest.json`). **(3) The test/correctness flywheel kept compounding:** DB-invariant pins **115 → 122**; the vitest ratchet rose to **89.3/75.1/91.5/91.6** and the component gate to **79.0/67.0/78.8/83.2**; a **17th Cloudflare worker** (`atlas-proxy`) landed (INERT, pending an operator deploy); and the canonical forward plan advanced to **`docs/strategy/roadmap-2026-08-03.md`** (supersedes 07-18), whose thesis is that **accuracy is the GATE, not a phase**.

> **Overnight reality — GREEN-with-known-saturation-noise, but NO-PUSH for the third straight night.** The 08-10 genuine-overnight pass (01:03 PDT) shipped **0** — the bash VM is down (`/sessions` no-space kills the shell → no git → no commit/deploy). Post-ship watch over the large 08-09 Claude-Code wave was **ALL PASS, 0 reverts**. Health at capture: security **0/0/0/0**; `detect_stalled_pipelines()` empty; **0** new recurring Sentry in 24h; **3 trust breaches — all pre-known/carried**: `panini_sale_price_capture_dry_days=13` (upstream residential-box capture outage since ~07-29 — operator), `unmapped_resolution_backlog_max=194` (AllDay permanent floor; rose on a historical-backfill inflow but net-draining ~28d), and `public_board_slow_count=5` (saturation collateral; root cause is the **deals** public board failing to warm nearly every tick → ~3h stale).

> **Traction reality — still the headline concern, and NOT re-measured this run.** `metrics-latest.json` this run did **not** capture a user/WAU count (queue-only, DB-read-limited pass). The last confirmed reading (2026-07-26) was **20 users / 0 new signups / 0 WAU**, and nothing this week suggests it moved. The site has been public since 07-17 and self-serve since 07-20; the machinery is built, instrumented, and idle. **Demand — not measurement, not features, not correctness — is the one number that decides everything, and it is unconfirmed-but-presumed-flat.**

> **Cost / storage — UP again.** DB is **12,372 MB, +520 MB** over last week's 11,852. **Disk-IO budget on the Supabase instance remains the binding operational constraint** — it is the direct cause of the `public_board_slow_count` breach and the statement-timeout pipeline alerts. ⚠ **Correction to prior reports: the instance is `SMALL` (2 GB RAM / 2-core), not `Micro`** (re-verified live 2026-08-08). The saturation is **disk-IO-budget-bound, not compute-bound** — the documented lever is killing expensive queries and precomputing, NOT upgrading the tier (Medium is the same 2 cores for 4× the cost).

> **Platform context (unchanged).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen (0 sales; honestly labelled "Flow market closed"; the revival arm was re-pointed to `ufc_flow_revival_sales_30d`). **(4) Candy / Solana** — PUBLIC since 07-31. **(5) Panini** — PUBLIC since 08-01 (listing-gated coverage disclosed structurally). **(6) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **1,181** entries, `inbox/`, `metrics-latest.json`, `focus.md` — **~47 days stale**, `.lock`). `docs/FREEZE.md` (absent this run → no freeze) halts all autonomous shipping. **Check `docs/overnight/ledger.md` and `docs/audits/deep-audit-register.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Numbering unchanged in `CLAUDE.md`. `#3` still double-labelled (Flowty indexer resolved + Trade Hub, now deleted). See §9. |
| Known issues — resolved | 11 | #2, #3 (Flowty), #4, #5, #6, #7, #8, #12 (**NEW — file removed**), #13, #15, #16 — §6 / §9 |
| Known issues — open / partial | **5** | #0, #10, #11, #14, #17 — §3 / §9 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot, 2026-08-01). Verified still absent. |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| **Deep-audit register (NEW)** | **~22 resolved / ~17 open** | `docs/audits/deep-audit-register.md`, created 2026-08-09. 1 **P0** (D2b, operator secrets rotation), 1 P1 (D8), ~11 P2, 2 P3, plus a few "landed-not-confirmed". — §2.3 / §3 |
| Commits this week | **not measured** | Bash/git VM down (3rd night) — no `git log`. The CC entries in `CLAUDE.md`/ledger indicate a very heavy interactive-CC week regardless. |
| Net-new shipped / landed this week (not numbered) | **many** | **Deep-audit drain** (~22 findings); **FMV confidence-accuracy program** (HIGH+MED shares up ~2×); **PUBLIC-BOARD-CACHING (nc1)** across 5 hot `/insights` boards; **DB pins 115→122**; ratchets raised (primary 89.3, component 79.0); **17th worker** `atlas-proxy` (INERT); **Sentry connector reconnected**; roadmap → 08-03 — §2 / §6 |
| Open overnight operational items | **~7 active + standing queue** | Deals public board ~3h stale (NEW user-facing); disk-IO MV-refresh cluster; panini price-capture dry 13d (operator); AllDay unmapped inflow; sync-nba-projections (off-season/egress); NO-PUSH shell/disk (escalated, operator) — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana (PUBLIC) + Panini (PUBLIC); multi-chain abstraction Phases A–F complete — §2.8 |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-08-03.md` is canonical (accuracy-is-the-gate). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** (+2 launch-flag-gated candy "note" branches by design, +4 panini draft/reference lines, +~10 resolved-annotation / guard-function lines, +~2 false positives, +~11 test refs) | 29 raw `Grep` matches across 15 files — §5 |
| Test / DB-invariant pins | **122 invariants** (121 `supabase/tests/*.sql` files incl. `_helpers.sql`) | Was 115. Primary ratchet 89.3/75.1/91.5/91.6; component 79.0/67.0/78.8/83.2. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A **correctness-and-audit** week. The dominant event is the first full **deep audit** and its new durable register: ~22 findings closed (several were genuinely user-facing — inverted net-of-fees signs, a fabricated bid-ask spread on the *public* Candy board, timeouts rendering as `$0`/`0 sales` measurements, the Set Tracker dead on three collections) and ~17 still open, one of them a **P0 secrets-rotation** that only Trevor can action (8 cron gate keys are in the public git history). Alongside that, the **FMV confidence-accuracy program** materially improved published-price trust (HIGH+MED editions roughly doubled on both big Flow collections), the test machine kept ratcheting (pins 115→122, higher coverage floors, a 17th worker), and one operator blind spot from last week **closed** — the **Sentry connector is reconnected** and reporting 0 new recurring issues. The board is GREEN-with-known-saturation-noise: three trust breaches, all pre-known and non-regressive. Descending, concentrated risk: **(1) demand** — the only gate (50+ WAU), last-measured 0, un-remeasured; **(2) the NO-PUSH shell/disk failure** — now **three nights running**, which blocks all autonomous shipping and needs an operator to free `/sessions`; **(3) the P0 gate-key rotation** (D2b); **(4) disk-IO saturation** on the SMALL instance (DB +520 MB), now causing a *new* user-facing symptom — the **deals** public board serving ~3h-stale data.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. Funnel wired. Last-measured **20 users / 0 WAU**; **not re-measured this run**. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| **Deep-audit program (NEW)** | `docs/audits/deep-audit-register.md` — ~22 findings resolved 08-09/08-10, ~17 open. 1 **P0** (D2b gate-key rotation, operator), 1 P1 (D8 wmc self-heal). New durable defect classes named (§2.3 / §3) |
| Data-intelligence correctness / honesty | **FMV confidence-accuracy program shipped (08-08)** — ask-ceiling + volume-gate + 90d catch-up; HIGH+MED shares ~2×. FMV dust-filter decision still **QUEUED, hand-off-only**. Several "failure renders as data" defects fixed (§2.3) |
| Test / quality infrastructure | **DB pins 115→122**; ratchet → **89.3/75.1/91.5/91.6**; component gate → **79.0/67.0/78.8/83.2**; `proxy.ts` now measured; 8 blocking CI jobs. **Never lower thresholds to green a build** (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** (2026-08-01) — verified still absent. Purely read-only (§2.9) |
| Chain expansion — BOTH boards PUBLIC | Candy `/insights/candy-mlb` (07-31); Panini `/insights/panini-squeeze` (08-01) — via single-boolean launch flags (verified `true`) (§2.8) |
| Cost / operational right-sizing | **DB 12,372 MB — UP ~520 MB.** **Disk-IO budget on the SMALL instance is the binding constraint** (correction: SMALL, not Micro) — fix expensive queries, don't upgrade the tier (§2.6) |
| Operational / overnight queue | **Deals board ~3h stale (NEW)**; disk-IO MV-refresh cluster; **panini price-capture dry 13d (operator)**; AllDay unmapped inflow; **NO-PUSH shell/disk 3 nights (operator)**; sync-nba-projections off-season (§2.6) |
| Tech debt / refactor | Monoliths (collection / sniper / analytics / dashboard) — not re-measured this run (shell down); as of 08-03: collection 1,330 / sniper 1,710 / analytics 1,675 / dashboard 2,197. Chain-rename shims deleted (§3) |
| Page polish | Deep-audit register swept many entity/board defects (Set Tracker, orderbook panel, series soft-404, tier bucketing); #17 tail continues (§3) |
| Stalled / scaffolded features | Cart / Trade Hub / Gifting DELETED. Breaks (dormant). **Blazers trivia file now REMOVED (#12)** (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; `badge_editions.low_ask` — AllDay + Golazos resolved, `highest_offer` residual gap |

---

## 2. Critical path — start here

Go-live is **done**; **`docs/strategy/roadmap-2026-08-03.md`** is the canonical forward plan (supersedes 07-18). Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. Headline metric: **share of prices at HIGH/MEDIUM confidence.** The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction was NOT re-measured this run** (queue-only overnight pass captured no user count). The **last confirmed reading (2026-07-26) is 20 users / 0 new signups / 0 WAU**, and no entry this week indicates movement — treat as presumed-flat pending a fresh capture.
- The reframe holds: the work is acquisition and retention, not instrumentation. The assets are built and idle: 30 `/insights` boards (both chain-two boards live), OG cards on every share surface, a working concierge, live alert loops.

Suggested next step: **re-capture the user/WAU count** (skipped this run), then pick **one** acquisition channel and run it against the 50+ gate. Still the single most important item in the whole report.

### 2.2 Public intelligence surfaces — 28 always-public + 2 newly-public = 30 — `Severity: n/a (shipped) · context`

All 30 built surface dirs in `app/insights/` are public; the two chain-two boards read their data directly and carry their mandatory honesty disclosures (Candy's LOW-confidence FMV; Panini's listing-gated "floor, not a census" banner + `meta.coverage`). IA reorg carried (Moments | Packs sub-toggle; Play hub). Market is edition-level, Sniper serial-level. **New risk this week:** the `deals` public board is serving ~3h-stale snapshots under saturation (§2.6) — the one surface where the new caching layer isn't keeping up.

### 2.3 Data-intelligence — an audit-and-accuracy week — `Severity: Medium (green; one P0 operator item, one queued decision) · Effort: mixed`

**FMV confidence-accuracy program landed (08-08):** ask-ceiling caps (base FMV never above the cheapest live ask), a volume-tier HIGH gate (HIGH requires ≥7 sales in the recent 30d window), and a 90-day catch-up sweep. Effect (per `metrics-latest.json`): HIGH+MEDIUM-confidence editions **TS 3,416 → 6,751**, **AllDay 394 → 1,550**; Golazos/UFC remain thin/dead-market by nature (2 / 0). ⚠ `rpc_trust_health_precompute_refresh` runs at ~569s of its 600s budget with only 3 EXCEPTION handlers across 7 legs — a load-bearing constraint noted for anyone adding an FMV arm (see register D34).

**Deep-audit findings resolved (08-09/08-10)** — highlights from `docs/audits/deep-audit-register.md` RESOLVED:

- **D9 — inverted-sign net-of-fees** on ~199 of 200 rows (`net +$0.25` where the buyer *lost* $0.25). Fixed; the old test had passed on an impossible fixture.
- **D33 — a fabricated bid-ask spread on the PUBLIC `/insights/candy-mlb` board** (mint-grain bid minus edition-grain ask over a different copy; 21% of rows read negative). Reworked to a genuine executable spread; the offers data itself was correct.
- **D11 / D12 / D10 — "a failed read served as data / HTTP 200"** class: `TOTAL EDITIONS 0`, `$0.00 / 0 sales`, and a real series page soft-404ing to Google were all timeouts rendering as measurements. Fixed at source (503 + `Retry-After`) and consumer.
- **D3 — Set Tracker dead on 3 collections** via a non-sargable `lower(wmc.wallet_address)` predicate (cost 124,243 → 2,551); D3b extended the fix to 6 more seq-scanning functions (RESOLVED 08-10, with a Candy base58 case-sensitivity guard).
- **D12/D13 — stale-table-read class named:** a live surface reading a retired table renders stale rows as current market data (Top Shot orderbook panel over one 86-day-old row; Pinnacle stats reading an ask feed under FMV labels).
- **D1 — unauthenticated service-role write IDOR** on `/api/support-chat/feedback`; **D5+D35 — 8 user-facing claims the product no longer honours** (incl. the legal page).

**Open / owed (see §3 and the register):**

- **D2b — P0 — rotate the 8 pack-pipeline cron gate keys.** The code is de-hardcoded to fail-closed edge secrets, but the LIVE keys are still the burned ones and remain reachable in git history. **Rotation is the only remedy — operator/Trevor-only** (runbook: `docs/handoff-2026-08-09e-edge-gate-key-rotation.md`, 9 pg_cron callers, ordering matters).
- **D8 — P1 — wmc metadata denorm has no self-heal** (enrichment failure only `console.warn`'d; `skipCached` blocks recovery). Backlog repaired but will regenerate.
- **FMV dust-filter decision (`docs/fmv-dust-filter-decision-2026-08-02.md`) — ANALYSIS ONLY, hand-off-only.** The `$0.50` sale floor inflates ~46% of TS / ~76% of AllDay editions (+45% mark-to-market). Recommendation: delete the floor. FMV logic is Trevor's call. (Note: the roadmap-08-03 dust-floor removal `3809425b` is a *related but separate* lever already partly landed; this decision doc concerns the remaining `DUST_PRICE_USD` sale floor.)

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; one P0 operator item) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon violations all empty. Register VERIFIED-CLEAN probes (RLS, public invariants, anon-write, secdef-drift, advisors, staged Candy/Panini data 37 objects / 0 anon-readable, no leaked credentials) all pass.
- **The one real security debt is D2b (P0):** the 8 gate keys in git history. It is tracked, has a runbook, and is operator-only.
- **DB-invariant SQL layer grew 115 → 122 pins** (121 `supabase/tests/*.sql` files incl. `_helpers.sql`; the drift-guard `PINS` array is authoritative). `db-pin-staleness.yml` enforces (weekly).
- **CI is 8 blocking jobs** (`.github/workflows/ci.yml`): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `db-tests`, `ledger-guard`, `edge-deno`.
- **Coverage ratchets raised:** vitest primary **89.3 / 75.1 / 91.5 / 91.6** (`proxy.ts` — the site-wide auth wall — is now inside `coverage.include`); component gate **79.0 / 67.0 / 78.8 / 83.2**.

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The autonomous passes are queue-only when the sandbox is down (this run). **Hygiene flags:** (1) `docs/overnight/focus.md` is still dated **2026-06-24** — **~47 days stale**, describing a June studio-platform program as current, which is actively misleading for a launched, read-only, both-boards-public repo; (2) **`docs/overnight/ledger.md` holds 1,181 entries** (was 900). **Closed since last week:** the Sentry connector — it is **reconnected and reporting** (0 new recurring/24h). The remaining standing operator blind spot is the **NO-PUSH shell/disk failure** (§2.6).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN-with-known-saturation-noise. The three trust breaches at capture are all pre-known and non-regressive. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **NO-PUSH shell/disk (ESCALATED)** | `/sessions` "no space left on device" prevents the workspace shell from starting → **no git → no overnight push, 3rd consecutive night.** | **Med–High (operator)** | Operator-only: delete old Cowork sessions to free `/sessions` (`docs/handoff-2026-08-09-cowork-shell-recovery.md`). |
| **DEALS public board ~3h stale (NEW)** | `cross_collection_deals_board` fails to warm nearly every `refresh-insights-cache` tick under saturation → deals `/insights` serves ~3h-old snapshots and drives `public_board_slow_count=5`. | Med | Fix = a materialized latest-FMV-per-edition precompute (CC-owned CODE; NO-PUSH-blocked). |
| **DISK-IO MV-refresh cluster** | Several MV refreshes time out / overshoot under saturation (`allday-pack-realized`, `allday-pack-sales-agg` jobid 210 up to 692s, `ccm-step2`, serial-fmv-jersey, thin-sale-ask-disclosure, misattrib-candidates). | Med | CC-owned; indexing + query narrowing. **Do NOT bump timeouts** or upgrade the tier — disk-IO-budget, not compute. |
| **PANINI price-capture dry 13d** | `panini_sale_price_capture_dry_days=13` (breach 3) — upstream residential-box capture outage since ~07-29. Board reads a floor + discloses coverage, so not fully dark, but FMV is stale. | Med (operator) | Operator/interactive A/B on the runner box. |
| **ALLDAY unmapped backlog** | `unmapped_resolution_backlog_max=194` (breach 100) — AllDay permanent floor; rose 162→194 on a historical-backfill inflow, live net-draining ~28d. | Low (carried) | Real fix is a resolver-reason exclusion (queued). |
| **sync-nba-projections 100% fail** | Off-season + all three upstreams Akamai/WAF-blocked (incl. the `rpc-sports-proxy` worker). Correct `all_upstreams_failed` classification; self-resolves ~Oct. | Low (operator) | Sole writer for `nba_games`; do NOT retire. Sanctioned reversible mute exists (auto-expiring). |
| **topshot-active-listings-ingest 68.8% egress-blocked** | Atlas-WAF; GHA `:13` backstop. The new `atlas-proxy` worker (17th) is shipped but INERT pending an operator `wrangler deploy` + egress probe. | Low | Do-not-suppress. |
| **DUNE lanes** | Both Dune bulk lanes remain inert (seller-recovery pending `DUNE_SALES_SELLER_QUERY_ID`). | Low–Med | Operator / billing. |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

Carried from last week. Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy's model leads with Typical-Pull median. The pricing engine, not the pack-shaped product, remains the opportunity. Register `D32` noted several "finds rows, writes none" pipelines around this area are mostly not-defects (read the `extra` payload) — but `match-topshot-players` may have a broken matcher (1,233 players in a review queue nobody reviews) worth a look.

### 2.8 Chain foundation — abstraction closed; BOTH expansions PUBLIC — `Severity: Low (shipped) · Effort: landed`

- **Chain-abstraction Phases A–F complete;** all 18 re-export shims deleted 07-25. New code imports canonical `@/lib/chains/flow/...` only.
- **Candy / Solana — PUBLIC since 2026-07-31.** `CANDY_MLB_PUBLIC = true` (verified). Rollback = flag flip.
- **Panini — PUBLIC since 2026-08-01.** `PANINI_PUBLIC = true` (verified). Listing-gated coverage disclosure travels with the surface (a launch requirement). Rollback = flag flip.
- **17th Cloudflare worker `atlas-proxy` landed** (Dapper Atlas marketplace pass-through so `topshot-active-listings-ingest` can reach Atlas from a non-WAF-blocked IP) — **INERT** pending operator deploy + egress probe.

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** (2026-08-01) — Glob confirms `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/`, and `app/api/{cart,trade-chain,trade-hub,gift}/` all absent this run. Inert Cadence templates kept as data; DB tables untouched. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues; "D…" = the deep-audit register. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve ~3.5 weeks; last-measured **20 users / 0 WAU** (not re-measured this run). The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** RPC now asks only for a public identifier (address / username) and reads view-only; the working self-serve path is the listing challenge (`resolve_wallet_challenge_match`, +500 credits). "Sign in with Dapper" was **removed by decision** (Dapper dev access RPC lacks). | Low–Medium | (mostly resolved-by-removal) |

### Deep-audit register — open findings (NEW this week)

| id | Issue | Severity | Owner |
|---|---|---|---|
| **D2b** | **Rotate the 8 pack-pipeline cron gate keys** — still the burned values, reachable in git history. Runbook exists; 9 pg_cron callers, ordering matters. | **P0** | **Trevor (secrets)** |
| D8 | wmc metadata denorm has **no self-heal** — enrichment failure only `console.warn`'d, `skipCached` blocks recovery. Backlog will regenerate. | P1 | Claude Code |
| D15 | `check_unmapped_backlog_growth()` blew the alert path under saturation. **Fix landed (precompute cache), trending resolved, not yet a full clean 24h** — re-probe. | P1 (landed, unconfirmed) | Claude Code |
| D37 | AllDay `unmapped_sales` backlog growing (94,852 unresolved) — resolver never reaches the tail. | P2 | Claude Code |
| D20 | 299 sets collapse into merged entity pages; the "variants merged" banner is keyed on the wrong field and fires on ~none of the real merges. Fix key = underlying set count (needs MV touch). | P2 | Claude Code |
| D13b | Pinnacle grain: `get_collection_stats`/`sniper_deals`/`top_sales`/`tier_breakdown` still read legacy `pinnacle_editions`; 5 "cheapest asks" are a 23-day-old feed (140/328 exactly $1). Repoint all consumers as one change. | P2 | Claude Code |
| D21 / D36 | AllDay `edition_offers` bids median ~12.8d stale; 217 editions with `highest_offer > low_ask` (50× TS rate) — collection-gated, staleness/benign-skew only. | P2 | Claude Code |
| D25 | 128 wmc rows render an impossible serial (0.006%) — 34 cosmetic stale-denorm + 94 upstream-wrong. Low value; `backfill_wmc_metadata_from_editions` won't fix (fill-only). | P2 | Claude Code |
| D31 | Migration-parity backlog: ~223 prod rows (14d window) with no committed file (3-day window clean). Blocks making `migration-parity.yml` enforcing. | P2 | Claude Code |
| D34 | Pinnacle has no FMV confidence-share arm (FMV in a different table); needs the precompute fn split per-leg first. | P2 | Claude Code |
| D16 / D17 / D18 / D32 | Cron-duration/"finds-rows-writes-none" families — **mostly measurement artifacts or already-fixed** (candy-offers, allday-lock-refresh, sales-history-backfills, onchain-art). Read the `extra` payload before acting; `match-topshot-players` matcher may be genuinely broken. | P2–P3 | Claude Code |
| D4b / D26 / D30 | Overview top-5 sniper deals don't gate like the Sniper tab (product call); 4 duplicate-slug players (cosmetic fossils); 3 production-dead components (pure cleanup). | P2–P3 | Trevor / Claude Code |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| FMV confidence-accuracy | Ask-ceiling + volume-gate + 90d catch-up **shipped 08-08**; HIGH+MED shares ~2×. | was Medium | (landed) |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions (+45% mark-to-market). **Decision doc queued — hand-off-only, Trevor's call.** | Medium | Small (decision) / medium (unwind) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary. Legacy `edition_key` is character-LOSSY — never repoint character reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **12,372 MB — UP ~520 MB** this week. | Low–Med | Small (monitor) |
| Disk-IO on SMALL instance | **The binding constraint** — causes `public_board_slow_count=5` (deals board), MV-refresh timeouts, statement-timeout alerts. Fix expensive queries / precompute; don't upgrade the tier. | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop; Fluid/cron/observability levers). | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | CLOSED — all 18 shims deleted 07-25. | n/a (resolved) | (landed) |
| Candy / Panini | Both PUBLIC (07-31 / 08-01). Rollback = flag flip. | n/a (shipped) | (landed) |
| `atlas-proxy` (17th worker) | Shipped but INERT — pending operator `wrangler deploy` + egress probe. | Low | Small (operator) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — **line counts NOT re-measured this run** (shell down; re-reading multi-thousand-line files is costly). As of 2026-08-03: collection **1,330** / sniper **1,710** / analytics **1,675**. `CLAUDE.md` #14's figures (~1,600 / ~1,705 / ~1,754) are close for sniper/analytics, stale-high for collection. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (much progressed) |
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` was **2,197** lines at 08-03 (not re-measured this run). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — RESOLVED (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. The deep audit swept a large batch this week (Set Tracker revived on 3 collections, orderbook panel retired, series soft-404 fixed, tier bucketing corrected, prototype-key crash guards). Remaining lower-value tier: modal a11y, Set B5/B7, the deferred `/ufc-strike/*`→`/ufc/*` 301. Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`) are point-in-time. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — token sweep complete; CI guard (`scripts/check-brand-tokens.mjs`). Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin). | Low | Small |
| 12 | Blazers trivia — **RESOLVED-BY-REMOVAL this week.** `lib/blazers-trivia.ts` is now **absent** (Glob returns no `**/blazers*` file; last report verified it present at 198 lines). `CLAUDE.md` #12 still cites it → now **stale**; recommend closing the slot. | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 / #3 / #3b | Cart / Trade Hub / Gifting — DELETED (2026-08-01), verified still absent. | n/a (removed) | n/a |
| — | Breaks — dormant (tables not in prod, migration unapplied). | Low (dormant) | n/a |

### Deferred hardening (intentional — from `CLAUDE.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy (`qual=true`/`with_check=true`). Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — **AllDay + Golazos RESOLVED** (live crons). `highest_offer` coverage remains the residual gap (Golazos has no offer source; a `golazos-offers-indexer` is staged but uncronned, gated on one on-chain recon).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Re-read `CLAUDE.md` before writing any new query. `docs/reference/schema-truth.md` (present) is authoritative for volatile schema facts.
- **Supabase compute is `SMALL` (2 GB / 2-core), not `Micro`** — correcting older reports. Saturation is disk-IO-budget-bound.
- **`evm_nft_transfers` holds ZERO rows** and its inert `evm-transfers-ingest` cron is disabled — the "1.01M Beezie transfers" claim in older docs is stale.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old 2026-05-24 two-item list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (verified present), now canonical (supersedes 07-18):

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM confidence share must beat the sites collectors already use before growth tactics return.** | Advancing — FMV confidence-accuracy program shipped 08-08 (TS/AllDay HIGH+MED ~2×); dust-floor removal partly landed; dust-filter *sale floor* decision still queued. |
| 1 | **Prove the product with real users — the only user gate is 50+ WAU.** | **Open — the critical path.** Instrumentation done; last-measured 0 WAU; not re-measured this run (§2.1). |
| 2 | Cost / latency levers. | Advancing — disk-IO is the binding constraint (deals-board-slow breach, MV-refresh timeouts); DB +520 MB. |
| 3 | Durable debt. | Advancing — read-only pivot (surface shrink); deep-audit drain; monoliths trimmed; `/dashboard` refactor remains. |
| 4 | Chain two, readiness-gated. | **DONE — both boards PUBLIC** (Candy 07-31, Panini 08-01). |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller.**

**Housekeeping still outstanding:** formally close the obsolete Flowty teardown priority in `CLAUDE.md` (API alive, feeds live ingest); close #12 (Blazers trivia file removed); refresh `docs/overnight/focus.md` (~47 days stale).

---

## 5. In-code TODO inventory

A first-hand `Grep` (ripgrep-backed) scan over `*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql}` (node_modules gitignored, so excluded) returned **29 raw matches across 15 files.** Excluding false positives, resolved-annotation lines, test references, launch-flag-gated defensive notes, and draft-only lines leaves **0 real actionable markers in live application code** — unchanged in character from last week. Breakdown:

### 5a. Candy launch-flag-gated "note" branches (2 markers) — keep by design

- `app/api/candy-sales-indexer/route.ts:160` and `app/api/ingest/candy-editions/route.ts:110` — `note: "…still a TODO_-prefixed placeholder"` strings inside launch-flag-gated defensive branches. Constants are filled; the branches are unreachable in practice. Not actionable.

### 5b. Panini draft/reference lines (4 markers) — draft-only

- `docs/drafts/panini/panini-proxy/index.js:19` (`TODO(discovery)`) and `docs/drafts/panini/ingest-panini-runner.mjs` (×3: `TODO(go-live)` / grid-enumeration references) — shelved draft scaffolding, not the live Panini surface.

### 5c. Resolved-annotation lines / guard functions (~10 markers)

- `lib/chains/solana/normalize.ts` (7 — `TODO_3/4/5 RESOLVED` narrative + the `startsWith("TODO_")` readiness-guard functions), `lib/rtr-lock-roi-weights.ts:7`, `app/api/rtr/lock-roi/route.ts:38`, `supabase/migrations/…wmc_team_name_denorm.sql:4` — all describe *resolved* TODOs or implement placeholder-guards, not open work.

### 5d. False positives / test refs (rest)

- **~2 false positives:** `lib/format.ts:6` (`"$X,XXX.XX"` format doc), migration-comment `XXX`-in-identifier (`phase-f-drop-chain-default`, `recover_golazos_video_url`).
- **~11 test refs:** `__tests__/api-candy-sales-indexer-deep.test.ts`, `api-ingest-candy-offers-deep.test.ts`, `api-wallet-backfill-candy.test.ts` (×2), `solana-normalize.test.ts` (×6) — assertions that the `TODO_`-prefix readiness guards behave.

> **Net change since last week:** none of consequence — the count moved 14→29 raw matches mostly because last week's scan mis-targeted the outputs cwd on its first pass; the substantive picture is identical: **live application code has zero actionable TODO markers** (the last real cluster went with the Trade-Hub deletion on 08-01).

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, `docs/audits/deep-audit-register.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, still resolved):** #2 (Sentry SDK wired — **and the connector is now reconnected**), #3 (Flowty event indexer — frontend shut, API alive), #4 (Pinnacle FMV — per-render engine primary), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key), #7 (AllDay `unmapped_sales` original defect), #8 (NBA projections — the current 100% fail is an off-season/egress condition, not the old defect), #13 (`flowty_archive` growth), #15 (scratch fixtures), #16 (`flow test` CI — expanded to 8 jobs), plus the fmv-recalc silent stall.

**Newly resolved / closed / shipped this week:**
- **Deep audit — ~22 findings resolved** (D1, D2, D3, D3b, D4, D5+D35, D6+D7, D9, D10, D11, D12, D13, D14, D19, D22, D23, D24, D27, D29, D33, D38, D-R1). See §2.3.
- **FMV confidence-accuracy program** — HIGH+MED shares roughly doubled on TS and AllDay.
- **PUBLIC-BOARD-CACHING (nc1)** — snapshot cache across the 5 hottest `/insights` boards (rookies/panini-squeeze/first-mint/candy-mlb warming ~3–4 min fresh; deals lags under saturation).
- **DB-invariant pins 115 → 122;** primary ratchet raised to 89.3/75.1/91.5/91.6 (now measures `proxy.ts`); component gate to 79.0/67.0/78.8/83.2.
- **17th Cloudflare worker `atlas-proxy`** landed (INERT).
- **Sentry connector reconnected** (last week's operator blind spot — closed).
- **#12 Blazers trivia** — file removed; slot resolved-by-removal.
- **Roadmap advanced to `docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate).

---

## 7. Suggested sequence

A pragmatic order under the **accuracy-is-the-gate** framing (`docs/strategy/roadmap-2026-08-03.md`):

1. **Clear the NO-PUSH shell/disk failure (§2.6) — operator.** Three nights of blocked autonomous shipping is the biggest *operational* regression; free `/sessions` (delete old Cowork sessions) so the night pass can commit/deploy again. Everything else the passes want to ship is gated on this.
2. **Rotate the 8 pack-pipeline cron gate keys (D2b, P0) — Trevor.** The only remaining real security debt; keys are in public git history and still live. Runbook exists.
3. **Drive traffic to the public site AND re-capture the WAU number (§2.1).** The only user gate is 50+ WAU; last confirmed 0, skipped this run. Pick one channel and run it. Still unambiguously the top product item.
4. **Un-stick the deals public board (§2.6).** It's the one surface where the new caching layer isn't keeping up (~3h stale); the fix is a materialized latest-FMV-per-edition precompute (CC-owned code, currently NO-PUSH-blocked).
5. **Put the FMV dust-filter *sale-floor* decision in front of Trevor (§2.3).** Highest-leverage correctness change still queued; hand-off-only.
6. **Cost / disk-IO posture (§2.6).** DB +520 MB; index/narrow the MV-refresh cluster; do NOT bump timeouts or upgrade the tier (disk-IO-budget, not compute).
7. **Doc hygiene:** refresh `docs/overnight/focus.md` (~47 days stale); in `CLAUDE.md`, close the obsolete Flowty priority and slot #12, and refresh #14's collection line count.
8. **Deep-audit tails as capacity allows** — D8 (wmc self-heal), D37 (AllDay unmapped tail), D20/D13b (Pinnacle grain + set-merge disclosure), D34 (precompute split → Pinnacle FMV arm).

---

## 8. Notes from verification

- **NO git / bash this run (3rd night).** Sandbox VM down (`/sessions` no-space `useradd` failure — retried, identical). No commit count, no diff-stat, no shell `wc -l`/`rg`. Everything is from the file tools + `metrics-latest.json` + `CLAUDE.md` + the deep-audit register.
- **TODO scan: 29 raw matches across 15 files → 0 real actionable markers in live app code** (§5). ⚠ Method note: the `Grep` tool defaults its `path` to the outputs cwd, not the repo — the first scan returned "no matches" until re-run with an explicit `C:\Users\TDill\rip-packs-city` path. Counts here are from the corrected scan.
- **Deletions verified by absence:** `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/trade-hub/`, `app/dashboard/gift/`, `app/api/cart/`, `app/api/trade-chain/`, `app/api/trade-hub/`, `app/api/gift/` — Glob returns No files found for all.
- **`lib/blazers-trivia.ts` verified ABSENT** — Glob for `**/blazers*` returns nothing (`blazers-trivia` string appears only in docs). Present at 198 lines in last week's report → removed since. #12 is resolved-by-removal.
- **Launch flags verified in `lib/launch-flags.ts`:** `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true` — both boards public.
- **DB-invariant SQL files:** Glob reports **121** `supabase/tests/*.sql` (incl. `_helpers.sql`); `CLAUDE.md`'s drift-guard `PINS` array is authoritative at **122 pins** (some pins share/omit a 1:1 file).
- **CI = 8 blocking jobs; coverage ratchets** (89.3/75.1/91.5/91.6 primary, 79.0/67.0/78.8/83.2 component) and **DB pins 122** are read from `CLAUDE.md`'s current entries; not independently re-derived from the config files this run.
- **Monolith line counts NOT re-measured this run** — reading four multi-thousand-line files under a dead shell is costly and low-value. Figures cited are from the 2026-08-03 report + `CLAUDE.md` #14, flagged as such.
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-08-03.md`, `docs/strategy/roadmap-2026-07-18.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `docs/audits/deep-audit-register.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/reference/schema-truth.md`, `lib/market-closed.ts`, `lib/safe-lookup.ts`, `lib/insights/board-cache.ts`. `docs/FREEZE.md` **absent** → no active freeze.
- **`docs/overnight/focus.md` is ~47 days stale** (dated 2026-06-24). `docs/overnight/ledger.md` has **1,181** `### ` entries (was 900).
- **DB-side facts** (FMV counts, editions, DB size **12,372 MB**, 3 pre-known trust breaches, security **0/0/0/0**, `detect_stalled_pipelines()` empty, deals-board snapshot age 178 min) come from **`docs/overnight/metrics-latest.json` (2026-08-10T08:05:00Z — same day)** plus `CLAUDE.md`'s 08-08/09/10 entries. They were **not** independently re-queried against production Supabase this run. **Traction (user/WAU) was NOT captured** — last confirmed 20 users / 0 WAU (2026-07-26). **Sentry IS live this run** (connector reconnected; 0 new recurring/24h).
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree and the register may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` + `docs/audits/deep-audit-register.md` are the authoritative records.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-08-10)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Mostly resolved-by-removal** — Dapper sign-in deleted; listing-challenge path is the self-serve route | `resolve_wallet_challenge_match` present |
| 1 | Cart execution | Shelved → DELETED | **Removed from the tree (08-01)** | `lib/cart/`, `app/api/cart/` absent |
| 2 | Sentry inactive | Resolved | **Resolved — SDK wired AND connector reconnected this run** | metrics: "Sentry live, 0 new recurring/24h" |
| 3 | Flowty indexer / Trade Hub | Resolved (Flowty) + DELETED (Trade Hub) | **#3 double-labelled** — Flowty resolved; Trade Hub deleted; contract + 16/16 suite kept in CI | `lib/trade-escrow/` absent; `cadence-escrow-tests` job |
| 3b | Gifting | Removed | **Removed from the frontend (08-01)** | `app/dashboard/gift/`, `app/api/gift/` absent |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary | `pinnacle_fmv_history` live |
| 5 | AllDay/UFC mis-categorized | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present |
| 7 | AllDay `unmapped_sales` | Resolved | **Resolved (original defect)** — current 194 backlog is expected self-draining residue + a backfill inflow | metrics + register D37 |
| 8 | NBA stats unreachable | Resolved | **Resolved (original defect)** — current 100% fail is off-season/egress, not the old bug | register D28 |
| 9 | Storefront audit pipeline | Retired | **Retired** | prior runs |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` ~2,197 lines (08-03; not re-measured) | prior report |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — token sweep complete; CI guard present | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Open | **RESOLVED-BY-REMOVAL** — `lib/blazers-trivia.ts` now absent | Glob `**/blazers*` → none |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` |
| 14 | Monolith page refactor | Open | **Open — trimmed** — collection 1,330 / sniper 1,710 / analytics 1,675 (08-03). #14's collection figure stale-high | prior report line counts |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — expanded**: 8 CI jobs incl. `edge-deno`, `db-tests`, `component-tests` | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set tune-up | Open (ongoing) | **Open — large deep-audit sweep this week** (Set Tracker, orderbook, series soft-404, tier bucketing); a11y + `/ufc-strike` 301 tail remain | register D3/D10/D12/D20/D23 |

**Tally:** 11 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #12, #13, #15, #16) · 3 removed from the tree by decision (#1 Cart, #3 Trade Hub, #3b Gifting) · 1 retired (#9) · 5 open or partial (#0, #10, #11, #14, #17). Plus the live, un-numbered **deep-audit register** (~22 resolved / ~17 open, incl. the P0 D2b), the **FMV confidence-accuracy program**, **Candy + Panini public boards**, **8-job CI**, **122 DB-invariant pins**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** three slots need a touch — **(a) #12 is now resolved-by-removal** (the file is gone; the slot should be closed); **(b) #3's numbering collision persists** and, with Trade Hub deleted, retiring the slot is cleaner than renumbering; **(c) #14's collection line count is stale-high** (~1,600 → 1,330 as of 08-03). Standing recommendations still hold: formally close the obsolete Flowty priority, and refresh the ~47-day-stale `focus.md`. Two things genuinely need a human this week: **(1)** the **NO-PUSH shell/disk failure** (3rd night, operator must free `/sessions`), and **(2)** the **P0 gate-key rotation** (D2b, Trevor). And the top-line framing is unchanged: with the site public and self-serve open ~3.5 weeks, the last confirmed reading is **20 users / 0 WAU** (un-remeasured this run) — **demand is the one number that decides everything**, and it has not visibly moved.
