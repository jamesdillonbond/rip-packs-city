# Rip Packs City — Project Health Report

**Date:** 2026-10-26
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **211 numbered items — 3 open · 7 partial · 201 closed**, newest slot **#213**), the canonical forward plan `docs/strategy/roadmap-2026-10-17.md`, `docs/reference/roadmap-status.md` (headline-metric block re-read 2026-10-22, plus the "Decisions taken" ledgers), `docs/reference/architecture-notes.md`, `docs/overnight/ledger.md` (1,130 headings; newest 2026-10-26), the two same-day sibling passes `claude/handoff-2026-10-26-overnight-pass.md` and `claude/weekly-health-digest-2026-10-26.md`, plus first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) at ~03:10 AM PT.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#213`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-10-19.md` (7 days ago). This regeneration mirrors its structure. `_2026-10-12.md` … `_2026-05-22.md` (twenty-four earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-10-19 — a very large Panini↔Top-Shot parity push and a multi-pass FMV-honesty sweep, shipped almost entirely by interactive sessions, not the autonomous pass.** The overnight handoff counts **631 unique files committed in the last 48 h** and the full week shows **899 commits since 10-19** — the heaviest week on record. Two workstreams dominated. (1) **Panini parity:** new product pages, a **Hot Floors** sweep board (`/panini-blockchain/hot-floors`), per-edition **ask-history** sections + a daily lane, an Analytics "Top products by volume" card, product-scoped set URLs (#204), accent-blind market search (#207), and five new Panini pipelines (product-rollup, edition-team-keys, public-deals, edition-ask-daily, offer-spread) — all running ok in the post-ship watch. (2) **FMV honesty / accuracy:** four rendered-HTML sweeps retired fabricated readings (ULTIMATE FMV now reads the edition's own ask and **retires 19 prices it can't support**; the Sniper prices #1/perfect serials from a fitted model, not a flat 8×; "Listed —", "0.0×", "$0" and raw "Series 8" labels became honest dashes/labels), and three pricing-tier caps landed (ASK_ONLY on All Day + Golazos #208, STALE on Top Shot + All Day #209, the thin-sale haircut depth floor #210). The register grew **17 slots (#197–#213)** and **closed +14 (187 → 201)**; open+partial moved **7 → 10**. Last week's three open items all left the open list — **#196** (interactive-row a11y) RESOLVED, **#193** (Pinnacle HIGH tier) and **#22** (credential purge) both demoted to partial — and last week's partials **#114**, **#181**, **#189** all closed. The five genuinely-new open/partial slots are measurement/pricing-decision work, not fire: **#202** (Panini LOW tier prices off a thin-edition outlier), **#198** (All Day V1 listing re-verify, prod proof due ~10-27), **#208/#209/#210** (pricing-cap partials with a weekly/basis tail), **#212** (a second leaked-credential residue, Trevor-only), **#213** (the #209 STALE cap misses low-serial sales, re-read ~10-30).

> **Overnight reality — GREEN and idle by design, every night this week.** Tonight's pass (2026-10-26 ~1:03 AM PT, push-capable via the laptop-VM route, no `FREEZE`) shipped **0**, reverted **0**, logged a quiet green night: the whole app/api + Panini surface is **hot** (631 files in 48 h), so nothing clean-safe + non-hot + independently verifiable was open to ship. Health GREEN across security, structure, pipelines and the accuracy gate. Every night 10-19 → 10-25 also shipped **0** from `rpc-nightly-autonomous-pass` — the week's shipping was all interactive Cowork / Claude Code sessions. The one critical pipeline arm from the prior night cleared (1 critical → 0); a new bounded signal surfaced (`panini_deal_board_all` cache-warm timeout, count=1) and is queued to watch.

> **Traction reality — still thin, but two engagement signals moved up.** Weekly digest 7-day reads: concierge **16** (smoke-filtered, up from 9), **outbound_clicks 95** (up sharply from 7 — the first real jump in that signal), **1** email subscriber, portfolio_snapshots **251** (flat). ⚠ The user gate is **100 WAU** (raised from 50 on 09-25) and **outreach is off** (Trevor, 10-14), so these are watch-signals, not a green light. Demand is still the one number that decides everything, and external WAU is in the low single digits against a 100-WAU gate. (A fresh internal-excluded WAU leg was not read this pass; the prior report's live read was WAU ~1 / 39 accounts / 175 saved wallets on 10-19.)

> **Accuracy gate — read the series, not the leg; Top Shot's ~44 % is a by-design label correction.** File-blessed weekly-mean legs (`rpc_trust_health_history`, roadmap-status 10-22 block, wk 10-19 **partial, 16 legs**): **Top Shot (M1) 44.5 %** (🔴 under its 50 % bar *by decision* — FMV 1.8.2 `gateMediumToRecentSale` requires a usable sale within 30 days), **All Day (M2) 27.3 %** (🔴 short of 30 %, flat), Pinnacle **33.4 %** (own leg, never averaged), Candy **54.1 %** (a relabel on a frozen market, unscored), Panini **42.4 %** (the 1.3.x re-grade + coverage growth, not a backtested gain), Golazos **0.1 %** (newest sale left the 30-day window — honest), UFC **0.0 %** (closed-market sentinel). Against **realised sales**, tonight's backtest leg (10-26) still matches or beats a naive median on the liquid collections: NBA published-HIGH ratio **0.966** (median abs err 11.1 %, within ±25 % 79.0 %), All Day HIGH ratio **1.067** (within ±25 % 72.0 %), Panini HIGH ~**1.008** vs a 30-day sales median. The STALE (2.86×) and ASK_ONLY (2.00×) tiers are the by-design non-reliable tiers the week's #208/#209 caps target — not published-HIGH.

> **Cost / storage — ~41.8 GB, up ~1.8 GB on legitimate Panini growth.** Live reads this run: **41,801 MB (~41.8 GB)**, up from ~39.9 GB last week. The growth is the Panini catalog expansion from this week's parity work — `panini_card_serials` 7.6 → **8.5 GB**, Panini editions 36,320 → **39,524 (+3,204)** — not a runaway; `net._http_response` sits at its ~1.8 GB sawtooth trough and is not the driver. This crosses the literal ">1 GB/week" tripwire but is explained and benign. Compute stays **LARGE** (resized 09-20). ⚠ **The ~4.2 GB June DB-size baseline doc is still badly stale** — the real operating baseline is ~40 GB; resetting it so it stops reading as a ~10× regression remains an open housekeeping item.

> **Platform context.** Top Shot's public REST API stays dead; the Atlas backend is the feed and answers a Cloudflare 403 on some lanes by design (self-healing — a failed page writes nothing and is re-walked). Flowty's hosted v1 book is dead for All Day / Golazos (repointed to the on-chain `cached_listings_v2` last week; ⚠ note `cached_listings_v2` holds **0 Top Shot rows**, so Top Shot moment-page asks now read `ts_listings` — fixed 10-25). NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled). **Candy/Solana is LIVE but its market has been frozen since 2026-10-11** — a 10-25 on-chain census (Solana public RPC, all venues) **confirmed trading genuinely stopped, did not migrate to OpenSea**, which closed **#58** by measurement and drives the lone `candy_sales_stale_hours` trust-arm breach (340.7 h, benign). Panini = WC Prizm + basketball plane (`PANINI_PUBLIC = true`), collector-walk still adding editions.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/roadmap-2026-10-17.md` for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#213** | Register STATUS INDEX: **211 numbered items — 3 open · 7 partial · 201 closed**. 17 new slots (#197–#213) since last week. See §9. |
| Known issues — resolved/closed since last week | **+14 net** | Closed count rose 187 → 201. Moved off the open/partial list: #196, #114, #181, #189 (closed) and #8/#58 (closed) — see §6 / §9. |
| Known issues — open / partial | **10** | **3 open** (#202, #212, #213) + **7 partial** (#22, #66, #193, #198, #208, #209, #210). Up from 7 last week (a build-and-measure surge, not fire). — §3 / §9 |
| Known issues — 🚨 live trust breach | **0 impossible-serial; 0 FMV sanity; 1 benign arm** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; **1 breach** = `candy_sales_stale_hours` 340.7 h = the frozen Candy market (benign, #58-class), not a defect. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#22** rotate the exposed Dapper session (GitHub half DONE 10-20); **#212** revoke the leaked LiveToken session; S1/S3/S6 console token rotation; C2 CAN-SPAM postal address; #8 cleanup (disable the dead edge cron before 10-27 5 PM PT). — §2.6 |
| Known issues — carried shelved | **~1** | **#58** OpenSea key — now **CLOSED BY MEASUREMENT** (Candy freeze is real, not a venue move); the 3 candy-opensea lanes stay unscheduled. The overnight queue still lists it as a standing "Trevor-only if he wants Candy to resume" note. |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. Accuracy gate: Top Shot met (series, by-design ~44 % leg), All Day short. Demand is the binding bar. — §2.1 |
| Commits since last report | **899** | `git log --since 2026-10-19` on the connected mount. Authors: Claude 841, Cowork (3 bot identities) ~34, monitor/nightly bots ~18, Trevor 3, context-hygiene 3. Mount HEAD `0668e8d02` 2026-10-25 21:33 PT (Claude); mount trails origin (`48ff97faa` tonight). |
| Accuracy gate (headline metric) | **Per-collection, weekly-mean legs** | Top Shot **44.5 %** (by-design 1.8.2 re-grade; read as a series), All Day **27.3 %** (NOT MET), Pinnacle 33.4, Candy 54.1 (relabel, frozen), Panini 42.4, Golazos 0.1, UFC 0.0 (sentinel). Realised-sales backtest still beats a naive median on the liquid collections. — §2.1/§2.3 |
| Demand (the critical-path number) | **thin; outbound_clicks ↑** | 7-day: concierge 16, outbound_clicks 95 (↑ from 7), 1 email sub, 251 portfolio snaps. Gate: **100+ WAU**; **no outreach** (10-14). — §2.1 |
| Open overnight operational items | **standing queue** | #58 OpenSea key (closed by measurement; lanes stay off); #22 + #212 credential rotations; `get_panini_franchise_panel` perf tail; `refresh_panini_offer_spread` self-collision; `panini_deal_board_all` cache-warm watch. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE (thin, market frozen) + Panini (WC Prizm + basketball, collector-walk live); plus a paused Rewards economy (dial-in). — §2.8 |
| Prioritized next actions | **canonical** | `roadmap-2026-10-17.md` (accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable** | Measured this run (`git ls-files` + `grep`): **6** matches, all narrative/false-positive (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **277 `supabase/tests/*.sql` files** | +10 vs last week's 267 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — unchanged from last week (same 21). See §8. |
| Public `/insights` surfaces | **33** | Measured this run: 33 `app/insights/*/page.tsx` dirs (+1 vs 32). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** The busiest shipping week on record, and a clean one. The register's open work *grew* (7 → 10 open+partial) — but the new slots are a **measurement-and-pricing surge, not a fire**: every new item is a pricing-accuracy refinement (#202, #208, #209, #210, #213), a scheduled production proof (#198), or a Trevor-only credential step (#212). Last week's whole open list is settled — **#196** resolved, **#193** and **#22** demoted to partial, **#114/#181/#189** closed — and two long-standing routed items cleared: **#8** (NBA projections now fed free by ESPN via pg_net since 10-23) and **#58** (OpenSea key closed by measurement — the Candy freeze is a real dead market, not a venue move). The concentrated risk is unchanged in shape: **(1) demand** — external WAU is low single digits against a 100-WAU gate with outreach off, though outbound-clicks ticked up; **(2) two Trevor-only credential residues** (#22 Dapper session, #212 LiveToken session — both "rotate regardless, the leak is in public git history"); and **(3)** a short, bounded pricing-accuracy tail (#202/#209/#210/#213) with clear falsifiers and dated re-reads. Live trust metrics are clean (0 impossible serials, 0 FMV sanity flags); the one breach is the benign Candy freeze. All Day remains the one published collection short of its accuracy bar.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. Demand thin; **outbound_clicks 95 (↑ from 7)**, concierge 16. Gate **100+ WAU**, **outreach off** (10-14). The problem is still *demand*. (§2.1) |
| **Panini ↔ Top Shot parity (the week's big build)** | Hot Floors board, product pages + "Top products by volume", per-edition ask-history + daily lane, product-scoped set URLs (#204), accent-blind search (#207); five new Panini pipelines, all ok in post-ship watch (§2.3/§2.8) |
| **FMV honesty / accuracy caps (the week's correctness arc)** | ULTIMATE FMV retires prices it can't support (19 retired); Sniper #1/serial fitted model (not flat 8×); ASK_ONLY cap (#208), STALE cap (#209), haircut depth floor (#210); four rendered-HTML fabrication sweeps (§2.3/§2.4) |
| **Live trust breach still CLEAR** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; 1 arm breach = the benign Candy freeze (§2.4) |
| Pinnacle FMV accuracy (ongoing) | #193 — HIGH tier now prices at the median of its last 5 sales (84/262 re-priced 10-23); weekly exit + tier-order question stay open (§2.3) |
| Pricing-tier caps (new partials) | #208 ASK_ONLY (All Day + Golazos), #209 STALE (Top Shot + All Day; basis line shipped 10-25), #210 thin-sale haircut depth floor — each a partial with a weekly/measurement tail (§2.3) |
| Panini LOW-tier outlier (new open) | #202 — LOW tier medians the last 3 sales of ANY age and ignores the live ask, so a thin edition's two-sale outlier becomes FMV; 64 editions ≥ 10× their low ask (~$1.56M of a $37.15M cap). A pricing-engine decision (§2.3) |
| Operator-owned / credential residues | #22 Dapper session rotation (GitHub purge DONE 10-20); #212 LiveToken session revoke; S1/S3/S6 console tokens; C2 postal address (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is detector); #114 live Cowork dashboards RESOLVED (ported to claude.ai artifacts 10-20) (§2.5) |
| Security | scans clean; trust breach clear; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support; R138 credential-literal guard landed (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| SEO | #66 — zero external links (Trevor, gated on the accuracy gate); structured data + llms.txt shipped; Search Console re-read ~10-28 (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run, roughly flat/slightly down: DashboardClient **3,003** / SniperClient **2,167** / CollectionAnalyticsClient **1,963** / CollectionTabClient **1,646** / MarketClient **1,374** (§3) |
| Perf tail (new, routed to Claude Code) | `get_panini_franchise_panel` 13.8 s max tail vs a 10 s page bound (crawler-burst only; did not recur tonight); `refresh_panini_offer_spread` REFRESH self-collision (self-heals) (§2.6) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy is the GATE, headline metric is the HIGH/MEDIUM confidence share read as a series) plus **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The binding user bar is **100+ WAU** (raised from 50 on 09-25), and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — accuracy near its bars, demand genuinely thin — `Severity: High · Effort: Medium (built + measured, no traffic by directive)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, 7-day digest reads (2026-10-26):** concierge **16** (smoke-filtered, up from 9), **outbound_clicks 95** (up sharply from 7 — the first real movement in that signal), **1** email subscriber, portfolio_snapshots **251** (flat). Real traffic is still thin; a clean internal-excluded WAU leg was not read this pass (the 10-19 live read was WAU ~1 / 39 accounts / 175 saved wallets).
- **Accuracy (weekly-mean legs, roadmap-status 10-22 block, wk 10-19 partial):** **M1 Top Shot 44.5 %** (under 50 % *by decision* — the 1.8.2 MEDIUM re-grade), **M2 All Day 27.3 % (≥ 30 % — NOT MET)**, Pinnacle 33.4, Candy 54.1 (relabel, frozen), Panini 42.4, Golazos 0.1, UFC 0.0 (sentinel). ⚠ Read the series, not the leg. Against realised sales, published HIGH still matches/beats a naive median on the liquid collections (tonight's leg: NBA HIGH 0.966, All Day HIGH 1.067).
- **M2 did not convert again.** All Day's HIGH/MED share has been flat near 26–27 % for weeks; it stays liquidity-limited and the 10-10 decision keeps its dispersion gate (no relabelling). The week's All Day work (#208 ASK_ONLY cap, #209 STALE cap) improves realised-sales *error* on the non-reliable tiers, not the HIGH/MED *share*.

The critical-path action is unchanged by directive: with outreach off (10-14) and the gate at 100 WAU, it is to **keep accuracy beating the incumbents (the gate) and get a clean internal-excluded WAU read** so demand is unambiguous when outreach is eventually turned on. Demand is still the single most important line in the report.

### 2.2 Public intelligence surfaces — 33 public — `Severity: n/a (shipped) · context`

All 33 built surface dirs in `app/insights/` are public (measured this run: 33 `page.tsx`, +1 vs last week). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window) remain as standing design considerations. The week's rendered-HTML sweeps closed several surface-level fabrications (rookie-board ULTIMATE /1 overpricing, Pack Sniper "0.0×" tiles, Pack Reality "$0" buckets, raw "Series 8" labels).

### 2.3 Data-intelligence — Panini parity + the FMV-cap arc — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM share (weekly-mean legs, roadmap 10-22 block):** Top Shot 44.5 (by-design 1.8.2 re-grade), All Day 27.3, Pinnacle 33.4, Candy 54.1 (relabel; frozen market), Panini 42.4, Golazos 0.1, UFC 0.0 (empty-market SENTINEL, never a percentage). HIGH-confidence rows estate-wide **18,457** (up from 12,643, driven by Panini; far above the 400 floor).

**Shipped / landed since last week:**

- **ULTIMATE FMV reads the edition's own ask and retires prices it can't support (10-25).** `compute_ultimate_non_special_fmv` was borrowing a sibling's ask (4 unlisted Kon Knueppel /1s priced at $2,513); the fix matches the edition's own `cached_listings` row and a NO_DATA result now **retires the writer's own priced row** (ran once: 187 priced, **19 retired**). Did not degrade the accuracy gate (NBA HIGH ratio 0.966, still centered).
- **Sniper prices #1 / perfect serials from a fitted model, not a flat 8× (10-25).** Backtest of 450 realised Top Shot #1 sales: `serial_fmv_estimate` beats 8× in every mint-count band; the estimate now sets adjusted FMV / discount / deal rating.
- **Pricing-tier caps:** **#208** — All Day + Golazos ASK_ONLY (live floor × 0.90) was a median 1.8× realised; now capped at the edition's recent sales (backtested 1.80 → 1.00). **#209** — Top Shot / All Day STALE price capped at the edition's last market sale (was ~2.0× realised on Top Shot); the edition page now states a stale price's last-sale age as a fact ("last sale 73d ago"), shipped 10-25. **#210** — the thin-sale haircut's depth term had no input, so every 0-sale LOW/ASK_ONLY edition took the deepest 0.55 cut (Top Shot LOW priced at 0.44× realised); the floor is now 0.75.
- **Panini parity build** (all pipelines ok in tonight's post-ship watch): Hot Floors (`/panini-blockchain/hot-floors`), per-edition ask-history + `panini-edition-ask-daily`, Analytics "Top products by volume", product-scoped set URLs (#204), accent-blind market search (#207), plus `panini-product-rollup`, `panini-edition-team-keys`, `panini-public-deals`, `panini-offer-spread`.
- **#114 — Cowork dashboards RESOLVED 10-20.** A cloud session linked to Trevor's laptop staged the dashboard store; all **11** live dashboards were ported to claude.ai artifacts with throwing helpers (closing the "render a failed read as empty" gap).

**New / open:**

- **`#202` — Panini LOW tier prices off a thin-edition outlier (OPEN, NEW 10-20, pricing decision).** LOW medians the last 3 sales of ANY age and ignores the live ask, so an edition whose two highest sales are the same serial reads "~$198 … lowest ask $1.00". **64 Panini editions have FMV ≥ 10× their low ask, ~$1.56M of the $37.15M collection cap.** Source `lib/chains/panini/ingest-normalize.ts`. An interactive pricing-engine decision (ask-aware floor, age weighting, or a dispersion gate).
- **`#198` — All Day V1 listing re-verify (PARTIAL, 10-20).** The recurring V1 re-verify lane is live (pg_cron 762 `rpc-allday-v1-listing-reverify`), tested against local Postgres; the **production proof** is the first real dispatch after the 10-20 stamps age past 7 days — the :24 tick ~8:24 AM PT **10-27**. Exit = that day's runs show `dispatched` > 0 with matching drains.
- **`#193` — Disney Pinnacle HIGH tier (PARTIAL, gate landed 10-23).** The HIGH tier now prices at the median of its last 5 sales (84/262 renders re-priced, 0 labels moved). What stays open: the **weekly exit** (published HIGH within ±25 % ≥ 68 % with MEDIUM holding; falsifier > 3 pts under naive-5 two weeks → revert) and the **tier-order question** (MEDIUM beat HIGH pre-switch; re-read after a week of post-switch sales). `pinnacle_fmv_sales_backtest()` is the instrument.
- **`#208 / #209 / #210` — pricing-cap partials.** Price halves are done and backtested; the tails are #208's weekly hold, #209's basis-line (shipped 10-25), and #210's remaining haircut sub-classes.
- **`#213` — the #209 STALE cap misses low-serial sales (OPEN, NEW 10-25, measurement).** `fmv_snapshots_cap_stale_to_last_sale()` reads only `serial_number > 25`, so on a small edition — where most supply is ≤ /25 — a newer, lower low-serial sale can sit under a price it never caps (e.g. All Day Chris Jones /30: newest sale serial #9 at $69 vs a published STALE $520 from serial #26). Population: Top Shot 331 current STALE (+ All Day/others). Re-read due ~10-30.
- **`#66` — SEO (PARTIAL, needs Trevor):** every code item done; zero external links remain Trevor's and stay **gated on the accuracy gate**; Search Console re-read ~10-28.
- **`#8` — NBA projections — RESOLVED 10-24.** Fed free by ESPN via the DB's pg_net egress (`nba-espn-projections`, hourly; Fast Break reads it since `0262dd4`, verified `dataStatus: "ok"`). ⚠ The *old* edge lane `sync-nba-projections` still fails 7/7 (last ran 10-24); disabling its cron-job.org job 7568448 is Trevor's — its **alarm suppression lapses 10-27 5:00 PM PT** (§2.6).

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon, function-search-path-drift all `[]` / 0 rows; `check_when_others_timeout_blind()` length 0). RLS: 0 public base tables with RLS off, 0 anon write-grants. A `recent_low_usd` search-path filing (10-26) was resolved by Claude Code (`20261026001535`, a curated inlined-helper exemption).
- **Live trust breach clear.** `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` **0**; the one trust-arm breach is `candy_sales_stale_hours` **340.7 h** (threshold 168) — the frozen Candy market since 10-11, benign and known, confirmed a real dead market by the 10-25 on-chain census. `edition_integrity_flags` 22 (threshold 250), `unmapped_resolution_backlog_max` 19 (threshold 100), `panini_coverage_pct_drop` 5.3 (threshold 15), `fmv_sweep_stall_pct_24h` 4 (threshold 50), `trust_precompute_max_age_hours` 5.28 (threshold 13) — all ok.
- **`#22` — credential-purge residue — PARTLY RESOLVED 10-20 (now PARTIAL, P0-operator tail).** GitHub Support (ticket #4811268, Solved) purged the leaked commit — it no longer fetches by SHA (`upload-pack: not our ref`), the API 422/404s, and the commit page 404s, re-tested by three instruments. **The one remaining step is Trevor's: rotate the exposed Dapper session regardless** (the values were public in git history, so treat them as exposed; `INGEST_SECRET_TOKEN` rotation also still owed).
- **`#212` — a second leaked-credential residue — OPEN, NEW 10-25 (Trevor-only).** The 2026-10-25 security audit found LiveToken session values committed in `docs/archive/audits/livetoken-api-intelligence.md`. The current file is redacted (commit `8bf1c1b`) and `no-credential-literals-in-tracked-files.test.ts` now bans the shape, but the values remain in public git history. Fix is outside the repo: **revoke that LiveToken session** (history-rewrite is not worth it once the session is dead — the #22 lesson).
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 277 `supabase/tests/*.sql` files** (+10, measured this run). CI is **21 jobs** in `ci.yml` (unchanged). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector; this run reads **0 client errors in 24 h** (newest 10-23). ⭐ **`#114` is now RESOLVED** — the 15/11 live Cowork dashboards were reachable from a laptop-linked cloud session on 10-20 and all ported to claude.ai artifacts with throwing helpers. ⭐ **`#76`** (site-availability alarm) stays resolved — cron-job.org job 8637511 probes `/api/health` every 5 min and emails on failure/recovery/auto-disable/TLS-expiry. The true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 new stalled pipelines; **99.1 %** pipeline success / 24 h). Open items for Trevor / operator / Claude Code:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#22 — Dapper session rotation** | GitHub purge DONE 10-20; the leaked values were public in git history. | **P0 (operator)** | Rotate the Dapper session regardless; rotate `INGEST_SECRET_TOKEN` too. |
| **#212 — LiveToken session revoke** | LiveToken session committed to a (now-redacted) audit doc; values still in public history. | **P1 (operator)** | Revoke/sign-out that LiveToken session. Same class as #22. |
| **#8 cleanup — disable the dead edge cron** | `sync-nba-projections` edge lane still fails 7/7; ESPN feed replaced it. | Med (operator) | Disable cron-job.org job 7568448 **before 10-27 5:00 PM PT** (its alarm suppression lapses then). |
| **S1 / S3 / S6 + C2** | console token rotation (cron-job.org, GHA, Vercel) + CAN-SPAM postal address (`RPC_SENDER_POSTAL_ADDRESS`). | Med (operator) | Do before marketing starts; digests stay flag-off until C2 exists. |
| **`get_panini_franchise_panel` perf tail** | 13.8 s max vs a 10 s page bound; tips only on a concurrent crawler sweep (did not recur tonight; mean 993 ms). | P2 (Claude Code) | Needs `EXPLAIN (ANALYZE, BUFFERS)` of a slow franchise, then a targeted index (likely on `panini_edition_team_keys`) or a precompute — not a blind index. |
| **`refresh_panini_offer_spread` self-collision** | Hourly refresh failed once (self-collision on its own MV); self-heals. | P3 (Claude Code) | Separate the read from the `REFRESH … CONCURRENTLY`, or guard with an advisory lock. |
| **`panini_deal_board_all` cache-warm timeout** | New count=1 statement-timeout on the cache-warm cron; degrades to cache. | watch | Watch for recurrence; if it persists, the combined ALL board query needs a look. |
| **#58 OpenSea key** | CLOSED BY MEASUREMENT 10-25 (Candy freeze is real). | Low (optional) | The 3 candy-opensea lanes stay unscheduled; only a Trevor-set key would resume the Candy book, if ever wanted. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. Pack-EV freshness holds (AllDay 3,141 packs, 224 stale > 3 d, ~93 % fresh — improved from 262; Top Shot 1,387 packs, 396 stale > 3 d, the known depleted-dist tail, board writes fresh daily, max_stale 0.05 d). The week's rendered-HTML sweep fixed the two Pack Sniper "0.0×" EV/ask tiles on an empty book (now "—").

### 2.8 Chain foundation — Candy LIVE (frozen market), Panini walked + parity-built, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN, market FROZEN since 10-11:** `CANDY_MLB_PUBLIC = true` (verified this run). The 10-25 on-chain census (Solana public RPC, all venues) confirmed trading genuinely stopped rather than migrating; FMV stays green off existing data; the `candy_sales_stale_hours` arm is the honest downstream symptom.
- **Panini — the WC Prizm + basketball plane** (`PANINI_PUBLIC = true`, verified this run). Collector-walk keeps adding editions (**39,524** Panini editions, +3,204 week-over-week; `panini_card_serials` ~8.5 GB, the main DB-size growth driver). This week added the parity surface (Hot Floors, product pages, ask-history, product-scoped sets) and five pipelines. The WNBA team walk was fixed 10-25 (URL-encoding bug that walked an empty grid).
- **Rewards economy — exists but PAUSED (dial-in).** 25 participants, 14,200 issued / 250 spent / 13,950 outstanding, 1 fulfilled, 0 pending, 0 negative balances. No new participation this week.
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The product is purely read-only (admin-signed giveaway delivery is the one exception).

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** External WAU low single digits; outbound_clicks ↑ (7 → 95), concierge 16. Gate **100+ WAU**; **no outreach** (10-14). | **High** | Medium (assets built, traffic off by directive) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (series, by-design ~44 % leg), All Day short. Demand is the binding bar. | High | Mixed |

### Security / operator (the open credential residues + P0)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 22 | 🚨 Credential purge — GitHub half DONE 10-20; rotate the exposed Dapper session regardless. | **P0 (operator)** | Rotation only |
| 212 | 🚨 LiveToken session committed to a (now-redacted) audit doc; values still in public history — revoke the session. | **P1 (operator)** | Revoke session |

### Data completeness / accuracy / pricing

| # | Issue | Severity | Effort |
|---|---|---|---|
| 202 | Panini LOW tier medians the last 3 sales of ANY age, ignores the live ask; 64 editions ≥ 10× low ask (~$1.56M of $37.15M cap). | Med (open) | Pricing-engine decision |
| 193 | Disney Pinnacle HIGH tier now prices at last-5 median (84/262 re-priced); weekly exit + tier-order question open. | Med (partial) | Measurement + weekly hold |
| 198 | All Day V1 listing re-verify lane live; production proof due the ~8:24 AM PT 10-27 tick. | Low–Med (partial) | Scheduled proof |
| 208 | All Day + Golazos ASK_ONLY price capped at recent sales (1.80 → 1.00); weekly hold open. | Low–Med (partial) | Backtest tail |
| 209 | Top Shot + All Day STALE price capped at last market sale; basis-line shipped 10-25. | Low–Med (partial) | Mostly landed |
| 210 | Thin-sale haircut depth floor was absent (0-sale cells took the deepest cut); now 0.75, remaining sub-classes open. | Low–Med (partial) | Measurement tail |
| 213 | The #209 STALE cap reads only serial > 25, so a newer low-serial sale can sit under an uncapped price. Re-read ~10-30. | Low–Med (open) | Measurement + cap widen |
| 66 | Zero external links (gated on the accuracy gate); code items done; Search Console re-read ~10-28. | Med | Off-platform (not code) |

### Instruments / darkness / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 34 | Sentry dark (beacon is detector; 0 client errors / 24 h). | Med | Decided (no spend) |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |
| — | `get_panini_franchise_panel` 13.8 s tail vs 10 s bound (crawler-burst only). | P2 | Claude Code — EXPLAIN + targeted index |
| — | `refresh_panini_offer_spread` REFRESH self-collision (self-heals). | P3 | Claude Code — advisory lock |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run: DashboardClient **3,003**, SniperClient **2,167**, CollectionAnalyticsClient **1,963**, CollectionTabClient **1,646**, MarketClient **1,374** (roughly flat/slightly down). | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **`cached_listings_v2` holds 0 Top Shot rows** — Top Shot moment-page asks read `ts_listings` (24 h window, absence is a dash not a census). All Day / Golazos / Pinnacle use `cached_listings_v2`; v1 `cached_listings` is dead for All Day / Golazos (tree-walk guarded).
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June ~4.2 GB DB-size baseline doc is badly stale** — the DB now operates at ~40–42 GB; reset the baseline so it stops reading as a ~10× regression.
- **FMV 1.8.2 tightened MEDIUM** (sale within 30 days) on 10-18 — Top Shot's HIGH/MED share reads ~44 % by design; a label correction, not a regression.
- **A server→client prop must be data, never a callback; a server component importing a VALUE from a `"use client"` module gets a stub (new 10-25); a `"use client"` module must never reach `lib/supabase.ts`; an inline `<style>` reset must sit in `@layer base`** — all green in `tsc`/vitest/lint but only a real render says so; see `architecture-notes.md`.
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **canonical**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents, read as a series.** | **Top Shot MET (series; ~44.5 % leg by design); All Day NOT MET (27.3 %) and flat; Pinnacle 33.4; Panini 42.4 (re-grade + coverage). Realised-sales backtest beats a naive median on the liquid collections.** |
| Go-live | **M1–M11 bars.** | Latency/beacon/mobile bars met in prior cycles; accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — 100+ WAU; no outreach (10-14).** | **Open — the critical path. External WAU low single digits; outbound_clicks ↑. Get a clean internal-excluded WAU read; hold traffic until the gate opens.** |
| 2 | Cost / latency / saturation levers. | **Stable — DB ~41.8 GB (Panini coverage + pg_net sawtooth), tier LARGE; reset the stale size baseline doc; one bounded Panini perf tail queued.** |
| 3 | Durable debt. | Heavy advance — Panini parity build, FMV-cap arc (#208/#209/#210), ULTIMATE-FMV retirement, #196 a11y, #114 dashboards ported. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, market frozen, #58 closed by measurement); Panini walked + parity-built; Rewards economy paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** rotate the #22 Dapper session + `INGEST_SECRET_TOKEN`; revoke the #212 LiveToken session; disable the dead `sync-nba-projections` edge cron before 10-27 5 PM PT; S1/S3/S6 console tokens + C2 postal address; decide #202 (Panini LOW-tier floor); land the `get_panini_franchise_panel` index/precompute; get a clean WAU read; and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand scan over tracked non-docs source (`git ls-files` → `*.{ts,tsx,js,jsx,mjs,cjs,sql,toml,css}`, excluding `docs/`; `node_modules`/`.next`/`.git` are untracked-excluded) with `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'` found **6 markers, none actionable** — unchanged in character from prior weeks. (TODO 5, XXX 1, FIXME 0, HACK 0.)

### 5a. Narrative / resolved-work references + the format-literal false positive (6 matches)

- `app/api/rtr/lock-roi/route.ts:38` — "v2 folds in the two signals the v1 TODO called out" (describes resolved work).
- `lib/rtr-lock-roi-weights.ts:7` — "resolves the standing 'calibrate the absolute curve' TODO" (resolved).
- `lib/chains/solana/normalize.ts:47` — "previously held as a TODO placeholder" (resolved).
- `lib/format.ts:6` — the `"$X,XXX.XX"` format doc comment; the `XXX` here is a format-string literal, the exact false positive the task names.
- `supabase/migrations/20260713050000_audit_20260713_wmc_team_name_denorm.sql:4` — "Motivation (was a TODO in CollectionMomentTable.tsx)" (migration already shipped; past-tense reference).
- `supabase/migrations/20260919173527_panini_bridge_candidates…sql:30` — "each is a pre-flip decision, **not a TODO**" (explicitly not a marker).

> **Net change since last week:** none of consequence. Live application code has **zero actionable** TODO/FIXME/HACK/XXX markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean. The working tree is clean with 0 untracked source files. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) persist by design.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the 10-26 overnight handoff + weekly digest, and the status-index rows:

**Newly resolved / landed / decided since last week (2026-10-19 → 2026-10-25):**
- **#196** — interactive table-row a11y RESOLVED 10-18, verified on prod and **gated** (both `nested-interactive` and `aria-conditional-attr` read 0 on the swept routes).
- **#114** — Cowork dashboards RESOLVED 10-20 (11 live dashboards ported to claude.ai artifacts with throwing helpers from a laptop-linked session).
- **#181** — Flow mainnet24–26 node gap RESOLVED 10-23 (`20261023213517`).
- **#189** — Top Shot offer capture CLOSED BY DECISION 10-23 (the ~3,238 pre-spork fills reachable only via dark history nodes — residual accepted).
- **#8** — NBA projections RESOLVED 10-24 (ESPN via pg_net; Fast Break reads it, verified `dataStatus: "ok"`). The old edge lane's cron-off is the only tail (Trevor, before 10-27 5 PM PT).
- **#58** — OpenSea key CLOSED BY MEASUREMENT 10-25 (on-chain census proved the Candy freeze is a real dead market, not a venue move; no key needed).
- **#211** — Recent-Low Total now ignores a "recent low" above 3× FMV (series rollup included), applied 10-25.
- **#197 / #199 / #200 / #201 / #203 / #204 / #205 / #206 / #207** — the 10-20/10-21 Panini + player-twin + set-URL + tile + search cluster, all resolved/decided.
- **FMV-cap arc** — ULTIMATE FMV retirement (19 rows), the Sniper serial-fit model, and the four rendered-HTML fabrication sweeps (10-25).

**Note on churn:** the register grew 194 → 211 numbered items in one week (+17), closed +14 (187 → 201), and open+partial rose 7 → 10. A build-and-measure surge (Panini parity + the pricing-cap arc), not a discovery of defects — every new open/partial is a pricing refinement, a scheduled proof, or a Trevor-only credential step.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars (outreach off, gate 100+ WAU):

1. **Action the two credential residues (Trevor), oldest first:** rotate the **#22** Dapper session (+ `INGEST_SECRET_TOKEN`) and revoke the **#212** LiveToken session — both are "the value is in public git history; rotate regardless." P0/P1.
2. **Disable the dead `sync-nba-projections` edge cron (#8 tail)** before **10-27 5:00 PM PT**, when its alarm suppression lapses and it starts re-firing a now-redundant 100 %-fail arm.
3. **Watch the dated proofs:** #198 All Day V1 re-verify first real dispatch (~8:24 AM PT **10-27**), #66 Search Console re-read (~**10-28**), #193 Pinnacle HIGH weekly exit (~**10-30**), #213 STALE low-serial re-read (~**10-30**).
4. **Decide #202 (Panini LOW-tier outlier)** — an ask-aware floor / age weighting / dispersion gate so a thin edition's two-sale outlier stops becoming its FMV (64 editions, ~$1.56M of the cap).
5. **Land the `get_panini_franchise_panel` fix (Claude Code):** `EXPLAIN (ANALYZE, BUFFERS)` a slow franchise, then a targeted index on the hot predicate (likely `panini_edition_team_keys`) or a panel precompute — not a blind index. Fold in the `refresh_panini_offer_spread` advisory-lock nit.
6. **Get a clean WAU read** (exclude `internal_accounts` + any test cohort) so demand means external users; hold traffic until the 100-WAU gate opens (no outreach, 10-14). Outbound-clicks ticking up (7 → 95) is the one signal worth a second look.
7. **Reset the stale DB-size baseline doc** (~4.2 GB June → operating ~40–42 GB) and keep the `net._http_response` sawtooth + the Panini-growth trend on watch.
8. **Finish the pricing-cap tails:** #208 weekly hold, #210 remaining haircut sub-classes — each has a falsifier in its item.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **899 commits** since 2026-10-19 (`git log --since`); mount HEAD `0668e8d02` 2026-10-25 21:33 PT (Claude). Authors: Claude 841, Cowork (3 bot identities) ~34, monitor/nightly bots ~18, Trevor 3, context-hygiene 3. ⚠ The mount trails origin (tonight's overnight pass saw `origin/main` at `48ff97faa`); the commit count is from the mount's history.
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (unchanged: changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests-shard, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno); DB-invariant test files = **277** (`supabase/tests/*.sql`, `ls`, +10); `app/insights/*/page.tsx` = **33** (+1). Monoliths re-measured (`wc -l`): DashboardClient 3,003 / SniperClient 2,167 / CollectionAnalyticsClient 1,963 / CollectionTabClient 1,646 / MarketClient 1,374.
- **Live metrics (from tonight's overnight pass + weekly digest, 2026-10-26 ~1:03 AM PT / ~07:43 UTC digest):** DB size **41,801 MB** (~41.8 GB; +401 MB overnight, +~1.8 GB week-over-week). Pipeline success **99.1 % / 24 h** (357 errors / 38,369 runs). FMV HIGH+MED by collection: Panini 17,712, NFL 1,730, Pinnacle 944, Candy 74, NBA 6,566, Golazos 1, UFC 0; estate HIGH-confidence 18,457. `v_fmv_sanity_flags` 0; `topshot_impossible_parallel_serials` 0. Trust: 1 breach (`candy_sales_stale_hours` 340.7 h, benign). Panini editions **39,524** (+3,204 wk). Client-error beacon 0 / 24 h. Vercel 24 h: 6 error groups, all count=1, all chronic/bounded.
- **Accuracy — file-blessed series (roadmap-status 10-22 block, wk 10-19 partial/16 legs):** Top Shot 44.5, All Day 27.3, Pinnacle 33.4, Candy 54.1, Panini 42.4, Golazos 0.1, UFC 0.0. Top Shot's ~44 % is the FMV 1.8.2 MEDIUM re-grade (by design). **Realised-sales backtest leg (10-26):** NBA published-HIGH ratio 0.966 (err 11.1 %, within ±25 % 79.0 %), All Day HIGH ratio 1.067 (within ±25 % 72.0 %), Panini HIGH ~1.008. **Read a series, not a leg.**
- **TODO scan: 6 markers, 0 actionable** (§5) — tracked non-docs source via `git ls-files` + `grep -nE '\b(TODO|FIXME|HACK|XXX)\b'`; the one `XXX` hit is a `$X,XXX.XX` format literal; the other 5 are past-tense/resolved references. Working tree clean, 0 untracked source files.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve, no stale references found** (the paths referenced by the current open/partial items + core honesty helpers): `docs/archive/audits/livetoken-api-intelligence.md`, `__tests__/no-credential-literals-in-tracked-files.test.ts`, `lib/chains/panini/ingest-normalize.ts`, `lib/accent-text.ts`, `__tests__/{accent-text-contrast,red-fill-contrast,text-color-uses-text-safe-tokens,api-cron-sales-serial-backfill}.test.ts`, `scripts/demand-read.sql`, `docs/strategy/roadmap-2026-10-17.md`, `supabase/functions/_shared/pack-supply-parse.ts`, `app/api/cron/sales-serial-backfill/route.ts`, `app/api/golazos-offers-indexer/route.ts`, `lib/{api-error}.ts`, `lib/insights/board-status.ts`, `lib/analytics/fetch-json.ts`, `lib/og/board-empty-copy.ts`, `docs/reference/{known-issues,roadmap-status,architecture-notes,topshot-ownership-index}.md`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **211 numbered items — 3 open · 7 partial · 201 closed**; the 3 open are **#202, #212, #213**; the 7 partial are **#22, #66, #193, #198, #208, #209, #210**; the newest filed slot is **#213**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-10-26)

The register's own generated STATUS INDEX reports **211 numbered items — 3 open · 7 partial · 201 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 202 | Panini LOW tier medians last-3 of any age, ignores live ask | 🟡 **open** | NEW 10-20 — 64 editions ≥ 10× low ask (~$1.56M of cap); a pricing-engine decision | known-issues #202 |
| 212 | LiveToken session committed to an audit doc | 🔴 **open** | NEW 10-25 — file redacted + guarded; values still in public history; revoke the session (Trevor) | known-issues #212 |
| 213 | #209 STALE cap reads only serial > 25 | 🟡 **open** | NEW 10-25 — a newer low-serial sale can sit under an uncapped price; re-read ~10-30 | known-issues #213 |
| 22 | 🚨 Credential purge | 🟠 partial | PARTLY RESOLVED 10-20 — GitHub purge DONE + verified; rotate the Dapper session (Trevor) | known-issues #22 |
| 66 | SEO / zero external links | 🟠 partial | Code items done; external links Trevor's, gated on the accuracy gate; Search Console re-read ~10-28 | known-issues #66 |
| 193 | Disney Pinnacle HIGH tier accuracy | 🟠 partial | PARTLY RESOLVED 10-23 — HIGH now last-5 median (84/262 re-priced); weekly exit + tier-order open | known-issues #193 |
| 198 | All Day V1 listing re-verify | 🟠 partial | PARTLY RESOLVED 10-20 — lane live; production proof due ~8:24 AM PT 10-27 | known-issues #198 |
| 208 | All Day + Golazos ASK_ONLY cap | 🟠 partial | PARTLY RESOLVED 10-22/10-23 — price capped (1.80 → 1.00); weekly hold open | known-issues #208 |
| 209 | Top Shot + All Day STALE cap | 🟠 partial | PARTLY RESOLVED 10-23 — price capped at last sale; basis line shipped 10-25 | known-issues #209 |
| 210 | Thin-sale haircut depth floor | 🟠 partial | PARTLY RESOLVED 10-23 — 0-sale cells now 0.75 (was 0.55); remaining sub-classes open | known-issues #210 |
| 196 | Interactive table-row a11y | ✅ closed | RESOLVED 10-18, gated (was open last week) | STATUS INDEX |
| 114 | Cowork dashboards render failed read as empty | ✅ closed | RESOLVED 10-20 (11 dashboards ported; was partial last week) | STATUS INDEX |
| 181 | Flow mainnet24–26 nodes dark | ✅ closed | RESOLVED 10-23 (was partial last week) | STATUS INDEX |
| 189 | Top Shot offer capture | ✅ closed | CLOSED BY DECISION 10-23 (was partial last week) | STATUS INDEX |
| 8 | NBA projections feed | ✅ closed | RESOLVED 10-24 (ESPN via pg_net); old edge cron-off is Trevor's tail | STATUS INDEX |
| 58 | OpenSea key / Candy indexers | ✅ closed | CLOSED BY MEASUREMENT 10-25 (Candy freeze is real; no key needed) | STATUS INDEX |

**Tally (per the register's own STATUS INDEX):** **211 numbered items — 3 open · 7 partial · 201 closed**, newest slot **#213**. Plus the go-live plan, the per-collection accuracy legs, Candy live (market frozen) + Panini walked & parity-built + Rewards paused, **21-job CI**, **277 DB-invariant test files**, and **33 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** the busiest shipping week on record (899 commits; 631 unique files in 48 h), and a clean one — all of it interactive Cowork / Claude Code, with the autonomous pass green-and-idle every night. The two arcs were **Panini↔Top-Shot parity** (Hot Floors, product pages, ask-history, product-scoped sets, five new pipelines) and **FMV honesty** (ULTIMATE FMV retiring prices it can't support, the Sniper serial-fit model, the ASK_ONLY/STALE/haircut caps #208/#209/#210, and four rendered-HTML fabrication sweeps). Open+partial rose **7 → 10**, but every new slot is a pricing refinement (#202/#209/#210/#213), a scheduled proof (#198), or a Trevor-only credential step (#212) — not a defect surge; last week's whole open list is settled (#196 resolved; #193 and #22 demoted to partial; #114/#181/#189/#8/#58 closed). Live trust metrics are clean (0 impossible serials, 0 FMV sanity flags, 1 arm breach = the benign Candy freeze). On the front page, **Top Shot is MET on its series (~44.5 % leg by design), All Day is still short (27.3 %)**, DB is ~41.8 GB on legitimate Panini growth, and **demand is still the one number that decides everything** — external WAU low single digits against a 100-WAU gate with outreach off, though outbound-clicks moved 7 → 95. The standing asks are operator/Trevor: the **#22** Dapper rotation, the **#212** LiveToken revoke, the **#8** dead-edge-cron disable before 10-27 5 PM PT, and the **#202** Panini LOW-tier pricing decision.
