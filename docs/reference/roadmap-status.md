<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## How to read this file (added 2026-08-27)

**Newest first, and only the FIRST dated block is current.** Every other headline block carries
**[SUPERSEDED]** in its heading — they are kept because their *reasoning* is often still right even when
their *values* are not, which is this file's standing convention. ⚠ **A superseded block's numbers must
never be quoted; its cautions still apply.**

⚠ **The section immediately below — "Prioritized next actions" — is the OLDEST material in this file
(2026-08-03 framing with a 2026-08-13 update), and it sits first for historical reasons, not because it is
current.** Its *framing* still binds (intelligence-first; read-only product; monetization tabled until 50+
WAU); its *measurements* were superseded five times over. **For any number, scroll to the first
`⭐ HEADLINE METRIC` block instead.**

| what you want | where it is |
|---|---|
| the current accuracy / demand / ops numbers | the first `⭐ HEADLINE METRIC …` block below |
| the standing product framing and gates | "Prioritized next actions", immediately below |
| the plan itself | [docs/strategy/roadmap-2026-08-03.md](../../docs/strategy/roadmap-2026-08-03.md) |
| open defects and their status | [known-issues.md](known-issues.md) (it now carries a STATUS INDEX) |

---

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](../../docs/strategy/roadmap-2026-08-03.md) (supersedes roadmap-2026-07-18).** Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. The new **headline metric is the share of prices at HIGH/MEDIUM confidence** (measured 08-03: Golazos 0.7%, AllDay 6.3%, UFC 3.2%, Top Shot 17.3%, Candy 60.8%). The $0.50 dust-floor removal (`3809425b`) was the first big accuracy lever landed under this framing — it reached only ~1,000 editions until 2026-08-03 because the `fmv-recalc` sweep cursor never advanced past page 0 (`484d08d7`), so measure any accuracy number AFTER a full sweep completes, not before. **✅ The sweep is now confirmed COMPLETE and roadmap §5.1 "dust-floor post-ship verification" is CLOSED (`cbe019fb`, 2026-08-04) — this was the only item blocking Gate 1.** In the trailing 24h **13,605 distinct editions** recalced (> the ~11,606 traded population), and the full-cohort ratios landed on the unfloored `cold-tail` control: Top Shot 4,295 eds **median 1.000 / p90 1.176 / >2× 16 (0.37%)** (was 1.110 / 2.576 / 461 floored), All Day 0.979 / 1.333 / 1.2%, Candy 1.051 / 1.151 / 0. The `fmv_apply_thin_sale_haircut` cohorts converged (TS 249→13 eds, ratio 1.800→0.717), confirming the haircut was a symptom not a second defect; this also resolves the §5.3 "9.2% of liquid TS editions >2×" item to **0.37%**. ✅ **The HIGH/MEDIUM confidence SHARES have now BEEN re-measured (2026-08-13) and the 08-03 figures above are the stale baseline, not current.** The flag this line used to carry — "still pre-sweep and genuinely due a re-measure" — is CLOSED: `cbe019fb` had re-measured the FMV-vs-median accuracy RATIOS, not this. Post-sweep: **Top Shot 17.3% → 54.5%**, **All Day 6.3% → 27.7%**, Candy 60.8% → 60.0%, Golazos 0.7% → 0.9%, UFC 3.2% → 0.0%, plus **Disney Pinnacle 30.3%** (never previously measured). Top Shot's `% priced >30d stale` also went **19.8% → 0.0%**. ⚠ **Read it from `public.rpc_trust_health_precompute`** (metrics `<collection>_fmv_high_med_share_pct`, written by `rpc_thp_leg_fmv_coverage`) — **do NOT call `rpc_fmv_confidence_share()` to refresh it**, which blows a 60 s statement budget on the live instance and is exactly why the precompute leg exists; a value of **999 is that leg's failure sentinel, not a percentage**. ⚠ **UFC's 0.0% is NOT a regression to fix** — the market closed and 96.3% of its prices are >30 d stale, so zero IS the honest confidence label; the roadmap's "the only correct product answer is a label" stands. ⚠ **And roadmap §6's target moved with the metric**: "All Day → the Top Shot band or better" is still OPEN despite All Day quadrupling, because Top Shot tripled in the same window — the gap is still ~2×. Full dated block + the denominator caveat: [roadmap §3.1](../../docs/strategy/roadmap-2026-08-03.md). Gate-1 status re-verified live 2026-08-03 evening: Candy `wmc.fmv_usd` denorm **DONE** (25,375 rows, 0 NULL); Golazos shells **draining** (4,249 → 3,905); UFC dead-market labelling is shipped for SEO (`lib/market-closed.ts` → `lib/seo.ts`) and the rendered `MarketplaceStatusBanner` covers overview/collection/sniper/edition — the residual gap is only UFC's `analytics` + `sets` tabs. Prior framing still binds where not superseded: go-live is DONE (public un-gate 2026-07-17); no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; verify pages by **rendered DOM, not HTTP 200** (streaming shells always return 200).

**Framing (2026-05-24, still binding):** RPC is committed **intelligence-first** — the goal is a product genuinely more useful than nbatopshot.com itself. Cart / live-buy is shelved (see Open #1). **Monetization — the Pro paywall, Stripe — is tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met.

1. ~~Flowty teardown~~ — **RE-SCOPED 2026-07-07 (verified live): the teardown premise is OBSOLETE.** `api2.flowty.io` is ALIVE and serving CURRENT listings (Series 8 probe 200 OK), and the listing-cache pipelines (`topshot/golazos/allday/ufc-listing-cache`, ~475 runs/wk each, ok=true) actively ingest it and feed cached_listings + ASK FMV + fmv-recalc chaining TODAY. Flowty's trading FRONTEND shut May 2026, but its API infrastructure lives on (now behind dapper.market). Do NOT delete the listing caches, flowty-proxy edge fn, or the ingest chain — they are live production ingest. The 2026-07-07 cleanup removed only the true zero-importer orphans (bot-prerender quote lib, flowty deep-link builder, Firestore offers lib, superseded allday/ufc sniper-feed routes, pinnacle debug route). Remaining candidates (edition-floor's Flowty leg, cart make-offer-flowty) are LIVE-reachable or Cart-gated — touch only with a product decision.
2. Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely differentiated from Top Shot's own site.

*Done — the Market/Sniper reframe to outbound "View Listing" links shipped 2026-05-23 (commit `b19d8f2`); the AllDay `unmapped_sales` resolver was rewritten + un-starved 2026-05-25; see Recent sessions.*

---


---

## ⭐ HEADLINE METRIC + DEMAND + OPS — re-read live 2026-08-27 20:45 PT (2026-08-28 03:45Z) (supersedes the 08-27 09:55 PT block below)

Read the documented way, straight from `public.rpc_trust_health_precompute`
(`<collection>_fmv_high_med_share_pct`, written by `rpc_thp_leg_fmv_coverage`) — **never by calling
`rpc_fmv_confidence_share()`**, which blows a 60 s budget. Leg age at read time: **1.9 h** for the five
shared collections (01:48:00Z) and **5.8 h** for Pinnacle (21:55:00Z, jobid 331's own schedule).

| collection | 08-27 20:45 | 08-27 09:55 | 08-26 19:00 | 08-24 15:35Z | 08-22 | range, 5 samples |
|---|---:|---:|---:|---:|---:|---|
| `nba_top_shot` | **55.0%** | 55.4% | 57.8% | 57.2% | 49.6% | 49.6 – 57.8 |
| `candy_mlb` | **63.2%** | 64.0% | 63.2% | 62.4% | 59.2% | 59.2 – 64.0 |
| `disney_pinnacle` | **43.8%** | 43.8% | 43.8% | 43.4% | 43.2% | 43.2 – 43.8 |
| `nfl_all_day` | **23.4%** | 25.2% | 26.7% | 27.0% | 22.5% | 22.5 – 27.0 |
| `laliga_golazos` | **0.2%** | 0.3% | 0.3% | 0.2% | 0.0% | 0.0 – 0.3 |
| `ufc_strike` | **0.0%** | 0.0% | 0.0% | 0.0% | 0.0% | 0.0 |

⛔ **Every one of today's readings sits INSIDE its own five-sample range, so nothing here is a move.**
The standing rule holds in both directions: a directional claim needs a distribution.

⭐ **The one directional claim the 08-27 09:55 block did make is FALSIFIED at the fifth sample, and it is
recorded here rather than quietly dropped.** That block singled out Candy as *"the only collection that has
moved monotonically across all four samples"* (59.2 → 62.4 → 63.2 → 64.0) and named it "the one worth
watching for a real trend". The fifth reading is **63.2** — the run is broken. ⛔ **That is not a decline
either**; it is the same two-instants trap pointing the other way, on the smallest population on the board.
The honest statement is the range: **Candy has read 59.2–64.0 across 08-22 → 08-27.**
⭐ **Durable: a monotonic run over four instants is not a trend, and naming one invites the next reader to
treat the fifth sample as news.** Do not re-open Candy on this.

### The all-keys denominator, re-derived the same instant — 30.1% (08-24) → **33.4%**

From `rpc_ops_snapshot()`'s `fmv_by_collection` block, which counts every key rather than the canonical
subset — **a different instrument from the precompute leg above, and it agrees with it in direction**:

| collection | keys | HIGH+MEDIUM | share | 08-24 |
|---|---:|---:|---:|---:|
| `nba_top_shot` | 19,735 | 7,571 | **38.4%** | 34.3% |
| `nfl_all_day` | 6,190 | 1,461 | **23.6%** | 21.4% |
| `laliga_golazos` | 575 | 1 | 0.2% | 0.0% |
| `ufc_strike` | 518 | 0 | **0.0%** | 0.0% |
| **total** | **27,018** | **9,033** | **33.4%** | 30.1% |

⚠ **Candy is ABSENT from that block** (it is in `editions_by_collection` at 125 editions but carries no
`fmv_by_collection` key), so this total covers four collections where the 08-24 all-keys total covered
five; adding Candy at its own leg's 63.2% of 125 moves it to ~33.6%, i.e. **under 0.2 pt either way**.
⚠ **`disney_pinnacle` reads `{}` here, exactly as documented** — it prices through the triple-keyed
`pinnacle_catalog` path and has zero rows in the `fmv_snapshots` family. Three denominators still exist and
**a share is meaningless without naming one**.

### Demand — re-read the same instant from `auth.users`, and it CONFIRMS 08-26 rather than superseding it

**23 accounts · 2 signups in 7 d (newest 2026-08-25) · WAU 2 · MAU 4** — identical on all four figures to
the 2026-08-26 capture. ⚠ **A confirmation is worth stamping precisely because the next reader cannot tell
a stale number from a re-verified one.** n = 2 is still 4% of the 50+ WAU gate and moves nothing.

### Ops, same instant (`rpc_ops_snapshot()`, generated 2026-08-28T03:45:19Z)

- **Trust board: 38 arms, 3 BREACHED.** ⭐ **Diff the SET, not the count: it was TWO on 08-26 19:10 PT**
  (`public_board_slow_count`, `unmapped_resolution_backlog_max`) **and the third is `board_mv_refresh_stale_hours`
  at 9.57 h against a `breach_at` of 8** — the arm [trust-board-and-safety.md](trust-board-and-safety.md)
  records as *"all clear in this sample"* three days ago. ⛔ **It is the documented cadence-vs-threshold
  mismatch, not a new incident:** its refresher is a **6-hourly** job against an **8-hour** threshold, so a
  single missed cycle guarantees a breach. The other two: `public_board_slow_count` **5** (breach 1) and
  `unmapped_resolution_backlog_max` **338** (breach 100, and the one arm still climbing — 258 → 291 → 338).
- ✅ **Two arms this file has spent pages on are GREEN in the same sample and their history should not be
  re-quoted as current:** `fmv_sweep_wedge_hours` **0.16** (breach 3; it read 12.17 on 08-16) and
  `fmv_sweep_stall_pct_24h` **6.2** (breach 50; it read 50 on 08-16). `panini_sale_price_capture_dry_days`
  is **0** (it read 19–20 breaching in mid-August).
- **DB size 14,055 MB (14.06 GB).** ⚠ **Do NOT quote known-issues #13's "13.8 → 6.5 GB" as the current
  size** — that is the May 2026 post-prune figure and the database has since more than doubled past it.
- **Editions by collection:** Top Shot **19,906** · All Day 6,190 · Golazos 575 · UFC 518 · Candy 125.

---

## [SUPERSEDED] ⭐ HEADLINE METRIC — re-read live 2026-08-27 09:55 PT (16:55Z) (supersedes the 08-26 block below)

Read the documented way: straight from `public.rpc_trust_health_precompute`
(`<collection>_fmv_high_med_share_pct`, written by `rpc_thp_leg_fmv_coverage`) — **never by calling
`rpc_fmv_confidence_share()`**, which blows a 60 s budget. ⚠ **Leg age at read time: 3.1 h for the five
shared collections** (13:48:00Z) **and 1.0 h for Pinnacle** (15:55:00Z, its own jobid 331 schedule). **That
is 12× staler than the 08-26 read’s 15 minutes — the figures below are a 3-hour-old instant, not a live one.**

| collection | 08-27 09:55 PT | 08-26 19:00 PT | 08-24 15:35Z | 08-22 |
|---|---:|---:|---:|---:|
| `nba_top_shot` | **55.4%** | 57.8% | 57.2% | 49.6% |
| `candy_mlb` | **64.0%** | 63.2% | 62.4% | 59.2% |
| `disney_pinnacle` | **43.8%** | 43.8% | 43.4% | 43.2% |
| `nfl_all_day` | **25.2%** | 26.7% | 27.0% | 22.5% |
| `laliga_golazos` | **0.3%** | 0.3% | 0.2% | 0.0% |
| `ufc_strike` | **0.0%** | 0.0% | 0.0% | 0.0% |

⛔ **Top Shot 57.8 → 55.4 and All Day 26.7 → 25.2 are NOT a decline — they are two instants, and this
file’s own rule is that a directional claim needs a distribution.** The honest statement remains a RANGE:
**Top Shot has read between 49.6% and 57.8% across 08-22 → 08-27, and All Day between 22.5% and 27.0%.
Today’s readings sit INSIDE both ranges**, on a population `/api/fmv-recalc` rewrites continuously. ✅
**Corroborated independently the same morning** by the nightly pass, which recorded HIGH+MED **counts**
moving Top Shot 7,631 → 7,502 and All Day 1,579 → 1,519 and classified both as *normal recompute churn*
with `*_fmv_stale_hours` = 0.1 — i.e. **fresh, not a coverage loss**. Two instruments, same conclusion.

⚠ **Candy is the only collection that has moved monotonically across all four samples** (59.2 → 62.4 →
63.2 → 64.0) and is the one worth watching for a real trend — **but four instants is still not a
distribution, and it is the smallest population here.** ⛔ **UFC 0.0% remains CORRECT and permanent**
(market closed) and **Golazos ~0.3% remains a liquidity ceiling, not a defect.** Neither is a queue.

## [SUPERSEDED] ⭐ HEADLINE METRIC + DEMAND — re-read live 2026-08-26 19:00 PT (supersedes the 08-24 canonical block below)

Read straight from `public.rpc_trust_health_precompute` (`<collection>_fmv_high_med_share_pct`, written by
`rpc_thp_leg_fmv_coverage`) — **never by calling `rpc_fmv_confidence_share()`**, which blows a 60 s budget on
the live instance and is exactly why the precompute leg exists. Leg age at read time: **15 minutes** for five
collections, **4.1 h** for Pinnacle (its own leg, jobid 331, runs on a different quarter-day schedule).

| collection | canonical-only HIGH/MEDIUM share | 08-24 15:35Z | 08-22 |
|---|---:|---:|---:|
| `nba_top_shot` | **57.8%** | 57.2% | 49.6% |
| `candy_mlb` | **63.2%** | 62.4% | 59.2% |
| `disney_pinnacle` | **43.8%** | 43.4% | 43.2% |
| `nfl_all_day` | **26.7%** | 27.0% | 22.5% |
| `laliga_golazos` | **0.3%** | 0.2% | 0.0% |
| `ufc_strike` | **0.0%** | 0.0% | 0.0% |

⛔ **DO NOT READ THAT AS A FOUR-DAY TREND — the columns are three instants, and this file's own rule is that a
directional claim needs a distribution.** The honest statement is a RANGE: **the Top Shot canonical leg has
read between 49.6% and 57.8% across 08-22 → 08-26**, on a population `/api/fmv-recalc` rewrites continuously
(24,959 rows in the trailing 24 h). ⚠ **Still the canonical-only denominator** — not comparable to the
**30.1% all-keys** figure below, which answers a different question over a set that excludes Pinnacle entirely.
⛔ **UFC's 0.0% remains CORRECT and permanent** (market closed) and **Golazos' ~0% remains a liquidity ceiling,
not a defect.** Neither is a queue.

⚠ **`<collection>_fmv_pct_stale_30d` reads `0.0` for EVERY collection in the same sample, and the metric's
NAME invites exactly the wrong reading.** A zero-everywhere metric looked like a broken leg, so it was
re-derived from `prosrc` and from the table: **it measures the age of the FMV COMPUTATION**
(`latest.computed_at < now() - 30 days`), **not the age of the market data underneath it.** Control run on the
collection where the two readings must diverge most — UFC, market closed since May 2026: **518 priced
editions, 0 computed more than 30 d ago (oldest snapshot 2026-08-24), and 381 `STALE` + 137 `NO_DATA` by
confidence.** So `0.0` is CORRECT and simply says *the recalc sweep is reaching everything*; the 08-13 line
below reading *"UFC 96.3% of its prices are >30 d stale"* is a **different measurement** and the two must never
be quoted as the same series. ⭐ **The durable lesson is the naming: `pct_stale_30d` is a PIPELINE-freshness
metric wearing a PRICE-freshness name**, and the only reason it was not filed as a broken leg is that someone
read its source instead of its title.

### Demand — re-captured 2026-08-26 (first movement since 2026-08-08)

Read from `auth.users`, the same instrument as the 08-24 capture:

| | 2026-08-26 | 2026-08-24 |
|---|---:|---:|
| accounts | **23** | 21 |
| signups in 7 d | **2** (newest 2026-08-25) | 0 |
| signed-in in 7 d (WAU) | **2** | 0 |
| signed-in in 30 d (MAU) | **4** | 2 |

⚠ **n = 2 is not a trend and does not move the gate** — 50+ WAU is the bar, and this is 4% of it. What it does
change is one dated claim: *"0 signups in 7 d, newest 2026-08-08"* is **no longer true**, and a session
quoting it would be publishing a stale zero about the reader's own product — the same class this codebase
polices everywhere else. ⛔ **`funnel_events` sessions are still NOT users** (wrong by ~3 orders of magnitude)
and **Vercel Web Analytics is still not enabled**, so there is still no independent corroborator for traffic.

---

## [SUPERSEDED] ⭐ CANONICAL-LEG RE-READ, 2026-08-24 ~15:35Z (08:35 PT) — a same-day second sample, and it MOVED

Read straight from `rpc_trust_health_precompute` (`<collection>_fmv_high_med_share_pct`, written by
`rpc_thp_leg_fmv_coverage`, 1.75 h old at read time) — **never by calling `rpc_fmv_confidence_share()`**,
which blows a 60 s budget on the live instance and is why the precompute leg exists.

| collection | canonical-only HIGH/MEDIUM share |
|---|---:|
| `nba_top_shot` | **57.2%** |
| `candy_mlb` | 62.4% |
| `disney_pinnacle` | **43.4%** |
| `nfl_all_day` | **27.0%** |
| `laliga_golazos` | 0.2% |
| `ufc_strike` | **0.0%** |

⚠ **THIS IS THE CANONICAL-ONLY DENOMINATOR AND IT IS NOT COMPARABLE TO THE 30.1% ALL-KEYS HEADLINE BELOW.**
Same day, same instance, different question. The block below records the canonical leg at **49.6%** for Top
Shot at ~03:35Z; it reads **57.2%** at ~15:35Z. ⛔ **Do NOT call that a 7.6-point gain — it is two snapshots
of a population `/api/fmv-recalc` rewrites continuously**, and this file's own standing rule is that a
directional claim needs a distribution, not two instants. The honest statement is: *the canonical leg has
read between 49.6 and 57.2 on 2026-08-24*, and anyone who needs the trend must read the series.

⚠ **Pinnacle is present here (43.4%) and ABSENT from the all-keys table below**, because `fmv_current` carries
zero Pinnacle rows — so the two denominators do not even cover the same set of collections.
⛔ **UFC's 0.0% is still CORRECT and permanent** (market closed since May 2026), and Golazos' ~0% is still a
liquidity ceiling, not a defect — do not chase either.

---

## [SUPERSEDED] ⭐ Headline metric AND demand — measured 2026-08-24 02:00–03:35Z (supersedes 08-22 for the all-keys denominator)

### The accuracy gate, all-keys denominator (`fmv_current`)

| collection | priced editions | HIGH/MEDIUM | share |
|---|---:|---:|---:|
| `nba_top_shot` | 19,667 | 6,740 | **34.3%** |
| `nfl_all_day` | 6,190 | 1,323 | **21.4%** |
| `candy_mlb` | 125 | 77 | 61.6% |
| `laliga_golazos` | 575 | **0** | **0.0%** |
| `ufc_strike` | 518 | **0** | **0.0%** |
| **total** | **27,075** | **8,140** | **30.1%** |

⚠ **THREE DENOMINATORS, and the number is meaningless without naming one.** This is **all-keys**, and it
**reproduces the 08-22 all-keys Top Shot figure (34.2% → 34.3%)**. The canonical-only precompute leg reads
**49.6%** — a different question, not a better one. And ⚠ **`fmv_current` carries ZERO Pinnacle rows**
(measured, against 2,564 in `pinnacle_catalog`; it prices through the triple-keyed path), so this denominator
covers **four of five** published collections while the precompute leg's includes Pinnacle at 43.2%.

⛔ **UFC's 0.0% is CORRECT and permanent** — 381 `STALE` + 137 `NO_DATA`, market closed since May 2026.
It can never improve and drags the headline; **excluding it, 30.7%.**
⛔ **Golazos' 0.0% is MARKET, not model** — 62 sales/30 d across **46 editions** (8% of its 575), and **not
one that sold has more than THREE sales in a month** (avg 1.4). **Do not chase it with a threshold.**

### The gate is mostly a LIQUIDITY CEILING — confirmed at the edition level

All Day, every edition with a sale in 30 d, by assigned confidence: **HIGH avg 11.8 sales, 100% have ≥5** ·
MEDIUM 5.5 · LOW 2.6. Monotonic. **The estimator is not the binding constraint for most of the catalogue.**

⚠ **The apparent exception is not one.** ~1,000 editions publish LOW while trading MORE than the MEDIUM
cohort (Top Shot: 368 at a **true 39.6 sales/30 d** vs MEDIUM's 22.2). Cause measured:
`MEDIUM_MAX_DISPERSION = 0.35` demotes MEDIUM→LOW once count ≥7, so **only high-volume editions are eligible
to be demoted at all**. **LOW avg CV 0.731 (76% over the ceiling) vs HIGH 0.222 (10%)** — working as written.
⛔ **A "sub-dollar tick" explanation was tested and FALSIFIED**: HIGH has the **lowest** median price ($0.31)
and the **most** sub-dollar editions (72%). **Do not build a tick-aware dispersion measure on it.**
⭐ **What survives: `LOW` conflates *"almost no data"* with *"643 sales that disagree"*** — opposite messages
to a collector. Splitting the label is a product decision, not a data problem.

### Demand — first capture since 2026-07-26

**21 accounts** (+1 in four weeks) · **0 signups in 7 d** (newest 2026-08-08) · **signed-in WAU = 0** ·
MAU 2 · all 21 have a saved wallet. Gate is 50+ WAU.

⛔ **`funnel_events` sessions are NOT users — wrong by ~3 orders of magnitude.** 16,463 weekly "non-bot"
sessions of which **99.67% fire exactly one event and never return**; **4 `wallet_paste` sessions, 0
`signin_click`, 0 `account_created`**. ⚠ **Vercel Web Analytics is NOT enabled**, so that table has no
independent corroborator. ⚠ **`bot_ua` is only meaningful from 2026-08-23 02:00Z forward** — before that the
column exists with no UA to classify (100% of rows carry one after, zero before), so `false` means *"never
saw one"*, not *"human"*.

⚠ Dated samples. `fmv_current` is delete-then-insert and the LOW cohort churns ±10% over hours. Re-derive.

## [SUPERSEDED] Headline metric — re-measured 2026-08-22 (supersedes the 08-13 figures above)

⚠ **The 2026-08-13 shares quoted earlier in this file are now the stale baseline.** Read live from
`public.rpc_trust_health_precompute` (metrics `<collection>_fmv_high_med_share_pct`, written by
`rpc_thp_leg_fmv_coverage`) at **2026-08-22 19:45 PT**:

| collection | HIGH/MED share | 08-13 baseline |
|---|---:|---:|
| nba_top_shot | **49.6%** | 54.5% |
| candy_mlb | **59.2%** | 60.0% |
| disney_pinnacle | **43.2%** | 30.3% |
| nfl_all_day | **22.5%** | 27.7% |
| laliga_golazos | **0.0%** | 0.9% |
| ufc_strike | **0.0%** | 0.0% |

⚠ **Do not read the Top Shot and All Day deltas as a regression without a distribution** — these are two
instants, and this file's own rule (a directional claim needs a series, not a snapshot) applies to its own
table. The metric legs' `computed_at` at read time were **19:48Z / 21:09Z**, i.e. **5–7 h old**; the
2026-08-22T1745Z filing measures the leg as unreadable ~20 h a day for structural reasons, so an age of
hours is the normal case, not a fault.

⚠ **TWO honest figures exist for Top Shot and neither is fabricated (deep-audit R41).** The precompute leg
filters Top Shot to canonical `setID:playID` keys (dated in its own comment 2026-08-04, *"the TopShot leg
is CANONICAL-ONLY"*) and reads **49.6–49.7%**; a direct all-keys measure over `fmv_snapshots` reads
**34.2%**. The instruments agree on the other four collections. **Always state the denominator with the
number.**

⚠ **STRUCTURAL FINDING that qualifies the Gate-2 target: accuracy tracks LIQUIDITY, not the pricing code.**
Ordering the four `fmv_snapshots` collections by sales per edition per month reproduces the accuracy
ordering with no inversions — Top Shot 5.51 → 34.2% · All Day 1.69 → 22.7% · Golazos 0.17 → 0.0% · UFC
0.00 → 0.0% (measured 2026-08-21T0256Z filing). **An edition with 0.17 sales a month cannot reach a
sales-based HIGH/MEDIUM however good the estimator is**, so roadmap §6's *"All Day → the Top Shot band or
better"* is bounded by market depth, and Golazos/UFC's zeros are the honest label rather than a defect
queue. ⚠ **Pinnacle is read from `pinnacle_catalog.fmv_confidence`, NOT `fmv_snapshots`, and its sales are
in `pinnacle_sales`** — querying the usual tables for all five returns NULL/0 for Pinnacle and reads as
"Pinnacle is broken".
