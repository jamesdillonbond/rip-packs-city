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
