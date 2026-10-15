# Rip Packs City — Project Health Report

**Date:** 2026-10-12
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **188 numbered items — 3 open · 7 partial · 178 closed**, newest slot **#190**), `docs/reference/roadmap-status.md` (accuracy-is-the-gate framing), `docs/reference/architecture-notes.md`, `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`, `docs/overnight/ledger.md` (newest heading 2026-10-11), the project handoff `claude/handoff-2026-10-11-overnight-pass.md`, plus first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) and **live DB reads (2026-10-12, ~3:48–4:00 PM PT)** for accuracy legs, trust-breach metrics, demand, DB size and the #185 split falsifier.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#190`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-10-05.md` (7 days ago). This regeneration mirrors its structure. `_2026-09-28.md` … `_2026-05-22.md` (twenty-four prior reports) also live in `docs/health/`.

> **Biggest change since 2026-10-05 — a register-reconciliation week, the mirror of last week.** Last week the register *grew* on discovery (153 → 172) with open at 5 and partial at 35. This week a **large known-issues triage pass on 2026-10-10 (under Trevor's "make decisions yourself" delegation) closed most of the partial backlog**: the register is now **188 numbered items — 3 open · 7 partial · 178 closed** (open **5 → 3**, partial **35 → 7**, closed **132 → 178**). The three chain-truth items that dominated last week's open/partial set are all **resolved**: **#167** (Top Shot sell-backs missing from `sales`, resolved 10-10), **#169** (sell-backs counted as market sales — the `sales_market` exit landed, resolved 10-10) and **#173** (`topshot_moment_subeditions` wrong base edition, resolved 10-09). **#171** (parallel re-key) also closed. Alongside the triage, a heavy daytime/Claude-Code shipping run landed **Top Shot offer-capture completeness** (#188/#189 — same-tick offers recovered, every `offer_fill` sale now carries `sales.offer_id`, 81,574/81,574), **account deletion** (`DELETE /api/profile/account`), a **legal/honesty + Terms pass** (eligibility age, non-affiliation list, privacy policy), **security quick wins** (constant-time Bearer comparison, auth-callback open-redirect closed), **light-mode conversions** (the guard now protects 87 files), **SEO structured data + llms.txt**, and **Candy ask corroboration** — which drove **Candy FMV HIGH/MED from 23.2% to 56.0%**. The autonomous side stayed quiet and honest: the overnight passes this week were **GREEN, 0 shipped, 0 reverted** (the 10-11 pass resolved every candidate to QUEUE — off-limits lane, hot file touched <24 h, or operator-only). The week's shipping was concurrent Claude Code / Trevor sessions, not the nightly pass.

> **Overnight reality — GREEN and honest.** The 2026-10-11 ~1:10 AM PT Cowork pass (push-capable, lock taken/released, no `FREEZE`) shipped **0**, reverted **0**. Security all `[]` (invariants, anon-write holes, rls-off-base, secdef-anon); structural all `[]`; trust health **0 breaches, all 38 arms ok** (↓ from 1 on 10-10 — `public_board_slow_count` cleared to 0); stalled pipelines `[]`; pg_cron recent failures `[]`; sentinel `ts_uuid_editions_48h` 0. Vercel 24h errors were **11 chronic/by-design groups, no new group traced to the recent commits**. The last code commit before the pass carried 23 CI checks, 0 failing.

> **Traction reality — WAU back to 2, and this is the honest external number.** Live reads (2026-10-12): **38 total accounts (+1), WAU 2, MAU 16, 170 saved wallets (+5)**, 34 of 38 users have a saved wallet, **1 email subscriber**. ⚠ **WAU dropped 12 → 2 because last week's 12 was the rewards dial-in test cohort, not external demand** — exactly the asterisk the 2026-10-05 report attached to it. With the rewards `scout_wallet` testing wound down, the raw auth-sign-in count falls back to low single digits, which is the genuine external-demand signal. Still far under the **50+ WAU gate**. **WAU is still the one number that decides everything**, and getting a clean, internal-excluded read of it remains an owed task.

> **Accuracy gate — Top Shot still MET, All Day still short, Candy jumped sharply.** Live `rpc_trust_health_precompute` legs (2026-10-12): **Top Shot 56.5%** HIGH/MED share (≥ 50% bar — **MET**, fresh-24h 74.4%), **All Day 26.7%** (≥ 30% bar — **NOT MET**, fresh-24h 48.2%), **Candy 56.0%** (up from 23.2% last week — the 10-11 Candy-ask-corroboration ship), Pinnacle **31.9%** (up from 31.6), Golazos **1.2%**, UFC **0.0%** (empty-market sentinel). ⚠ These are **single legs**, not the 65-leg series the file tells you to read; the series was not recomputed this run. Top Shot slipped a fraction (57.3 → 56.5) but stays over its bar; All Day is flat-to-down and remains the one published collection short of its gate.

> **Cost / storage — up again, same shape as before.** DB read **~35.6 GB live (36,461 MB)** at the run — up from ~31.8/34.4 GB a week ago, continuing the slow accumulation (four-plus months' ingestion, this summer's Flowty/sales re-promotions, Panini catalog walks adding editions, pg_toast, and the chronic TTL-managed `net._http_response` pg_net log). The overnight handoff reads db_size roughly flat day-to-day (35,602 → 35,701 MB on 10-10→10-11). Growth is accumulation, not a runaway. Compute stays **LARGE** (resized 2026-09-20). The **stale June 4.2 GB size-baseline doc still wants an update** — the DB now cycles in the mid-30s GB. The `flowty_archive.scratch_*` set (~185 MB) still has a written dedupe + drop script awaiting a Supabase SQL-editor run (operator-gated, destructive).

> **Platform context (largely unchanged).** Top Shot's public REST API stays dead; the Atlas backend read is the feed, still answering a Cloudflare JS challenge (403) on some lanes (designed-for, self-healing — `topshot-pack-supply-atlas` 210 by-design partials/24h). Flowty's trading frontend is shut and **Trevor flagged 2026-09-25 that Flowty will turn its API endpoints off "soon"** — the teardown is pre-staged and RPC is Flowty-independent for priced columns. NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled). Candy/Solana LIVE (Magic Eden is the load-bearing feed; OpenSea lanes are additive and 100% failing on a missing `OPENSEA_API_KEY`, = #58, Trevor env-var). Panini = WC Prizm plane (`PANINI_PUBLIC = true`), collector-walk adding editions.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All twenty-five reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#190** | Register STATUS INDEX: **188 numbered items — 3 open · 7 partial · 178 closed**. ~16 new slots (#175–#190) since last week; a 10-10 triage pass closed most partials. See §9. |
| Known issues — resolved/closed since last week | **~46 net** | Closed count rose 132 → 178. Biggest: #167/#169/#171/#173 (chain-truth), #175–#188 (offers, legal/honesty, security, light-mode), plus the 10-10 partial-backlog triage. — §6 / §9 |
| Known issues — open / partial | **10** | **3 open** (#22, #172, #190) + **7 partial** (#17, #66, #76, #114, #181, #185, #189). — §3 / §9 |
| Known issues — 🚨 live trust breach | **0** | `topshot_impossible_parallel_serials` **0** (live 2026-10-12); 38/38 arms ok; `public_board_empty_count` 0; `public_board_slow_count` **0** (was 1); `fmv_sanity_flags` 0. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#22** purge GC + rotation (P0, unchanged); **#190** keyed data-source decision (Dune/Find Labs/Bitquery); `flowty_archive` scratch-drop + tx-lane dedupe (SQL editor); **#172** giveaway desktop delivery; **#58** `OPENSEA_API_KEY` env var; **#144** `ATLAS_POOL_INGEST_KEY`. — §2.6 |
| Known issues — carried shelved | **1** | **#8 sports-proxy 403** — SHELVED (Trevor delegation); alarm muted to 2026-10-28; `sync-nba-projections` failing by design, fails safe. — §2.3 |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot MET on its leg, All Day short. — §2.1 |
| Commits since last report | **458** | `git log --since 2026-10-05`. Authors: Claude 397, Trevor 40, Cowork 14, context-hygiene 2, nightly/monitor bots ~4. Tip `6071d18bd` 2026-10-12 15:51 PT (Trevor). |
| Accuracy gate (headline metric) | **Per-collection, live legs** | Top Shot **56.5%** (MET), All Day **26.7%** (NOT MET), **Candy 56.0** (↑ from 23.2), Pinnacle 31.9, Golazos 1.2, UFC 0.0 (sentinel). Legs, not the 65-leg series. — §2.1/§2.3 |
| Demand (the critical-path number) | **WAU 2 · 38 accounts · 170 saved wallets** | Live 2026-10-12. WAU 12 → 2 as the rewards test cohort wound down (last week's 12 was testing-inflated). MAU 16. Gate: **50+ WAU**. — §2.1 |
| Open overnight operational items | **standing queue** | #22 purge residue; #190 data-source decision; `flowty_archive` scratch-drop + dedupe (SQL editor); #58 OpenSea env var; #172 giveaway desktop delivery; #144 key rotation; #23/#25 drift. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE thin + Panini (WC Prizm, collector-walk live); plus a paused Rewards economy (dial-in). — §2.8 |
| Prioritized next actions | **superseded** | `roadmap-2026-08-03.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **50+ WAU**. See §4. |
| In-code TODO markers | **0 actionable in live app code** | Measured this run (`grep`): 4 narrative/false-positive refs only (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **266 `supabase/tests/*.sql` files** | +14 vs last week's 252 (measured this run, `ls`). |
| CI jobs (ci.yml) | **20** | Measured this run under `jobs:` — same 20 as last week. See §8. |
| Public `/insights` surfaces | **32** | Measured this run: 32 `app/insights/*/page.tsx` dirs (+1). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 50+ WAU. |

**Health read:** A reconciliation week, the mirror of last week's discovery surge. The register **shrank its open work** (open+partial 40 → 10) because the 2026-10-10 triage pass closed the long partial tail and the three chain-truth items (#167/#169/#171/#173) all landed. The headline wins: **Top Shot offer capture is now complete and attributable** (every `offer_fill` sale carries `sales.offer_id`), **Candy FMV jumped to 56% on ask corroboration**, and a **legal/honesty + security quick-wins pass** cleared a batch of pre-launch surface debt. The concentrated risk that remains: **(1) demand** — the honest WAU is 2, far under 50+; **(2) three open items**, of which #22 (credential-purge residue, P0 operator) is weeks old and now waits on a GitHub Support ticket, and #190 (pre-2023 custodial pack-open history has no free data source for 33 of 34 saved wallets) needs a keyed-provider decision from Trevor; **(3) seven partials**, mostly draining-or-operator-gated (#185 issuer-held split is draining on schedule; #181 waits on Flow's dark historical nodes; #114 needs a Cowork-desktop session to fix the 15 live dashboards; #76 needs an off-GitHub alarm trigger).

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **WAU 2 / 38 accounts / 170 saved wallets (live 10-12).** Accuracy at/around its bars. The problem is still *demand*. Gate: **50+ WAU** (§2.1) |
| **Register reconciliation (the week's big move)** | 10-10 triage pass closed most partials; chain-truth #167/#169/#171/#173 all resolved; open+partial 40 → 10 (§9) |
| Top Shot offer / sales completeness | Offer capture complete (#188/#189 — `sales.offer_id` 81,574/81,574); 4.0% pre-spork fills still unplaced (#189 partial) (§2.3) |
| Pre-2023 pack-open history | #190 (custodial opens before 2023-11-08 have no free source for 33/34 wallets); #181 (Flow mainnet24–26 nodes dark) (§2.3) |
| **Live trust breach still CLEAR** | `topshot_impossible_parallel_serials` 0 (live 10-12); 38/38 arms; boards empty 0 / slow **0** (§2.4) |
| Legal / honesty / security pre-launch pass | Account deletion, Terms/privacy, constant-time Bearer, open-redirect close, light-mode guard 87 files (§2.4 / §6) |
| Operator-owned / hand-offs | #22 purge (P0); #190 data-source decision; #58 OpenSea env var; `flowty_archive` scratch-drop + dedupe (SQL editor); #172 giveaway desktop; #144 key rotation; #23/#25 drift (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is the detector); #76 off-GitHub alarm trigger; #114 live Cowork dashboards (§2.5) |
| Security | scans clean; trust breach clear; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| SEO | #66 — zero external links (Trevor); structured data + llms.txt shipped 10-11; off-platform authority remains (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run and all still growing: DashboardClient **3,005** / SniperClient **2,095** / CollectionAnalyticsClient **2,037** / CollectionTabClient **1,599** / MarketClient **1,435** (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation still owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is two layers: **`docs/strategy/roadmap-2026-08-03.md`** (accuracy is the GATE — headline metric is the HIGH/MEDIUM confidence share) and **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The only user gate remains **50+ WAU**.

### 2.1 Launch + activation — Top Shot MET, All Day short, demand genuinely low — `Severity: High · Effort: Medium (built + measured, needs clean traffic)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, live read 2026-10-12:** **38 total accounts, WAU 2, MAU 16, 170 saved wallets**, 34 of 38 with a saved wallet, 1 email subscriber. **WAU fell 12 → 2** because last week's 12 was the rewards dial-in test cohort (`scout_wallet` earners), which the 2026-10-05 report already flagged as inflation. WAU 2 is the honest external-demand floor — still low single digits.
- **Accuracy (live precompute legs, 2026-10-12):** **M1 Top Shot 56.5% (≥ 50% — MET on the leg)**, **M2 All Day 26.7% (≥ 30% — NOT MET)**, Candy 56.0 (↑ from 23.2 — ask corroboration), Pinnacle 31.9, Golazos 1.2, UFC 0.0 (sentinel). These are single legs; the 65-leg series (`rpc_trust_health_history`) was not recomputed this run — read it as a series before acting.
- **M2 did not convert again.** All Day's HIGH/MED share has been flat-to-down for several weeks; it stays liquidity-limited and the code-side levers are small.

Suggested next step unchanged: **pick one acquisition channel and run it against the 50+ WAU gate** — and separately, get a clean WAU read by excluding `internal_accounts` and any remaining test cohort so the number means external demand. Still the single most important item in the report.

### 2.2 Public intelligence surfaces — 32 public — `Severity: n/a (shipped) · context`

All 32 built surface dirs in `app/insights/` are public (measured this run: 32 `page.tsx`, +1). The one previously-slow public board (`public_board_slow_count`) is now **0** (was 1 last week — the `panini_sale_feed_status` census). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window) remain as standing design considerations.

### 2.3 Data-intelligence — chain-truth landed, offer capture complete, pre-2023 history gap — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM share (live legs, 2026-10-12):** Top Shot 56.5, All Day 26.7, Candy 56.0, Pinnacle 31.9, Golazos 1.2, UFC 0.0 (empty-market SENTINEL, never a percentage).

**Shipped / resolved since last week:**

- **Last week's chain-truth open set is CLOSED.** **#167** (Top Shot instant sell-backs missing from `sales`) resolved 10-10; **#169** (sell-backs counted as market sales — the `sales_market` exit landed) resolved 10-10; **#171** (parallel moments filed under base edition — re-key + coverage) closed; **#173** (`topshot_moment_subeditions` wrong base edition) resolved 10-09. The three items that dominated last week's open/partial list are done.
- **Top Shot offer capture — COMPLETE (#188/#189).** The offers indexer no longer drops an offer created-and-completed inside one tick, nor a serial offer whose nft `moments` lacked (falls back to `wallet_moments_cache` then `checkpoint_nft_meta`). **Every Top Shot `offer_fill` sale now carries `sales.offer_id` (81,574/81,574)**, 17,257 historical accepted-offer rows recovered, a wallet "Offers Made" card shipped. ⚠ **Open remainder (#189 partial):** ~3,243 of 81,720 fills (**4.0%**) still have no offer row — their `OfferAvailable` predates the 2025-12-29 spork and is reachable only via the history access nodes, which are currently dark (see #181). A live-indexer Atlas fallback (`extra.resolved_via_atlas`) now places most new serial offers.
- **Candy ask corroboration (10-11).** Candy MLB's confirmed ask now corroborates FMV confidence rather than only capping it (75 of 91 Candy LOW…), which lifted the **Candy HIGH/MED leg from 23.2% to 56.0%**.
- **`#185` — Top Shot issuer-held split (PARTIAL, draining on schedule).** The `/insights/market-cap` "inside packs vs reserve" split has read `pending` since the lane started 10-03; the 10-10 throughput fix is draining the overdue backlog fast: **2,891 (at fix) → 2,007 (10-11) → 430 (live 10-12)**. The falsifier (overdue near 2,891 on 10-13) **passes**; expect the split to leave `pending` around 10-13/10-15. Still `pending: distribution list incomplete or stale` at read time.
- **SEO structured data + llms.txt (10-11).** Structured data where Google can see it, `llms.txt` regenerated from the public surface, and a default-OG fallback — part of #66's code-side work (external links remain Trevor's).

**Carried / open:**

- **`#190` — pre-2023-11-08 custodial Top Shot pack opens have NO free data source for 33 of 34 saved wallets (OPEN, NEW 10-11, needs Trevor).** Everything else reconciles (NFT pack opens match Dapper for all 34 wallets and every collection; custodial opens 2023-11-08 → now come from the chain). What is missing: 69,028 Top Shot moments held at 2023-11-08 by 33 wallets have no arrival record. Free sources are ruled out (pre-2023 access nodes gone, Dapper studio-platform returns 0, `public-api` 530, Flipside gone). **Keyed options need Trevor's decision:** Dune `flow.cadence_events` (purchase deferred 10-03; query drafted at `docs/research/dune-rigged-custodial-opens-2026-09-29.sql`), Find Labs Simple API, or Bitquery v1 — validate any against 0xbd94…'s known 2021–23 reveals first.
- **`#181` — Flow historical access nodes (mainnet24/25/26) dark since ~10-08 (PARTIAL).** Every chain-arrival floor check and bisection below mainnet27 waits. Parked with a canary (ended the 789-of-2,212-calls/h timeout waste) and a refloor lane handles anything reachable at mainnet27's root. **Decision deferred to 10-24:** if still dark then, retire pre-mainnet27 arrival lookups and mark those probes `failed` with UI-stateable copy. Blast radius: pack-history freshness + pre-mainnet27 attribution for saved/seeded wallets only; no FMV/site/security impact.
- **`#8` — sports-proxy 403 — SHELVED** (Trevor delegation). `sync-nba-projections` failing by design, fails safe; alarm muted to 2026-10-28. Do NOT retire.
- **`#66` — SEO (PARTIAL, needs Trevor):** zero external links; structured data + llms.txt + sitemap pruning partly done; external links (Flow directories, README, launch posts — ⛔ never leading with the Team Captain designation) remain Trevor's. The title-CTR re-read was due ~10-06.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon, function-search-path-drift, txn-control-pins all `[]` per the 10-11 pass).
- **Live trust breach clear.** `topshot_impossible_parallel_serials` **0** (live 2026-10-12); 38/38 arms ok; `public_board_empty_count` 0; `public_board_slow_count` **0** (cleared from 1); `fmv_sanity_flags` 0.
- **Pre-launch security quick wins shipped (10-11).** Bearer-token comparison is now constant-time and every inline `=== \`Bearer ${…}\`` route check was swept; the auth callback's open redirect was closed; account deletion (`DELETE /api/profile/account` + confirm-by-typing) now exists.
- **`#22` — the credential-purge residue is STILL OPEN (P0, operator-only).** The leak branch was deleted from origin, but the pre-purge blob stays fetchable **by SHA** until GitHub Support GCs the unreachable objects, and the RS256 token PII does not expire. A GitHub Support ticket (#4811268) was filed 09-30 and the "internal references only" option posted 10-04 (the SHA is referenced by closed PRs 8–15); as of 10-04 the commit still loaded publicly and GitHub had not acted. **Still Trevor's: chase the ticket, re-test (expect 404), rotate the Dapper session regardless.** `INGEST_SECRET_TOKEN` rotation (~15 functions) also still owed. A scheduled task was set to re-test the commit URL.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 266 `supabase/tests/*.sql` files** (+14, measured this run). CI is **20 jobs** in `ci.yml`. **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark since 2026-08-18; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; the connector also currently needs re-auth. ⚠ **`#76`** — the site-availability alarm's detection is closed in design (pg_cron `probe_site_health()` + a GHA alarm) but GitHub sheds most of its scheduled runs; the real fix needs an **off-GitHub, off-Vercel trigger** and a credential only Trevor can place. ⚠ **`#114`** — the Cowork dashboard-artifact failure-handling fix is in the three repo copies + guard, but the **15 live dashboards live in OneDrive outside the connected folders** and can only be fixed from a Cowork-desktop session; re-run `scripts/audit-cowork-artifact-failure-handling.mjs` after. ⭐ **`#23`/`#25`** — 25 edge functions not on `main`; loudly-correct standing detectors, reconcile when convenient. ⭐ **`#62`** — the true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 new stalled pipelines). Open items for Trevor / operator:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#22 — credential-purge residue** | Branch deleted; blob still fetchable by SHA; RS256 PII does not expire. GitHub Support ticket #4811268 filed, awaiting action. | **P0 (operator)** | Chase the ticket → re-test `commit/1c3e01a8f` (expect 404) → rotate the Dapper session regardless; `INGEST_SECRET_TOKEN` too. |
| **#190 — pre-2023 pack-open history** | 33 of 34 saved wallets have no free source for custodial opens before 2023-11-08. | **Med (decision)** | Pick a keyed provider (Dune / Find Labs / Bitquery), validate against 0xbd94…'s known reveals. |
| **`flowty_archive` scratch-drop + tx-lane dedupe** | `dedupe_tx_lane` then `drop_scratch` SQL (~185 MB `flowty_archive.scratch_*`). Destructive; MCP write-hold cancels it unseen from a headless session. | **Med (SQL editor)** | Run in the Supabase SQL editor, dedupe first. |
| **#58 — `OPENSEA_API_KEY` not set** | Candy/Panini OpenSea indexers 100% failing (honest-degradation path working; Magic Eden covers Candy). | Low (operator) | One env var in Vercel (all envs) + redeploy closes both halves. |
| **#172 — giveaway "Deliver all" stalls on desktop** | Flow Wallet browser extension sits at "waiting for your wallet…"; the iPhone (WalletConnect) path works. | Med (operator) | Make `0x3d0b…` the active account in the extension, hard-reload, retry; act on the 20s hint line. Workaround: deliver from phone. |
| **#144 — rotate `ATLAS_POOL_INGEST_KEY`** | `?key=` branch deleted + deployed (header-only, pinned); the key was in logs. | Med (operator) | Rotate the edge secret + Trevor's user env var. |
| **#23 / #25 — edge-fn + pin drift** | 25 edge functions not on `main`; nothing surfaces the three daily detectors. | Low (standing) | Reconcile or re-date; loudly-correct detectors. |
| **#8 sports-proxy 403** | SHELVED; alarm muted to 2026-10-28. | Med (deferred) | Do NOT retire. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. **#128's fabricated-zero pack-rip drain stays resolved** (drained to 0 last week; no longer on the open list). Two low-impact pack-lane items are queued to Claude Code/Trevor: `get_wallet_pack_summary` 8s RPC timeout on one whale wallet (function-body cost, not a missing index — 3/24h, low impact) and `chain-arrival-pack-pulls` durable bound (P1, ~7 nights, off-limits ingest route-logic).

### 2.8 Chain foundation — Candy LIVE, Panini walked, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN:** `CANDY_MLB_PUBLIC = true` (verified this run), overview tab. Magic Eden is the load-bearing feed (`candy_sales_stale_hours` 6.5, `candy_fmv_stale_hours` 0.4 — green); OpenSea lanes are additive and down on #58.
- **Panini — the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run). Collector-walk runs on Trevor's box and keeps adding editions (panini editions 23,071 → 25,631 over 10-10→10-11). NO_DATA retirement holding.
- **Rewards economy — exists but PAUSED (dial-in).** `REWARDS_LIVE` unset; award/redeem refuse. Last week's WAU-12 reading was this cohort's `scout_wallet` test earns; that testing has wound down (WAU back to 2).
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is purely read-only.

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** **WAU 2 / 38 accounts / 170 saved wallets (live 10-12)** — honest external floor. Gate: **50+ WAU**. | **High** | Medium (assets built, channel unrun) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (leg), All Day short. | High | Mixed |

### Security / operator (the open items + P0)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable by SHA; RS256 PII persists. GitHub ticket filed; rotate regardless. | **P0 (operator)** | GitHub GC + rotation |

### Data completeness / chain history

| # | Issue | Severity | Effort |
|---|---|---|---|
| 190 | Pre-2023-11-08 custodial pack opens have no free source (33/34 wallets); keyed-provider decision. | Med (open) | Decision + keyed ingest |
| 189 | Top Shot offer capture — complete; ~4.0% pre-spork fills still have no offer row (reachable only via dark history nodes). | Low–Med | Partly landed |
| 181 | Flow mainnet24–26 access nodes dark; pre-mainnet27 arrival checks wait; retire-vs-repoint decision 10-24. | Med | Partly landed (parked) |
| 185 | Top Shot issuer-held split `pending` since 10-03; overdue backlog draining 2,891 → 430; expect clear ~10-13/15. | Low–Med | Draining on schedule |
| 66 | Zero external links; structured data shipped; external links remain Trevor's. | Med | Off-platform (not code) |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 172 | Giveaway "Deliver all" stalls on desktop (Flow Wallet extension); phone works. | Med (operator) | Active-account + hard-reload retry |
| 114 | Cowork dashboards render failed read as empty — 15 live artifacts in OneDrive (outside connected folders) still carry the old helper. | Med | Cowork-desktop session + re-run audit |
| 76 | Site-availability alarm closed in design, degraded in cadence (GitHub sheds runs); needs off-GitHub trigger + a credential. | Med | Trevor (credential) |
| 17 | Pack/Moment/Set page a11y — modals done 10-10; low-severity tail deferred; live-site real-browser modal check still open. | Low | Mostly landed |
| 34 | Sentry dark (beacon is detector; connector needs re-auth). | Med | Decided (no spend) |
| 58 | Candy/Panini OpenSea indexers 100% failing on missing `OPENSEA_API_KEY`; Magic Eden covers Candy. | Low | Trevor env var |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run and all growing: DashboardClient **3,005**, SniperClient **2,095**, CollectionAnalyticsClient **2,037**, CollectionTabClient **1,599**, MarketClient **1,435**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June 4.2 GB DB-size baseline doc is stale** — the DB now cycles in the mid-30s GB (35.6 GB live this run).
- **Flowty's API is expected to go dark "soon"** (Trevor, 09-25). RPC is now Flowty-independent for priced columns; the teardown checklist is pre-staged.
- **A server→client prop must be data, never a callback** (2026-09-29); **a `"use client"` module must never reach `lib/supabase.ts`** (2026-09-28); **an inline `<style>` reset must sit in `@layer base`** (2026-10-03) — all three are green-in-`tsc`/vitest/lint but only a real render says so; see `architecture-notes.md`.
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-08-03.md`** (accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents.** | **Top Shot MET (56.5% leg); All Day NOT MET (26.7%) and flat; Candy jumped to 56.0 on ask corroboration. Read as a series.** |
| Go-live | **M1–M11 bars.** | Accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 50+ WAU.** | **Open — the critical path. WAU 2 live (honest external floor).** |
| 2 | Cost / latency / saturation levers. | **Stable — DB ~35.6 GB (genuine growth + TOAST + pg_net log), tier LARGE; update the stale size baseline doc.** |
| 3 | Durable debt. | Heavy advance — chain-truth #167/#169/#171/#173 closed, offer capture complete, legal/honesty + security pass, light-mode guard to 87 files. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, 56% leg); Panini walked; Rewards economy paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** action the #22 purge GC + credential rotation (chase the GitHub ticket; rotate `INGEST_SECRET_TOKEN`); decide #190's keyed data source; run the `flowty_archive` tx-lane dedupe then scratch-drop in the SQL editor; set `OPENSEA_API_KEY` (#58); rotate `ATLAS_POOL_INGEST_KEY` (#144); retry the giveaway desktop delivery (#172); fix the 15 live Cowork dashboards (#114) from a desktop session; get a clean WAU read (exclude internal + any test cohort).

---

## 5. In-code TODO inventory

A first-hand `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` over `app/ lib/ components/ scripts/ workers/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; `node_modules`/`.next`/`coverage`/`dist` excluded) found **4 markers, none actionable** — unchanged in character from prior weeks:

### 5a. Narrative / resolved-work references (4 matches)

- `app/api/rtr/lock-roi/route.ts:38` ("v2 folds in the two signals the v1 TODO called out — TIER and SERIAL"), `lib/rtr-lock-roi-weights.ts:7` ("resolves the standing … TODO"), `lib/chains/solana/normalize.ts:47` ("previously held as a TODO placeholder"), `lib/format.ts:6` (the `"$X,XXX.XX"` format doc — the `XXX` here is a format-string literal, the exact false positive the task names). All describe resolved work or are literals.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) and draft-doc `TODO(...) RESOLVED` lines persist by design. Vendored `workers/**/node_modules/` markers are third-party and excluded.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the 10-11 overnight handoff, and live DB reads:

**Newly resolved / landed since last week (2026-10-05 → 2026-10-11):**
- **#167 / #169 / #171 / #173** — the full chain-truth / sell-back / Top Shot edition-identity set from last week's open/partial list, all resolved 10-09/10-10.
- **#188 / #189** — Top Shot offer capture: same-tick offers recovered, serial-offer resolution fallback, **`sales.offer_id` on 81,574/81,574 `offer_fill` sales**, 17,257 historical offers recovered. (#189 left partial at ~4.0% pre-spork fills unplaced.)
- **Legal / honesty / security pre-launch pass (10-11)** — account deletion (`DELETE /api/profile/account`), Terms (eligibility age, non-affiliation list, Rewards & Giveaways, IP takedowns), privacy policy, constant-time Bearer comparison, auth-callback open-redirect close.
- **Candy ask corroboration (10-11)** — lifted the Candy HIGH/MED leg from 23.2% to **56.0%**.
- **Light-mode conversions (10-11)** — the guard now protects **87 files** (was 63); the last light-mode holdouts converted rather than excepted.
- **SEO structured data + llms.txt (10-11)** — structured data where Google can see it, llms.txt regenerated, default OG fallback.
- **`public_board_slow_count` cleared to 0** (was 1 — the `panini_sale_feed_status` census).
- **The 2026-10-10 known-issues triage pass** — closed most of the partial backlog (partial 35 → 7) under Trevor's "make decisions yourself" delegation.

**Note on churn:** the register grew 172 → 188 numbered items in one week, but open+partial collapsed 40 → 10 as the triage pass and the chain-truth ships landed. This was a reconciliation week — the mirror of last week's discovery surge.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars:

1. **Action the #22 purge residue (Trevor):** chase GitHub Support ticket #4811268 (option 2 — internal references only — was posted 10-04), then re-test `commit/1c3e01a8f` (expect 404) and **rotate the Dapper session regardless**. Rotate `INGEST_SECRET_TOKEN` in the same pass. Oldest open P0.
2. **Decide #190's data source:** pick a keyed provider (Dune `flow.cadence_events`, Find Labs Simple API, or Bitquery v1) for the pre-2023 custodial pack-open history, and validate it against 0xbd94…'s known 2021–23 reveals before committing.
3. **Run the `flowty_archive` SQL in the Supabase SQL editor:** `dedupe_tx_lane` then `drop_scratch` (~185 MB). Log each in the ledger the same turn.
4. **Clear the small operator items:** set `OPENSEA_API_KEY` in Vercel (#58, closes both Candy + Panini halves), rotate `ATLAS_POOL_INGEST_KEY` (#144), retry the giveaway desktop delivery (#172, make `0x3d0b…` active + hard-reload).
5. **Fix the 15 live Cowork dashboards (#114)** from a Cowork-desktop session (copy the `rpc-insights-health.html` helper into all 15, `update_artifact` each), then re-run `scripts/audit-cowork-artifact-failure-handling.mjs`.
6. **Get a clean WAU read** (exclude `internal_accounts` + any test cohort) so the demand number means external users, then **drive one acquisition channel against the 50+ WAU gate (§2.1).**
7. **Watch the draining partials:** #185 issuer-held split (expect `pending` → `ok` ~10-13/15), #181 Flow-nodes retire-vs-repoint decision on 10-24.
8. **Update the stale DB-size baseline doc** (4.2 GB June → cycling mid-30s GB) and keep the `net._http_response` bloat on watch.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **458 commits** since 2026-10-05 (`git log --since`); tip `6071d18bd` 2026-10-12 15:51 PT (Trevor). Authors: Claude 397, Trevor 40, Cowork 14, context-hygiene 2, nightly/monitor bots ~4.
- **Counts measured this run:** CI = **20** jobs under `jobs:` in `.github/workflows/ci.yml` (changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno) — same 20 as last week; DB-invariant test files = **266** (`supabase/tests/*.sql`, `ls`, +14); `app/insights/*/page.tsx` = **32** (+1). Monoliths re-measured (`wc -l`): DashboardClient 3,005 / SniperClient 2,095 / CollectionAnalyticsClient 2,037 / CollectionTabClient 1,599 / MarketClient 1,435 — all slightly up.
- **Live DB reads 2026-10-12 (PT):** demand → **38** accounts / WAU **2** / MAU **16** / **170** saved wallets / **34**-of-38 with a saved wallet / **1** email sub. DB size `sum(pg_database_size)` → **36,461 MB** (~35.6 GB). Accuracy legs from `rpc_trust_health_precompute` (TS 56.5 [fresh-24h 74.4], All Day 26.7 [48.2], Candy 56.0, Pinnacle 31.9, Golazos 1.2, UFC 0.0; `topshot_impossible_parallel_serials` 0, boards empty 0 / slow 0, `fmv_sanity_flags` 0). #185 issuer-held split `pending`, overdue backlog `topshot_atlas_dists.next_due_at <= now()` → **430** (from 2,891 at the fix).
- **TODO scan: 0 actionable markers in live app code** (§5) — `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` with `node_modules`/`.next`/`coverage`/`dist` excluded; the one `XXX` hit is a `$X,XXX.XX` format literal.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve, no stale references found:** `docs/strategy/{roadmap-2026-08-03,go-live-2026-09}.md`; `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,testing-and-ci,schema-truth,architecture-notes,player-identity,chain-strategy}.md`; `docs/overnight/{ledger.md,metrics-latest.json,focus.md}`; `lib/{launch-flags,collections,address,api-error}.ts`; `lib/insights/{board-status,board-page-fetch}.ts`; `lib/analytics/fetch-json.ts`; `lib/og/board-empty-copy.ts`; `lib/sniper/header-copy.ts`; `app/api/golazos-offers-indexer/route.ts`; `scripts/audit-cowork-artifact-failure-handling.mjs`; `docs/cowork-skills/rpc-insights-health.html`; `docs/research/dune-rigged-custodial-opens-2026-09-29.sql`; `.github/workflows/{ci.yml,edge-fn-deploy.yml,site-availability-alarm.yml,wallet-backfill-backstop.yml}`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **188 numbered items — 3 open · 7 partial · 178 closed**; the 3 open are **#22, #172, #190**; the 7 partial are **#17, #66, #76, #114, #181, #185, #189**; the newest filed slot is **#190**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-10-12)

The register's own generated STATUS INDEX reports **188 numbered items — 3 open · 7 partial · 178 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 22 | 🚨 Credential purge | 🟡 **open** | Branch deleted; blob fetchable by SHA + RS256 PII persists; GitHub ticket #4811268 filed — GC + rotation owed to Trevor | known-issues #22 |
| 172 | Giveaway "Deliver all" desktop stall | 🟡 **open** | Extension path stalls; phone works; operator retry + hint-line owed | known-issues #172 |
| 190 | Pre-2023 custodial pack opens, no free source | 🟡 **open** | NEW 10-11 — 33/34 wallets; keyed-provider decision owed to Trevor | known-issues #190 |
| 17 | Pack/Moment/Set a11y tune-up | 🟠 partial | Modals done 10-10; low-severity tail deferred; live-site real-browser modal check open | known-issues #17 |
| 66 | SEO / zero external links | 🟠 partial | Structured data + llms.txt shipped; external links remain Trevor's | known-issues #66 |
| 76 | Site-availability alarm cadence | 🟠 partial | Closed in design, degraded in cadence (GitHub sheds runs); needs off-GitHub trigger + credential | known-issues #76 |
| 114 | Cowork dashboards render failed read as empty | 🟠 partial | Repo copies fixed; 15 live OneDrive dashboards still carry old helper; needs Cowork-desktop session | known-issues #114 |
| 181 | Flow mainnet24–26 nodes dark | 🟠 partial | Parked with canary; retire-vs-repoint decision deferred to 10-24 | known-issues #181 |
| 185 | Top Shot issuer-held split pending | 🟠 partial | Draining — overdue 2,891 → 430 (live 10-12); expect `ok` ~10-13/15 | live DB read |
| 189 | Top Shot offer capture | 🟠 partial | Complete; ~4.0% pre-spork fills unplaced (reachable only via dark history nodes) | known-issues #189 |
| 167 | Top Shot sell-backs missing from `sales` | ✅ closed | RESOLVED 10-10 (was open last week) | STATUS INDEX |
| 169 | sell-backs counted as market sales | ✅ closed | RESOLVED 10-10 (`sales_market` exit landed; was open last week) | STATUS INDEX |
| 171 | parallel moments under base edition | ✅ closed | RESOLVED 10-10 (was partial last week) | STATUS INDEX |
| 173 | `topshot_moment_subeditions` wrong base edition | ✅ closed | RESOLVED 10-09 (was open last week) | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **188 numbered items — 3 open · 7 partial · 178 closed**, newest slot **#190**. Plus the go-live plan, the per-collection accuracy legs, Candy live + Panini walked + Rewards paused, **20-job CI**, **266 DB-invariant test files**, and **32 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** this was a reconciliation week — the mirror of last week's discovery surge. The 2026-10-10 triage pass and the chain-truth ships collapsed open+partial from 40 to 10: **#167/#169/#171/#173 are all closed**, **Top Shot offer capture is complete** (`sales.offer_id` 81,574/81,574), and a **legal/honesty + security quick-wins pass** cleared pre-launch surface debt. Live trust metrics are clean (0 breaches, 38/38 arms, boards slow 0) and the overnight passes were GREEN with 0 reverts. The open set is three — **#22** (credential-purge residue, P0, weeks old, now on a GitHub ticket), **#172** (giveaway desktop delivery), and **#190** (pre-2023 pack-open history needs a keyed-provider decision). Seven partials remain, mostly draining-or-operator-gated. On the front page, **Top Shot is MET (56.5%), Candy jumped to 56.0% on ask corroboration, All Day is still short (26.7%)**, and **WAU fell to 2 as the rewards test cohort wound down — the honest external number is low single digits against a 50+ gate**. The standing asks are operator/Trevor: the **#22 purge GC + rotation**, the **#190 data-source decision**, the **`flowty_archive` dedupe + scratch-drop SQL**, **#58's OpenSea env var**, and the **#172 giveaway desktop retry**. **Demand — a clean one — is still the one number that decides everything.**
