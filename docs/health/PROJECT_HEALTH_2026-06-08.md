# Rip Packs City — Project Health Report

**Date:** 2026-06-08
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` (Known Issues §, Prioritized Next Actions §, Deferred Hardening §, Architecture Notes §, Chain Strategy §, Recent Sessions §), `docs/overnight/ledger.md` (live autonomous-pass state), a gitignore-aware `TODO/FIXME/HACK/XXX` scan of the source tree, and `git log` (available and reliable this run).
**Scope:** A single consolidated, themed view of open work — the known-issue slots (now `#0–#17` after a new `#0` Wallet-verification item), the prioritized actions, the overnight operational queue (cron / Q / N / DUPE / PIN items), and 39 in-code TODO markers — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-06-03.md` (5 days ago). This regeneration mirrors its structure. `PROJECT_HEALTH_2026-06-01.md`, `_2026-05-30.md`, `_2026-05-25.md`, and `_2026-05-22.md` are also present.

> **Report location — the relocation actually happened.** Last week's report flagged that the older `PROJECT_HEALTH_*.md` reports were *still in the repo root* despite the brief saying they'd been relocated. **This week that is resolved:** the repo root is clean (0 `PROJECT_HEALTH_*` files there) and all five prior reports live in `docs/health/`. This report is written there too.

> This is a snapshot. `CLAUDE.md` remains the source of truth for project memory; `docs/overnight/ledger.md` is the source of truth for what the autonomous passes shipped/queued/declined. This doc reorganizes both for triage and adds an in-code TODO inventory neither tracks. **Severity and effort tags throughout are suggestions, not gospel.**

> **Biggest change since the 2026-06-03 report — the busiest week in the project's history: ~132 commits since 2026-06-04 (≈148 code files / ≈154 docs files touched), vs ~30 last week.** Five large workstreams landed, all advancing the intelligence-first / activation framing: **(1) A whole new feature — the off-chain Rewards points economy** (June 4, `c689771`→`830bfdb`→`7ede297`→`cc82283` + June-7 waves `b569b56`/`5795518`). Two-number system (Status tier + spendable Credits), 11 `audit_20260604_rewards_*` migrations, auth-gated `/rewards` hub + admin console, earn hooks on verify/profile/visit. Live end-to-end, status **DIAL-IN** (store stocking awaits Trevor's Moment picks; raffle held pending legal review). Not in any numbered known-issue slot. **(2) Wallet verification rebuilt as an on-demand listing challenge** (June 7, `6c09e36`/`ba8a28e`) — now tracked as new `CLAUDE.md` known-issue **#0**; RPC picks a cheap Moment, the user lists it at an unbuyable price, and a live GQL check (`/api/profile/verify-challenge/check`) confirms + awards credits. Dapper-developer "Sign in with Dapper" is still gated (request pending). **(3) Pinnacle per-render FMV re-architecture** (June 6–7) — the headline FMV-correctness work: an additive per-render engine on `pinnacle_catalog` (`a4c6bb5`), `render_id` re-key of catalog/sales/wmc (`2e8cbd1`/`32f0bf1`), and reader-cutover waves 1a/1b/2 shipped; the formerly-blended Kylo Ren Digital-Display now prices $277.67 vs set-mates $23–33 (~16× spread). **(4) Top Shot + AllDay on-chain offers indexers** (June 3, `91ac5e1`/`cc8a3e7`) → `offers` + `edition_offers` (depth / identity / fill intelligence; closes the AllDay best-offer gap). **(5) The full SEO server-render wave** (June 5, `39983de`→`56c61d8`) — every `/insights` board now server-renders for crawlers, plus an internal-linking pass.

> **Plus two operational close-outs:** the **full 21-job cron stagger** landed and was server-verified (June 7) — root-causing the recurring rush-window DB saturation (**I1 RESOLVED**) to the `:00/:20/:40` cron-job.org anchor pile-up, not a writer bug; and a **3-broken-sentinel-check repair** (`87f5f83`) that had the `Pipeline Sentinel` GHA crying CRITICAL on every run while masking the real TS-UUID tripwire. The weekly-maintenance DB function was also fixed (it had been silently timing out and failing the Saturday cleanup for ≥1 week).

> **Traction reality (carried forward — no fresh snapshot this run).** The last logged traction read (2026-05-31, in the ledger) was **~13 total users, 0 signups in 7 days (last May 9), 0 outbound clicks in 30+ days, ~1 real concierge conversation/week.** RPC is deeply pre-traction. A large amount of *activation machinery* shipped since (the Rewards economy, wallet verification, SEO server-render + internal linking, honest `/pricing`), but **whether any of it has moved signups off zero is not yet measured.** Monetization remains explicitly tabled until 50+ WAU, so there are **0 revenue-blocking items by design**; the live lever is *activation* — and now *measurement* of the activation features just built.

> **Platform context (unchanged, still material).** **(1) Flowty shut down its marketplace (~2026-05-13)** — Flowty-dependent infra is frozen; the teardown DECISION is "keep frozen, close Priority #1" (`docs/cleanup-decisions-2026-06-01.md`). This week extended the historical-framing to the public `/analytics` Flowty surfaces (`9912094`). **(2) NFL All Day ended primary pack sales** — AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only.

> **Operational reality — autonomous Cowork tasks.** `rpc-daytime-monitor` (read-only sweeps, ~every 3h) and `rpc-nightly-autonomous-pass` (1am, ships ≤4 low-risk changes) run against this repo; shared state is in `docs/overnight/` (`ledger.md`, `inbox/`, `metrics-latest.json`, `focus.md`, `.lock`). `docs/FREEZE.md` halts all autonomous shipping (absent right now = no freeze active). The **2026-06-08 night pass fired in-window (~01:02 PDT) but NO-PUSH** (scheduled sandbox has no GitHub creds; the bot clone is unmounted) — shipping nothing, reverting nothing, with the whole 06-07-evening Claude Code wave verified green. **Check `docs/overnight/ledger.md` before acting** — items below may move without a human in the loop.

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#17** | **NEW `#0` Wallet verification** added this week. `#3` is still double-assigned — "Flowty event indexer" (resolved) + "Trade Hub" (shelved). See §9. |
| Known issues — resolved | 10 | #2, #3 (Flowty indexer), #4, #5, #6, #7, #8, #13, #15, #16 (+ the fmv-recalc silent stall) — see §6 / §9 |
| Known issues — open / partial | **6** | **#0 (new)**, #10, #11, #12, #14, #17 — see §3 / §9 |
| Known issues — shelved by decision | 2 | #1 Cart; #3 Trade Hub (guarded) |
| Known issues — retired | 1 | #9 Storefront audit pipeline — cleanup machinery deleted 2026-06-02/03 |
| Net-new shipped features (not numbered) | **5** | Rewards points economy; Pinnacle per-render FMV engine; TS + AllDay on-chain offers indexers; SEO server-render wave; pack-viz/pack-dist honesty (§2.2 / §2.3 / §2.7) |
| Open overnight operational items | **~14** | LISTCACHE-CRON-DROP (new), N1, P3-BUYERS, PIN-SYNC-CRON, L1, CRON-30S 3/4, Q2 (cron family); DUPE1 + B2 (FMV writer); N2 (hydrator timeout); Q5/SMOKE-EDITION-TIMEOUT (smoke); PIN1, Q6; Q7 (git infra) — see §2.6 |
| Net-new structural workstream | 1 | Multi-chain chain-abstraction — Phases A–F complete; 18 Phase-D shim TODOs remain — see §2.8 |
| Prioritized next actions | 2 | Both data-intelligence / housekeeping; Priority #1 (Flowty) recommended-closed (keep frozen) |
| In-code TODO markers | **39 across 29 files** | **0 delta vs last week.** 2 false positives excluded — see §5 / §8 |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU |

**Health read:** Operationally stable through an unusually large, feature-heavy week. The platform's dominant concern is unchanged: **activation/traction** (≈13 users at last read) over any single code defect — but the calculus shifted, because the week shipped a genuine acquisition/retention surface (the Rewards economy) plus wallet verification and an SEO server-render wave, so the question is now *"does the new activation machinery work?"* rather than *"is the funnel even open?"*. Code-quality risk is concentrated in four places, descending: **(1) FMV correctness** — still the core intelligence asset; the lens this week was Pinnacle per-render pricing (a real fix, ~16× spreads recovered) plus the persistent **DUPE1** inert-UUID re-mint whose durable fix is off-limits worker code (Item B2); **(2) cron/external-trigger reliability** — the stagger closed I1, but a new whole-family `topshot-listing-cache` tick dropout (LISTCACHE-CRON-DROP) plus N1/P3-BUYERS/PIN-SYNC-CRON show cron-job.org dropouts are a recurring class; **(3) the git-infra fragility** (Q7) that keeps the night pass NO-PUSH; **(4) the chain-abstraction cleanup tail** — 18 unchanged re-export shims. Everything else (monolith refactors, brand polish, page tune-ups) remains genuinely secondary.

### Themes

| Theme | Items |
|---|---|
| Conversion / activation (the real critical path) | **NEW this week: Rewards points economy** (live, DIAL-IN) + **wallet verification rebuild** (#0) + **SEO server-render wave** + honest `/pricing` (`1514a7c`). Verify `funnel_events` is accumulating; measure whether signups move off zero. (§2.1) |
| Data-intelligence quality | Pinnacle per-render FMV engine + reader-cutover waves (§2.3); TS + AllDay on-chain offers indexers; FMV accuracy cluster (A1 pagination keystone, A2 ask-corroboration, F2/F4); DUPE1 inert-UUID re-mint (§2.6) |
| Housekeeping — dead infrastructure | Flowty teardown DECISION = keep frozen (§2.5); `/analytics` Flowty surfaces reframed historical (`9912094`); storefront-cleanup machinery deleted + payer wallet/cron paused (#9 / N3); dead `PinnacleSniper.tsx` deleted (`980b6f1`) |
| Operational / overnight queue | Cron-family reliability (LISTCACHE-CRON-DROP, N1, P3-BUYERS, PIN-SYNC-CRON, L1, CRON-30S, Q2); DUPE1; N2 hydrator timeout; Q5/SMOKE-EDITION-TIMEOUT; PIN1; Q6; Q7 git infra (§2.6) |
| Multi-chain foundation | Chain-abstraction Phases A–F complete; 18 Phase-D shim TODOs (§5a) |
| Tech debt / refactor | `/dashboard` migration (#10, now **1,681 lines** — shrank ~99 from dead-code drop); monolith pages (#14); scratch fixtures (#15, resolved) |
| Page polish | Pack/Moment/Set tune-up (#17 — pack-dist math/honesty + TS-screenshot history parity shipped); brand punch list (#11 — phase-1 token sweep + CI guard shipped); Blazers trivia (#12) |
| Stalled / scaffolded features | Trade Hub (#3, shelved + guarded); Cart (#1, shelved by decision) |
| Deferred hardening (intentional) | Public INSERT-policy tables, `owner_key`→`user_id` migration, `badge_editions.low_ask` gap |

---

## 2. Critical path — start here

Intelligence-first with revenue shelved by decision. Given the traction reality, **activation leads** (now that a real activation surface — Rewards — exists and needs measurement), followed by FMV correctness and the usual housekeeping/operational workstreams.

### 2.1 Conversion / activation — now has real machinery to measure — `Severity: High · Effort: Medium (shipped, unmeasured)`

The primary funnel leak (logged-out CTAs → `/login`) was fixed weeks ago; entity pages, `/share`, `/overview`, `/insights`, and `/api/og/*` are anon-public and the live sitemap emits ~33K URLs. This week the activation story went from "funnel open, verify it" to "a full acquisition/retention layer shipped":

- **Rewards points economy (NET-NEW, `c689771`→`cc82283` + waves).** An off-chain two-number system — **Status** (only rises; tiers Rookie/Role Player/Starter/All-Star/Franchise) and spendable **Credits** — with prizes = Pro time / cosmetics / raffle (held) / Moments / merch. 11 `audit_20260604_rewards_*` migrations, auth-gated `/rewards` hub, admin console (`/admin/rewards`), and earn hooks on wallet-link / referral / favorite-team / complete-profile / daily-visit / share-profile. **Security invariant (verified): no user-writable points path** — all mutations via service-role-only SECDEF fns with a session-resolved user id and no amount-taking endpoint; the verified-wallet redeem gate is the sybil guard. **Status: DIAL-IN** — store stocking awaits Trevor's Moment picks (`add_moment_shop_item`); raffle items held pending legal review of `docs/rewards-raffle-official-rules-DRAFT.md`.
- **Wallet verification rebuild (#0, `6c09e36`/`ba8a28e`).** On-demand listing challenge: RPC server-picks a cheap Moment, the user lists it at a unique ~100×/$10-floor (unbuyable) price, and `/api/profile/verify-challenge/check` live-confirms via the topshot-proxy GQL then awards +500 credits via `resolve_wallet_challenge_match`. Interim fallback is owner-attested `admin_verify_wallet`. The old `cached_listings`-based cron matcher is dead (frozen data) but left harmless.
- **SEO server-render wave (`39983de`→`56c61d8`, `549ddfa`).** Every `/insights` board (squeeze, rookies, deals, first-mint, set-squeeze, offer-spread, pinnacle-scarcity, market, cross-collection) now server-renders for crawlers; an internal-linking pass wired footer hubs + insights↔entity links + `/moment` canonicals.
- **Honest `/pricing` + click tracking (`1514a7c`).** Beta page + pack-CTA outbound click tracking + 2026-06 concierge knowledge.

Suggested next step: confirm `funnel_events` is recording anon top-of-funnel; instrument/observe Rewards engagement (sign-ups, daily-visit earns, redemptions); decide store stocking + raffle legal so the Rewards loop is fully live. This is the highest-leverage work and is arguably worth promoting to an explicit `CLAUDE.md` prioritized action.

### 2.2 Public intelligence surfaces — still expanding — `Severity: n/a (shipped) · context`

Directly advances Prioritized Action #2.

- **`/insights` hub — holds at 12 surfaces** (`squeeze`, `pack-reality`, `rookies`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `market`, `offer-spread`, `deals`, `squeeze-check`, `tc-report` — verified against `INSIGHT_ROUTES` in `app/sitemap.ts` and both the page-dir and API-route listings). `/insights/deals` went cross-collection (TS + Pinnacle render-spine, `9d5113c`).
- **TS + AllDay on-chain offers indexers (`91ac5e1`, `cc8a3e7`).** New `offers` (Top Shot: depth/identity/type/fill) + `edition_offers` (AllDay best-offer cell). This closes the AllDay best-offer "data gap" properly with a real on-chain source.
- **OG cards now 14 routes** (added `share`, `b3dae3d` — the `/share` OG was previously a 0-byte/500 PNG): `collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `share`, `team`.
- **Pack/moment TS-screenshot history parity (`81f686f`).** Pack content-remaining + sales history, edition special serials, moment serial highlight — bringing RPC's entity pages to parity with Top Shot's own surfaces.

No open defects tracked here; listed because it is a large body of *shipped* product work.

### 2.3 FMV pipeline — Pinnacle per-render correctness shipped — `Severity: Medium · Effort: Medium`

The FMV story this week was a Pinnacle re-architecture plus an accuracy cluster:

- **Pinnacle per-render FMV engine (PIN-FMV-REKEY).** Pinnacle FMV had been *blended* across all renders of an edition_key, badly mispricing chasers/variants. Shipped additively (`a4c6bb5` + `audit_20260606_pinnacle_render_fmv_engine_additive`): render-keyed FMV columns on `pinnacle_catalog` beside `floor_ask`; `render_id` re-key of catalog/sales/wmc (`2e8cbd1`, `32f0bf1` — `pinnacle_sales` now 100% render-keyed); legacy `pinnacle_fmv_snapshots` left live so **zero of ~40 readers broke**. Reader cutover **waves 1a/1b/2 shipped** (wmc/dashboard/share/profile per-render; scarcity board + pin pages render-keyed; 13 entity fns + analytics swapped; concierge reads per-render). Verified: Kylo Ren Digital-Display **$277.67 vs set-mates $23–33** (was one blended number). **Remaining (queued, Trevor-sequenced): PIN-FMV-REKEY-WAVES 2/3** — the last entity/stats/route readers, then retire legacy `pinnacle_fmv_snapshots` + its writer at zero readers; after 48h cadence, watchlist `pinnacle-fmv-recalc`.
- **Pinnacle legacy-FMV retirement (`0769091`/`26fc9f3`).** `pinnacle-sync` repointed off the dead Flowty FMV legs to `pinnacle_refresh_editions_ask`; dead `PinnacleSniper.tsx` deleted (`980b6f1`, last legacy-table type ref).
- **FMV accuracy cluster (June 4).** **A1 keystone (`1c5ccf5`)** — paginate the Step-1 sales re-fetch past PostgREST's 1,000-row cap (the same class as the May silent stall); **A1 (`bf4cbd5`)** — Step-6 stale-touch must skip traded editions (Cause-B fossils); **A2 (`b8a0a49`)** — lift LOW→MEDIUM when sales median agrees with live ask; **F2 (`d881a75`)** — `edition_offers` ASK fallback for the zero-sales NO_DATA tail; **F4 (`fd61038`)** — shared FMV-basis renderer + methodology-linked confidence chip.
- **Carryover (still valid):** the Top Shot NO_DATA tail remains *structural* (most NO_DATA editions have no recent sale) — the coverage lever is a primary listings/ask feed, not throughput. The June-3 mis-key sweep (F2–F5 + `v_fmv_sanity_flags`) and the silent-stall/Step-6/batched-RPC fixes all remain shipped.

Suggested next step: finish PIN-FMV-REKEY waves 2/3 and retire the legacy Pinnacle FMV table; wire `v_fmv_sanity_flags` into the weekly health check (still an open operator TODO); keep the DUPE1 writer fix (B2, §2.6) on the radar as the durable cure for inert-UUID NO_DATA inflation.

### 2.4 Smoke / sentinel reliability — three broken health checks repaired — `Severity: Medium (was masking) · Effort: Small (shipped)`

`87f5f83` (June 7) fixed three checks in the `Pipeline Sentinel` GHA that were CRITICAL on *every* run from their own bugs — masking the real TS-UUID tripwire: (1) **Sniper Feed** self-fetched with no auth → 307→login HTML → `res.json()` threw (added Bearer auth); (2) **Edition Coverage** divided *all* `fmv_snapshots` history by edition count → "2105.7%" dead detector (now uses `sentinel_fmv_confidence_rows()` distinct-per-edition → 100%); (3) **FMV Confidence** lumped all collections + ~6.4k inert TS dupes into one denominator → permanently-scary 2.8% (re-scoped to canonical TS via new `sentinel_fmv_confidence_canonical_ts()` → HIGH 5.8% / HIGH+MED 32.1%). Verified via `workflow_dispatch` 2026-06-08 00:04Z. Two new smoke-calibration follow-ups were queued from this work (Q5 sales-lag, SMOKE-EDITION-TIMEOUT — §2.6).

### 2.5 Flowty teardown (Prioritized action #1) — DECISION made: keep frozen — `Severity: Low · Effort: n/a`

Not a teardown task. `docs/cleanup-decisions-2026-06-01.md` concludes **keep frozen, close Priority #1**: the `flowty_*` tables (~40–45MB) and the `offers` RPC back *live* admin Flowty-analytics surfaces, so nothing is safe to drop. This week the public `/analytics` Flowty loan/listing/wallet surfaces were reframed as a historical archive (badge, titles, descriptions, Dataset JSON-LD; `9912094`), matching the admin framing. The remaining action is simply to formally close Priority #1 in `CLAUDE.md`.

### 2.6 Overnight operational queue — ~14 open items, dominated by cron reliability — `Severity: Low–Medium · Effort: mixed`

The `docs/overnight/ledger.md` queue churned hard this week. **Closed since the last report:** I1 (cron-rush saturation — full 21-job stagger landed), P1-CAD (em-dash×`btoa()` Cadence crash), DUPE1-MIT (cold-tail skips inert UUID editions), R1 (hydrator offers FK), SMOKE-RETRY, SMOKE-MARKET-EMPTY, CROSS1 (obsolete), TFP-WATCH, PACKEV-THROUGHPUT, PIN-SER (unfillable rows), plus the prior P1/S1/N1/Q10 reconciliations. Still open:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| LISTCACHE-CRON-DROP | The whole `topshot-listing-cache` cron family (primary + `-v2`) dropped ticks overnight (primary 4h49m gap; `-v2` ~9.5h silent). | Low–Med | **NEW.** Clean external-cron dropout, 0 fails. Bounded impact (only the ASK_ONLY minority risks ~3h staleness; core FMV fresh). Operator: re-fire/investigate the family, or **retire the redundant `-v2`**. |
| N1 | `snapshot-institutional-wallets` stalled a 3rd time (missed 06:00Z daily slot). | Low | Operator: re-fire **and move its slot off the cron-rush peak** — recurrence makes the slot move clearly warranted. |
| P3-BUYERS | `pinnacle-resolve-buyers` dropped ~7.3h of ticks (2nd multi-hour dropout in a week; recovered alone). | Low | Operator watch — same flaky-external-trigger class as N1/Q3. |
| PIN-SYNC-CRON | `pinnacle-sync` now logs `pipeline_runs` (PIN-SYNC-OBS shipped) but has no daily cron-job.org entry yet. | Low | Operator: wire the daily cron, then add the watchlist row (after ≥1 logged run). Until then Pinnacle FMV refresh is manual. |
| CRON-30S 3/4 + hygiene | AllDay + Golazos pack-dist cron 30s timeouts (seeds essentially static historical data); 4 cron entries still pass the INGEST token as `?token=` in the URL. | Low | Operator/CC: decide if the pack-dist cron is needed at all (retirement candidate); migrate the 4 entries to `Authorization: Bearer` (dashboard-only). |
| Q2 | `compute-laliga-pack-ev` cron cadence. | Watch | Golazos has no confirmed primary pack path; appears active. |
| L1 | `league-drift-detection` ran once (05-31); not watchlisted. | Low | Operator/CC: wire a cron + generous watchlist if recurring, else record as one-shot. |
| DUPE1 | Inert TS UUID-dupe re-mint re-fills the dedup backlog (~400–520/hr peaks; sentinel CRITICAL is a **true positive — do not raise the threshold**). All rows inert (trigger-held) — no corruption/outage. | Low–Med data / Med ops-noise | Durable fix is **off-limits worker code** — `seed_topshot_editions`/`buildEditionKey` int-pair preference (**Item B2**). DUPE1-MIT (cold-tail skip) already shipped to stop the NO_DATA stamping. Re-run a canonical-merge dedup only after B2 lands. |
| N2 | `v_moments_needing_hydration` candidate-read still exceeds `statement_timeout` under peak cron-rush contention (re-open of C2). | Medium | The materialized-CTE fix is net-positive — **do NOT revert.** Deeper fix (statement_timeout bump / supporting index / further view-cost reduction) is operator/CC. |
| Q5 | Smoke `analytics_pipeline_health.sales` lag threshold (30m < ~2h indexer cadence) → intermittent false `degraded`. | Medium | Proper fix: compute lag from the last *successful* run, not newest `sales.sold_at`. Operator/CC. |
| SMOKE-EDITION-TIMEOUT | `NEXTJS-1H` — edition-page "Recent Sales" smoke assertion timed out once on a cold lambda (the board `81f686f` just added). | Low | **NEW.** Single transient, no recurrence in ~3h. Assertion-class → bypasses SMOKE-RETRY by design. If it recurs, bump the per-fetch timeout for the heavier edition endpoint. |
| PIN1 | `NEXTJS-15` Pinnacle listing-indexer Sentry gate counts `cadence_capped` deferrals toward the spike threshold → transient warnings. | Low | Operator/CC: exclude `cadence_capped` from the spike count, or raise the per-tick budget. |
| Q6 | `evm-transfers-ingest` Base-429. | Low | Code fix shipped earlier (`8605c43`) + watchlist false-positive fixed (P1). Effectively addressed; ledger entry not restamped. |
| Q7 | Recurring `.git/index.lock`/`HEAD.lock` orphaned by the scheduled sandbox sharing Trevor's working `.git`; the Windows↔sandbox bridge intermittently NUL-corrupts git reads. | Infra | Bot clone created + push-verified, but scheduled-sandbox reachability is **negative**. Keeps the night pass NO-PUSH (DB-migration + artifact + on-disk-docs only). Wound down pending a sandbox-native-clone decision. |

Also tracked here: **PACKVIZ-GRID** (deferred grid restructure) was largely shipped via `41dfae2` (top-chases hero strip + exhausted-pool split) — the ledger entry lags; and **I1 histogram verification** of the flattened cron minute-distribution was due 2026-06-08 evening. The ledger's **Declined — do not re-suggest** section is currently empty.

### 2.7 Pack EV / pack-viz — honesty pass + queue unwedge — `Severity: Low–Medium · Effort: Medium (mostly shipped)`

- **Pack-dist page math/honesty (`5dcdee8`).** Tier-odds denominator fixed (Common no longer reads "596%"); pull-odds panel hidden on no-pool packs; no-pool sentinel EV rows render "—" not "$0.00"; clean set-cell names; `PackHeroArt` 2×2 montage fallback when the asset preview errors.
- **PACKVIZ-GRID (`41dfae2`).** Top-chases hero strip (5 highest-FMV pullable editions) + pullable/exhausted split in `EditionsGridPaginated` (`packMode`).
- **pack-ev v21 (`f39761a`).** Per-pack fetch timeout unwedges the EV queue (no more head-of-line blockage); the remaining lever is throughput (cron frequency), tracked as the now-closed PACKEV-THROUGHPUT.

### 2.8 Chain-abstraction follow-through — complete, with a cleanup tail — `Severity: Low–Medium · Effort: Medium`

Static this week. Phases **A–F are complete** (Phase F `ALTER COLUMN chain DROP DEFAULT` shipped 2026-06-01). **Open tail:** the **18 re-export shims** at old import paths, each carrying `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim` (§5a) — unchanged count, bulletproof by design (zero caller breakage across 833 `@/lib/...` imports). **Trap (from `CLAUDE.md`):** `lib/flow.ts` is the only shim with `export default` — keep `export { default }` alongside `export *`. Chain two (Solana/Candy) is gated on a July-8 data tripwire — do not start chain-two code early.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `CLAUDE.md` § Known issues. **§9 has the verified open/resolved status of every numbered item.**

### Conversion / activation (the real critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 0 | **NEW — Wallet verification.** "Sign in with Dapper" gated on Dapper developer access (request pending). The working path is the on-demand listing challenge (`/api/profile/verify-challenge/check` → `resolve_wallet_challenge_match`, +500 credits); `admin_verify_wallet` is the interim owner-attested fallback. The old `cached_listings` cron matcher is dead (frozen data) but left harmless. | Medium | Medium (core shipped; Dapper path blocked externally) |
| — | Activation machinery (Rewards economy, SEO server-render, honest `/pricing`) shipped; **verify `funnel_events` is recording** and measure whether signups move off zero. | High | Medium (shipped, unmeasured) |

### Data-intelligence quality

| Item | Issue | Severity | Effort |
|---|---|---|---|
| PIN-FMV-REKEY | Pinnacle per-render FMV — engine + waves 1a/1b/2 shipped; waves 2/3 (remaining entity/stats/route readers) + legacy `pinnacle_fmv_snapshots` retirement queued (Trevor-sequenced). | Medium | Medium |
| DUPE1 | Inert TS UUID-dupe re-mint inflates NO_DATA + sentinel; durable fix is off-limits worker code (Item B2 — int-pair preference in `buildEditionKey`/`seed_topshot_editions`). DUPE1-MIT already stopped the NO_DATA stamping. | Low–Med | Medium (writer code) |
| — | FMV NO_DATA tail confirmed *structural*; coverage lever is a primary listings/ask feed (not throughput). | Medium | Medium |

### Multi-chain foundation

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Phase D tail | 18 `lib/*` re-export shims carry a `chain-rename` TODO (repoint 833 imports to `@/lib/chains/flow/…`, then delete shims). Unchanged. Intentional, low-risk. | Low | Medium |

### Page polish — Pack / Moment / Set

| # | Issue | Severity | Effort |
|---|---|---|---|
| 17 | Pack / Moment / Set page tune-up. This week: pack-dist tier-odds math + honest empty states + hero art (`5dcdee8`), PACKVIZ-GRID top-chases + exhausted split (`41dfae2`), TS-screenshot history parity (`81f686f`), responsive 390px-overflow fixes (`ccfce64`). Remaining lower-value tier: modal accessibility verification (Moment V3 / Set V5), Set B5 (series rollups from only the first 100 editions — needs an aggregate RPC), Set B7 (client-sort partial-page). Audit docs (`PACK_/MOMENT_/SET_PAGES_AUDIT_2026-05-22.md`, archived) are point-in-time, partially superseded. | Low–Medium | Medium (mostly done) |

### Brand / polish

| # | Issue | Severity | Effort |
|---|---|---|---|
| 11 | Brand punch list — **phase-1 token sweep + CI guard shipped** (`de01542` tokenized `#E03A2F`/`'Barlow Condensed'`/`'Share Tech Mono'` on 6 public surfaces; new `scripts/check-brand-tokens.mjs` hard-fails CI on regression in those surfaces). OG routes now **14** (added `share`). `public/home-fmv-preview.png` unreferenced (moot — live `<HomeFmvPreview />`). Remaining: ~70-file Phase-2 debt (admin, dashboard, modals, email HTML) tracked, not gated; Fast Break / RTR / admin tokenize once stable. | Low | Small |
| 12 | Blazers trivia (`lib/blazers-trivia.ts`, **198 lines** verified) — shelved, still no UI / no importer. | Low | Small |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 10 | `/dashboard` token migration — `app/dashboard/page.tsx` = **1,681 lines** (verified; **shrank ~99 from last week's 1,780** via the `46ec1fb`/`311ae4f` dead-code drop). Big lift, deferred until stable. | Low | Large |
| 14 | Monolith page refactor — verified line counts: `collection/page.tsx` **2,899**, `analytics/page.tsx` **2,204**, `sniper/page.tsx` **2,070**. **`CLAUDE.md` #14 was updated this week and now cites the correct figures** (~2,900 / ~2,208 / ~2,070) — last report's stale "~2,485 sniper" drift is fixed. Phase 1 plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md` (present). | Low–Medium | Large (Phase 1 small) |
| 15 | `livetoken-portfolio*.json` scratch fixtures — **RESOLVED.** `CLAUDE.md` marks resolved; `git ls-files` shows none tracked. | Low (resolved) | Trivial |

### Stalled / scaffolded features

| Item | Issue | Severity | Effort |
|---|---|---|---|
| #1 | Cart execution — **SHELVED by decision (2026-05-24).** RPC is an intelligence product; in-app live-buy is not a goal. The Cadence in `lib/chains/flow/cadence/purchase-moment.ts` stays dormant and revivable. Not a defect. | n/a (shelved) | n/a |
| #3 | Trade Hub / trade-escrow — **SHELVED + GUARDED (2026-06-01, `e246f22`); tracked as `CLAUDE.md` #3.** `ensureLive()` (verified present, 6 refs) throws unless `RPC_TRADE_ESCROW_ADDRESS` is set; `/api/trade-chain/{propose,execute,deposit-callback}` return 503 (verified); `/dashboard/trade-hub` `notFound()`s via `TradeHubClient.tsx`. The 8 in-code stub TODOs (§5b) persist in the dormant code. The wishlist/offers/matches CRUD (`/api/trade-hub/*`) is untouched. To revive: deploy `RPCTradeEscrow`, set the env var, replace stub bodies. | Medium (shelved) | Large |

### Net-new feature not in the numbered list

| Item | Issue | Severity | Effort |
|---|---|---|---|
| Rewards | Off-chain points economy — **live end-to-end, status DIAL-IN.** Non-code blockers: store stocking (Trevor's Moment picks via `add_moment_shop_item`); raffle items held pending legal review (`docs/rewards-raffle-official-rules-DRAFT.md`). Security invariant verified (no user-writable points path). Worth a numbered slot in `CLAUDE.md` (e.g. #18). | n/a (live, dialing in) | Medium (non-code) |

### Deferred hardening (intentional — from `CLAUDE.md`)

Tracked but intentionally unfixed; revisit when a real consumer or per-row write API arrives.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each carry a `roles=public` INSERT policy with `qual=true`/`with_check=true`. Future hardening: per-row size caps via CHECK constraints, a `created_at` rate-limit column/trigger, a `bot_score` column from BotID, possibly an edge rate-limiter. (The `funnel_events` table follows the safer pattern — RLS-on, anon INSERT-only, no anon SELECT, event-type allowlisted + size-capped — a good template.)
- `user_achievements` + `watchlist_items` — service-role-only writes since 2026-04-27 but still keyed on `owner_key` (text) rather than `user_id` (UUID); migrate to `user_id` + RLS when a real consumer arrives. (Note: the Rewards profile work in `6f4a2d5` did re-key the profile OG card from `owner_key`→`user_id` — a sign this migration is starting to happen surface-by-surface.)
- `badge_editions.low_ask` coverage gap: AllDay 0/1,572, Golazos 12/218 (~5.5%), TopShot ~86%. Populate via a cron that walks `cached_listings` and upserts `min(ask_price)`. (Related to Q8's badge-sync row-grain work.)

### Architecture note worth tracking

- **Watchlist + FMV Alerts partially decommissioned.** Per `CLAUDE.md` Architecture notes, the watchlist/alert tables and API routes were applied earlier but the current concierge tool set no longer includes watchlist/alert tools, so the user-facing path is partially dead. Verify table/route status before reactivating — relevant if "harden the intelligence surfaces" (Priority #2) revisits alerting, and adjacent to the new Rewards earn-hook surface.

---

## 4. Prioritized next actions (from `CLAUDE.md`, 2026-05-24 framing)

| P | Action | Maps to |
|---|---|---|
| 1 | Flowty teardown — **recommended CLOSED (keep frozen).** `docs/cleanup-decisions-2026-06-01.md` concludes nothing is safe to drop. The remaining action is to formally close the priority in `CLAUDE.md`; the `/analytics` historical-framing (`9912094`) is the last visible loose end and it shipped. | §2.5 — housekeeping |
| 2 | Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely more useful than Top Shot's own site. **Advanced heavily this week** via the Pinnacle per-render FMV engine, the FMV accuracy cluster, TS + AllDay on-chain offers, pack-dist honesty, and the SEO server-render wave. | §2.2 + §2.3 + §2.7 |

*Implicit priority surfaced weeks ago and still un-promoted:* **activation/conversion** (§2.1). With ≈13 users and a brand-new Rewards economy + wallet verification now live but unmeasured, this is arguably the highest-leverage work and is worth promoting to an explicit `CLAUDE.md` action — paired with instrumenting the Rewards loop so its effect can be seen.

**Framing note carried from `CLAUDE.md`:** monetization (Pro paywall, Stripe, public launch) is explicitly **tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met — this is why §1 reports 0 active revenue-blocking items.

---

## 5. In-code TODO inventory

A gitignore-aware scan of the source tree (`*.{ts,tsx,js,jsx,mjs,cjs,cdc,sql,css}`) found **41 raw matches → 39 real markers across 29 files, plus 2 false positives** (see §8). That is **0 delta vs last week** (39 / 29) — the entire inventory is unchanged, and every line number matches last week's (no edits shifted these markers this week). `CLAUDE.md` does not track these. Grouped by theme:

### 5a. Chain-rename shims — Phase-D reorg tail (18 markers, 18 files) — unchanged

Every relocated Flow primitive left a one-line re-export shim at its old path, each tagged `// TODO(chain-rename): repoint callers to @/lib/chains/flow/… and delete this shim`:

- `lib/flow.ts`, `lib/flow-resolve.ts`, `lib/fcl-config.ts`, `lib/topshot.ts`, `lib/topshot-graphql.ts`, `lib/topshot-username-resolve.ts`, `lib/allday.ts`, `lib/allday-cadence.ts`, `lib/alldayGraphql.ts`, `lib/dapper-v1-tx-decode.ts`, `lib/wallet-backfill-helpers.ts` (all `:2`)
- `lib/cadence/make-offer-topshot.ts`, `lib/cadence/make-offer-flowty.ts`, `lib/cadence/wallet-preflight.ts`, `lib/cadence/break-transactions.ts`, `lib/cadence/purchase-moment.ts`, `lib/cadence/purchase-moment-flow-wallet.ts`, `lib/cadence/pinnacle-wallet.ts` (all `:2`)

→ Still the largest cluster. Intentional, low-risk; cleanup is "repoint 833 imports, then delete." See §2.8. (Mind the `lib/flow.ts` default-export trap.)

### 5b. Trade Hub / escrow — feature stubbed but guarded (8 markers, 2 files)

- `lib/trade-escrow/fcl-submit.ts` (×6, lines 10, 75, 85, 104, 112, 122) — the header block plus all five trade transactions are stubs: `submitProposeTrade`, `submitDepositToTrade`, `submitExecuteSwap`, `submitCancelTrade`, `submitReclaimExpired`. Fronted by `ensureLive()` (line 51) so the stubs throw rather than return fake tx ids when the contract is unset.
- `app/dashboard/trade-hub/TradeChainPanel.tsx` (lines 186, 196) — cancel callback unwired; the UI sets `"Cancel signing not wired yet — see TODO in TradeChainPanel.tsx"`. The page itself `notFound()`s via the `TradeHubClient.tsx` server gate.

→ See §3 (#3, shelved + guarded).

### 5c. `special-serial-sweep` ownership lookup stubbed (4 markers, 1 file)

- `supabase/functions/special-serial-sweep/index.ts` (lines 119, 126, 132, 138) — ownership lookup is a no-op for all four collections (topshot, allday, golazos, ufc); the edge function only `console.log`s a `TODO` line. Related to `docs/code-todos.md` item 2.

### 5d. Pipeline calibration / migration (3 markers, 3 files)

- `lib/fast-break-optimizer.ts:119` — `TODO(captain-bonus)`: the Captain-points multiplier is not calibrated against observed data.
- `app/api/rtr/lock-roi/route.ts:156` — `TODO(lock-roi-calibration)`: `estimatedPlayoffPoints = floor(fmv / 10)` is a v1 placeholder.
- `workers/topshot-moments-hydrator/index.ts:317` — `TODO(supabase-migration)`: needs a `replace_topshot_moments_batch(payload jsonb)` RPC.

### 5e. Smaller data-quality / polish TODOs (4 markers, 4 files)

- `app/(collections)/[collection]/collection/page.tsx:2667` — `team_name` from UUID-keyed (formerly Flowty) editions is often wrong; long-term fix is a `team` column on `wallet_moments_cache`.
- `app/api/pinnacle-wallet/route.ts:74` — wallet-scoped offer totals return `null` until Pinnacle offer ingest lands.
- `app/(collections)/[collection]/pack/[id]/page.tsx:26` — `TODO(og-image)`: build `/api/og/pack/lifecycle` share card. Overlaps #11.
- `lib/pack-urls.ts:19` — `TODO(2026-05-26)`: verify the pack URL still resolves for sold-out drops.

### 5f. Cadence test coverage gap (2 markers, 1 file)

- `cadence/tests/RPCTradeEscrow_test.cdc` (lines 627, 630) — Scenario 14 (`testTypeMismatchRejected`) is unimplemented; needs a second `NonFungibleToken`-conforming contract in the emulator test env.

> **No change since last week:** the marker set, file set, and line numbers are identical to the 2026-06-03 inventory.

---

## 6. Resolved / no action needed

Verified against the codebase, `CLAUDE.md`, and `docs/overnight/ledger.md`:

**Known-issue slate:**
- **#2 Sentry error capture — RESOLVED.** DSN set in Vercel; SDK wired.
- **#3 Flowty event indexer "regression" — RESOLVED / reclassified.** Flowty shut down ~2026-05-13. (Slot #3 is now also occupied by the shelved Trade Hub — see §9.)
- **#4 Pinnacle FMV — RESOLVED + substantially enhanced.** `pinnacle_fmv_snapshots` ~425 editions, 84% HIGH+MED; this week the per-render engine (`pinnacle_catalog.fmv_*`) replaced blended pricing for most readers.
- **#5 AllDay/UFC mis-categorized editions — RESOLVED.** Only 8 stray (all `disney_pinnacle`).
- **#6 WarmupContext key mismatch — RESOLVED.**
- **#7 AllDay `unmapped_sales` backlog — RESOLVED 2026-05-25.** Resolver rewritten GQL-primary + `batch_size 5→200`.
- **#8 NBA stats / projections — RESOLVED.** `nba_player_projections` syncing.
- **#13 `flowty_archive` growth — RESOLVED.** Prune + `VACUUM FULL`; DB 13.8 → 6.5 GB.
- **#15 scratch fixtures — RESOLVED.** None git-tracked (verified via `git ls-files`).
- **#16 `flow test` CI gating — RESOLVED, fully blocking.** `continue-on-error` removed; lint repointed to canonical Cadence path.
- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).**

**Newly resolved / closed this week:**
- **I1 (cron-rush DB saturation) — RESOLVED.** Root cause was the `:00/:20/:40` cron-job.org anchor pile-up; the full 21-job stagger landed across cron-job.org + the GHA workflows (`306a7ed`/`c9b6a04`). Histogram verification was due 2026-06-08 evening.
- **3 broken Pipeline-Sentinel checks — REPAIRED (`87f5f83`).** Sniper Feed auth, Edition Coverage distinct-count, FMV Confidence canonical-TS scoping; verified green via `workflow_dispatch` 2026-06-08.
- **Weekly-maintenance DB function — FIXED.** `run_weekly_db_maintenance()`'s wmc DELETE was seq-scanning ~1.58M rows and timing out every run (silently failing the Saturday cleanup ≥1 week); rewritten wallet-scoped + backed by `idx_wmc_last_seen_at`.
- **P1-CAD — FIXED (`bf4c38c`).** Em-dash×`btoa()` Cadence-encode crash in `pinnacle-metadata-backfill`.
- **R1 (hydrator offers FK), DUPE1-MIT (cold-tail skip), SMOKE-RETRY, SMOKE-MARKET-EMPTY, CROSS1, TFP-WATCH, PACKEV-THROUGHPUT, PIN-SER** — all closed/shipped (see ledger).
- **`PinnacleSniper.tsx` deleted (`980b6f1`)** — last legacy-Pinnacle-table type ref removed.
- **CLAUDE.md #14 line figures corrected** — the stale "~2,485 sniper" the last report flagged is fixed (now ~2,070).
- **Report relocation done** — repo root cleared; all 5 prior `PROJECT_HEALTH_*` reports now in `docs/health/` (last report flagged this as not-yet-done).

**Also shipped this week (net-new features, not in the numbered list):** the Rewards points economy (`c689771`→`cc82283` + waves); the Pinnacle per-render FMV engine + reader-cutover waves (`a4c6bb5`, `2e8cbd1`, `32f0bf1`, `eeb9044`, `90fcf0b`, `5f448f7`, `a9f86af`); TS + AllDay on-chain offers indexers (`91ac5e1`, `cc8a3e7`); the SEO server-render wave + internal linking (`39983de`→`56c61d8`, `549ddfa`); pack-dist honesty + PACKVIZ-GRID + pack/moment history parity (`5dcdee8`, `41dfae2`, `81f686f`); the FMV accuracy cluster (`1c5ccf5`, `bf4cbd5`, `b8a0a49`, `d881a75`, `fd61038`); `/share` OG fix (`b3dae3d`); honest `/pricing` + click tracking (`1514a7c`); the June 7–8 full-platform audit follow-ups Items 1–7 (`3364d4e`, `eb39370`, `9912094`, `ccfce64`, `de01542`, `29715ed`) + the `audit_20260608_seed_sets_wnba_skyline_254` migration.

---

## 7. Suggested sequence

A pragmatic order under the intelligence-first framing, with activation promoted given the traction reality:

1. **Measure the activation machinery you just built (§2.1).** Cheapest, highest-leverage — confirm `funnel_events` is recording anon top-of-funnel; instrument the Rewards loop (sign-ups, daily-visit earns, redemptions); unblock the Rewards DIAL-IN (store stocking + raffle legal). Then watch whether signups move off zero.
2. **Finish the Pinnacle per-render FMV cutover (§2.3 / PIN-FMV-REKEY waves 2/3)** and retire the legacy `pinnacle_fmv_snapshots` table at zero readers; wire `v_fmv_sanity_flags` into the weekly health check.
3. **Address the cron-reliability class (§2.6).** Re-fire/retire the LISTCACHE-CRON-DROP family (decide whether `-v2` is redundant); move N1's slot off the rush; wire PIN-SYNC-CRON; decide CRON-30S 3/4 (retire vs fix) + migrate the 4 `?token=` cron entries to Bearer.
4. **Land the DUPE1 durable fix (Item B2)** — int-pair preference in `buildEditionKey`/`seed_topshot_editions` (off-limits to the passes; needs a human/CC push), then a one-time canonical-merge dedup. This stops the inert-UUID treadmill at source.
5. **Drain the rest of the queue (§2.6).** N2 (hydrator statement-timeout decision), Q5 (smoke-lag rebase), PIN1/L1 (small operator items), Q6 (effectively done), Q7 (git-lock infra — stays wound-down pending a native-clone call).
6. **Formally close Priority #1 (Flowty, §2.5)** — record the keep-frozen decision in `CLAUDE.md`.
7. **Chain-abstraction cleanup as capacity allows (§2.8 / §5a).** Repoint callers off the 18 shims in batches, then delete (mind the `lib/flow.ts` default-export trap). Deferrable.
8. **Pack/Moment/Set tail (#17), brand Phase-2 (#11), `/dashboard` migration (#10), monolith refactor (#14).** Lowest priority.

---

## 8. Notes from verification

- **Git was available and reliable this run.** HEAD = `29715ed` (2026-06-07, the audit-followup LOW batch). `git log` returned **132 commits dated 2026-06-04 onward** (the clean "since the prior report" window — the prior report's git window ended at the 06-03 night pass), touching **148 code files** and **154 docs files**. Counting from 2026-06-03 inclusive gives 144 commits (a few 06-03 commits were already covered in the prior report). Either way it is the busiest week recorded.
- **Report-location caveat is RESOLVED.** Last week the older root-level `PROJECT_HEALTH_*` reports were still in the repo root despite the brief; this run `ls PROJECT_HEALTH*` at the root returns nothing and `docs/health/` holds all five prior reports (`_2026-05-22`, `_2026-05-25`, `_2026-05-30`, `_2026-06-01`, `_2026-06-03`). This report is the sixth there.
- **Cited-path spot check:** all paths cited in `CLAUDE.md` / the prior report exist, **except** the intentionally-deleted ones, which are correct (not stale): `lib/pro/gate.tsx` (deleted prior week), `scripts/cleanup-storefront-wallets.mjs` + root `cleanup.cdc` (deleted 2026-06-02 `d8cc6c2`, documented in #9), and `components/PinnacleSniper.tsx` (deleted this week `980b6f1`). `docs/FREEZE.md` is absent **by design** (it exists only while a freeze is active — no freeze is active now). New-feature paths verified present: `lib/rewards.ts`, `app/rewards/page.tsx`, `app/admin/rewards/page.tsx`, `app/api/rewards/{redeem,summary}/route.ts`, `app/api/profile/verify-challenge/check/route.ts`, `scripts/check-brand-tokens.mjs`, `docs/strategy/rpc-rewards-program-2026-06-04.md`.
- **Two TODO-scan matches are false positives:** `lib/format.ts:6` — `XXX` inside the format-string literal `"$X,XXX.XX"`; and `docs/migrations/phase-f-drop-chain-default-2026-05-30.sql:17` — `XXX` inside the placeholder migration name `audit_2026XXXX_...` (in `docs/`, outside the source-dir scan, but confirmed for week-over-week comparability). Both excluded from the 39 real markers.
- **TODO count delta vs last week: 0.** 39 real markers across 29 files, unchanged; all line numbers match last week's inventory.
- **Verified line counts** (`wc -l`): `collection/page.tsx` **2,899** · `analytics/page.tsx` **2,204** · `sniper/page.tsx` **2,070** · `dashboard/page.tsx` **1,681** (down from 1,780) · `lib/blazers-trivia.ts` **198**.
- **OG routes: 14** (`collection`, `deal`, `default`, `edition`, `fast-break`, `insights`, `moment`, `pack`, `player`, `profile`, `series`, `set`, `share`, `team`) — `share` is new this week (`b3dae3d`); was 13.
- **`/insights` surfaces: 12** — confirmed by the `INSIGHT_ROUTES` array in `app/sitemap.ts` and by both the page-dir and API-route listings (`squeeze`, `pack-reality`, `rookies`, `first-mint`, `cross-collection`, `set-squeeze`, `pinnacle-scarcity`, `market`, `offer-spread`, `deals`, `squeeze-check`, `tc-report`). Unchanged from last week.
- **Trade Hub guard verified live in source:** `ensureLive()` present in `lib/trade-escrow/fcl-submit.ts` (6 refs); `/api/trade-chain/{propose,execute,deposit-callback}/route.ts` each carry the 503 "not available yet" body.
- **Rewards security invariant** (no user-writable points path) is reported as documented in `CLAUDE.md` / the rewards handoffs; not independently re-audited against the live SECDEF grants this run.
- **DB-side facts** (FMV counts, Pinnacle render spreads, NO_DATA structural finding, traction numbers, pipeline health, security posture "RLS on all 88 tables / 0 security ERRORs") are reported **as logged in `CLAUDE.md` / `docs/overnight/ledger.md` / the in-repo monitor commits** — they were **not independently re-queried** against production Supabase this run, consistent with prior reports.
- **Autonomous-task caveat:** because the daytime monitor and night pass run against this repo, the working tree may differ from this snapshot by the time it is read. `docs/overnight/ledger.md` is the authoritative record. The 06-08 night pass was NO-PUSH (no sandbox git creds; it also repaired a recurring `.git/config` NUL corruption to make git usable).
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git (no commits/branches/PRs), per the task brief — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-06-08)

Every slot from `CLAUDE.md`'s known-issues list, checked against the actual repo. "Verified status" is what the code/docs show.

| # | Issue | `CLAUDE.md` status | Verified status | Evidence |
|---|---|---|---|---|
| 0 | **Wallet verification (NEW)** | Open | **Open** — listing-challenge path live; Dapper-dev "Sign in with Dapper" blocked externally | `app/api/profile/verify-challenge/check/route.ts` present |
| 1 | Cart execution | Shelved | **Shelved by decision** — not a defect | `lib/chains/flow/cadence/purchase-moment.ts` dormant |
| 2 | Sentry inactive | Resolved | **Resolved** | DSN set; SDK wired |
| 3 | Flowty event indexer regression **/ Trade Hub** | Resolved (Flowty) **+ Shelved (Trade Hub)** | **#3 double-assigned** — Flowty indexer resolved; Trade Hub shelved + guarded | `ensureLive()` + 503 routes + `TradeHubClient.tsx` |
| 4 | Pinnacle FMV | Resolved | **Resolved + enhanced** — per-render engine now primary for most readers | `pinnacle_catalog.fmv_*`; `a4c6bb5` |
| 5 | AllDay/UFC mis-categorized editions | Resolved | **Resolved** — only 8 stray | `CLAUDE.md` Resolved § |
| 6 | WarmupContext key mismatch | Resolved | **Resolved** | `WarmupContext.tsx` prefetches `/api/packs` |
| 7 | AllDay `unmapped_sales` | Resolved 2026-05-25 | **Resolved** | `CLAUDE.md` + 2026-05-25 session |
| 8 | NBA stats unreachable | Resolved | **Resolved** | `nba_player_projections` syncing |
| 9 | Storefront audit pipeline | Retired + cleanup deleted | **Retired** — manual script; cleanup driver deleted | `scripts/cleanup-storefront-wallets.mjs` + `cleanup.cdc` gone (verified); payer wallet/cron intentionally paused (N3) |
| 10 | `/dashboard` token migration | Open | **Open** — `app/dashboard/page.tsx` = **1,681** lines (shrank ~99) | `wc -l` |
| 11 | Brand punch list | Open (partial) | **Open — much improved** — phase-1 token sweep + CI guard (`de01542`); 14 OG routes | `ls app/api/og/`; `scripts/check-brand-tokens.mjs` |
| 12 | Blazers trivia | Open | **Open** — `lib/blazers-trivia.ts` (198 lines), no importer | `wc -l` |
| 13 | `flowty_archive` growth | Resolved | **Resolved** | per `CLAUDE.md` (DB-side; trusted) |
| 14 | Monolith page refactor | Open | **Open** — collection 2,899 / analytics 2,204 / sniper 2,070; `CLAUDE.md` figures now correct | `wc -l` |
| 15 | `livetoken-portfolio*.json` fixtures | Resolved | **Resolved** — none git-tracked | `git ls-files` |
| 16 | `flow test` in CI | Resolved | **Resolved — fully blocking** | `.github/workflows/ci.yml` |
| 17 | Pack/Moment/Set page tune-up | Open (ongoing) | **Open — mostly shipped** | pack-dist math/honesty + PACKVIZ-GRID + history parity + responsive batches landed; a11y + Set-RPC tail remains |

**Tally:** 10 resolved (#2, #3-Flowty, #4, #5, #6, #7, #8, #13, #15, #16) · 2 shelved by decision (#1 Cart, #3 Trade Hub) · 1 retired (#9) · 6 open or partial (**#0**, #10, #11, #12, #14, #17). (Slot #3 is counted in both "resolved" and "shelved" because it is double-assigned.) Plus the live, un-numbered **Rewards** feature.

**Bottom line for `CLAUDE.md`:** the known-issues list is in good shape and several prior-report recommendations landed (the #14 line figures were corrected; the prior reports relocated into `docs/health/`; `PinnacleSniper.tsx` removed). Drift points to correct on the next pass: (a) **resolve the #3 numbering collision** — Trade Hub reuses the slot of the resolved "Flowty event indexer" item; give Trade Hub a fresh number (e.g. #18); (b) **give the live Rewards economy a numbered slot** (e.g. #19) so a major shipped feature isn't tracked only in Recent Sessions; (c) Prioritized Action #1 (Flowty teardown) can be **closed** (keep frozen); (d) the in-code TODO inventory is untracked in `CLAUDE.md` — the 18 Phase-D chain-rename shims especially are intentional debt worth a one-line note. Finally, given the traction reality (≈13 users at last read) and the new Rewards/verification machinery, consider promoting **activation/conversion + its measurement** to an explicit prioritized action.
