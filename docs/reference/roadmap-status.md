<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Prioritized next actions

**The canonical forward plan is [docs/strategy/roadmap-2026-08-03.md](../../docs/strategy/roadmap-2026-08-03.md) (supersedes roadmap-2026-07-18).** Its thesis: **accuracy is the GATE, not a phase** — "zero users is the correct output of the current input," so every growth tactic is removed rather than demoted until the data beats the sites collectors already use. The new **headline metric is the share of prices at HIGH/MEDIUM confidence** (measured 08-03: Golazos 0.7%, AllDay 6.3%, UFC 3.2%, Top Shot 17.3%, Candy 60.8%). The $0.50 dust-floor removal (`3809425b`) was the first big accuracy lever landed under this framing — it reached only ~1,000 editions until 2026-08-03 because the `fmv-recalc` sweep cursor never advanced past page 0 (`484d08d7`), so measure any accuracy number AFTER a full sweep completes, not before. **✅ The sweep is now confirmed COMPLETE and roadmap §5.1 "dust-floor post-ship verification" is CLOSED (`cbe019fb`, 2026-08-04) — this was the only item blocking Gate 1.** In the trailing 24h **13,605 distinct editions** recalced (> the ~11,606 traded population), and the full-cohort ratios landed on the unfloored `cold-tail` control: Top Shot 4,295 eds **median 1.000 / p90 1.176 / >2× 16 (0.37%)** (was 1.110 / 2.576 / 461 floored), All Day 0.979 / 1.333 / 1.2%, Candy 1.051 / 1.151 / 0. The `fmv_apply_thin_sale_haircut` cohorts converged (TS 249→13 eds, ratio 1.800→0.717), confirming the haircut was a symptom not a second defect; this also resolves the §5.3 "9.2% of liquid TS editions >2×" item to **0.37%**. ✅ **The HIGH/MEDIUM confidence SHARES have now BEEN re-measured (2026-08-13) and the 08-03 figures above are the stale baseline, not current.** The flag this line used to carry — "still pre-sweep and genuinely due a re-measure" — is CLOSED: `cbe019fb` had re-measured the FMV-vs-median accuracy RATIOS, not this. Post-sweep: **Top Shot 17.3% → 54.5%**, **All Day 6.3% → 27.7%**, Candy 60.8% → 60.0%, Golazos 0.7% → 0.9%, UFC 3.2% → 0.0%, plus **Disney Pinnacle 30.3%** (never previously measured). Top Shot's `% priced >30d stale` also went **19.8% → 0.0%**. ⚠ **Read it from `public.rpc_trust_health_precompute`** (metrics `<collection>_fmv_high_med_share_pct`, written by `rpc_thp_leg_fmv_coverage`) — **do NOT call `rpc_fmv_confidence_share()` to refresh it**, which blows a 60 s statement budget on the live instance and is exactly why the precompute leg exists; a value of **999 is that leg's failure sentinel, not a percentage**. ⚠ **UFC's 0.0% is NOT a regression to fix** — the market closed and 96.3% of its prices are >30 d stale, so zero IS the honest confidence label; the roadmap's "the only correct product answer is a label" stands. ⚠ **And roadmap §6's target moved with the metric**: "All Day → the Top Shot band or better" is still OPEN despite All Day quadrupling, because Top Shot tripled in the same window — the gap is still ~2×. Full dated block + the denominator caveat: [roadmap §3.1](../../docs/strategy/roadmap-2026-08-03.md). Gate-1 status re-verified live 2026-08-03 evening: Candy `wmc.fmv_usd` denorm **DONE** (25,375 rows, 0 NULL); Golazos shells **draining** (4,249 → 3,905); UFC dead-market labelling is shipped for SEO (`lib/market-closed.ts` → `lib/seo.ts`) and the rendered `MarketplaceStatusBanner` covers overview/collection/sniper/edition — the residual gap is only UFC's `analytics` + `sets` tabs. Prior framing still binds where not superseded: go-live is DONE (public un-gate 2026-07-17); no paywall/Stripe until 50+ WAU; no infra spend pre-revenue; verify pages by **rendered DOM, not HTTP 200** (streaming shells always return 200).

**Framing (2026-05-24, still binding):** RPC is committed **intelligence-first** — the goal is a product genuinely more useful than nbatopshot.com itself. Cart / live-buy is shelved (see Open #1). **Monetization — the Pro paywall, Stripe — is tabled until RPC has 50+ weekly active users.** Do not prioritize or propose it before that bar is met.

1. ~~Flowty teardown~~ — **RE-SCOPED 2026-07-07 (verified live): the teardown premise is OBSOLETE.** `api2.flowty.io` is ALIVE and serving CURRENT listings (Series 8 probe 200 OK), and the listing-cache pipelines (`topshot/golazos/allday/ufc-listing-cache`, ~475 runs/wk each, ok=true) actively ingest it and feed cached_listings + ASK FMV + fmv-recalc chaining TODAY. Flowty's trading FRONTEND shut May 2026, but its API infrastructure lives on (now behind dapper.market). Do NOT delete the listing caches, flowty-proxy edge fn, or the ingest chain — they are live production ingest. The 2026-07-07 cleanup removed only the true zero-importer orphans (bot-prerender quote lib, flowty deep-link builder, Firestore offers lib, superseded allday/ufc sniper-feed routes, pinnacle debug route). Remaining candidates (edition-floor's Flowty leg, cart make-offer-flowty) are LIVE-reachable or Cart-gated — touch only with a product decision.
2. Harden the core intelligence surfaces — FMV, wallet/portfolio analytics, the concierge, pack EV — so RPC is genuinely differentiated from Top Shot's own site.

*Done — the Market/Sniper reframe to outbound "View Listing" links shipped 2026-05-23 (commit `b19d8f2`); the AllDay `unmapped_sales` resolver was rewritten + un-starved 2026-05-25; see Recent sessions.*

---


---

## ⭐ CANONICAL-LEG RE-READ, 2026-08-24 ~15:35Z (08:35 PT) — a same-day second sample, and it MOVED

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

## ⭐ Headline metric AND demand — measured 2026-08-24 02:00–03:35Z (supersedes 08-22 for the all-keys denominator)

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

## Headline metric — re-measured 2026-08-22 (supersedes the 08-13 figures above)

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
