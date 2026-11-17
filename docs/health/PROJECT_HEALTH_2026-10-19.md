# Rip Packs City — Project Health Report

**Date:** 2026-10-19
**Compiled by:** Claude (Cowork) — automated weekly run
**Sources:** `CLAUDE.md` + `docs/reference/known-issues.md` (generated STATUS INDEX, now reading **194 numbered items — 3 open · 4 partial · 187 closed**, newest slot **#196**), the new canonical forward plan `docs/strategy/roadmap-2026-10-17.md` (supersedes `roadmap-2026-08-03.md`; accuracy-is-the-gate unchanged), `docs/reference/roadmap-status.md`, `docs/reference/architecture-notes.md`, `docs/strategy/go-live-2026-09.md`, `docs/overnight/ledger.md` (newest heading 2026-10-18), the two same-day sibling passes `claude/handoff-2026-10-19-overnight-pass.md` and `claude/weekly-health-digest-2026-10-19.md`, plus first-hand file-tool + shell scans over the connected repo (`git`, `grep`, `wc`, `ls`) and **live DB reads (2026-10-19, ~02:35–02:50 AM PT)** for the accuracy confidence distribution, traction, DB size, and trust health.
**Scope:** A single consolidated, themed view of open work — the numbered known-issue slots (`#0–#196`), the go-live framing, the prioritized actions, the overnight operational queue, and the in-code marker inventory — with suggested severity, effort, and a recommended sequence.
**Prior report:** `PROJECT_HEALTH_2026-10-12.md` (7 days ago). This regeneration mirrors its structure. `_2026-10-05.md` … `_2026-05-22.md` (twenty-three earlier reports) also live in `docs/health/`.

> **Biggest change since 2026-10-12 — a correctness-and-honesty shipping week, led by Flowty's hosted book finally going dark.** The 09-25 prediction that *"Flowty will turn its API endpoints off soon"* came true, and the week's heaviest workstream was **repointing every All Day / Golazos market reader off the dead Flowty v1 book (`cached_listings`) onto the on-chain book (`cached_listings_v2`)** — the relative-deals board, tier-benchmark sidebar, Analytics order-book-depth card, Golazos catalog-deals, and the listing-challenge wallet-verification path (which could no longer verify an All Day/Golazos-only wallet on Flowty's shutdown day) all moved in 10-18 migrations. Alongside it: an **accessibility pass** made `color-contrast` + `select-name` **blocking in CI** (the E2E DOM Smoke `a11y-audit` job, 299 → 18 axe nodes), and **#195 closed the last two DB lanes that still logged a fabricated `rows_written = 0`**. The register grew six slots (#191–#196) and **open+partial fell 10 → 7**: the three items that were open last week either resolved or were decided — **#190** (pre-2023 pack-open history) DECLINED by Trevor (no infra spend pre-revenue), **#172** (giveaway desktop stall) SHELVED (phone path works), **#185** (Top Shot issuer-held split) RESOLVED 10-14 as predicted, and partials **#17** (page a11y tail, closed by decision) and **#76** (site-availability alarm, resolved off-GitHub via a cron-job.org probe) both landed. Two new open items are measurement/polish, not fire: **#193** (Disney Pinnacle's HIGH tier is less accurate than a naive last-5 median — a proposal, gated on ≥500 HIGH sales ~10-28) and **#196** (two serious axe rules on interactive table rows — a deliberate keyboard-operability pattern that needs its own redesign pass). As ever, the week's shipping was concurrent Claude Code / Trevor / sibling-Cowork sessions, not the nightly autonomous pass.

> **Overnight reality — GREEN and idle by design.** The 2026-10-19 ~01:06 AM PT cloud nightly pass (push-capable, dry-run clean, no `FREEZE`) shipped **0**, reverted **0**, logged `idle: no-work`. It shipped nothing because the entire code tree was hot from a sibling Cowork session's large 10-18 evening sweep (last commit 11:46 PM PT) — no clearly-safe, non-hot edit existed, and no new low-risk DB/artifact item was open. Security scans all `[]`; **37 of 38 trust arms ok** with the one breach being `candy_sales_stale_hours` 172.8 h (benign — see below); `stalled_pipelines []`; sentinel 0; all drift checks `[]`. Every other night this week (10-12 → 10-18) also shipped **0** — quiet green nights.

> **Traction reality — WAU ~1, and this is the honest external floor.** Live reads (2026-10-19 ~02:45 AM PT): **39 total accounts (+1), 3 internal, 36 external, WAU 1, MAU 15, 175 saved wallets (+5)**, 35 users with a saved wallet, **1 email subscriber**. The weekly digest's 7-day activity counts agree it is thin: concierge 9 (smoke-filtered), outbound_clicks 7, portfolio_snapshots 241. WAU by external sign-in is **1** (the rewards `points_ledger` proxy is **0** now that the dial-in cohort has wound down). ⚠ **The user gate was raised to 100 WAU (from 50) on 2026-09-25, and Trevor added a NO-OUTREACH directive on 10-14** — so the "pick one acquisition channel" suggestion from prior reports is now explicitly off the table. Demand is still the one number that decides everything, and it is near zero against a 100-WAU gate.

> **Accuracy gate — read the series, not the leg; Top Shot's drop to ~44 % is a by-design label correction.** The canonical roadmap's weekly-mean legs (`rpc_trust_health_history`, week of 10-12, 23 legs): **Top Shot (M1) 55.8 %** (🟢 met every leg since 09-21), **All Day (M2) 26.3 %** (🔴 short of its 30 % bar), Disney Pinnacle 32.6 %, Candy MLB 57.1 % (a relabel, not a pricing gain), Panini 27.2 % (leg first appears this week), Golazos 1.0 %, UFC 0.0 % (closed market, honest label). ⚠ **This week's headline move is intentional:** FMV 1.8.2 (shipped 10-18) makes a MEDIUM grade require a sale within 30 days, so Top Shot's share was expected to fall to **~44 %** from 10-18 — a label correction (90-day-only MEDIUM backtested worse: 20.0 % vs 14.0 % error), not a pricing regression, and the FMV route is off-limits/actively owned. My single live distribution leg (`fmv_confidence_precompute`, 2026-10-19 ~02:35 AM PT) confirms the landing: Top Shot HIGH 1,353 + MEDIUM 5,046 = 6,399 of 14,528 = **44.0 %**, All Day **27.5 %**, Pinnacle **33.2 %**, Candy **49.6 %** (down from the 57.1 relabel peak as its frozen market ages out), Panini **35.6 %**, Golazos **0.0 %**, UFC **0.0 %**. Against realised sales the published FMV still matches or beats a naive last-3 median on every collection measured (Top Shot 7 d: 14.3 % median error).

> **Go-live bars — several converted this week.** M4 (Collection-tab cold time-to-first-row) MET 10-17 (2.1–2.6 s on 15K-Moment Top Shot wallets, was 4.3–6.6 s); M5 (warm reload) MET 10-18 (0.6–0.9 s); M6 (390/320 px overflow = 0) holds; M7 (client-error beacon fires) met; M8 (E2E DOM Smoke green 7 consecutive nights) met 09-29 → 10-17. The remaining binding bar is demand, not code.

> **Cost / storage — ~38–40 GB and roughly flat week-over-week.** Live reads today: 38,630 MB in this run (~37.7 GB), 39,927 MB in the digest, 39,970 MB in the overnight snapshot — the DB cycles ~38–40 GB (the `net._http_response` pg_net log sawtooths ~1.8 GB). It is up from ~35.6 GB last week; the growth is **Panini catalog coverage expansion** (`panini_card_serials` ~7.6 GB, 36,320 editions, +1,323 editions day-over-day), not a runaway. Compute stays **LARGE** (resized 09-20). ⚠ **The June 4.2 GB DB-size baseline doc is now badly stale** — the digest recommends resetting it to ~40 GB so it stops reading as a 10× regression. The `flowty_archive.scratch_*` dedupe + drop SQL (~185 MB, operator-gated, destructive) is still awaiting a Supabase SQL-editor run.

> **Platform context — Flowty's hosted book is the week's big external change.** Flowty's trading frontend was already shut; its hosted listing book (`cached_listings` v1) is now dead for All Day / Golazos, which is why those surfaces were repointed to the on-chain `cached_listings_v2` this week (RPC remains Flowty-independent for priced columns, as pre-staged). Top Shot's public REST API stays dead; the Atlas backend read is the feed and answers a Cloudflare 403 on some lanes by design (self-healing — a failed page writes nothing and is re-walked, so nothing is lost). NFL All Day secondary-market only. UFC Strike Flow market frozen (0 sales; honestly labelled). **Candy/Solana is LIVE but its market has been frozen since 2026-10-11** (no Magic Eden activity of any kind — confirmed a genuine market freeze on a healthy pipeline via a live A/B on 10-14, not a capture bug), which is what drives the lone `candy_sales_stale_hours` trust-arm breach; OpenSea lanes remain additive and down on the missing `OPENSEA_API_KEY` (#58). Panini = WC Prizm plane (`PANINI_PUBLIC = true`), collector-walk still adding editions.

> This is a snapshot. `CLAUDE.md` + `docs/reference/known-issues.md` are the source of truth for project memory; `docs/overnight/ledger.md` for what shipped; `docs/strategy/roadmap-2026-10-17.md` (+ `go-live-2026-09.md`) for the plan. This doc reorganizes them for triage. **Severity and effort tags throughout are suggestions, not gospel.**

> **Report location stays clean.** All reports (this one included) live in `docs/health/`; the repo root holds none (verified this run).

---

## 1. At a glance

| Bucket | Count | Notes |
|---|---|---|
| Known-issue slots tracked | **#0–#196** | Register STATUS INDEX: **194 numbered items — 3 open · 4 partial · 187 closed**. 6 new slots (#191–#196) since last week. See §9. |
| Known issues — resolved/closed since last week | **~12 net** | Closed count rose 178 → 187. New this week: #172, #190, #185, #17, #76 moved off the open/partial list, plus #186/#191/#195 landed. — §6 / §9 |
| Known issues — open / partial | **7** | **3 open** (#22, #193, #196) + **4 partial** (#66, #114, #181, #189). Down from 10 last week. — §3 / §9 |
| Known issues — 🚨 live trust breach | **0 impossible-serial; 1 benign arm** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; **37/38 arms ok**, the one breach `candy_sales_stale_hours` 172.8 h = the frozen Candy market (#58), not a defect. — §2.4 |
| Known issues — needs Trevor, operator | **few** | **#22** purge GC + rotation (P0, unchanged); **#58** `OPENSEA_API_KEY` env var (oldest routed item, ~24 nights); `flowty_archive` scratch-drop + dedupe (SQL editor); **#144** `ATLAS_POOL_INGEST_KEY`. — §2.6 |
| Known issues — carried shelved | **2** | **#8** sports-proxy 403 — SHELVED (every upstream still 403s; alarm muted to ~10-27 PT; preseason tip-off ~10-20 is the re-look). **#172** giveaway desktop stall — SHELVED (phone path works). |
| Known issues — removed from the tree by decision | 3 | #1 Cart, #3 Trade Hub, #3b Gifting — DELETED (read-only pivot). Verified still absent this run. |
| Go-live plan | **M1–M11 + B1–B5** | `docs/strategy/go-live-2026-09.md`. M4/M5/M6/M7/M8 all met this cycle; accuracy gate: Top Shot met (series), All Day short. — §2.1 |
| Commits since last report | **589** | `git log --since 2026-10-12` on the connected mount. Authors: Claude 407, Cowork 91, Trevor 79, nightly/monitor bots ~12. Mount HEAD `08c112940` 2026-10-18 16:51 PT (Trevor). |
| Accuracy gate (headline metric) | **Per-collection, weekly-mean legs** | Top Shot **55.8 %** series / **44.0 %** live leg (by-design 1.8.2 re-grade), All Day **26.3 %** (NOT MET), Pinnacle 32.6, Candy 57.1 series (relabel; live leg 49.6, market frozen), Panini 27.2, Golazos 1.0, UFC 0.0 (sentinel). Read as a series. — §2.1/§2.3 |
| Demand (the critical-path number) | **WAU ~1 · 39 accounts · 175 saved wallets** | Live 2026-10-19. WAU by external sign-in 1 (points proxy 0). MAU 15. Gate: **100+ WAU** (raised from 50 on 09-25); **no outreach** (Trevor, 10-14). — §2.1 |
| Open overnight operational items | **standing queue** | #58 OpenSea env var (oldest); #22 purge residue; `flowty_archive` scratch-drop + dedupe (SQL editor); #144 key rotation; pack_rips post-vacuum read. — §2.6 |
| Net-new structural workstream | 2 live | Candy/Solana LIVE (thin, market frozen) + Panini (WC Prizm, collector-walk live); plus a paused Rewards economy (dial-in). — §2.8 |
| Prioritized next actions | **superseded** | `roadmap-2026-10-17.md` (canonical; accuracy-is-the-gate) + `go-live-2026-09.md`. Gate: **100+ WAU**, no outreach, no infra spend pre-revenue. See §4. |
| In-code TODO markers | **0 actionable in live app code** | Measured this run (`grep`): 4 narrative/false-positive refs only (incl. the `$X,XXX.XX` literal). — §5 |
| Test / DB-invariant pins | **267 `supabase/tests/*.sql` files** | +1 vs last week's 266 (measured this run, `ls`). |
| CI jobs (ci.yml) | **21** | Measured this run under `jobs:` — +1 (`component-tests-shard`) vs last week's 20. See §8. |
| Public `/insights` surfaces | **32** | Measured this run: 32 `app/insights/*/page.tsx` dirs (flat). |
| Active revenue-blocking items | 0 | By decision — monetization tabled until 100+ WAU. |

**Health read:** A build-and-harden week with no autonomous-pass drama. The register's open work **shrank again** (open+partial 10 → 7): the three items that dominated last week's open list are all settled — **#190** declined (pre-2023 custodial pack-open history is infra spend the roadmap holds at zero pre-revenue), **#172** shelved (the phone delivery path works), **#185** resolved exactly on its predicted 10-14 schedule — and two partials (**#17**, **#76**) closed. The headline engineering win is **resilience**: with Flowty's hosted book dead, every All Day / Golazos market reader and the listing-challenge wallet-verification path were repointed to the on-chain book in a day, so the collections kept pricing and verifying through the shutdown. The honesty ledger also advanced (**#195** closed the last fabricated-`rows_written` lanes; the accessibility contrast gate went blocking in CI). The concentrated risk that remains is unchanged in shape: **(1) demand** — the honest WAU is ~1 against a 100-WAU gate, with outreach now explicitly off; **(2) #22** (credential-purge residue, P0 operator, weeks old, on a GitHub Support ticket); and **(3)** two fresh measurement/polish items (**#193** Pinnacle HIGH-tier accuracy, gated on more sales ~10-28; **#196** interactive-row a11y redesign). All Day remains the one published collection short of its accuracy bar, and the Candy market freeze (benign) is the lone trust-arm breach.

### Themes

| Theme | Items |
|---|---|
| **Launch / activation (the whole critical path)** | Public + self-serve. **WAU ~1 / 39 accounts / 175 saved wallets (live 10-19).** Accuracy at/around its bars. The problem is still *demand*, and **outreach is off** (10-14). Gate raised to **100+ WAU** (§2.1) |
| **Flowty teardown resilience (the week's big move)** | Flowty's hosted book went dark; All Day/Golazos relative-deals, tier benchmarks, order-book-depth, catalog-deals and listing-challenge verification all repointed to the on-chain `cached_listings_v2` (10-18 migrations) (§2.3) |
| Accessibility hardening | `color-contrast` + `select-name` now BLOCKING in CI (E2E DOM Smoke `a11y-audit`, 299 → 18 axe nodes); #196 filed for the interactive-row pattern (§2.4) |
| Honesty / write-side correctness | #195 closed — the last two DB lanes logging a fabricated `rows_written = 0` now report real counts (§2.4 / §6) |
| **Live trust breach still CLEAR** | `topshot_impossible_parallel_serials` 0; `v_fmv_sanity_flags` 0; 37/38 arms ok (the one breach is the benign Candy freeze) (§2.4) |
| Pinnacle FMV accuracy (new) | #193 — HIGH tier less accurate than a naive last-5 median; a last-5 proposal gated on ≥500 HIGH sales (~10-28) (§2.3) |
| Pre-2023 pack-open history | #190 DECLINED (no free source; keyed providers are infra spend, held pre-revenue); #181 (Flow mainnet24–26 nodes dark) carried (§2.3) |
| Operator-owned / hand-offs | #58 OpenSea env var (oldest); #22 purge (P0); `flowty_archive` scratch-drop + dedupe (SQL editor); #144 key rotation (§2.6) |
| Instrument darkness | #34 Sentry dark (beacon is detector); #114 live Cowork dashboards in OneDrive (§2.5) |
| Security | scans clean; trust breach clear; #60 (can't revoke anon from net/cron schemas) carried, needs Supabase support (§2.4) |
| Product simplification — READ-ONLY pivot | Cart / Trade Hub / Gifting **DELETED** — verified still absent (§2.9) |
| SEO | #66 — zero external links (Trevor); structured data + llms.txt shipped earlier; off-platform authority remains; Search Console re-read ~10-28 (§2.3) |
| Tech debt / refactor | Monoliths re-measured this run and all growing: DashboardClient **3,012** / SniperClient **2,107** / CollectionAnalyticsClient **2,040** / CollectionTabClient **1,605** / MarketClient **1,458** (§3) |
| Deferred hardening (intentional) | Public INSERT-policy tables; `owner_key`→`user_id`; Golazos `highest_offer` gap (settled: no offer source); `INGEST_SECRET_TOKEN` rotation still owed; `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller) |

---

## 2. Critical path — start here

Go-live is **operationally done** (public + self-serve). The forward plan is now **`docs/strategy/roadmap-2026-10-17.md`** (canonical; it supersedes but does not reverse `roadmap-2026-08-03.md` — accuracy is still the GATE, headline metric is the HIGH/MEDIUM confidence share read as a series) plus **`docs/strategy/go-live-2026-09.md`** (what "through the gate" means in numbers). The binding user bar is now **100+ WAU** (raised from 50 on 09-25), and **outreach is off** (Trevor, 10-14).

### 2.1 Launch + activation — accuracy near its bars, demand genuinely near zero — `Severity: High · Effort: Medium (built + measured, no traffic by directive)`

Read-only tabs are anonymous for the 5 published Flow collections (+Candy overview, +Panini); cost-basis/P&L, saved wallets, watchlist, `/dashboard/*`, and every mutation stay behind sign-in.

- **Traction, live read 2026-10-19 (~02:45 AM PT):** **39 total accounts (3 internal, 36 external), WAU 1, MAU 15, 175 saved wallets**, 35 users with a saved wallet, 1 email subscriber. WAU by external sign-in is 1; the rewards `points_ledger` WAU proxy is 0 (dial-in cohort wound down). This is the honest external-demand floor — essentially flat near zero.
- **Accuracy (weekly-mean legs, roadmap-2026-10-17 §2, week of 10-12):** **M1 Top Shot 55.8 % (≥ 50 % — MET every leg since 09-21)**, **M2 All Day 26.3 % (≥ 30 % — NOT MET)**, Pinnacle 32.6, Candy 57.1 (relabel), Panini 27.2, Golazos 1.0, UFC 0.0 (sentinel). ⚠ **Top Shot is expected to read ~44 % from 10-18 by decision** — FMV 1.8.2 tightened MEDIUM to require a sale within 30 days (a label correction, backtested better than 90-day-only MEDIUM). My live single leg (10-19 ~02:35 AM PT) confirms the landing at **44.0 %**; read the series, not the leg.
- **M2 did not convert again.** All Day's HIGH/MED share has been flat near 26–27 % for weeks; it stays liquidity-limited and the 10-10 decision keeps its dispersion gate (no relabelling).

Suggested next step has **changed by directive**: with outreach off (10-14) and the gate at 100 WAU, the critical-path action is no longer "run an acquisition channel." It is to **keep accuracy beating the incumbents (the gate) and get a clean internal-excluded WAU read** so the demand number is unambiguous when outreach is eventually turned on. Demand is still the single most important line in the report.

### 2.2 Public intelligence surfaces — 32 public — `Severity: n/a (shipped) · context`

All 32 built surface dirs in `app/insights/` are public (measured this run: 32 `page.tsx`, flat). Carried honesty risks `#50` (`/insights/pack-reality` ranker) and `#33`-class (ISR bakes a failed read into the `revalidate` window) remain as standing design considerations.

### 2.3 Data-intelligence — Flowty-book repoint, Pinnacle accuracy, pre-2023 gap declined — `Severity: Medium (correctness) · Effort: mixed`

**FMV HIGH/MEDIUM share (weekly-mean legs, roadmap §2):** Top Shot 55.8 (→ ~44 by design from 10-18), All Day 26.3, Pinnacle 32.6, Candy 57.1 (relabel; frozen market), Panini 27.2, Golazos 1.0, UFC 0.0 (empty-market SENTINEL, never a percentage).

**Shipped / landed since last week:**

- **Flowty hosted-book repoint (10-18) — the week's biggest workstream.** With Flowty's `cached_listings` (v1) dead, five All Day / Golazos readers were moved to the on-chain book `cached_listings_v2`: `get_relative_deals` (Golazos Sniper fallback), `get_tier_pricing_benchmarks` (Sniper sidebar), `analytics_listings_summary` (Analytics order-book-depth card — All Day 28,857 / Golazos 4,178 asks where it showed Flowty's 108 / 100), `get_golazos_catalog_deals`, and `get_golazos_market_editions`. A tree-walk guard (`allday-golazos-readers-stay-on-the-onchain-book.test.ts`, 857 defs) bans v1 readers at zero.
- **Wallet verification by listing fixed for All Day / Golazos-only wallets (#195 lineage).** `resolve_wallet_verification_challenges` matched only v1 `cached_listings`, so on Flowty's shutdown day an All Day/Golazos-only wallet could not verify; it now has a second leg over `cached_listings_v2` (seller + exact price, listed after the challenge), verified on production.
- **`#185` — Top Shot issuer-held split — RESOLVED 10-14** exactly as last week's falsifier predicted. `get_topshot_issuer_held_split()` reads `ok` for the first time since the lane started 10-03 (1,706,375 Moments in unopened packs, 1,880,536 reserve); the 10-10 throughput fix drained the overdue backlog and the list-gate now tracks the last completed walk.
- **`#195` — the last fabricated-`rows_written = 0` lanes CLOSED (10-18).** `refresh_fmv_confidence_precompute` and `run_refresh_pack_grail_metrics_mv_job` now report real counts instead of a hardcoded 0, closing the write-side honesty gap.

**New / open:**

- **`#193` — Disney Pinnacle's HIGH tier is less accurate than a naive median of the last 5 sales (OPEN, NEW 10-17, measurement).** First backtest of Pinnacle FMV against realised sales: since the 10-09 engine change, HIGH renders price at a 90-day recency-weighted median that lags a falling market, so a naive last-5 median beats published HIGH on both within-±25 % and WAPE, and MEDIUM currently out-accuracies HIGH (tier order inverted). A dispersion gate was measured and is *not* the fix; the proposal is to price HIGH-eligible renders at their last-5 median. ⛔ **Ship gate:** re-measure on ≥ 500 HIGH sales after the 10-09 change (~10-28); ship only if last-5 still wins without losing MEDIUM. Measurement is now a function, `pinnacle_fmv_sales_backtest()`.
- **`#190` — pre-2023-11-08 custodial Top Shot pack opens — CLOSED, DECLINED 10-17.** 33 of 34 saved wallets have no *free* source for custodial opens before 2023-11-08; every free source is ruled out and the three keyed options (Dune, Find Labs, Bitquery) are infra spend the roadmap holds at zero pre-revenue. **Reopen when** RPC has revenue or a paying user asks for full-history pack P&L.
- **`#181` — Flow historical access nodes (mainnet24/25/26) dark (PARTIAL).** Pre-mainnet27 arrival checks still wait; parked with a canary. Retire-vs-repoint decision was due 10-24. Blast radius: pack-history freshness + pre-mainnet27 attribution for saved/seeded wallets only; no FMV/site/security impact.
- **`#189` — Top Shot offer capture (PARTIAL).** Complete; ~3,238 of 21,372 pre-spork fills still have no offer row, reachable only via the dark history nodes (#181). The 10-18 re-walk ran to `done`, ~0 net inserts, snapshot stable at 21,619.
- **`#8` — sports-proxy 403 — SHELVED.** `sync-nba-projections` is 100 %-failing (24/24, `all_upstreams_failed`, 0 rows, never once succeeded) — a provider decision, not a code fix; a 10-18 probe confirmed Vercel's egress is blocked too. Alarm muted to ~10-27 PT; preseason tip-off ~10-20 is the re-look. Low user impact (enrichment-only). Do NOT retire.
- **`#66` — SEO (PARTIAL, needs Trevor):** zero external links; structured data + llms.txt + sitemap pruning partly done; external links (Flow directories, README, launch posts — ⛔ never leading with the Team Captain designation) remain Trevor's. Search Console re-read ~10-28.

### 2.4 Security, confidentiality + test infrastructure — `Severity: Medium (clean scans; 0 live breaches) · Effort: mostly landed`

- **Security scans clean** (invariants, anon-write holes, rls-off-base-tables, secdef-anon, function-search-path-drift, txn-control-pins all `[]` / 0 rows). RLS: 0 public base tables with RLS off, 0 anon write-grants.
- **Live trust breach clear.** `topshot_impossible_parallel_serials` 0 (sentinel 0); `v_fmv_sanity_flags` 0; **37/38 arms ok**; the one breach is `candy_sales_stale_hours` 172.8 h (threshold 168) — the frozen Candy market since 10-11, benign and known (#58), confirmed a real market freeze on a healthy pipeline. `edition_integrity_flags` read 22 transiently (was 8); `fmv_sweep_wedge_hours` 0.19 (the 10-17 fix holding).
- **Accessibility contrast gate went BLOCKING (10-17/10-18).** The E2E DOM Smoke `a11y-audit` job now fails on `color-contrast` and `select-name` (22/22 green against production first; 299 → 18 axe nodes). A contrast regression on the swept routes now reds the workflow instead of passing silently. The interactive-row pattern that two serious axe rules still flag is **#196** (deliberate keyboard-operability roles pinned by tests — a redesign pass, not a cleanup).
- **`#22` — the credential-purge residue is STILL OPEN (P0, operator-only).** The leak branch was deleted from origin, but the pre-purge blob stays fetchable by SHA until GitHub Support GCs the unreachable objects, and the RS256 token PII does not expire. The GitHub Support ticket is filed; the 10-08 re-test task ran. **Still Trevor's: chase the ticket, re-test the commit URL (expect 404), rotate the Dapper session regardless.** `INGEST_SECRET_TOKEN` rotation (~15 functions) also still owed.
- **`#60` (carried):** Postgres cannot revoke `anon`/`authenticated` from the `net`/`cron` schemas; real fix needs Supabase support.
- **DB-invariant SQL layer: 267 `supabase/tests/*.sql` files** (+1, measured this run). CI is **21 jobs** in `ci.yml` (+1 `component-tests-shard`). **Never lower thresholds to green a build.**

### 2.5 Automation / asset hygiene — `Severity: Low–Medium · Effort: ongoing`

⚠ **`#34` — Sentry dark; no-spend DECIDED** — the `window.onerror`/rejection beacon → `usage_events.client_error` is the detector (M7's beacon fires; all 7-day rows are the headless crawler, `automated:true`). ⚠ **`#114`** — the Cowork dashboard-artifact failure-handling fix is in the three repo copies + guard, but the **15 live dashboards live in OneDrive outside the connected folders** and can only be fixed from a Cowork-desktop session; re-run `scripts/audit-cowork-artifact-failure-handling.mjs` after. ⭐ **`#76` is now RESOLVED** — the detection gap was closed off-GitHub and off-Vercel: cron-job.org job 8637511 probes `/api/health` every 5 min and emails Trevor after 2 consecutive failures, on recovery, on auto-disable, and before TLS expiry (what remains is only the Vercel spend-cap recurrence risk, Trevor's). ⭐ **`#62`** — the true-mobile QA instrument (`scripts/qa/mobile-sweep.mjs`, real Chromium at 390/320 px) remains the only real mobile instrument.

### 2.6 Overnight operational queue — `Severity: Low–High (mixed) · Effort: mixed`

Health scans GREEN (0 new stalled pipelines; 99.3 % pipeline success / 24 h). Open items for Trevor / operator:

| Item | Issue | Severity | Notes |
|---|---|---|---|
| **#58 — `OPENSEA_API_KEY` not set** | Candy/Panini OpenSea indexers unscheduled; the downstream `candy_sales_stale` breach is the symptom (Magic Eden covers Candy FMV). Oldest routed item (~24 nights). | Low (operator) | Create a permanent OpenSea key → set env in Vercel (all envs) → redeploy → restore the 3 cron lines. Or confirm it stays shelved. |
| **#22 — credential-purge residue** | Branch deleted; blob still fetchable by SHA; RS256 PII does not expire. GitHub Support ticket filed. | **P0 (operator)** | Chase the ticket → re-test the commit URL (expect 404) → rotate the Dapper session regardless; `INGEST_SECRET_TOKEN` too. |
| **`flowty_archive` scratch-drop + tx-lane dedupe** | `dedupe_tx_lane` then `drop_scratch` SQL (~185 MB `flowty_archive.scratch_*`). Destructive; MCP write-hold cancels it unseen from a headless session. | **Med (SQL editor)** | Run in the Supabase SQL editor, dedupe first. |
| **#144 — rotate `ATLAS_POOL_INGEST_KEY`** | `?key=` branch deleted + deployed (header-only, pinned); the key was in logs. | Med (operator) | Rotate the edge secret + Trevor's user env var. |
| **pack_rips post-vacuum read** | `maint-vacuum-pack-rips` fires ~4:37 AM PT; the night pass captures pre-vacuum only. | Low | Daytime monitor to read allvisible after the vacuum. |
| **#8 sports-proxy 403** | SHELVED; alarm muted to ~10-27 PT; preseason re-look. | Med (deferred) | Do NOT retire. |

### 2.7 Pack EV / pack-viz — `Severity: Low–Medium (correctness, mostly clean) · Effort: mostly landed`

Pack-EV surfaces label rows for packs nobody can buy and disclose AllDay/Golazos EV as an original-supply model; Candy leads with Typical-Pull median. Pack-EV freshness holds (AllDay 3,141 packs, ~92 % fresh; Top Shot 1,383 packs, known depleted-dist tail, board writes fresh daily). One low-impact straggler was dispositioned this week with no action: an `NFL` market-cap tile 8 s timeout (1 hit/24 h) whose core query EXPLAINs at 2.5 ms, fully indexed — a cold-start tail-latency straggler, not a missing index.

### 2.8 Chain foundation — Candy LIVE (frozen market), Panini walked, Rewards paused — `Severity: Low (shipped) · Effort: landed`

- **Candy / Solana — LIVE, THIN, market FROZEN since 10-11:** `CANDY_MLB_PUBLIC = true` (verified this run), overview tab. Magic Eden is the load-bearing feed; no Candy activity of any kind since 10-11 8:21 PM PT (genuine market freeze on a healthy pipeline, confirmed by a live A/B on 10-14). FMV stays green off existing data; the `candy_sales_stale_hours` arm breach is the honest downstream symptom.
- **Panini — the WC Prizm plane** (`PANINI_PUBLIC = true`, verified this run). Collector-walk keeps adding editions (36,320 Panini editions; `panini_card_serials` ~7.6 GB and the main DB-size growth driver). NO_DATA retirement holding.
- **Rewards economy — exists but PAUSED (dial-in).** `REWARDS_LIVE` unset; 25 participants, 14,200 issued / 250 spent / 13,950 outstanding, 1 fulfilled, 0 pending, 0 negative balances. No new participation this week.
- **Chain-abstraction Phases A–F complete.**

### 2.9 Read-only product pivot — carried, verified still in effect — `Severity: n/a (landed) · Effort: (done)`

Cart, Trade Hub, and Gifting remain **deleted from the tree** — verified this run by absence: `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` all absent. The 10-03 trading revisit did not change this. The product is purely read-only (admin-signed giveaway delivery is the one exception).

---

## 3. Known issues — by theme

Severity/effort are suggestions. "#" = the item number in `docs/reference/known-issues.md`. **§9 has the verified open/moved status.**

### Launch / activation (the whole critical path)

| # | Issue | Severity | Effort |
|---|---|---|---|
| — | **Traffic / WAU.** **WAU ~1 / 39 accounts / 175 saved wallets (live 10-19)** — honest external floor. Gate: **100+ WAU**; **no outreach** (10-14). | **High** | Medium (assets built, traffic off by directive) |
| — | **Go-live bars.** Accuracy gate: Top Shot MET (series), All Day short. M4/M5/M6/M7/M8 met. | High | Mixed |

### Security / operator (the open items + P0)

| # | Issue | Severity | Effort |
|---|---|---|---|
| 22 | 🚨 Credential purge — branch deleted, blob still fetchable by SHA; RS256 PII persists. GitHub ticket filed; rotate regardless. | **P0 (operator)** | GitHub GC + rotation |

### Data completeness / accuracy / chain history

| # | Issue | Severity | Effort |
|---|---|---|---|
| 193 | Disney Pinnacle HIGH tier less accurate than a naive last-5 median; tiers do not rank in order. Last-5 proposal gated on ≥500 HIGH sales (~10-28). | Med (open) | Measurement + engine tweak |
| 189 | Top Shot offer capture — complete; ~3,238 pre-spork fills still unsourced (reachable only via dark history nodes). | Low–Med | Partly landed |
| 181 | Flow mainnet24–26 access nodes dark; pre-mainnet27 arrival checks wait; retire-vs-repoint decision ~10-24. | Med | Partly landed (parked) |
| 66 | Zero external links; structured data shipped; external links remain Trevor's; Search Console re-read ~10-28. | Med | Off-platform (not code) |

### Instruments / darkness / a11y / operator

| # | Issue | Severity | Effort |
|---|---|---|---|
| 196 | Two serious axe rules on interactive table rows (`nested-interactive` on moment rows, `aria-conditional-attr` on sniper rows) — a deliberate keyboard-operability pattern needing its own redesign. | Low–Med (open) | Pattern redesign |
| 114 | Cowork dashboards render failed read as empty — 15 live artifacts in OneDrive (outside connected folders) still carry the old helper. | Med | Cowork-desktop session + re-run audit |
| 34 | Sentry dark (beacon is detector; connector needs re-auth). | Med | Decided (no spend) |
| 58 | Candy/Panini OpenSea indexers unscheduled on missing `OPENSEA_API_KEY`; Magic Eden covers Candy. Oldest routed item. | Low | Trevor env var |
| 60 | Cannot revoke anon/authenticated from net/cron schemas; needs Supabase support. | Low–Med | External |

### Tech debt / refactor

| # | Issue | Severity | Effort |
|---|---|---|---|
| 14 / 10 | Monolith page refactor — re-measured this run and all growing: DashboardClient **3,012**, SniperClient **2,107**, CollectionAnalyticsClient **2,040**, CollectionTabClient **1,605**, MarketClient **1,458**. | Low–Medium | Large |

### Stalled / scaffolded + deferred hardening

- Cart / Trade Hub / Gifting — **DELETED, verified still absent.**
- Deferred hardening (intentional): `email_subscribers`/`outbound_clicks`/`portfolio_snapshots`/`support_conversations` public INSERT policies; `user_achievements`+`watchlist_items` still on `owner_key` (text); Golazos `highest_offer` gap SETTLED (no offer source — do NOT build the indexer); `sales-serial-backfill` substring-token check (latent dead code; `INGEST_SECRET_TOKEN` rotation owed); `buildTopshotPoolPayload` fabricated-divisor (latent, no live caller — exit when the pool lane revives, #65).

### Architecture notes worth tracking

- **Two "collection vocabulary" and two "confidence vocabulary" footguns** persist by design. Re-read `CLAUDE.md` before any new query.
- **Flowty's hosted book is now dead for All Day / Golazos** — the on-chain `cached_listings_v2` is the source; any surface or query still reading v1 `cached_listings` for those collections is stale (guarded by a tree-walk test).
- **Supabase compute is `LARGE`** (resized from SMALL 2026-09-20). Any pre-09-20 finding citing the SMALL-tier disk-IO floor (e.g. 22 MB/s) is stale — re-derive.
- **The June 4.2 GB DB-size baseline doc is badly stale** — the DB now cycles ~38–40 GB (reset the baseline to ~40 GB).
- **FMV 1.8.2 tightened MEDIUM** (sale within 30 days) on 10-18 — Top Shot's HIGH/MED share drops to ~44 % by design; a label correction, not a regression.
- **A server→client prop must be data, never a callback; a `"use client"` module must never reach `lib/supabase.ts`; an inline `<style>` reset must sit in `@layer base`** — all green in `tsc`/vitest/lint but only a real render says so; see `architecture-notes.md`.
- **Eight caller sources** — including a Windows Scheduled Task on Trevor's box and cron-job.org — are invisible to a repo grep. Enumerate all before calling any ingest dead.

---

## 4. Prioritized next actions — **superseded**

`CLAUDE.md`'s old list is replaced by **`docs/strategy/roadmap-2026-10-17.md`** (canonical; accuracy-is-the-gate) and **`docs/strategy/go-live-2026-09.md`**:

| Phase | Action | Status |
|---|---|---|
| Gate | **Accuracy is the GATE — HIGH/MEDIUM share must beat incumbents, read as a series.** | **Top Shot MET (55.8 % series; ~44 % live leg by design); All Day NOT MET (26.3 %) and flat; Candy 57.1 series (relabel; live leg 49.6, market frozen). Backtest beats a naive last-3 median on every collection measured.** |
| Go-live | **M1–M11 bars.** | M4/M5/M6/M7/M8 met this cycle; accuracy gate met for Top Shot, short for All Day; demand is the binding bar. |
| 1 | **Prove the product with real users — now 100+ WAU; no outreach (10-14).** | **Open — the critical path. WAU ~1 live. Get a clean internal-excluded WAU read; hold traffic until the gate opens.** |
| 2 | Cost / latency / saturation levers. | **Stable — DB ~38–40 GB (Panini coverage + pg_net sawtooth), tier LARGE; reset the stale size baseline doc; M4/M5 latency bars met.** |
| 3 | Durable debt. | Heavy advance — Flowty-book repoint, #185 resolved, #195 fabricated-count lanes closed, a11y contrast gate blocking. |
| 4 | Chain two, readiness-gated. | Candy LIVE (thin, market frozen); Panini walked; Rewards economy paused/dial-in. |

**Standing guardrails:** no paywall/Stripe until 100+ WAU; no infra spend pre-revenue; **no outreach** (10-14); **verify pages by rendered DOM, not HTTP 200**; **before gating/short-circuiting any route, enumerate EVERY caller** (eight sources).

**Housekeeping still outstanding:** set `OPENSEA_API_KEY` (#58) or confirm it stays shelved; action the #22 purge GC + credential rotation (chase the GitHub ticket; rotate `INGEST_SECRET_TOKEN`); run the `flowty_archive` tx-lane dedupe then scratch-drop in the SQL editor; rotate `ATLAS_POOL_INGEST_KEY` (#144); fix the 15 live Cowork dashboards (#114) from a desktop session; get a clean WAU read; and reset the stale DB-size baseline doc.

---

## 5. In-code TODO inventory

A first-hand `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` over `app/ lib/ components/ scripts/ workers/ supabase/functions/` (`*.{ts,tsx,js,jsx,mjs,cjs}`; `node_modules`/`.next`/`coverage`/`dist` excluded) found **4 markers, none actionable** — unchanged in character from prior weeks:

### 5a. Narrative / resolved-work references (4 matches)

- `app/api/rtr/lock-roi/route.ts:38` ("v2 folds in the two signals the v1 TODO called out — TIER and SERIAL"), `lib/rtr-lock-roi-weights.ts:7` ("resolves the standing … TODO"), `lib/chains/solana/normalize.ts:47` ("previously held as a TODO placeholder"), `lib/format.ts:6` (the `"$X,XXX.XX"` format doc — the `XXX` here is a format-string literal, the exact false positive the task names). All describe resolved work or are literals.

> **Net change since last week:** none of consequence. Live application code has zero actionable TODO markers. `scripts/`, `workers/` (non-vendored) and `supabase/functions/` scanned clean this run. `TODO_`-prefixed launch-flag guard strings (which do not match `\bTODO\b`) and draft-doc `TODO(...) RESOLVED` lines persist by design. Vendored `workers/**/node_modules/` markers are third-party and excluded.

---

## 6. Resolved / no action needed

Verified against the register STATUS INDEX, the ledger, the 10-19 overnight handoff + weekly digest, and live DB reads:

**Newly resolved / landed / decided since last week (2026-10-12 → 2026-10-18):**
- **#185** — Top Shot issuer-held split RESOLVED 10-14 (reads `ok`; the predicted ~10-14/15 clear landed on schedule).
- **#190** — pre-2023 custodial pack-open history CLOSED, DECLINED 10-17 (no free source; keyed providers are infra spend held pre-revenue).
- **#172** — giveaway "Deliver all" desktop stall SHELVED 10-17 (the phone/WalletConnect path works; reopen if a phone delivery stalls).
- **#17** — Pack/Moment/Set page a11y tail CLOSED 10-17 by decision (not worth work before the site has weekly users).
- **#76** — site-availability alarm RESOLVED 10-13 (off-GitHub cron-job.org probe emails on failure/recovery/auto-disable/TLS-expiry).
- **#195** — the last two DB lanes logging a fabricated `rows_written = 0` closed (10-18): `refresh_fmv_confidence_precompute` and `run_refresh_pack_grail_metrics_mv_job` now report real counts.
- **#191** — All Day / Top Shot / UFC tracked-wallet delete-cap fixed (on-chain-count-confirmed deletes; watch closed 10-17).
- **#186** — UFC holdings closed, NOT a defect (the chain confirms RPC's holdings; Dapper's studio UFC owner index is stale both ways).
- **Flowty hosted-book repoint (10-18)** — All Day / Golazos market readers + listing-challenge verification moved to the on-chain `cached_listings_v2`.
- **Accessibility contrast gate (10-17/10-18)** — `color-contrast` + `select-name` now blocking in CI (299 → 18 axe nodes); `docs/reference/text-colour-system.md` added.
- **Go-live latency bars** — M4 (cold time-to-first-row) met 10-17, M5 (warm reload) met 10-18.

**Note on churn:** the register grew 188 → 194 numbered items in one week, and open+partial fell 10 → 7. A build-and-decide week rather than a discovery surge.

---

## 7. Suggested sequence

A pragmatic order under **accuracy-is-the-gate** + the go-live bars (outreach off, gate 100+ WAU):

1. **Decide #58 (Trevor):** either create a permanent OpenSea key, set `OPENSEA_API_KEY` in Vercel, redeploy and restore the 3 cron lines, or confirm it stays shelved. It is the oldest routed item (~24 nights) and the `candy_sales_stale` arm is its downstream symptom.
2. **Action the #22 purge residue (Trevor):** chase the GitHub Support ticket, re-test the commit URL (expect 404), and **rotate the Dapper session regardless**; rotate `INGEST_SECRET_TOKEN` in the same pass. Oldest open P0.
3. **Run the `flowty_archive` SQL in the Supabase SQL editor:** `dedupe_tx_lane` then `drop_scratch` (~185 MB). Log each in the ledger the same turn. Rotate `ATLAS_POOL_INGEST_KEY` (#144) while there.
4. **Fix the 15 live Cowork dashboards (#114)** from a Cowork-desktop session, then re-run `scripts/audit-cowork-artifact-failure-handling.mjs`.
5. **Get a clean WAU read** (exclude `internal_accounts` + any test cohort) so demand means external users; hold traffic until the 100-WAU gate opens (no outreach, 10-14).
6. **Watch the dated items:** #193 Pinnacle HIGH-tier re-measure on ≥500 HIGH sales (~10-28), #66 Search Console re-read (~10-28), #181 Flow-nodes retire-vs-repoint (~10-24), #8 sports-proxy re-look at preseason tip-off (~10-20/27).
7. **Keep the Flowty-repoint watch** — confirm no All Day/Golazos surface regresses to the dead v1 book (the tree-walk guard enforces it) as the teardown completes.
8. **Reset the stale DB-size baseline doc** (4.2 GB June → cycling ~40 GB) and keep the `net._http_response` sawtooth on watch.

---

## 8. Notes from verification

- **Sandbox / device shell active this run.** `git`/`grep`/`wc`/`ls` all work over the connected repo; counts are first-hand. **589 commits** since 2026-10-12 (`git log --since`); mount HEAD `08c112940` 2026-10-18 16:51 PT (Trevor). Authors: Claude 407, Cowork 91, Trevor 79, nightly/monitor bots ~12. (The mount's HEAD may trail origin; a sibling cloud pass today saw later commits.)
- **Counts measured this run:** CI = **21** jobs under `jobs:` in `.github/workflows/ci.yml` (+1 `component-tests-shard`: changes, memory-docs, docs-tests, inherited-status, typecheck, eslint-ratchet, cadence-escrow-tests, unit-tests-shard, unit-tests, component-tests-shard, component-tests, workflow-lint, build-render, worker-tests, workers-typecheck, db-tests, ledger-guard, register-guard, inbox-guard, tree-corruption, edge-deno); DB-invariant test files = **267** (`supabase/tests/*.sql`, `ls`, +1); `app/insights/*/page.tsx` = **32** (flat). Monoliths re-measured (`wc -l`): DashboardClient 3,012 / SniperClient 2,107 / CollectionAnalyticsClient 2,040 / CollectionTabClient 1,605 / MarketClient 1,458 — all slightly up.
- **Live DB reads 2026-10-19 (~02:35–02:50 AM PT):** demand → **39** accounts (**3** internal, **36** external) / WAU **1** (external sign-in; points-proxy **0**) / MAU **15** / **175** saved wallets / **35** with a saved wallet / **1** email sub. DB size `sum(pg_database_size)` → **38,630 MB** (~37.7 GB; the digest read 39,927 MB and the overnight snapshot 39,970 MB — cycles ~38–40 GB). Accuracy confidence distribution from `fmv_confidence_precompute` (computed 09:35Z): Top Shot HIGH 1,353 / MED 5,046 (= 44.0 % of 14,528), All Day 210 / 1,494 (27.5 % of 6,190), Pinnacle 227 / 690 (33.2 % of 2,762), Candy 4 / 58 (49.6 % of 125), Panini 11,289 / 1,643 (35.6 % of 36,320), Golazos 0 / 0 (575), UFC 0 / 0 (617). `v_fmv_sanity_flags` 0.
- **Accuracy series (file-blessed way, from roadmap-2026-10-17 §2):** weekly-mean legs, week of 10-12 — Top Shot 55.8, All Day 26.3, Pinnacle 32.6, Candy 57.1, Panini 27.2, Golazos 1.0, UFC 0.0. Top Shot's expected ~44 % from 10-18 is the FMV 1.8.2 MEDIUM re-grade (by design). **Read a series, not a leg** (a single leg moves ±2.5 points).
- **TODO scan: 0 actionable markers in live app code** (§5) — `grep -rnE '\b(TODO|FIXME|HACK|XXX)\b'` with `node_modules`/`.next`/`coverage`/`dist` excluded; the one `XXX` hit is a `$X,XXX.XX` format literal; `scripts`/`workers`/`supabase/functions` clean.
- **Deletions verified by absence (`test -e`):** `lib/cart`, `lib/trade-escrow`, `app/dashboard/trade-hub`, `app/dashboard/gift`, `lib/blazers-trivia.ts`, `docs/FREEZE.md` — all absent.
- **Launch flags verified:** `lib/launch-flags.ts` `CANDY_MLB_PUBLIC = true`, `PANINI_PUBLIC = true`.
- **Cited paths spot-checked — all resolve, no stale references found:** `docs/strategy/{roadmap-2026-10-17,roadmap-2026-08-03,go-live-2026-09}.md` (+ `docs/strategy/collections/` 8 entries, `docs/strategy/features/` 7 entries); `docs/reference/{known-issues,roadmap-status,database,cron-and-schedulers,key-files-and-honesty,testing-and-ci,schema-truth,architecture-notes,player-identity,chain-strategy,text-colour-system}.md`; `docs/overnight/{ledger.md,metrics-latest.json,focus.md}`; `lib/{launch-flags,collections,address,api-error}.ts`; `lib/insights/{board-status,board-error}.ts`; `lib/analytics/fetch-json.ts`; `lib/og/board-empty-copy.ts`; `lib/market/ask-freshness.ts`; `app/api/golazos-offers-indexer/route.ts`; `scripts/audit-cowork-artifact-failure-handling.mjs`; `docs/research/dune-rigged-custodial-opens-2026-09-29.sql`; `e2e/a11y.spec.ts`; `.github/workflows/{ci.yml,edge-fn-deploy.yml,site-availability-alarm.yml}`. **Absent (correctly):** the four deleted product dirs, `lib/blazers-trivia.ts`, `docs/FREEZE.md`.
- **Known-issues STATUS INDEX:** its own generated line reads **194 numbered items — 3 open · 4 partial · 187 closed**; the 3 open are **#22, #193, #196**; the 4 partial are **#66, #114, #181, #189**; the newest filed slot is **#196**.
- This report did **not** edit `CLAUDE.md` or any source file and did **not** touch git — it only created this file.

---

## 9. Known-issues reconciliation (verified 2026-10-19)

The register's own generated STATUS INDEX reports **194 numbered items — 3 open · 4 partial · 187 closed**. ⛔ `closed`/`open` means the item *says* so — read its own date stamp. The current open/partial set and the items that moved since last week:

| # | Issue | Index status | Verified status | Evidence |
|---|---|---|---|---|
| 22 | 🚨 Credential purge | 🟡 **open** | Branch deleted; blob fetchable by SHA + RS256 PII persists; GitHub ticket filed — GC + rotation owed to Trevor | known-issues #22 |
| 193 | Disney Pinnacle HIGH tier less accurate than naive last-5 | 🟡 **open** | NEW 10-17 — measurement; last-5 proposal gated on ≥500 HIGH sales (~10-28); `pinnacle_fmv_sales_backtest()` exists | known-issues #193 |
| 196 | Interactive table-row a11y (nested-interactive / aria-conditional-attr) | 🟡 **open** | NEW 10-18 — deliberate keyboard-operability pattern; redesign pass owed; both rules printed-not-gated in `e2e/a11y.spec.ts` | known-issues #196 |
| 66 | SEO / zero external links | 🟠 partial | Structured data + llms.txt shipped; external links remain Trevor's; Search Console re-read ~10-28 | known-issues #66 |
| 114 | Cowork dashboards render failed read as empty | 🟠 partial | Repo copies fixed; 15 live OneDrive dashboards still carry old helper; needs Cowork-desktop session | known-issues #114 |
| 181 | Flow mainnet24–26 nodes dark | 🟠 partial | Parked with canary; retire-vs-repoint decision ~10-24 | known-issues #181 |
| 189 | Top Shot offer capture | 🟠 partial | Complete; ~3,238 pre-spork fills unsourced (reachable only via dark history nodes); 10-18 re-walk ~0 net inserts | known-issues #189 |
| 185 | Top Shot issuer-held split pending | ✅ closed | RESOLVED 10-14 (`ok` on the total row; was partial last week) | STATUS INDEX / live |
| 190 | Pre-2023 custodial pack opens, no free source | ✅ closed | CLOSED 10-17, DECLINED (infra spend held pre-revenue; was open last week) | STATUS INDEX |
| 172 | Giveaway "Deliver all" desktop stall | ✅ closed | SHELVED 10-17 (phone path works; was open last week) | STATUS INDEX |
| 17 | Pack/Moment/Set a11y tune-up | ✅ closed | CLOSED 10-17 by decision (was partial last week) | STATUS INDEX |
| 76 | Site-availability alarm cadence | ✅ closed | RESOLVED 10-13 (off-GitHub cron-job.org probe; was partial last week) | STATUS INDEX |
| 195 | Fabricated `rows_written = 0` DB lanes | ✅ closed | CLOSED 10-18 (last two lanes report real counts) | STATUS INDEX / ledger |

**Tally (per the register's own STATUS INDEX):** **194 numbered items — 3 open · 4 partial · 187 closed**, newest slot **#196**. Plus the go-live plan, the per-collection accuracy legs, Candy live (market frozen) + Panini walked + Rewards paused, **21-job CI**, **267 DB-invariant test files**, and **32 public `/insights` surfaces**.

**Bottom line for `CLAUDE.md`:** this was a correctness-and-honesty shipping week driven by Flowty's hosted book going dark. The All Day / Golazos market readers and the listing-challenge verification path were repointed to the on-chain book in a day, so those collections kept pricing and verifying through the shutdown; **#195** closed the last fabricated-`rows_written` lanes and the a11y contrast gate went blocking in CI. Open+partial fell **10 → 7**: last week's three open items are settled (**#190** declined, **#172** shelved, **#185** resolved) and two partials (**#17**, **#76**) closed, while two new measurement/polish opens appeared (**#193** Pinnacle HIGH-tier accuracy, **#196** interactive-row a11y). Live trust metrics are clean (0 impossible serials, 0 FMV sanity flags, 37/38 arms — the one breach is the benign Candy market freeze), and every night this week shipped 0 from the autonomous pass. On the front page, **Top Shot is MET on its series (55.8 %) and dropping to ~44 % by design** (FMV 1.8.2 MEDIUM re-grade), **All Day is still short (26.3 %)**, and **WAU is ~1 against a 100-WAU gate with outreach now off**. The standing asks are operator/Trevor: **#58** (OpenSea env var, the oldest routed item), the **#22 purge GC + rotation**, the **`flowty_archive` dedupe + scratch-drop SQL**, and **#144** key rotation. **A clean demand number — and permission to chase it — is still the one thing that decides everything.**
