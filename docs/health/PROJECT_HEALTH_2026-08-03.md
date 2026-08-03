# Rip Packs City — Project Health Report

**Date:** 2026-08-03
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Testing & CI §, Recent Sessions § — current through the 2026-08-02/03 entries), `docs/overnight/metrics-latest.json` (captured **2026-08-03T08:03:02Z**, same day), `docs/overnight/focus.md` (stale, dated 2026-06-24), `docs/overnight/ledger.md` (**900** `### ` entries), plus a first-hand `ripgrep` TODO scan and file-existence / line-count verification via the file tools.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-07-27.md` (7 days ago). This regeneration mirrors its structure. `_2026-07-20.md` … `_2026-05-22.md` (thirteen prior reports) also live in `docs/health/`.

> **⚠ Tooling note — NO git / bash this run.** The Cowork sandbox VM is **down** (`useradd`/disk failure, verified across ≥3 identical failures this session and confirmed by the overnight pass at 08:03Z), so there is **no `git log`, no `wc -l`, no `ripgrep`-in-shell**. Every figure here comes from the **file tools** (Read/Glob/Grep) against the mounted working tree plus `metrics-latest.json` and `CLAUDE.md`. Consequently: **commit counts and diff-stats are omitted** (unmeasurable this run — last prior report's real git log covered 07-20→07-27); line counts are exact (from the Read tool's line numbering); the TODO scan is a full `Grep` (ripgrep-backed) over the committed tree; DB-side facts are from `metrics-latest.json` (same-day) and are **not** independently re-queried.

> **Report location stays clean.** All fourteen reports (this one included) live in `docs/health/`; the repo root holds none. Written there per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-07-27 — a strategic simplification plus two public go-lives, on top of a launched product that still has near-zero audience.** Three stories dominate the week. **(1) A hard "READ-ONLY" product pivot (Trevor, 2026-08-01).** Cart, Trade Hub, and Gifting were **DELETED from the tree** — not merely shelved. `lib/cart/`, `lib/trade-escrow/`, `app/dashboard/{trade-hub,gift}/`, and the `app/api/{cart,trade-chain,trade-hub,gift}/` routes are gone (verified absent). The rationale is risk-reduction: live-fire Cadence-signing code against an undeployed contract, and an unauthenticated anon→service-role cart-log INSERT, were strictly worse than no code. This **also erased the report's last standing in-code TODO cluster** — the 6 Trade-Hub `fcl-submit.ts` stubs went with `lib/trade-escrow/`. **(2) BOTH chain-two public boards went LIVE.** `CANDY_MLB_PUBLIC` flipped `true` on 07-31 and `PANINI_PUBLIC` flipped `true` on 08-01 (verified in `lib/launch-flags.ts`) — `/insights/candy-mlb` and `/insights/panini-squeeze` are now **public and indexable**. Last week both were gated; the go-live editorial calls that headlined §2.8 are now **made**. **(3) The test/correctness machine kept compounding.** DB-invariant pins jumped **22 → 115** (116 `supabase/tests/*.sql` files incl. `_helpers.sql`; a 2026-08-02 wave alone added 25, pinning the whole insider-signal detector family + the sales serial-write guards); the vitest ratchet rose to **87.85/73.35/90.7/90.35** and the component gate to **74.6/61.75/73.5/78.65**; test files **880 → 1,053**; and **`edge-deno` was promoted to a BLOCKING CI job (16 `deno check` errors → 0)**, taking CI to **8 blocking jobs**. Two smaller shifts: an **honesty pass** (08-02) stopped three knowingly-wrong publications (a dead 62-day UFC price emitted to Google as a live `Offer`; pack-EV rows for unbuyable packs; misleading Pinnacle serial columns); and a **FMV dust-filter decision doc** landed as analysis-only (recommends deleting the `$0.50` sale floor that inflates ~46% of TS / ~76% of AllDay editions — **QUEUED, FMV logic is hand-off-only**).

> **Overnight reality — GREEN-with-known-noise, but constrained.** The 08-03 genuine-overnight pass (01:03 PDT, no skew) shipped **0** — for two independent reasons: the bash VM was down (no git, no collision-gate, no CI, no commit), and no safe autonomous candidate existed anyway. Post-ship watch over the 08-02 wave (incl. the dust-floor removal) was **ALL PASS, 0 reverts.** Health at capture: security **0/0/0/0**, `fmv_sanity_flags` **0**, sentinel TS-UUID 48h **0**, but **3 trust breaches — all pre-known**: `public_board_slow_count=3` (chronic IOPS, already queued, improved from 6), `sales_serial_supply_worst_pct=5.53` (marginal AllDay serial-supply gap), `unmapped_resolution_backlog_max=105` (self-draining, ~0.5d). Two operator-visibility gaps: **Sentry connector invalidated** (flagged 08-03 00:09Z, needs reconnect — Sentry was NOT checked this run) and the **bash/git VM down**.

> **Traction reality — still the headline concern, and NOT re-measured this run.** `metrics-latest.json` this run did **not** capture a user/WAU count (the run was queue-only, DB-read-limited). The last captured reading (2026-07-26) was **20 users / 0 new signups / 0 WAU**, and nothing in the week's entries suggests it moved. The site has been public since 07-17 and self-serve since 07-20; the machinery is built, instrumented, and idle. **Demand — not measurement, not features, not correctness — is the one number that decides everything, and it is unconfirmed-but-presumed-flat.**

> **Cost / storage — UP again.** DB is **11,852 MB, +743 MB** over last week's 11,109. **IOPS on the Micro instance remains the binding operational constraint** — it is the direct cause of the `public_board_slow_count` breach and the statement-timeout pipeline alerts, and it is the item most likely to degrade the public boards that just went live. `edition_integrity_flags` also rose **5 → 97** (a data-quality watch item — likely surfaced by the honesty/inventory passes; not a security or availability issue).

> **Platform context (mostly unchanged).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest — teardown premise still obsolete. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** Flow market frozen (0 sales in 30d; now honestly labelled "Flow market closed" after the 08-02 honesty pass). **(4) Candy / Solana** — **PUBLIC as of 07-31.** **(5) Panini** — **PUBLIC as of 08-01** (listing-gated coverage disclosed structurally). **(6) Expansions are readiness-gated, not sequence-gated.**

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **900** entries, `inbox/`, `metrics-latest.json`, `focus.md` — **~40 days stale**, `.lock`). `docs/FREEZE.md` halts all autonomous shipping. **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Numbering unchanged in `CLAUDE.md`. `#3` still double-labelled (Flowty indexer resolved + Trade Hub) — and Trade Hub is now **deleted**, not just shelved. See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — §3 / §9 |
| Known issues — **removed from the tree by decision** | 3 | **#1 Cart, #3 Trade Hub, #3b Gifting — DELETED** (read-only pivot, 2026-08-01). Were "shelved" last week. |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Commits this week | **not measured** | Bash/git VM down this run — no `git log`. (Prior report's real log covered 07-20→07-27: 295 commits.) |
| Net-new shipped / landed this week (not numbered) | **8+** | **Candy public go-live** (07-31); **Panini public go-live** (08-01); **Cart/Trade-Hub/Gifting deletion** (read-only pivot); **`edge-deno` → blocking CI** (16→0 errors); **DB-invariant pins 22→115**; **honesty pass** (3 knowingly-wrong publications stopped); inventory recovery + an armed-data-destruction bug disarmed (`scan-pinnacle-wallet`); a UFC canonical-slug link-class sweep — §2 / §6 |
| Open overnight operational items | **~6 active + standing queue** | Carried: PUBLIC-BOARD-SLOW / IOPS (chronic, queued); AllDay-unmapped residue (self-draining); PINNACLE-SYNC-CRON silent ~46h (operator re-enable); GHA-ACTIVE-LISTINGS-INGEST dropout; several statement-timeout alerts; Sentry connector reconnect — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana (**PUBLIC**) + Panini (**PUBLIC**); multi-chain abstraction Phases A–F complete, all 18 shims deleted 07-25 (§2.8) |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-07-18.md` is canonical (post-launch). Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 real actionable in live app code** (+2 launch-flag-gated candy "note" branches kept by design, +~5 panini draft/reference lines, +3 false positives, +~4 resolved-annotation lines, +2 test refs) | The 6 Trade-Hub `fcl-submit.ts` stubs are **GONE** with the deletion — §5 / §8 |
| Test files / DB-invariant pins | **1,053** / **115 invariants** (116 SQL files incl. `_helpers.sql`) | Was 880 / 22. Ratchet 87.3→**87.85** stmts / line coverage **90.7**. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** A strategic-clarity week. The dominant move is **subtractive** — deleting Cart, Trade Hub, and Gifting to make the product **purely read-only**, which shrinks the attack surface, kills the last real TODO cluster, and matches the honest reality that RPC is an *intelligence* product, not a marketplace. Alongside that, **both chain-two boards went public** (Candy 07-31, Panini 08-01), so the two editorial go-live calls that led last week's report are now made and shipped. The correctness/test flywheel kept turning hard: **DB-invariant pins more than 5×'d (22→115)**, a **new blocking `edge-deno` CI job** finally type-checks the Deno edge layer, and an **honesty pass** stopped the site publishing three numbers it knew were wrong (a dead UFC price to Google, unbuyable-pack EV, misleading Pinnacle serials). Operationally the board is GREEN-with-known-noise: three trust breaches, **all pre-known and non-regressive** (chronic IOPS, a marginal serial-supply gap, a self-draining backlog). The two things that genuinely need a human: **(1) the Sentry connector is invalidated** — reconnect so error visibility returns; **(2) the pinnacle-sync cron has been silent ~46h** — an operator cron-job.org re-enable. Descending, concentrated risk is otherwise unchanged: **(1) demand** (the only gate — 50+ WAU — and last-measured 0, un-remeasured this run); **(2) IOPS on the Micro instance** (DB +743 MB, now the direct cause of the slow-board breach on freshly-public surfaces); **(3)** the FMV dust-filter decision (queued, hand-off-only, would materially change published prices); **(4)** the `edition_integrity_flags` 5→97 data-quality rise, worth a look. Chain foundation is done and both expansions are live.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public since 07-17; self-serve since 07-20. Funnel wired. Last-measured **20 users / 0 WAU**; **not re-measured this run**. The problem is *demand*. Gate: **50+ WAU** (§2.1) |
| Product simplification — READ-ONLY pivot (NEW) | **Cart, Trade Hub, Gifting DELETED from the tree** (2026-08-01, Trevor). Purely read-only, low-friction, low-risk. Cadence templates kept as inert data; DB tables untouched (§2.9) |
| Chain expansion — BOTH boards PUBLIC (NEW) | **Candy `/insights/candy-mlb` LIVE 07-31**; **Panini `/insights/panini-squeeze` LIVE 08-01** — via single-boolean launch flags. Panini's listing-gated coverage disclosed structurally (§2.8) |
| Data-intelligence correctness / honesty | **Honesty pass (08-02):** killed a dead-UFC-price `Offer` to Google, labelled unbuyable-pack EV, fixed Pinnacle serial columns. **Armed data-destruction bug disarmed** (`scan-pinnacle-wallet`). **FMV dust-filter** decision doc — QUEUED, hand-off-only (§2.3) |
| Test / quality infrastructure | **DB pins 22→115**; ratchet 87.3→**87.85** / line **90.7**; component gate raised; **`edge-deno` → BLOCKING (8 CI jobs)**; 1,053 test files. **Never lower thresholds to green a build** (§2.4) |
| Cost / operational right-sizing | **DB 11,852 MB — UP ~743 MB.** **IOPS is the binding constraint** and directly causes the `public_board_slow_count=3` breach on the now-public boards (§2.6) |
| Operational / overnight queue | IOPS-reindex (queued); AllDay-unmapped residue (self-draining); **pinnacle-sync silent ~46h (operator)**; **Sentry connector reconnect (operator)**; GHA active-listings dropout; statement-timeout alerts (§2.6) |
| Tech debt / refactor | Monoliths: collection **1,330** (−288) / sniper **1,710** (flat) / analytics **1,675** / dashboard **2,197** (−169). All 18 chain-rename shims deleted 07-25; reorg tail closed (§3) |
| Page polish | UFC canonical-slug link class swept; pack-reality un-broken; holders-table cap fix; entity-page hardening (#17) |
| Stalled / scaffolded features | **Cart / Trade Hub / Gifting now DELETED** (were shelved). Breaks (dormant). Top Shot in-app bulk-buy (Dapper wall) — moot under read-only (§2.9) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; `badge_editions.low_ask` — AllDay + Golazos resolved, `highest_offer` residual gap |

---

## 2. Critical path — start here

Go-live is **done**; `docs/strategy/roadmap-2026-07-18.md` is the canonical forward plan. Phase 1 = prove the product with real users (**the only gate is 50+ WAU**); Phase 2 = cost/latency levers; Phase 3 = durable debt; Phase 4 = chain two, readiness-gated (now **shipped** — both boards public).

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17; self-serve magic-link signup opened 07-20. Read-only tabs are anonymous for the 5 published Flow collections; cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction was NOT re-measured this run** (the queue-only overnight pass did not capture a user count). The **last confirmed reading (2026-07-26) is 20 users / 0 new signups / 0 WAU**, and no entry this week indicates movement — treat it as presumed-flat pending a fresh capture.
- **The reframe holds:** the work is acquisition and retention, not instrumentation. The assets are built and idle: **30** `/insights` boards (28 always-public + the 2 chain-two boards now live), OG cards on every share surface, a working concierge, live alert loops.

Suggested next step: **re-capture the user/WAU count** (it was skipped this run), then pick **one** acquisition channel and run it against the 50+ gate. This remains the single most important item in the whole report and is worth promoting to the explicit top-line item in `CLAUDE.md`.

### 2.2 Public intelligence surfaces — 28 always-public + 2 newly-public = 30 — `Severity: n/a (shipped) · context`

- **`/insights` hub:** `INSIGHT_ROUTES` in `lib/sitemap-data.ts` carries the always-public slugs; `candy-mlb` (07-31) and `panini-squeeze` (08-01) are now appended by their launch flags, so **all 30 built surface dirs in `app/insights/` are public.** The two chain-two boards read their data directly and carry their mandatory honesty disclosures (Candy's LOW-confidence FMV; Panini's listing-gated "floor, not a census" banner + `meta.coverage`).
- **IA reorg (carried):** `packs` / `pack-sniper` / `hot-floors` / `challenges` stay registered pages but folded off the top bar; pack surfaces reached via an in-page **Moments \| Packs sub-toggle**. Top Shot **Play hub** fronts Challenges / Fast Break / Road to the Ring.
- **Market vs Sniper split:** Market is **edition-level**, Sniper is **serial-level**. Market defaults to Price ascending.

No open defects tracked here; listed because it is a large body of shipped product sitting in front of anonymous visitors — and IOPS pressure (§2.6) is the thing most likely to degrade it.

### 2.3 Data-intelligence — an honesty week (correctness by subtraction) — `Severity: Medium (green; one queued decision) · Effort: mixed`

**Honesty / correctness landed (08-02):**

- **Three knowingly-wrong publications stopped (`bb09ea6a`).** (1) **UFC was emitting a dead 62-day-old price to Google as a transactable `Offer`** — a stale MEDIUM snapshot passed the `confidence !== 'STALE'` guard; a new static `lib/market-closed.ts` (keyed by canonical slug + the `ufc-strike` alias) emits **no** Offer for closed markets and labels titles "Flow market closed." (2) **Pack EV** now labels the ~4,488/4,596 rows for packs nobody can buy and discloses AllDay/Golazos EV as an original-supply model. (3) **Pinnacle serials** — `is_serialized` is unusable; the helper now returns true/false/**null='cannot say'** off `edition_type`.
- **An armed data-destruction bug caught + disarmed (`c61a9d8e`).** `scan-pinnacle-wallet`'s upsert payload carried `serial_number: null` for unmapped ids; a PostgREST upsert overwrites every payload column, so a same-day repair would have converted a latent bug into a live one. Verified 0 damage; deployed v26 omitting serial/series from the payload. **Durable lesson: repairing a silently-failing function can arm a latent bug — audit the whole write payload before re-enabling.**
- **Inventory recovery (`c61a9d8e`).** Golazos: 4,796 empty wallet shells recovered via `sales`; Candy: 18,932 un-enriched rows → 0 on a publicly-live board; the enrichment-aware fix closed a class where pre-existing empty shells were skipped forever.

**Queued (hand-off-only — do NOT auto-ship):**

- **FMV dust-filter decision doc (`docs/fmv-dust-filter-decision-2026-08-02.md`) — ANALYSIS ONLY.** The `DUST_PRICE_USD = 0.5` sale floor discards **46.0% of Top Shot** and **76.3% of All Day** 30d sales, inflating published FMV (mark-to-market, affected editions transacted **$24,464** that RPC values at **$35,503, +45%**). Recommendation: **delete the floor.** FMV pricing logic is **Trevor's call** — the doc is queued, nothing shipped.
- **FMV coverage (from `metrics-latest.json`, 2026-08-03T08:03Z):** TS HIGH+MED **3,416**; AllDay **394**; UFC **15**; Golazos **4**; Pinnacle render-keyed (`fmv_stale_hours` 9.4, ok). `fmv_sanity_flags` **0**; `edition_integrity_flags` **97** (up from 5 — a data-quality watch item worth a look); `sentinel_ts_uuid_editions_48h` **0**.

Suggested next step: put the FMV dust-filter decision in front of Trevor (it is the highest-leverage correctness change on the table); glance at the `edition_integrity_flags` 5→97 rise to confirm it's honesty/inventory-pass fallout, not a new defect.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (green; one benign flag) · Effort: landed`

- **Security posture GREEN.** `metrics-latest.json`: **0/0/0/0** — invariants, anon-write holes, rls-off base tables, secdef-anon violations all empty. Every new Candy/Panini table/view this week was explicitly anon/authenticated SELECT-revoked and verified with `has_table_privilege`.
- **One benign flag still to clear (owner action).** The ~11 Candy `security_invoker=true` views trip `check_public_security_invariants()` `view_unexpected_definer` (the invariant matches only `=on`). **No leak** — all anon/authenticated-revoked; clears once allowlisted. Tracked, not urgent.
- **DB-invariant SQL layer grew 22 → 115 pins** (116 `supabase/tests/*.sql` files incl. `_helpers.sql`). The 08-02 wave (+25) pinned the **full insider-signal detector family** (`detect_floor_drops`, `detect_concentration_buys`, `detect_unusual_edition_volume`, `detect_new_edition_early_buyers`, `detect_topshot_sweeps` — the fabricated-market-signal class) and the **two sales serial-number write guards** (`update_sale_serial`, `update_topshot_sale_serial`). The whole layer was audited **0 STALE / 0 NOT_IN_LIVE** against live prod. **`db-pin-staleness.yml` now ENFORCES** (the last missing repo secret was added 08-01).
- **CI is now 8 blocking jobs** (verified in `.github/workflows/ci.yml`): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `db-tests`, `ledger-guard`, **`edge-deno` (NEW — promoted to blocking 08-01, 16 `deno check` errors → 0 via a fixed `--config` invocation; it is the only thing type-checking the Deno edge source).**
- **Coverage ratchets:** vitest `87.85 / 73.35 / 90.7 / 90.35` (`vitest.config.ts`); component gate `74.6 / 61.75 / 73.5 / 78.65` (`vitest.components.config.ts`), climbed by the 07-28→08-03 component-coverage program. **1,053** test files under `__tests__/`.

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The autonomous passes are shipping when the sandbox is up; this run's pass was queue-only (VM down). **Two hygiene flags carry:** (1) `docs/overnight/focus.md` is still dated **2026-06-24** — now **~40 days stale**, still describing a June studio-platform deep-history program as the current priority, which is actively misleading for a launched, post-Candy/Panini, read-only repo; (2) the **Sentry connector is invalidated** (flagged 08-03 00:09Z) — reconnect via claude.ai connector settings so error visibility returns. `docs/overnight/ledger.md` holds **900** entries (was 563).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

Health is GREEN-with-known-noise. The three trust breaches at capture are all pre-known and non-regressive. Open items:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **PUBLIC-BOARD-SLOW / IOPS-REINDEX** | `public_board_slow_count=3` (chronic IOPS-saturation, fail-soft). Improved from 6. Now directly affects freshly-public boards. | **Med (queued)** | Queued "night 2" reindex; the binding constraint is Micro-instance IOPS. |
| **PINNACLE-SYNC-CRON silent ~46h** | `pinnacle-sync` stalled (last run 2026-08-01 10:07Z); likely the cron-job.org "RPC Pinnacle Sync" entry still disabled. **Pinnacle FMV still fresh via other pipelines — not user-facing.** | Med | **Operator:** verify/re-enable the cron-job.org entry. |
| **SENTRY CONNECTOR INVALIDATED** | Error visibility gap — Sentry not checked this run. | Med | **Operator:** reconnect via claude.ai connector settings. |
| **ALLDAY-UNMAPPED residue** | `unmapped_resolution_backlog_max=105` (breach_at 100) — known self-draining class, ~0.5d to clear; `sales_serial_supply_worst_pct=5.53` marginal serial-supply gap. | Low (carried) | Self-heal cron (pg_cron jobid 215) drains it; off-limits by policy. |
| **GHA-ACTIVE-LISTINGS-INGEST-DROPOUT** | `topshot-active-listings-ingest` 9/25 egress-blocked ticks. | Low | External/self-healing dropout family. |
| **Statement-timeout alerts** | `allday-lock-refresh` 15/52, `wallet-username-resolver` 33/108, `allday-unmapped-resolver-tail` 7/19 — all IOPS-saturation-class. | Low–Med | Symptom of the IOPS constraint above. |
| **DUNE lanes** | Both Dune bulk lanes remain inert (seller-recovery pending `DUNE_SALES_SELLER_QUERY_ID`; datapoint-cap history). | Low–Med | Operator / billing. |

### 2.7 Pack EV / pack-viz — `Severity: Low (honest by construction) · Effort: landed`

The P0 fabricated-EV bug was killed last week at the read layer. This week the pack story is **honesty**: the pack-EV surfaces now **label rows for packs nobody can buy** (`On sale` / `Secondary only` / `Retired`, failing closed) and disclose that AllDay/Golazos EV is an original-supply model. `edition_count` was overstating the pullable pool up to 27× and is fixed to `weight > 0`. Candy's `candy_pack_ev_model` leads with **Typical Pull median (~$26)**, not the noisier Actual EV (~$86). The pricing engine, not the pack-shaped product, remains the opportunity.

### 2.8 Chain foundation — abstraction closed; BOTH expansions now PUBLIC — `Severity: Low (shipped) · Effort: landed`

- **Chain-abstraction Phases A–F complete; reorg tail closed** (all 18 re-export shims deleted 07-25). New code imports canonical `@/lib/chains/flow/...` only.
- **Candy / Solana — PUBLIC as of 2026-07-31.** `CANDY_MLB_PUBLIC = true` (verified). `/insights/candy-mlb` is public + indexable; the single boolean atomically un-gated the proxy wall, sitemap slug, `/insights` hub card, footer link, and dropped `noindex`. CI + Smoke green; 8 board views populated; 0 new Sentry. **Rollback:** set the flag `false` + push (~3 min, no DB unwind). `collections.is_active` for `candy_mlb` stays `false` (the board reads Candy directly). **Binding honesty constraint holds: `candy_listings`/`candy_best_offers` are ask/bid floors, NEVER FMV.**
- **Panini — PUBLIC as of 2026-08-01.** `PANINI_PUBLIC = true` (verified). `/insights/panini-squeeze` is public + indexable; the listing-gated coverage disclosure (`meta.coverage` + the "floor, not a census" banner, now also carrying oldest/newest family refresh ages) is a **launch requirement that travels with the surface — do not remove it.** The runner refreshes from a residential box every 4h; coverage is **listing-gated** (measured 08-02: **38.8%** of 4,149 editions — the figure drifts as the denominator grows, and the surface reads it LIVE so only prose ever goes stale). **Rollback:** set the flag `false` + push.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** Public + self-serve a full ~2.5 weeks; last-measured **20 users / 0 WAU** (not re-measured this run). The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** "Sign in with Dapper" still gated on Dapper developer access. Working path = the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim fallback. | Medium | Medium (core shipped; Dapper path blocked externally) |

### Product simplification — READ-ONLY pivot (this week)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 1 | **Cart — DELETED from the tree (2026-08-01).** `lib/cart/`, `components/cart/`, `app/api/cart/{validate,record}` removed. Had **zero mounts** in prod; `record` was an unauthenticated anon→service-role INSERT. Inert Cadence templates kept as data; `cart_purchase_log` table untouched. | n/a (removed) | (landed) |
| 3 | **Trade Hub — DELETED from the tree (2026-08-01).** `lib/trade-escrow/`, `app/dashboard/trade-hub/`, `app/api/{trade-chain,trade-hub}/*`, and 15 tests removed — including the live-fire `fcl.mutate` submitters against an **undeployed** contract. The Cadence contract + its 16/16 `flow test` suite are **kept** (still CI-gated). This erased the report's last real TODO cluster. | n/a (removed) | (landed) |
| 3b | **Gifting — REMOVED from the frontend (2026-08-01).** `app/dashboard/gift/`, `app/api/gift/*`, `lib/chains/flow/gift.ts` removed (the one live write surface of the three). Inert `gift-moment.ts` template + `moment_gifts` table kept. | n/a (removed) | (landed) |

### Data-intelligence correctness / honesty

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Honesty pass | Dead UFC `Offer` to Google, unbuyable-pack EV, misleading Pinnacle serials — **all fixed** (08-02). | was Medium | (landed) |
| Armed data-destruction | `scan-pinnacle-wallet` upsert payload disarmed (v26). Verified 0 damage. | was High (latent) | (landed) |
| FMV dust-filter | `$0.50` sale floor inflates ~46% TS / ~76% AllDay editions (+45% mark-to-market). **Decision doc queued — hand-off-only, Trevor's call.** | Medium | Small (decision) / medium (unwind) |
| `edition_integrity_flags` 5→97 | Data-quality flag count rose sharply — likely honesty/inventory-pass fallout; confirm it's not a new defect. | Low–Med | Small (verify) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary. Legacy `edition_key` is character-LOSSY — never repoint character reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **11,852 MB — UP ~743 MB** this week (back-to-back increases). | Low–Med | Small (monitor) |
| IOPS on Micro | **The binding constraint** — directly causes `public_board_slow_count=3` on the now-public boards + the statement-timeout alerts. | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop, Fluid/cron/observability levers). | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | **CLOSED** — all 18 shims deleted 07-25. | n/a (resolved) | (landed) |
| Candy chain-two | **PUBLIC 07-31.** Rollback = flag flip. Benign `view_unexpected_definer` flag to allowlist. | n/a (shipped) | Small (owner allowlist) |
| Panini | **PUBLIC 08-01.** Coverage listing-gated (~38.8%, drifts); disclosure structural + a launch requirement. | n/a (shipped) | (landed) |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **1,330** (−288, further extraction) · `sniper/page.tsx` **1,710** · `analytics/page.tsx` **1,675** · `dashboard/page.tsx` **2,197**. **`CLAUDE.md` #14's figures (~1,600 / ~1,705 / ~1,754) are close for sniper/analytics but now STALE-high for collection** — recommend refreshing to 1,330. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (much progressed) |
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,197 lines** (−169). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. This week: a **UFC canonical-slug-vs-alias link class swept** across board clients + dashboard formatter; `/insights/pack-reality` un-broken (MV'd the slow leg); the candy-mlb Holders tab cap fix (was showing 250 of 407). Remaining lower-value tier: modal accessibility, Set B5/B7. Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, present) are point-in-time. **Still open (deliberately not bundled):** a 301 `/ufc-strike/*`→`/ufc/*` redirect for full canonical dedup. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — token sweep complete; CI guard (`scripts/check-brand-tokens.mjs`, present). Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin). | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no importer. | Low | Small |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 / #3 / #3b | Cart / Trade Hub / Gifting — **DELETED this week** (see the READ-ONLY pivot rows above). No longer "stalled scaffolding" — removed. | n/a (removed) | n/a |
| — | Breaks — dormant (tables not in prod, migration unapplied). | Low (dormant) | n/a |

### Deferred hardening (intentional — from `CLAUDE.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy (`qual=true`/`with_check=true`). Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter.
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — **AllDay + Golazos RESOLVED** (live crons). `highest_offer` coverage remains the residual gap (Golazos has no offer source; a `golazos-offers-indexer` is staged but uncronned, gated on one on-chain recon).

### Architecture note worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form collection strings; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Both documented in `CLAUDE.md`; re-read before writing any new query. `docs/reference/schema-truth.md` (present) is authoritative for volatile schema facts.
- **`evm_nft_transfers` now holds ZERO rows** (verified 08-02) and its inert `evm-transfers-ingest` cron was disabled as pure waste — the "1.01M Beezie transfers" claim in older docs is stale.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old 2026-05-24 two-item list is replaced by `docs/strategy/roadmap-2026-07-18.md` (verified present), which is canonical:

| Phase | Action | Status |
|---|---|---|
| 1 | **Prove the product with real users — the only gate that matters is 50+ WAU.** | **Open — the critical path.** Instrumentation done; last-measured 0 WAU; not re-measured this run (§2.1). |
| 2 | Cost / latency levers. | Advancing — IOPS is the binding constraint (public-board-slow breach, statement-timeout alerts); DB +743 MB. |
| 3 | Durable debt. | Advancing — **Cart/Trade-Hub/Gifting deleted** (surface shrink); monoliths trimmed; `/dashboard` refactor + profile consolidation remain. |
| 4 | Chain two, **readiness-gated**. | **DONE — both boards PUBLIC** (Candy 07-31, Panini 08-01) (§2.8). |

**Standing guardrails from the roadmap:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller.**

**Housekeeping still outstanding:** the old Priority #1 (Flowty teardown) is **obsolete** — the API is alive and feeds live ingest; formally close it in `CLAUDE.md`.

---

## 5. In-code TODO inventory

A first-hand `Grep` (ripgrep-backed) scan over `*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql}` (node_modules gitignored, so excluded) returned **14 raw matches across the committed tree.** Excluding false positives, resolved-annotation lines, test references, launch-flag-gated defensive notes, and draft-only lines leaves **0 real actionable markers in live application code** — the Trade-Hub cluster is gone with the deletion. Breakdown:

### 5a. Trade Hub / escrow — **RESOLVED (−6 this week, cluster eliminated)**

`lib/trade-escrow/fcl-submit.ts` (the 6 stub markers that were the report's *sole* remaining real cluster last week) is **DELETED** with the whole `lib/trade-escrow/` directory in the 08-01 read-only pivot. Verified absent. This was the last actionable in-code TODO cluster; the codebase now has none in live app code.

### 5b. Candy launch-flag-gated "note" branches (2 markers) — **keep by design**

- `app/api/candy-sales-indexer/route.ts:160` and `app/api/ingest/candy-editions/route.ts:95` — `note: "…is a TODO placeholder"` strings inside launch-flag-gated defensive branches. `CLAUDE.md`'s standing finding classifies these as **keep** (constants are filled; the branches are unreachable in practice). Not actionable.

### 5c. Panini draft/reference lines (~5 markers) — draft-only

- `docs/drafts/panini/*` (×5 across `ingest-panini-runner.mjs`, `panini-ingest-route.ts`, `panini-proxy/index.js`) — `TODO(go-live)` / `TODO(discovery)` in **shelved draft scaffolding**, not the live surface. The live Panini runner + board carry no actionable markers.

### 5d. False positives / resolved annotations / test refs (rest)

- **3 false positives:** `lib/format.ts:6` (`"$X,XXX.XX"` format doc), plus migration-comment `XXX`-in-identifier patterns.
- **~4 resolved-annotation lines:** `lib/chains/solana/normalize.ts:46`, `lib/rtr-lock-roi-weights.ts:7`, `app/api/rtr/lock-roi/route.ts:38`, `supabase/migrations/…wmc_team_name_denorm.sql:4` — all describe *resolved* TODOs, not open work.
- **2 descriptive test refs:** `__tests__/api-candy-sales-indexer-deep.test.ts:126`, `api-ingest-candy-offers-deep.test.ts:104` — assertions that the `TODO_`-prefix guards behave.

> **Net change since last week:** the 6 Trade-Hub `fcl-submit.ts` stubs (the entire "sole real cluster") are gone with the deletion. **Live application code now has zero actionable TODO markers** — the standing `CLAUDE.md` finding ("no safe live TODO exists") is now literally true in the tree.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry SDK wired — though the *connector* is invalidated this run, a separate operator item), #3 (Flowty event indexer — frontend shut, API alive), #4 (Pinnacle FMV — per-render engine primary), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — present), #7 (AllDay `unmapped_sales` — resolver rewritten; current residue is expected succeeding-backfill), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed / shipped this week:**
- **Candy `/insights/candy-mlb` — PUBLIC** (07-31, flag flip; CI + Smoke green).
- **Panini `/insights/panini-squeeze` — PUBLIC** (08-01, flag flip; coverage disclosure travels with it).
- **Cart / Trade Hub / Gifting — DELETED from the tree** (read-only pivot; the last real TODO cluster went with Trade Hub).
- **`edge-deno` CI job — PROMOTED TO BLOCKING** (16 `deno check` errors → 0; the Deno edge source is now type-checked).
- **DB-invariant pins 22 → 115** (insider-signal detector family + sales serial-write guards + many more; audited 0 STALE vs live).
- **`db-pin-staleness.yml` — now ENFORCES** (last missing repo secret added 08-01).
- **Honesty pass** — dead UFC `Offer`, unbuyable-pack EV, misleading Pinnacle serials all stopped.
- **Armed data-destruction bug** (`scan-pinnacle-wallet`) — disarmed (v26).
- **Inventory recovery** — Golazos 4,796 shells + Candy 18,932 rows enriched; skip-forever class closed.
- **UFC canonical-slug link class** — swept across board clients + dashboard formatter.
- **`/insights/pack-reality`** — un-broken (materialized the slow leg).

---

## 7. Suggested sequence

A pragmatic order under the **post-launch** framing (`docs/strategy/roadmap-2026-07-18.md`):

1. **Drive traffic to the now-public site (§2.1) — AND re-capture the WAU number** (it was skipped this run). The only gate is 50+ WAU; last confirmed 0. The assets (30 public insights boards incl. both new chain-two boards, OG cards, concierge, alert loops) exist and are idle. Pick one channel and run it. Unambiguously #1.
2. **Clear the two operator visibility items (§2.6).** Reconnect the **Sentry connector** (error visibility is dark right now); re-enable the **pinnacle-sync cron-job.org entry** (silent ~46h). Neither is user-facing yet, both are blind spots.
3. **Put the FMV dust-filter decision in front of Trevor (§2.3).** It's the highest-leverage correctness change queued — deleting the `$0.50` floor de-inflates ~46% of TS / ~76% of AllDay editions (+45% mark-to-market). Hand-off-only; nothing ships without the call.
4. **Cost / IOPS posture (§2.6).** DB rose another ~743 MB and IOPS is now the direct cause of the slow-board breach on freshly-public surfaces — keep the read-diet, run the queued reindex, do the Vercel Spend-Management cap backstop.
5. **Glance at `edition_integrity_flags` 5→97 (§2.3)** to confirm it's honesty/inventory-pass fallout, not a new defect.
6. **Refresh the autonomous-pass steering (§2.5).** `docs/overnight/focus.md` is ~40 days stale and describes a June program as current — actively misleading for a read-only, both-boards-public repo.
7. **Chain-foundation + debt tails as capacity allows.** Both expansions are live; next is `/dashboard` (#10, 2,197 lines) and the page/brand tail (#17 incl. the deferred `/ufc-strike/*`→`/ufc/*` 301, #11).

---

## 8. Notes from verification

- **NO git / bash this run.** The sandbox VM is down (`useradd`/disk failure — retried and confirmed identical ≥3×; also recorded by the 08-03 overnight pass). So there is **no commit count, no diff-stat, no shell `wc -l`/`rg`**. Everything below is from the file tools + `metrics-latest.json` + `CLAUDE.md`.
- **Line counts are exact (from the Read tool's line numbering):** `collection/page.tsx` **1,330** · `sniper/page.tsx` **1,710** · `analytics/page.tsx` **1,675** · `app/dashboard/page.tsx` **2,197** · `lib/blazers-trivia.ts` **198**. (Note: last week's report listed `analytics/page.tsx` at 495 — that measured the *standalone* `app/(analytics)/analytics/page.tsx`; this report measures the per-collection `[collection]/analytics/page.tsx` that `CLAUDE.md` #14 tracks, which is 1,675 — near #14's ~1,754.)
- **Stale figures in `CLAUDE.md` #14** — it lists collection ~1,600 / sniper ~1,705 / analytics ~1,754. Sniper/analytics are close; **collection is now 1,330** (down further) — recommend refreshing.
- **TODO scan: 14 raw matches → 0 real actionable markers in live app code.** The 6 Trade-Hub `fcl-submit.ts` stubs are gone with the `lib/trade-escrow/` deletion. Remaining matches are 2 launch-flag-gated candy "note" branches (keep), ~5 panini draft lines, 3 false positives, ~4 resolved-annotation lines, 2 test refs (§5).
- **Deletions verified by absence:** `lib/trade-escrow/`, `lib/cart/`, `app/dashboard/trade-hub/`, `app/dashboard/gift/`, `app/api/cart/`, `app/api/trade-chain/`, `app/api/trade-hub/`, `app/api/gift/` — Glob returns **No files found** for all.
- **Launch flags verified in `lib/launch-flags.ts`:** `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true` — both boards public.
- **CI: 8 blocking jobs verified** in `.github/workflows/ci.yml`: `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `component-tests`, `db-tests`, `ledger-guard`, **`edge-deno` (NEW)**. **116** `supabase/tests/*.sql` files (115 invariants + `_helpers.sql`). **1,053** `__tests__/**/*.test.{ts,tsx}` files.
- **Coverage ratchets read directly:** `vitest.config.ts` implied thresholds **87.85 / 73.35 / 90.7 / 90.35** (per `CLAUDE.md`); `vitest.components.config.ts` gate **74.6 / 61.75 / 73.5 / 78.65**.
- **Cited paths spot-checked — all resolve:** `docs/strategy/roadmap-2026-07-18.md`, `docs/candy-go-live-flip-2026-07-25.md`, `docs/fmv-dust-filter-decision-2026-08-02.md`, `docs/audits/refactor-plan-monolith-pages-2026-05.md`, `docs/reference/schema-truth.md`, `lib/market-closed.ts`, `lib/blazers-trivia.ts`, `lib/chains/flow/cadence/purchase-moment.ts`. **No active freeze** would be shown by `docs/FREEZE.md`; not separately verified this run (assumed absent per the overnight pass, which shipped queue-only for VM reasons, not a freeze).
- **`docs/overnight/focus.md` is ~40 days stale** (dated 2026-06-24). `docs/overnight/ledger.md` has **900** `### ` entries (was 563).
- **DB-side facts** (FMV counts, editions, DB size **11,852 MB**, trust 20 metrics / **3 pre-known breaches**, security **0/0/0/0**, `fmv_sanity_flags` 0, `edition_integrity_flags` **97**, sentinel 0) come from **`docs/overnight/metrics-latest.json` (2026-08-03T08:03:02Z — same day)** plus `CLAUDE.md`'s 08-01/02/03 entries. They were **not** independently re-queried against production Supabase this run. **Traction (user/WAU count) was NOT captured this run** — last confirmed 20 users / 0 WAU (2026-07-26). **Sentry was NOT checked** (connector invalidated).
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-08-03)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev path blocked externally | `verify-challenge/check` route present |
| 1 | Cart execution | Shelved → **DELETED** | **Removed from the tree (08-01)** — read-only pivot | `lib/cart/`, `app/api/cart/` absent |
| 2 | Sentry inactive | Resolved | **SDK resolved** — but the **connector is invalidated this run** (separate operator item) | metrics `sentry_unresolved_24h: NOT CHECKED` |
| 3 | Flowty event indexer **/ Trade Hub** | Resolved (Flowty) **+ Shelved → DELETED (Trade Hub)** | **#3 double-labelled** — Flowty resolved; **Trade Hub DELETED from the tree (08-01)**; contract + 16/16 suite kept in CI | `lib/trade-escrow/` absent; `cadence-escrow-tests` job |
| 3b | Gifting | Live write surface → **REMOVED** | **Removed from the frontend (08-01)** | `app/dashboard/gift/`, `app/api/gift/` absent |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary | `pinnacle_fmv_history` live |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present |
| 7 | AllDay `unmapped_sales` | Resolved | **Resolved (original defect)** — current backlog 105 is expected self-draining residue | metrics + ledger |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired | **Retired** | prior runs |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,197** lines (−169) | Read-tool line count |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — token sweep complete; CI guard present | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | Read-tool line count |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open — trimmed** — collection **1,330** / sniper **1,710** / analytics **1,675**. `CLAUDE.md` #14's collection figure now STALE-high | Read-tool line counts |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — and expanded**: 8 CI jobs incl. `edge-deno` (NEW blocking), `db-tests`, `component-tests` | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — UFC slug class swept, pack-reality un-broken, holders-cap fix** this week; a11y + `/ufc-strike` 301 tail remain | audit docs present |

**Tally:** 10 resolved (#2-SDK, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · **3 removed from the tree by decision (#1 Cart, #3 Trade Hub, #3b Gifting)** · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). Plus the live, un-numbered **public go-live + self-serve signup**, **Candy + Panini public boards**, **8-job CI (edge-deno blocking)**, **115 DB-invariant pins**, and the **30 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the numbering is unchanged, and this week reshapes three slots: **(a) #1 / #3 / #3b moved from "shelved" to "DELETED from the tree"** — the read-only pivot, worth reflecting in the known-issues prose; **(b) #3's numbering collision persists** — Trade Hub still shares #3 with the resolved Flowty indexer, and now that it's deleted it may be cleaner to retire the slot than renumber; **(c) correct #14's line counts** — collection is now **1,330** (the ~1,600 figure is stale-high). Standing recommendations still hold: **formally close the obsolete Flowty priority**; note that the **in-code TODO inventory is now empty of actionable live-app markers** (the last cluster went with Trade Hub); and the `badge_editions.low_ask` deferred-hardening note is now stale for both AllDay **and** Golazos (only `highest_offer` remains). And the top-line framing is unchanged and hardening: with the site public and self-serve signup open ~2.5 weeks, the last confirmed reading is **20 users / 0 WAU** (un-remeasured this run) — **demand is the one number that decides everything**, and it has not visibly moved. Two operator blind spots opened this run and should be closed fast: the **Sentry connector is invalidated** and the **pinnacle-sync cron is silent ~46h**.
