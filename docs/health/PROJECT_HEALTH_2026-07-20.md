# Rip Packs City — Project Health Report

**Date:** 2026-07-20
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Cross-session Safety §, Testing & CI §, Recent Sessions § — current through the 2026-07-20 Claude-Code entry), `docs/overnight/metrics-latest.json` (captured **2026-07-19T08:03:06Z**), `docs/overnight/ledger.md` (413 entries, spot-queried), `docs/overnight/focus.md` (stale, dated 2026-06-24), `docs/overnight/inbox/` (5 pending monitor ticks), plus a first-hand `git log` / `TODO|FIXME|HACK|XXX` scan and `wc -l` / file-existence verification of the source tree.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#17`), the prioritized actions, the overnight operational queue, and the in-code TODO inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-07-13.md` (7 days ago). This regeneration mirrors its structure. `_2026-07-06.md`, `_2026-06-29.md`, `_2026-06-22.md`, `_2026-06-15.md`, `_2026-06-08.md`, `_2026-06-03.md`, `_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present in `docs/health/`.

> **Tooling note (the inverse of last week).** The Cowork bash/git sandbox **provisioned cleanly this run** — the `useradd: exit status 12` failure that blocked the 07-12 and 07-13 reports is gone (it recovered on 07-14 per `CLAUDE.md`). So this report has a **real `git log`** for the first time in two weeks: **488 commits since 2026-07-13**, **594 files changed (+55,458 / −3,596)**. Line counts are `wc -l`, existence checks are `ls`/`find`, and the TODO scan is a full `grep -rn`. Only DB-side facts are second-hand (from `metrics-latest.json`, one day old).

> **Report location stays clean.** The repo root holds **0** `PROJECT_HEALTH_*` files; all twelve reports (this one included) live in `docs/health/`. This is written there, per the brief.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since 2026-07-13 — the product went PUBLIC, and the week that followed was the heaviest in the report's history.** 488 commits across 7 days (peak: 132 on 07-17) versus a typical ~50–100. Six stories: **(1) GO-LIVE SHIPPED (07-17).** The read-only feature tabs are now **public to anonymous visitors** for the 5 published Flow collections — the `proxy.ts` un-gate walls *personalization*, not *content*. This is the single most consequential shift in the report's history and it re-frames everything below: a new post-launch roadmap (`docs/strategy/roadmap-2026-07-18.md`) supersedes the go-live program, and **the only gate that matters now is traction: 50+ WAU.** **(2) A CONFIDENTIALITY INCIDENT was found and fixed (07-19).** The staged "gated" Panini + Candy dataset was **anon-readable via PostgREST** — `proxy.ts` gates HTTP *routes*, not *data*, and the anon key ships in the client bundle. Most sensitive: `panini_card_serials` carried **1,011 distinct third-party collector usernames**. Fixed across 3 migrations (17 objects + `editions_unified` revoked; verified 0/17 readable by `anon` or `authenticated`; zero breakage). The durable lesson — `REVOKE … FROM PUBLIC` does not strip Supabase's default per-role grant, **and that applies to tables and views, not just SECDEF functions** — is now in `CLAUDE.md`'s security posture. **(3) Test coverage roughly DOUBLED and a whole new test layer landed.** The vitest ratchet went **34.3/26.5/39.4/36.5 → 75.5/60.6/80.9/78.0** (live actuals 75.64/60.83/81.09/78.24) — a +41-point statement-coverage swing in one week. Added: a **DB-invariant SQL test layer** (13 self-contained `supabase/tests/*.sql` files pinning 12 Postgres function/trigger invariants) with a new **blocking `db-tests` CI job**, the RPCTradeEscrow Cadence suite **promoted into CI** (16/16 green, zero test TODOs), and a **`ledger-guard`** job. CI is now **6 jobs**; `__tests__/` holds **751** test files (was ~565). **(4) In-code debt collapsed: 59 → 34 real markers (−25).** The entire Candy/Solana discovery-placeholder block (§5g, 17 lines) **resolved** — all five `TODO_N` placeholders are filled with real values and 125 `candy_mlb` editions / 25,375 serials are ingested. The Panini live-scaffold markers went to zero when `lib/chains/panini/feed.ts` was retired. The Cadence-test gap (§5f) closed. See §5. **(5) A ledger-integrity incident + its durable fix.** Commit `fecda2e` silently deleted **13 ledger entries while adding its own** — destroying revert paths for live prod migrations. Restored non-destructively; a pure-bash `ledger-guard` CI job now fails any push that drops a ledger entry. **(6) A PostgREST 1000-row-cap bug class swept out of live user-facing code** — a whale wallet ranked over only the first 1,000 of its 5,320 moments, the Market edition-lookup built from an arbitrary 1,000 of ~19k editions, and a `snapshotsToday` metric silently reporting 4,243 as exactly 1,000. Plus a **3-month-old** Golazos sets bug (0 owned / 0% completion since 2026-04-14) and a **latent hot-wallet signing landmine** (wrong curve *and* wrong hash) both fixed.

> **Overnight reality — GREEN and un-blocked.** The bash/git sandbox recovered; the 07-19 pass was a genuine in-window overnight with push available and shipped 1 (a DB-only watchlist-notes cadence correction), closed 4, and ran a post-ship watch over "the largest wave in weeks (~20+ commits, 10+ migrations)" — **ALL PASS, 0 reverts**. Health at the last capture: security **0/0/0/0**, trust **15 metrics / 0 breaches**, sentinel TS-UUID 48h **0**, `impossible_parallel` **0**, pg_cron failures **[]**, Sentry **0 unresolved**. One stalled pipeline (`pinnacle-sync`, catalog half — an operator cron-job.org item).

> **Traction reality — measured for the first time, and honestly near-zero.** Last week's headline concern was "activation machinery built but unmeasured." That is now **answered**: instrumentation was verified working end-to-end (both sinks record), a `collection_view` funnel event closed the last blind spot, and the reading is **31 sessions / 7 days** with **23 `funnel_events` in 24h**. The conclusion in `CLAUDE.md` is the right one: the near-zero read is *a real absence of traffic post-un-gate, not broken tracking.* So the problem statement shifts from "instrument it" to **"get people to the now-public site."** **Cost/storage reversed direction:** DB is **10,054 MB, DOWN ~990 MB** from last week's 11,044 — the first week-over-week decline the report has recorded (it crossed back under after the 07-16 IOPS read-diet + reclaim work; it did cross 10 GB upward mid-week and remains a LOW watch item on an IOPS-constrained Micro instance).

> **Platform context (updated).** **(1) Flowty** frontend shut but API ALIVE and feeding live ingest — teardown premise still obsolete. **(2) NFL All Day** primary pack sales ended; secondary-market only. **(3) UFC Strike** migrating to Aptos; Flow market permanently frozen. **(4) Candy / Solana chain-two is no longer a placeholder** — discovery complete, data ingested, ME sales + best-offer indexers LIVE; the remaining blocker is **zero price signal** (0 sales / 0 FMV / 0 asks; only bids). **(5) Panini** runner is LIVE on a residential box refreshing ~1,022 editions every 4h; the public surface is built and staged behind **one `proxy.ts` line (L127)**; its blocker is now **editorial, not technical**. **(6) The 2026-07-16 sequencing rule change matters:** expansions are **readiness-gated, not sequence-gated** — the old "one chain at a time, Candy-first" rule is retired.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md` — **413 entries**, `inbox/` — **5 pending**, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping — **verified absent this run = no freeze active.** **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | Unchanged in `CLAUDE.md` since last week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | #0, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline |
| Commits this week | **488** | 594 files changed, +55,458 / −3,596. Peak day 07-17 (132). First real `git log` in 2 weeks. |
| Net-new shipped features (not numbered) | **12+** | **Public go-live un-gate (NEW, biggest)**; DB-invariant SQL test layer + `db-tests` CI job (NEW); `ledger-guard` CI job (NEW); IA reorg — Moments\|Packs sub-toggle + Play hub + Market=edition/Sniper=serial (NEW); Candy chain-two data layer + ME sales & best-offer indexers (NEW); Panini coverage-disclosure surface (NEW, gated); `sales-counterparty-backfill` — 16th CF worker (NEW); Panini→shared-catalog bridge (built INERT); pre-2026 TS sale-ingest pipeline (built INERT); AllDay lock-refresh scheduler; external pack-drop pricing engine; RPCTradeEscrow suite green + in CI — §2 |
| Open overnight operational items | **~9 active + ~5 deferred** | New: **PANINI-EDITORIAL-DECISION** (bridge built, decision pending); **TWO-DUNE-PIPELINES-INERT** (env-bake never took); **PANINI-SET-RPC-BRANCH**; **MARKET-SOURCES-FMV-RECENT-WINDOW-CAP**; **COMPUTE-LALIGA-PACK-EV-SCHEMA-MISMATCH**. Carried: `pinnacle-sync` catalog half (operator); WMC-LOCK-FRESHNESS; MARKET-EDITION-LINK (proven unbuildable); TS-PACK-DIST-NAME-BACKLOG; Vercel cost family; cron-job.org dropout family — see §2.6 |
| Net-new structural workstream | 3 | Multi-chain abstraction (Phases A–F complete; **all 18 shims now zero-caller**, deletion gated on chain two) + Candy/Solana (**discovery COMPLETE**, blocked on price signal) + Panini (runner LIVE, blocked on an editorial call) (§2.8) |
| Prioritized next actions | **superseded** | `docs/strategy/roadmap-2026-07-18.md` is now canonical (post-launch). Old #1 (Flowty) obsolete; old #2 (harden intelligence) advanced hard. See §4. |
| In-code TODO markers | **34 real lines / 26 files** (+3 false positives, +4 vendored-contract, +7 test refs, +23 resolved-annotation) | **−25 vs last week's 59.** Candy block 17→0, Panini live-scaffold 5→0, Cadence-test 2→0, §5e 3→1 — see §5 / §8 |
| Test files / DB-invariant pins | **751** / **13 SQL files (12 invariants)** | Was ~565 / 0. Coverage ratchet 34.3→**75.5** stmts. |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** The week the product actually launched. The 07-17 public un-gate is the headline and it reorders the whole board: content is now anonymous-readable for the 5 published collections, a post-launch roadmap replaces the go-live program, and the single gate is **50+ WAU**. Underneath it, an extraordinary volume of work landed — 488 commits — dominated by *quality* rather than features: test coverage roughly doubled (34→75 stmts) and grew a whole new DB-invariant SQL layer with blocking CI, in-code debt fell 59→34 markers (the Candy discovery block resolved outright), and a cluster of genuine correctness bugs was found and fixed (a PostgREST 1000-cap class hitting live user-facing surfaces, a 3-month-old Golazos completion bug, a wrong-curve hot-wallet signing landmine). Two incidents deserve standing attention: a **confidentiality exposure** (gated Panini/Candy data anon-readable, 1,011 collector usernames) and a **ledger clobber** (13 revert paths silently destroyed) — both fixed, both with durable guardrails now in place, and both of the same shape: *a protection everyone assumed was there wasn't.* Operationally the platform reads GREEN across the board and the overnight tooling is un-blocked. The dominant concern is no longer measurement — it's **demand**: 31 sessions/7d on a now-public site. Descending, concentrated risk: **(1)** traffic/activation post-launch (the only gate that matters); **(2)** two "gated" datasets whose exposure model was wrong once already — audit any other route-gated surface; **(3)** the Panini editorial decision (a ~46%-coverage listing-gated index becoming a full catalog citizen) and the Candy zero-price-signal blocker; **(4)** cost/IOPS on a Micro instance (DB improved this week but the instance is the binding constraint). Chain-foundation tails and page polish are secondary.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path now)** | **Public un-gate SHIPPED 07-17** — read-only tabs anonymous for 5 collections. Funnel instrumentation **verified working**; reading is 31 sessions/7d, 23 funnel_events/24h. The problem is now *demand*, not measurement. Gate: **50+ WAU** (§2.1) |
| **Security / confidentiality (NEW headline)** | Route-gating ≠ data-gating — 17 pre-launch objects + `editions_unified` were anon-readable via PostgREST (1,011 collector usernames). Revoked + verified. New durable rule in `CLAUDE.md`. Audit any other gated surface with `SET LOCAL ROLE anon` (§2.4) |
| Test / quality infrastructure | Ratchet 34.3→**75.5** stmts (actual 75.64). **NEW DB-invariant SQL layer** (13 files / 12 pins) + blocking `db-tests` job + DDL drift guard; Cadence escrow suite promoted into CI (16/16); `ledger-guard`. 6 CI jobs, 751 test files (§2.4) |
| Data-intelligence correctness | PostgREST 1000-cap sweep (lock-roi whale, `/api/market` edition lookup, market-pulse 4× undercount); 3-month-old Golazos sets-db bug; sales-counterparty multi-collection engine (~100% recovery, 26,127 recovered); Dune validated as the bulk lane (§2.3) |
| Chain expansion (readiness-gated, parallel allowed) | **Candy: discovery COMPLETE** (125 editions / 25,375 serials, ghost-purge self-heal, ME sales + best-offer indexers live) — blocker is zero price signal. **Panini: runner LIVE**, coverage proven **listing-gated (~47% trustworthy)**, disclosure baked structurally, bridge built INERT — blocker is editorial (§2.8) |
| Cost / operational right-sizing | **DB 10,054 MB — DOWN ~990 MB** (first weekly decline). IOPS on the Micro instance is the real constraint. Vercel cost family carried; seed-wallet 12h gate shipped (~29 lambda-hrs/day) (§2.6) |
| Operational / overnight queue | `pinnacle-sync` catalog half (operator); two Dune pipelines INERT (env bake never took); PANINI-SET-RPC-BRANCH; MARKET-SOURCES-FMV-CAP; LALIGA-PACK-EV schema mismatch; WMC-LOCK-FRESHNESS; MARKET-EDITION-LINK (unbuildable); cron-job.org dropout family (§2.6) |
| Tech debt / refactor | Monoliths roughly flat this week — collection **1,618** (+89) / sniper **1,691** (−21) / dashboard **2,360** (flat) / analytics **495**. **All 18 chain-rename shims now zero-caller** (deletion gated on chain two) (§3) |
| Page polish | IA reorg (Moments\|Packs sub-toggle, Play hub, Market=edition/Sniper=serial); Packs/Moments wallet sub-tabs with an honest lower-bound disclosure; pack/set/team soft-404 hardening (#17) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded, 8 stub TODOs — but the contract suite is now **16/16 green and in CI**); Cart (#1, shelved); breaks (dormant, signing bug fixed); Top Shot in-app bulk-buy (Dapper co-signer wall) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; `badge_editions.low_ask` — **AllDay now RESOLVED (69.5%, cron live)**, Golazos still frozen |

---

## 2. Critical path — start here

The framing changed this week. Go-live is **done**; `docs/strategy/roadmap-2026-07-18.md` is the canonical forward plan. Phase 1 = prove the product with real users (**the only gate is 50+ WAU**); Phase 2 = cost/latency levers; Phase 3 = durable debt; Phase 4 = chain two, readiness-gated.

### 2.1 Launch + activation — the site is public; demand is the gap — `Severity: High · Effort: Medium (built + measured, needs traffic)`

The un-gate shipped 07-17 (`65b55209` / `db04342f`, browser-verified). What's public: GET/HEAD on `/{slug}/{collection|market|sniper|sets|packs|pack-sniper|challenges|hot-floors|play|analytics}` for the **5 published Flow collections only**, plus a `PUBLIC_READ_APIS` allowlist and the stateless POST read-computes. What stays behind sign-in: cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, wallet-cache writes, and every mutation. Panini and Candy stay gated (no multi-chain pre-launch).

- **Instrumentation is now verified, not assumed.** Both funnel sinks record; a new `collection_view` event (migration widened the CHECK; `FunnelTracker` mounted `perPath` in the collections layout, published-collections branch only) closed the landing → collection → Market/Sniper blind spot. **Reading: 31 sessions / 7 days; 23 `funnel_events` in 24h.**
- **This is the important reframe.** Last week's recommendation ("measure it") is complete. The measurement says traffic is genuinely near-zero. So the work is now acquisition and retention, not instrumentation: SEO surfaces are the cheapest channel (28 sitemapped `/insights` routes), alerts + Rewards + challenges are live engagement loops, and none of them have an audience yet.

Suggested next step: pick one acquisition channel and actually run it — the assets (28 public insights boards, OG cards on every share surface, a working concierge) are built and idle. Then watch WAU against the 50+ gate. Worth promoting to the explicit top-line item in `CLAUDE.md`.

### 2.2 Public intelligence surfaces — 28 sitemapped + 1 gated — `Severity: n/a (shipped) · context`

- **`/insights` hub: 28 routes in the sitemap** (verified: `INSIGHT_ROUTES` in `lib/sitemap-data.ts` = 28 entries) against **29 built surface dirs** in `app/insights/`. The delta is **`panini-squeeze`** — built, deliberately excluded from the sitemap, and gated behind `proxy.ts:127`. Sitemapped count is unchanged from last week; the new build is the gated one.
- **IA reorg (07-18).** `packs` / `pack-sniper` / `hot-floors` / `challenges` stay registered pages (gates + capability checks keep working) but are folded off the top bar via `TAB_BAR_HIDDEN_PAGES`; pack surfaces are reached through an in-page **Moments \| Packs sub-toggle** (`?section=packs`, deep-linkable, "Pins" on Pinnacle). New Top Shot **Play hub** fronts Challenges / Fast Break / Road to the Ring.
- **Market vs Sniper split (Trevor decision).** Market is **edition-level** (one row per edition), Sniper is **serial-level** (individual listings). Market defaults to Price ascending.
- **Wallet Packs/Moments sub-tabs** with an in-UI honesty disclosure: the Sold tab is a **lower bound** (sales counterparty coverage ~21% TS / 12% AllDay / ~0% Golazos+UFC), and wmc is a *current* snapshot — RPC keeps no durable record of past holdings.

No open defects tracked here; listed because it is a large body of shipped product work now sitting in front of anonymous visitors for the first time.

### 2.3 Data-intelligence correctness — a strong bug-finding week — `Severity: was High (correctness) · Effort: large, mostly landed`

- **PostgREST 1000-row-cap class swept from live surfaces.** Three real user-facing defects: `rtr/lock-roi` ranked a 5,320-moment whale over only its first 1,000 moments; `/api/market`'s `loadEditionLookup` built the (player,set)→edition map from an arbitrary 1,000 of ~19k TS editions (so many Market rows got a null edition link + no badges); and `/api/profile/market-pulse` requested `count:"exact"` then read `rows.length`, silently reporting 4,243 snapshots/24h as exactly 1,000. All fixed with `.range()` paging / `head:true` count reads, each with a regression test **proven to fail against the old code**. The `CLAUDE.md` rule was hardened with both sub-classes (bare unbounded `.select()`, and count-vs-length).
- **A 3-month-old bug fixed.** `/api/sets-db`'s owned-by-set accumulator built a list but never `.set()` it back into the Map — so **every Golazos set read 0 owned / 0% completion since 2026-04-14**. One-line fix + regression test (owned 0 → 1,100).
- **Sales-counterparty backfill matured into a multi-collection engine** — TS buyer+seller, AllDay/UFC seller-only (their `Deposit.to` is a Dapper custodian; writing it as buyer would be a lie), Golazos excluded. ~100% recovery at full tick rate; **26,127 rows recovered**. Dune validated as the bulk accelerator (~167 credits for full 2024–26 history).
- **FMV coverage (from `metrics-latest.json`, 2026-07-19T08:03Z):** TopShot HIGH 976 / MEDIUM 2,398 / **HIGH+MED 3,374**; AllDay HIGH+MED 577; UFC 15; Golazos 1. *The TS drop from last week's 5,194 is the documented benign sales-cooldown redistribution, flattened as predicted — freshness is green (`topshot_fmv_stale_hours` 0.2, `fmv_sanity_flags` 0), so this is a confirm-only movement, not a regression.* `edition_integrity_flags` 5; `impossible_parallel` **0**; Pinnacle `fmv_stale` 9.4h.
- **Two latent landmines defused.** `lib/breaks/server-authz.ts` signed with **p256 + SHA3-256** while the hot wallet's keys are **secp256k1 + SHA2-256** — wrong on both axes, surviving only because a wrong-curve signature is still a well-formed 128-hex string and the test asserted length. Now verified cryptographically. And `analytics_sales_summary` / `v_moments_needing_hydration` — the #1 and #3 disk readers — were rewritten (237 MB → 1.5 MB per call on the latter).

Suggested next step: keep the per-collection `*_fmv_stale_hours` tripwires in the weekly check; treat the "regression test must fail against the old code" discipline used in the cap sweep as the standard for correctness fixes.

### 2.4 Security, confidentiality + test infrastructure — `Severity: High (incident, fixed) · Effort: landed`

- **CONFIDENTIALITY INCIDENT — fixed 07-19.** `proxy.ts:127` gates the Panini **routes**; it does not gate the **data**. The underlying tables/views carried Supabase's default `anon` grant and the anon key ships in the client bundle, so anyone could query `/rest/v1/panini_squeeze_board` and friends. **`panini_card_serials` carried 1,011 distinct third-party collector usernames**; `editions_unified` exposed all 125 `candy_mlb` editions. Fixed across 3 migrations — explicit `REVOKE SELECT … FROM anon`/`authenticated` on all 17 pre-launch objects + `editions_unified`; **verified 0 of 17 readable** by either role; zero breakage (both live consumers use `supabaseAdmin`). **Durable lessons now in `CLAUDE.md`:** (a) `REVOKE … FROM PUBLIC` does not strip the default per-role grant — *and this applies to tables and views, not just SECDEF functions*; (b) verify with `has_table_privilege('anon', …)` or `SET LOCAL ROLE anon`, **never** `information_schema.role_table_grants` (which still listed `anon` after a successful revoke); (c) **route-gating ≠ data-gating** — audit any other gated surface the same way. Also noted: `check_secdef_anon_execute_violations()` only watches a hardcoded 9-function allowlist and will **not** flag new SECDEF functions — set grants explicitly.
- **Test coverage roughly doubled.** Ratchet **34.3/26.5/39.4/36.5 → 75.5/60.6/80.9/78.0** (live actuals 75.64/60.83/81.09/78.24, ~0.15 buffer kept for concurrent churn). Driven by the route-integration harness + deep-loop fixtures (`__tests__/helpers/route-harness.ts`, `anthropic-fixture.ts`) that drive real route bodies rather than just guards.
- **NEW: a DB-invariant SQL test layer.** 13 self-contained `supabase/tests/*.sql` files pin **12 invariants** on high-stakes Postgres functions/triggers vitest can't reach (`_norm_player`, the phantom-FMV block, `expire_ended_challenges`, the FMV clamps, pack-EV weighting, the **destructive-op circuit breaker**, `resolve_moment_id`, …). Each embeds a **verbatim copy** of the committed DDL and rolls back, so it runs on a vanilla `postgres:16` with no schema bootstrap. A **drift guard** (`__tests__/db-invariants-drift-guard.test.ts`, in the blocking `unit-tests` job) fails CI if an embedded copy diverges from its source migration. New blocking `db-tests` CI job.
- **CI is now 6 blocking jobs** (verified in `.github/workflows/ci.yml`): `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `db-tests`, `ledger-guard`.
- **Ledger-integrity incident + fix.** Commit `fecda2e` silently deleted **13 ledger entries while adding its own** (353→340 entries), so it looked like normal growth — destroying revert paths for live prod migrations. Restored non-destructively. `ledger-guard` now compares heading **sets** (not just counts, after a same-count remove-one/add-one swap defeated the count-only check) with a `[ledger-roll]` opt-out.
- **A monitoring gap was named and closed.** CI status was in **no** automated sweep — `main` sat red ~24h undetected (Vercel builds don't run vitest). The ops-monitor now reads GH Actions conclusions.

### 2.5 Automation / asset hygiene — `Severity: Low · Effort: ongoing`

The bash/git sandbox **recovered** (07-14), so the passes can ship again. `metrics-latest.json` is one day old (2026-07-19T08:03Z). **Two hygiene flags carry:** (a) `docs/overnight/focus.md` is still dated **2026-06-24** — now **26 days stale** (was 19) and it still describes a June deep-history program as the current priority, which is actively misleading for a post-launch repo; (b) `docs/overnight/inbox/` holds **5 undrained monitor ticks** (3× 07-19, 2× 07-20).

### 2.6 Overnight operational queue — `Severity: Low–Medium · Effort: mixed`

**Closed this week:** IMPOSSIBLE-PARALLEL-27 (→0), PINNACLE-SYNC-FMV-STALE (FMV half, pg_cron backstop did it unaided), CI-STATUS-NOT-IN-ANY-SWEEP, WALLET-BACKFILL-STALL-THRESHOLDS (closed by measurement — gate not met), DUNE-SELLER-RECOVERY-EXECUTE-400 (root cause: **Dune has no `date` param type**; retyped to `text`, re-executed clean), BASH/GIT-SANDBOX-PROVISION-FAILURE (recovered), TOPSHOT-ACTIVE-LISTINGS-ATLAS-BLOCK, ALLDAY-UNMAPPED-SALES-BACKLOG (premise disproven). Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **PANINI-EDITORIAL-DECISION** (new) | The Panini→shared-catalog bridge is **built and shipped INERT** (dry-run default; 0 rows written). Technically de-risked (blast radius zero; RLS + `is_active` gate hides synced rows). The remaining blocker is editorial: **running the sync makes a listing-gated ~46%-coverage index a full citizen of the shared catalog.** | **Med** | Trevor-only. Go-live is a single `proxy.ts:127` deletion + sitemap/hub links. |
| **TWO-DUNE-PIPELINES-INERT** (new) | `sync-sales-ingest-dune` **appears activated but is not** — `DUNE_SALES_INGEST_QUERY_ID=8030177` was set in Vercel but the "rebuild to bake" commit was **empty**, and `vercel.json`'s `ignoreCommand` skips empty *and docs-only* commits. Still logs `dune_not_configured`. `DUNE_SALES_SELLER_QUERY_ID` unset. | Med | Fix: force a real rebuild via **v13 deployments POST** (an empty or `*.md`-only commit can never force one on this project). |
| **`pinnacle-sync` catalog half** | Only stalled pipeline at last capture (~46h silent, cron-job.org dropout class). FMV half is backstopped + healthy; catalog half is not. | Med | Operator (cron-job.org console). Wants the same pg_cron backstop the FMV half got. |
| **PANINI-SET-RPC-BRANCH** (new) | `editions_unified` feeds the set **directory** but not the set **edition grid** — `get_set_detail`/`get_set_editions` need a per-collection branch before a Panini set page can render. | Med | Gated behind the editorial call above. |
| **MARKET-SOURCES-FMV-RECENT-WINDOW-CAP** (new) | `getSupabaseMarketMap` reads `fmv_snapshots` DESC `.limit(10000)` → clamped to 1,000, which spans only a few hours of ~4,200 TS snaps/day, so most requested editions get no FMV. Same class as the lock-roi fix. | Low (dormant) | Not shipped: its only caller has no in-repo consumer and it feeds `computeFmv` (off-limits). Fix via `fmv_current` `.in(ids)` chunked when the route revives. |
| **COMPUTE-LALIGA-PACK-EV-SCHEMA-MISMATCH** (new) | Dies daily inserting a column `pack_ev_history` lacks. Not user-facing (the golazos route covers the collection). | Low–Med | Off-limits pack-EV route logic + an ownership call. Only the `pack_ev_history` insert is wrong — adding the column is explicitly rejected. |
| **WMC-LOCK-FRESHNESS** | The 7-day lock-freshness promise is **structurally unmeetable** (TS wmc 1.61M rows, 98% stale >7d, needs ~226k checks/day vs a ~9.6k/day ceiling). On-demand refresh now converges the *viewed* wallet, which covers the display-trust need — but only for **signed-in** viewers. | Low–Med | By explicit decision. `BATCH_LIMIT` raise + denser cadence queued but not shipped. |
| **MARKET-EDITION-LINK** | The queued "full fix" is **proven unbuildable server-side** — TS's numeric edition `flowID` does not exist on the GQL nodes and public-api enforces a persisted-query allowlist. | Low (terminal) | Do **not** re-attempt the GQL-ingest-column approach. Current "—" + native-moment fallback holds. |
| **TS-PACK-DIST-NAME-BACKLOG** | Sealed-pack "no name/art" is a data gap — TS `primary_withdraw` dist resolution is normally 84.8% but crashed to ~21–45% on the 14.5k-pack 07-16/17 drop. | Med | Pack-ingest territory, owner session. |
| **Vercel cost family / cron-job.org dropout** | Carried. The seed-wallet 12h gate shipped (~29 lambda-hrs/day, corrected down from the ~56 headline). Dropout family is external + self-healing. | Low–Med | Trevor (dashboard) + operator. |

### 2.7 Pack EV / pack-viz — `Severity: Low · Effort: shipped`

Pack EV stayed accurate-by-construction: the pool-completeness guard holds (no fabricated EV on chase-biased pools), Actual-vs-Typical EV both surface, and a new **external pack-drop pricing engine** (`score_external_pack_drop`, deliberately anon-executable) prices *any* lot — all 7 Vaultopolis drops seeded, 104/105 moments mapped, and RPC disagrees with operator pricing in **both** directions (+7.4% / −6.3%), which is the point: it's an independent valuation. **Decision-critical market measurement: 66 packs sold LIFETIME (~$365 total)** — this supersedes the June TAM guess, and the honest read recorded in `CLAUDE.md` is "the pack-shaped product is not the opportunity; the pricing engine was."

### 2.8 Chain foundation — abstraction complete; two live expansion programs — `Severity: Low–Medium · Effort: Medium`

- **Chain-abstraction Phases A–F complete.** The Phase-D tail moved this week: **all 18 re-export shims are now zero-caller** — every in-repo caller (including ~70 test `vi.mock` paths and 4 canonical `lib/chains/flow/*` modules that were themselves importing through shims) was repointed across two sweeps. **The shims remain in place and their deletion is explicitly gated on chain two shipping.** New code must import the canonical paths. (17 of the 18 comments were updated to say so; `lib/dapper-v1-tx-decode.ts` still carries the old wording — a cosmetic inconsistency, verified 0 callers.)
- **Candy / Solana — discovery COMPLETE, no longer a placeholder.** All five `TODO_N` values are filled with real data (`CANDY_MLB_COLLECTION_ADDRESS = JkJA4y…p8n`, `CANDY_MLB_ME_SYMBOL = 2026_mlb_base_series_icons_candy_digital`, `SERIAL_ATTR_KEY = serial_number`, …). 125 editions / 25,375 serials ingested and reconciled to supply exactly; 371 ghost-owner rows purged with a daily pg_cron self-heal; ME **sales indexer** and **best-offer indexer** both LIVE (first real sweep: 47 offers / 24 best-offers / 2 bidders). **Remaining blocker: zero price signal** (0 sales / 0 FMV / 0 asks; only bids). **Binding honesty constraint: `candy_best_offers` is a best-offer signal, NEVER FMV** — never fold into `fmv_snapshots`. `candy_mlb` stays `is_active=false`.
- **Panini — runner LIVE, blocker is editorial.** ~1,022 editions refresh every 4h from a residential logged-in box. **The critical finding: discovery is listing-GATED** — enumeration runs off a marketplace-listings GraphQL op, so an edition enters the index only once *listed*; only **47%** of 1,647 discovered editions sit in a trustworthy-coverage bucket, and coverage falls monotonically with scarcity (1-of-1 parallels 7–8% discovered). Panini exposes **no full-checklist route**, so the only lane is *accept and disclose* — and that disclosure is now **structural**, not a checklist item (the page renders a coverage-driven "floor, not a census" banner; the public JSON carries `meta.coverage`, both fail-soft). Five additional built boards stay deliberately unsurfaced.
- **A correction worth carrying:** the `panini_blockchain` collections row records the retired OpenSea **bridge** plane — there is **no Sawtooth chain** (that earlier claim was invented), and the row **gates nothing**.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** The site is public; instrumentation is verified; the reading is **31 sessions/7d**. The gap is demand, not measurement. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| 0 | **Wallet verification.** "Sign in with Dapper" still gated on Dapper developer access. Working path = the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim fallback. | Medium | Medium (core shipped; Dapper path blocked externally) |

### Security / confidentiality (new)

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Route-gating ≠ data-gating | 17 pre-launch objects + `editions_unified` were anon-readable via PostgREST (**1,011 collector usernames**). **Fixed + verified 0/17.** Residual action: audit any *other* route-gated surface the same way, and remember `check_secdef_anon_execute_violations()` won't flag new SECDEF fns. | was **High** | (landed; audit is small) |

### Test / quality infrastructure

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Coverage ratchet | 34.3 → **75.5** stmts in one week (actual 75.64). **Raise as coverage climbs; NEVER lower to green a build**, and keep a ~0.15 buffer for concurrent pushes. | was Medium | (landed) |
| DB-invariant SQL layer | 13 files / 12 pins + blocking `db-tests` job + DDL drift guard. **When you change a pinned function, copy the new DDL verbatim into the test** or CI fails. | n/a (new) | (landed) |
| Ledger integrity | 13 entries silently destroyed by one commit. Restored; `ledger-guard` CI job compares heading *sets*. | was High | (landed) |

### Data-intelligence correctness

| Item | Issue | Severity | Effort |
|---|---|---|---|
| PostgREST 1000-cap class | Three live user-facing truncations fixed with proven regression tests. One dormant instance remains (`MARKET-SOURCES-FMV-RECENT-WINDOW-CAP`). | was Medium | (mostly landed) |
| Golazos sets completion | 0 owned / 0% for every set since 2026-04-14 — a missing `Map.set()`. **Fixed** + regression test. | was Medium | (landed) |
| Sales counterparty coverage | ~21% TS / 12% AllDay / ~0% Golazos+UFC. Backfill engine live (~100% tick recovery, 26,127 recovered); Dune bulk lane validated. **Separate finding: `sales` ingest itself is materially incomplete** (~8% of on-chain sales for a reference wallet), so recovery ceilings are the rows we have, not true counts. | Medium | Medium (running) |
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine primary; Phase 1 shipped (2 dead legacy reads retired). **Key finding: legacy `edition_key` is character-LOSSY** — never repoint character-level reads onto it. | Medium | Medium |

### Cost / operational right-sizing

| Item | Issue | Severity | Effort |
|---|---|---|---|
| DB storage | **10,054 MB — DOWN ~990 MB** this week (first decline). Crossed 10 GB upward mid-week; LOW watch. | Low–Med | Small (monitor) |
| IOPS on Micro | The real binding constraint — the all-day statement-timeout family traces to disk-IOPS burst exhaustion. Read-diet levers shipped (delta rewrites, partial indexes, single-scan rewrites). | Medium | Ongoing |
| Vercel cost family | Carried (Spend-Management cap backstop, Fluid/cron/observability levers). Seed-wallet 12h gate shipped. | Medium | Small–Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 shims, **all now zero-caller**. Deletion explicitly gated on chain two shipping. Mind the `lib/flow.ts` default-export trap. | Low | Small (when unblocked) |
| Candy chain-two | Discovery COMPLETE; data ingested; indexers live. Blocker: **zero price signal**. | Low–Med | Blocked externally |
| Panini | Runner LIVE; coverage listing-gated (~47%); disclosure structural; bridge built INERT. Blocker: **editorial decision** + `PANINI-SET-RPC-BRANCH`. | Medium | Small (one line) + a judgment call |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 | Monolith page refactor — roughly **flat this week** after last week's big drop. Verified `wc -l`: `collection/page.tsx` **1,618** (+89) · `sniper/page.tsx` **1,691** (−21) · `analytics/page.tsx` **495**. **`CLAUDE.md` #14's figures (~2,900 / ~2,070 / ~2,208) are all STALE** — recommend correcting. Plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (much progressed) |
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **2,360 lines** (unchanged). | Low | Large |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED** (none git-tracked). | Low (resolved) | Trivial |

### Page polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack/Moment/Set tune-up. This week: IA reorg, wallet Packs/Moments sub-tabs (with an honest lower-bound disclosure), Market thumbs 52→80px, pack/set/team soft-404 hardening, Pinnacle Market honest empty state. Remaining lower-value tier: modal accessibility (Moment V3 / Set V5), Set B5 (series rollups from first 100 editions — needs an aggregate RPC), Set B7. Audit docs (`docs/archive/audits/{PACK,MOMENT,SET}_PAGES_AUDIT_2026-05-22.md`, all present) are point-in-time and partially superseded. | Low–Medium | Medium (mostly done) |
| 11 | Brand punch list — token sweep complete; CI guard (`scripts/check-brand-tokens.mjs`, present). Remaining: longer-tail surfaces (email HTML, Fast Break / RTR / admin). | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** Cadence dormant in `lib/chains/flow/cadence/purchase-moment.ts` (verified present). Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED.** 8 in-code stub TODOs persist (§5b). **But the contract suite is now 16/16 green and running in CI**, and two latent compile blockers were fixed in the undeployed contract (`Trade.execute()` → `settle()` — `execute` is a hard keyword in Cadence ≥1.0; string-form NFT import). | Medium (shelved) | Large |
| — | Breaks — dormant (tables not in prod, migration unapplied). The **hot-wallet signing bug is fixed** (`3b5e62d8`); it was a live landmine on any revival. Stripe is subscription-only (no goods checkout / order table / refund path). | Low (dormant) | n/a |

### Deferred hardening (intentional — from `CLAUDE.md`)

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each retain a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps, a `created_at` rate-limit column/trigger, a `bot_score` column, possibly an edge rate-limiter. (`funnel_events` follows the safer pattern.)
- `user_achievements` + `watchlist_items` — service-role-only writes but still keyed on `owner_key` (text) rather than `user_id` (UUID).
- `badge_editions.low_ask` — **AllDay RESOLVED** (3,897/5,607 = 69.5%, refreshed every 30 min by a live cron; the old "0/1,572 always NULL" note is stale — do NOT build a second AllDay cron). TopShot healthy and fresh. **Still open: Golazos** — 104/218 (47.7%) and **frozen since 2026-07-08**; `highest_offer` 0/218.

### Architecture note worth tracking

- **Watchlist + FMV Alerts** — the legacy `fmv_alerts` mis-route is retired; the live feature is the `alert_subscriptions` / `notification_channels` / `lib/alerts.ts` implementation (verified present). Reconcile the old watchlist tables before any reactivation.
- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design (long-form vs short-form collection strings; `HIGH|MEDIUM|LOW` vs `HIGH|MED|LOW`). Both are documented in `CLAUDE.md` and worth re-reading before writing any new query.

---

## 4. Prioritized next actions — **superseded this week**

`CLAUDE.md`'s old 2026-05-24 two-item list has been **replaced by `docs/strategy/roadmap-2026-07-18.md`** (verified present), which is now canonical:

| Phase | Action | Status |
|---|---|---|
| 1 | **Prove the product with real users — the only gate that matters is 50+ WAU.** | **Open — the critical path.** Instrumentation done; traffic is the gap (§2.1). |
| 2 | Cost / latency levers. | Partly shipped — seed-wallet 12h gate landed; the non-wave wallet-backfill driver is still queued. |
| 3 | Durable debt. | Partly shipped — the hydration view was fixed; profile consolidation, mobile polish, monolith refactors remain. |
| 4 | Chain two, **readiness-gated** (not sequence-gated — the old "one at a time, Candy-first" rule is retired). | Both Candy and Panini are live programs blocked on non-code gates (§2.8). |

**Standing guardrails from the roadmap:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200** (streaming shells always return 200); and **before gating/short-circuiting any route, enumerate EVERY caller** (cron-job.org, GHA, `vercel.json`, pg_cron, in-repo fetches) — the 07-18 seed-wallet gate silently no-op'd the GHA backstop because the caller sweep stopped at cron-job.org.

**Housekeeping still outstanding:** the old Priority #1 (Flowty teardown) is **obsolete** — the API is alive and feeds live ingest; formally close it in `CLAUDE.md` rather than leaving it as a standing action.

---

## 5. In-code TODO inventory

A first-hand scan (`grep -rn 'TODO|FIXME|HACK|XXX'` over `*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`, excluding `node_modules`/`.next`/`.git`) returned **71 raw matches across 40 files**. Excluding **3 hard false positives**, **4 vendored third-party contract markers**, **7 descriptive test references**, and **23 resolved-annotation / discovery-tool lines** (all itemized in §8) leaves **34 real actionable markers across 26 files** — **−25 vs last week's 59.** Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — count unchanged, **status changed**

Every relocated Flow primitive left a one-line re-export shim at its old path. **17 of 18 now read** `// TODO(chain-rename): in-repo callers all repointed to @/lib/chains/flow/… (2026-07-19) — delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/wallet-backfill-helpers.ts`, `lib/dapper-v1-tx-decode.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest cluster, but the *work* is done: **all 18 are zero-caller** (verified — `lib/dapper-v1-tx-decode.ts` returns 0 in-repo importers). Deletion is explicitly **gated on chain two shipping**. Minor inconsistency: `lib/dapper-v1-tx-decode.ts:2` still carries the *old* "repoint callers" wording while the other 17 were updated — cosmetic only.

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files) — unchanged

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs, fronted by `ensureLive()` so they throw rather than return fake tx ids.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI shows `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3). Note the *contract* side advanced: `cadence/tests/RPCTradeEscrow_test.cdc` is 16/16 green and in CI.

### 5c. `special-serial-sweep` ownership lookup (0 markers) — unchanged, still resolved

All four collection legs resolve owners (TopShot via `getMintedMoment`, AllDay/Golazos/UFC via `lookupOwnerFromWmc`). A whole-tree scan of `supabase/functions/` returns zero markers.

### 5d. Pipeline calibration (1 marker, 1 file) — unchanged

- `app/api/rtr/lock-roi/route.ts:180` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder. (Moved from `:156` — the file grew with the PostgREST-cap paging fix.)

### 5e. Smaller data-quality / polish TODOs (1 marker, 1 file) — **−2 this week**

- `app/api/pinnacle-wallet/route.ts:76` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands. **Still present.**
- ~~`components/collection/CollectionMomentTable.tsx:730`~~ — **RESOLVED.** The `team_name`-from-UUID-editions problem was fixed at the data layer by migration `20260713050000_audit_20260713_wmc_team_name_denorm.sql`, whose header explicitly records "was a TODO in components/collection/CollectionMomentTable.tsx."
- ~~`scripts/ingest-topshot-active-listings.mjs:126`~~ — **RESOLVED.** `listing_url` is now populated with the confirmed dapper.market format (`/nba/moment/<nftId>`).

### 5f. Cadence test coverage gap (0 markers) — **−2 this week (cluster resolved)**

- `cadence/tests/RPCTradeEscrow_test.cdc` — **zero TODO/FIXME markers remain** (verified by direct count). Scenario 14 (`testTypeMismatchRejected`) was implemented via a new committed fixture contract `cadence/tests/contracts/ExampleNFT2.cdc` (registered in `cadence/tests/flow.test.json`), and `testReceiverCapInvalidation` was implemented using Cadence 1.0 capability controllers. The suite runs **16/16 green** and is now a **CI job** (`cadence-escrow-tests`).

### 5g. Candy / Solana chain-two discovery placeholders (0 actionable) — **−17 this week (cluster resolved)**

**The whole block is filled.** `lib/chains/solana/normalize.ts` now exports real values (verified by reading the file): `CANDY_MLB_COLLECTION_ADDRESS = "JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n"`, `CANDY_MLB_ME_SYMBOL = "2026_mlb_base_series_icons_candy_digital"`, `SERIAL_ATTR_KEY = "serial_number"`, `EDITION_SIZE_ATTR_KEY = "Serial Number"`, and a resolved edition-key derivation. The lines the scan still matches are **`TODO_3/4/5 RESOLVED` annotations** plus the permanent `.startsWith("TODO_")` route guards (which stay by design as a safety net) — none are actionable. The two route-level "is a TODO placeholder" strings (`candy-sales-indexer:133`, `candy-editions:93`) are now unreachable-in-practice guard messages. `scripts/candy-discovery.mjs` (13 matched lines) is the discovery tool that *produced* these values — a spent instrument, safe to keep or archive.

### 5h. Panini discovery placeholders (6 markers, 4 files) — **−4 this week**

- **Live surface: 0 markers.** `lib/chains/panini/feed.ts` (3 markers) and the two inert cron routes (`panini-circulation-refresh:107`, `panini-fmv-recalc:82`) are **gone** — the superseded pull-model scaffolding was retired (`45038b8a`), leaving `lib/chains/panini/ingest-normalize.ts`.
- **Remaining (reference/draft only):** `docs/drafts/panini/ingest-panini-runner.mjs` (lines 16, 29, 33), `docs/drafts/panini/panini-ingest-route.ts:137`, `docs/drafts/panini/panini-proxy/index.js:19`, and `scripts/ingest-panini-runner.mjs:16` (the LIVE runner's header comment referencing the grid-enumeration capture).
- **Note:** the `scripts/ingest-panini-runner.mjs:16` marker is arguably **stale** — the enumeration question was resolved on 07-19 (Panini exposes no full-checklist route; branch 2b "accept + disclose" was adopted and the disclosure is now structural). Worth a one-line comment update rather than work.

> **Net change since last week:** **−25 real markers / −8 files** (59/34 → 34/26). Four clusters resolved: §5g Candy 17→0 (discovery complete + ingested), §5f Cadence-test 2→0 (suite green + in CI), §5h Panini live-scaffold 5→0 (pull-model retired), §5e 3→1 (wmc `team_name` denorm + `listing_url` both landed). §5a and §5b are line-identical to last week, though §5a's *status* changed materially (all 18 shims now zero-caller).

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/metrics-latest.json`:

**Known-issue slate (carried, all still resolved):** #2 (Sentry — DSN set, 0 unresolved), #3 (Flowty event indexer — reclassified: frontend shut, API alive and feeding live ingest), #4 (Pinnacle FMV — per-render engine primary), #5 (AllDay/UFC mis-categorized — only 8 stray), #6 (WarmupContext key — `lib/warmup/WarmupContext.tsx` verified present), #7 (AllDay `unmapped_sales` — resolver rewritten; **premise re-disproven this week**, drains ~7,028/24h with 0 unresolved <30d), #8 (NBA projections — syncing), #13 (`flowty_archive` growth — pruned), #15 (scratch fixtures — none tracked), #16 (`flow test` CI — blocking), plus the fmv-recalc silent stall.

**Newly resolved / closed this week:**
- **PUBLIC GO-LIVE — SHIPPED (07-17)** and browser-verified. The read-only feature tabs are anonymous for the 5 published Flow collections.
- **Confidentiality exposure — FIXED (07-19).** 17 pre-launch objects + `editions_unified` revoked from `anon`/`authenticated`; verified 0/17 readable; zero breakage.
- **Candy chain-two discovery — COMPLETE.** All 5 `TODO_N` placeholders filled; 125 editions / 25,375 serials ingested; ghost-owner purge + daily self-heal; ME sales and best-offer indexers live.
- **Cadence escrow test suite — 16/16 GREEN and promoted into CI**; zero test TODOs remain; two latent compile blockers fixed in the undeployed contract.
- **DB-invariant SQL test layer + `db-tests` CI job — SHIPPED** (13 files, 12 pins, drift guard).
- **`ledger-guard` CI job — SHIPPED**, after a commit silently destroyed 13 ledger entries (restored).
- **PostgREST 1000-cap class — swept** from `rtr/lock-roi`, `/api/market`, `/api/sets-db` (indirectly), and `/api/profile/market-pulse`; each with a proven regression test.
- **3-month-old Golazos sets-db completion bug — FIXED** (0 owned / 0% since 2026-04-14).
- **Breaks hot-wallet signing bug — FIXED** (p256+SHA3 → secp256k1+SHA2, verified cryptographically).
- **All 18 chain-rename shims — now zero-caller** (deletion gated on chain two).
- **`analytics_sales_summary` + `v_moments_needing_hydration` disk-reader rewrites** — the #1 and #3 readers (the latter 237 MB → 1.5 MB/call, and the standing "only a trigger-maintained queue can fix it" premise **disproven**).
- **CI-status monitoring gap — closed** (ops-monitor now reads GH Actions conclusions; `main` had sat red ~24h undetected).
- **Bash/git sandbox — RECOVERED** (the escalating 2-night item from last week's report).
- **IA reorg, Market/Sniper reframe, wallet Packs/Moments sub-tabs, AllDay lock-refresh scheduler, external pack-drop pricing engine, `sales-counterparty-backfill` worker — all SHIPPED.**
- **`badge_editions.low_ask` — AllDay leg RESOLVED** (69.5%, live 30-min cron). The deferred-hardening note was stale.

---

## 7. Suggested sequence

A pragmatic order under the **post-launch** framing (`docs/strategy/roadmap-2026-07-18.md`):

1. **Drive traffic to the now-public site (§2.1).** The only gate that matters is 50+ WAU. Instrumentation is done and says 31 sessions/7d — the assets (28 sitemapped insights boards, OG cards, a working concierge, live alert loops) exist and are idle. Pick one channel and run it.
2. **Finish the confidentiality audit (§2.4).** The Panini/Candy exposure proved that route-gating ≠ data-gating. Sweep every *other* surface staged behind a `proxy.ts` line with a `SET LOCAL ROLE anon` probe, and remember `check_secdef_anon_execute_violations()` only watches a hardcoded 9-function allowlist.
3. **Make the two Panini/Candy calls (§2.8).** Panini: the editorial decision on bridging a ~46%-coverage listing-gated index into the shared catalog (go-live is one `proxy.ts:127` line + sitemap/hub links, ordered *after* the un-gate, plus `PANINI-SET-RPC-BRANCH`). Candy: nothing to decide until a first printed sale exists — the indexers will capture it automatically.
4. **Clear the small operator items (§2.6).** Restore the `pinnacle-sync` catalog-half trigger (or give it the pg_cron backstop the FMV half got); **force a real v13-POST rebuild** to actually bake `DUNE_SALES_INGEST_QUERY_ID` (an empty or docs-only commit can never do it); set `DUNE_SALES_SELLER_QUERY_ID`.
5. **Refresh the autonomous-pass steering (§2.5).** `docs/overnight/focus.md` is 26 days stale and still describes a June program as current — actively misleading now that the product has launched. Drain the 5 pending inbox ticks.
6. **Let the correctness work soak (§2.3).** Keep the per-collection `*_fmv_stale_hours` tripwires in the weekly check; watch the sales-counterparty drain; confirm the TS FMV redistribution stays flat.
7. **Cost / IOPS posture (§2.6).** DB improved this week, but IOPS on the Micro instance is the binding constraint behind the statement-timeout family — keep the read-diet discipline and do the Vercel Spend-Management cap backstop regardless.
8. **Chain-foundation + debt tails as capacity allows.** The 18 shims are zero-caller and safe to delete the moment chain two ships. Then `/dashboard` (#10, 2,360 lines) and the page/brand tail (#17, #11).

---

## 8. Notes from verification

- **Git WAS available this run** (the sandbox recovered). `git log --since=2026-07-13` → **488 commits**; `git diff --stat` → **594 files changed, +55,458 / −3,596**. Per-day: 07-13 **41** · 07-14 **4** · 07-15 **6** · 07-16 **93** · 07-17 **132** · 07-18 **96** · 07-19 **100** · 07-20 **16**. Directories touched most: `docs` (383), `__tests__` (293), `app` (232), `lib` (54), `CLAUDE.md` (45), `supabase` (38). **17** migration files landed via git (more were applied directly via MCP, which is normal for this repo).
- **Line counts are real `wc -l`** this run: `app/(collections)/[collection]/collection/page.tsx` **1,618** · `app/(collections)/[collection]/sniper/page.tsx` **1,691** · `app/dashboard/page.tsx` **2,360** · `app/(analytics)/analytics/page.tsx` **495** · `lib/blazers-trivia.ts` **198**.
- **Stale figures in `CLAUDE.md` #14** — it still lists collection ~2,900 / sniper ~2,070 / analytics ~2,208. All three are wrong (actual 1,618 / 1,691 / 495). Recommend correcting.
- **One genuinely stale path reference found.** `CLAUDE.md` known-issue #3 cites **`RPCTradeEscrow_DEPLOYMENT.md`**, which does **not** exist at that name — the file was relocated to **`docs/trade-escrow/DEPLOYMENT.md`** (alongside `STATUS.md` and `CADENCE_TEST_RECONCILIATION.md`). Every other cited path resolved.
- **TODO scan: 71 raw matches / 40 files → 34 real markers / 26 files.** Exclusions:
  - **3 hard false positives** (unchanged): `lib/format.ts:6` (`"$X,XXX.XX"`), `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` (`audit_2026XXXX_`), `supabase/migrations/20260624162548_….sql:6` (`numeric_numeric_recXXX`).
  - **4 vendored third-party contract markers (NEW category):** `cadence/contracts/imports/ExampleNFT.cdc:366` (upstream Flow example contract, pinned v1.2.2 as an escrow-test dep) and `imports/edf9df96c92f4595/Pinnacle.cdc` (×3 — Disney's own deployed contract source, fetched for Cadence verification). Not RPC-authored; not actionable.
  - **7 descriptive test references:** `__tests__/api-candy-sales-indexer-deep.test.ts:123`, `api-ingest-candy-offers-deep.test.ts:104`, `api-wallet-backfill-candy.test.ts:22`, `solana-normalize.test.ts:114,116,117,118` — assertions that the `TODO_`-prefix guards behave, not markers.
  - **23 resolved-annotation / discovery-tool lines:** `lib/chains/solana/normalize.ts` ×7 (four `TODO_N RESOLVED` notes + three permanent guard lines), `scripts/candy-discovery.mjs` ×13 (the tool that produced the now-filled values), the two route guard strings, and `supabase/migrations/20260713050000_….sql:4` (which *records* a resolved TODO).
- **Cluster resolutions were verified by reading the files, not inferred.** `lib/chains/solana/normalize.ts` exports real Candy values (collection address, ME symbol, serial attr key) — confirmed by direct grep of the export lines. `cadence/tests/RPCTradeEscrow_test.cdc` returns a TODO/FIXME count of **0**. `lib/chains/panini/feed.ts` is **absent** (dir now holds `ingest-normalize.ts`). `lib/dapper-v1-tx-decode.ts` has **0** in-repo importers.
- **CI: 6 blocking jobs verified** in `.github/workflows/ci.yml`: `typecheck`, `cadence-lint`, `cadence-escrow-tests`, `unit-tests`, `db-tests`, `ledger-guard`. **13** `supabase/tests/*.sql` invariant files. **751** test files under `__tests__/`. **16** worker dirs under `workers/`. **32** `"schedule"` entries in `vercel.json`. All match `CLAUDE.md`'s stated figures.
- **Coverage ratchet read directly from `vitest.config.ts`:** thresholds **75.5 / 60.6 / 80.9 / 78.0**, with the in-file comment history recording live actuals of **75.64 / 60.83 / 81.09 / 78.24** as of a 2026-07-20 pass. Note these are *higher* than the 74.7/59.6/79.8/77.3 quoted in `CLAUDE.md` — two further ratchet bumps landed on 07-20 after that prose was written. `CLAUDE.md` is one wave behind here.
- **`/insights`: 28 sitemapped routes** (`INSIGHT_ROUTES` in `lib/sitemap-data.ts`, counted directly) vs **29 built surface dirs** in `app/insights/`. The delta is `panini-squeeze` — built, deliberately un-sitemapped, gated at `proxy.ts:127` (verified: the regex matches page, public JSON, and OG card).
- **No active freeze.** `docs/FREEZE.md` verified absent.
- **`docs/overnight/focus.md` is 26 days stale** (dated 2026-06-24, last modified Jun 30) and describes a June deep-history program as the current priority. `docs/overnight/inbox/` holds **5** undrained ticks. `docs/overnight/ledger.md` has **413** `### ` entries.
- **DB-side facts** (FMV counts, editions, DB size 10,054 MB, trust 15 metrics/0 breaches, security 0/0/0/0, sentinel 0, `impossible_parallel` 0, `edition_integrity_flags` 5, Sentry 0, artifacts 17, funnel_events 23/24h) come from **`docs/overnight/metrics-latest.json` (2026-07-19T08:03:06Z — one day old)** plus `CLAUDE.md`'s 07-19/07-20 entries. They were **not** independently re-queried against production Supabase this run, consistent with prior reports.
- **Autonomous-task caveat:** the daytime monitor and night pass run against this repo, so the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-07-20)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | Wallet verification | Open | **Open** — listing-challenge path live; Dapper-dev path blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant (present) |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; 0 unresolved/24h per metrics |
| 3 | Flowty event indexer **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty resolved; Trade Hub shelved + guarded, **contract suite now 16/16 in CI** | `ensureLive()` + 503 routes + `TradeHubClient.tsx` present; `cadence-escrow-tests` job present |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine primary; grain-migration Phase 1 shipped | `pinnacle_fmv_history` live |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `lib/warmup/WarmupContext.tsx` present |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved — premise re-disproven 07-17** (drains ~7,028/24h, 0 unresolved <30d; residual 2,466 is a frozen pre-rewrite tail) | `CLAUDE.md` + ledger |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — `scan-historical-storefront.mjs` present (manual); `cleanup-storefront-wallets.mjs` + `cleanup.cdc` correctly absent | `ls` verified |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **2,360** lines (unchanged) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — token sweep complete; CI guard present | `scripts/check-brand-tokens.mjs` present |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open — roughly flat this week** — collection **1,618** (+89) / sniper **1,691** (−21) / analytics **495**. **All three `CLAUDE.md` figures are STALE** | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | prior runs |
| 16 | `flow test` in CI | Resolved | **Resolved — and expanded**: `cadence-lint` **plus** a new `cadence-escrow-tests` job | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — IA reorg + wallet sub-tabs + soft-404 hardening landed this week** | audit docs present; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (#0, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **public go-live**, **test-coverage + DB-invariant infrastructure**, **Candy chain-two data layer**, **Panini runner + gated surface**, **bulk-buy intelligence**, **challenges**, **alerts + Rewards**, and the 28 public `/insights` surfaces.

**Bottom line for `CLAUDE.md`:** the numbering is unchanged and several recurring recommendations still stand, plus new ones from this week: (a) **resolve the #3 numbering collision** — give Trade Hub a fresh number (e.g. #18); (b) **correct #14's line counts** — all three are stale (actual 1,618 / 1,691 / 495); (c) **fix the one stale path** — #3 cites `RPCTradeEscrow_DEPLOYMENT.md`, now at `docs/trade-escrow/DEPLOYMENT.md`; (d) **the coverage figures are one wave behind** — the ratchet is 75.5/60.6/80.9/78.0, not 74.7/59.6/79.8/77.3; (e) **formally close the obsolete Flowty priority**; (f) give numbered slots to the live-but-unnumbered features (go-live, test infra, Candy, Panini); (g) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 zero-caller shims and 8 Trade Hub stubs are the only real clusters left and are worth a one-line note; (h) **the `badge_editions.low_ask` deferred-hardening note is stale for AllDay** (resolved, 69.5%) — only Golazos remains. And the top-line framing has genuinely changed: with the site now **public** and instrumentation **verified**, the standing recommendation is no longer "measure activation" but **"generate demand"** — 31 sessions/7d against a 50+ WAU gate is the number that decides everything else.
