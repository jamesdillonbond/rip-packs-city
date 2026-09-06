<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Displaced from CLAUDE.md 2026-09-04 (verbatim) — the one measured-but-unshipped DB fix

> - **The one measured-but-unshipped DB fix is LOW-STAKES now (re-derived 2026-09-02): every caller is
>   PER-DIST, and a whole 57-dist tick costs 1.75 s / 152,542 buffers** — the 1,046,192-buffer premise is
>   a bulk-join shape nothing runs. ⭐ Another stated blocker was a MEASUREMENT — **re-read a "blocked"
>   item's blocker before inheriting it.**

Also displaced the same day, from the "Prioritized next actions" list: the sports-proxy bullet's detail
(*"ESPN 403s residentially too; the 'no alert' gap is a MYTH"*) — it already lives in full at #8 in
[known-issues.md](known-issues.md) — and the `fmv-recalc` line's stale wall-kill note, replaced by the
2026-09-04 sizing: `query_sql` is the database's #1 reader (2,171 calls / 12.1M blocks in 24 h) and
`fmv-recalc`'s seven inline scans over 153 daily runs own it (inbox `2026-09-04T0500Z`).

## ⭐ RE-DERIVED 2026-09-02 — the "one measured-but-unshipped DB fix" is LOW-STAKES, because its cost premise is not a production shape

CLAUDE.md carried this for weeks as the single remaining measured DB fix, *"blocked on a DECISION not a
diagnosis"*: replacing `compute_pack_ev_per_edition_weighted`'s `fmv_current` leg, filed at
**18,766 vs 1,046,192 buffers**, held up because the change re-seeds a pinned fixture (Trevor's call).

**Re-read the blocker, as this file's own rule says to, and the cost half of it has gone.**

**1. The 1,046,192 figure is a BULK-JOIN shape that nothing calls.** The ledger entry it comes from
measured `LEFT JOIN fmv_current` over **3,097 edition ids at once**. Every real caller invokes the
function **per dist**: DB-side `refresh_atlas_pack_ev` (jobid 217) and
`backfill_topshot_historical_pack_ev` (jobid 71); repo-side the `compute-topshot-pack-ev` and
`compute-allday-pack-ev` edge functions, both one RPC per dist. There is no bulk call site.

**2. Measured at the real call site, 2026-09-02 (EXPLAIN ANALYZE, BUFFERS, warm), driving the exact
57-dist atlas set jobid 217 uses:**

| what | ms | buffers |
|---|---:|---:|
| all 57 dists in one pass | **1,746** | **152,542** |
| the driver seq scan alone | 116 | 2,898 |
| ⇒ per function call | ~29 | **~2,625** |

A single call measured separately: **141 ms / 3,600 buffers**, of which 285 buffers were the probe's
own `dist_id` lookup.

**3. Corroborated from the other side by the fleet numbers.** After the 2026-08-30 top-consumer drain,
jobid 217 runs a full 57-dist tick in **~2 s** (mean 195 s → 2 s at unchanged run count) and jobid 71
in **~1 s** (178 s → 1 s). A function costing ~1M buffers per call could not produce those times.

👉 **So the decision is no longer "accept a fixture re-seed to win 55× on the platform's hottest
compute".** The win at the real call sites is small, and the change was already verified
value-identical against the live view (0 mismatches). ⛔ **This is NOT a recommendation to close the
item** — Trevor still owns the fixture question, and the leg remains the more correct shape. It is a
correction of the STAKES, so nobody spends a session unblocking a lever that is now worth little.

⚠ **And the transferable half:** the filed figure was never wrong — it measured a shape that was
never run. **A cost figure is only actionable together with the CALL SITE it was measured at**, and
neither the ledger entry nor the CLAUDE.md pointer carried one.

## How to read this file (added 2026-08-27)

**Newest first, and only the FIRST dated block is current.** Every other headline block carries
**[SUPERSEDED]** in its heading — they are kept because their *reasoning* is often still right even when
their *values* are not, which is this file's standing convention. ⚠ **A superseded block's numbers must
never be quoted; its cautions still apply.**

⭐ **DECIDED 2026-08-28 (Trevor, deep-audit run-4 follow-up): the accuracy-gate metric's Top Shot denominator is ALL ROWS, not canonical-only.** The gate figure is therefore **39.2%** as of 2026-08-27 (canonical was 55.0 the same day — quote it only WITH the "canonical" label). ~~The `rpc_thp_leg_fmv_coverage` precompute still publishes canonical-only until its re-point ships (register R41 carries the owed consequences).~~ 🚨 **CORRECTED 2026-08-30 (PT) — THAT SENTENCE IS STALE AND WAS ACTIVELY MISLEADING: the re-point HAS shipped, and the precompute publishes ALL ROWS.** Read from live `prosrc`, not inferred: the leg's `elig` CTE is now a bare `SELECT l.collection_id, l.edition_id, l.computed_at, l.confidence FROM latest l` — **no filter at all** (a vestigial pass-through where the canonical restriction used to be), so its denominator is every latest-per-`(collection_id, edition_id)` row in `fmv_snapshots`. ⚠ **The consequence, which is why this is worth a correction rather than a tidy-up: anyone following the old sentence would label the precompute's figure "canonical" — and canonical was 55.0 against all-rows 39.2 the same day, so it mislabels the single headline gate metric by ~16 points.** ⭐ Two independent lines agree: the source has no canonical predicate, and the published value tracks the all-rows series (39.2 on 08-27 → 39.9 on 08-29 → **38.5** live) rather than the canonical one (55.0). ⓘ Stated as source-derived — the figure was **not** independently recomputed, deliberately: that recomputation IS jobid 325, which costs 411 s and has hit the 600 s ceiling. ⚠ **AND `pinnacle_fmv_high_med_share_pct` IS NOT WRITTEN BY THIS LEG AT ALL** — `rpc_thp_leg_pinnacle_fmv_share` writes it from a **different table, key and column** (`pinnacle_fmv_history`, `DISTINCT ON (render_id)`, `fmv_confidence`). That is correct for Pinnacle's data model, but it means **43.6 is not interchangeable with the other five and must never be folded into an estate-wide average** — which is what "Pinnacle remains in neither total" is protecting. This closes R41's standing "two figures, no denominator" ambiguity: one gate, stated denominator. ⚠ **The 39.2 is a DATED SAMPLE and has already moved — see the first `⭐ HEADLINE METRIC` block for the live figure and for the ~68.3% CEILING this basis carries.**

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

## ⭐ HEADLINE METRIC — re-read live 2026-09-01 20:5x PT (2026-09-02 03:5xZ) (supersedes the 08-29 17:25 PT block below)

**All-rows basis (Trevor's 08-28 decision). Read THE DOCUMENTED WAY — straight from
`public.rpc_trust_health_precompute` (`<collection>_fmv_high_med_share_pct`, written by
`rpc_thp_leg_fmv_coverage`), never by calling `rpc_fmv_confidence_share()`.** Leg age at read: **2.2 h**
for the five shared collections (01:48:00Z), **0.0 h** for Pinnacle (03:55:00Z, jobid 331's own
schedule). ⓘ An independent hand-derivation over `fmv_snapshots` agreed to the decimal on all five
shared collections — recorded as a cross-check of the precompute, not as the source.

| collection | priced | HIGH/MEDIUM | share | vs 08-29 |
|---|---:|---:|---:|---:|
| nba_top_shot | 19,771 | 7,885 | **39.9%** | **FLAT** (+29 denom, +17 rows) |
| nfl_all_day | 6,190 | 1,574 | **25.4%** | +53 rows, +0.8 pt on an unchanged denominator |
| laliga_golazos | 575 | 2 | 0.3% | flat |
| ufc_strike | 518 | 0 | 0.0% | flat |
| candy_mlb | 125 | 79 | 63.2% | +3 rows, +2.4 pt |
| **estate-wide** | **27,179** | **9,540** | **35.1%** | **+73 rows, +0.2 pt** |
| *disney_pinnacle (separate leg)* | — | — | *45.0%* | *+1.2 pt vs 08-27's 43.8%* |

🚨 **THE GATE HAS NOT MOVED IN 3.5 DAYS.** Top Shot is 39.9% on 08-29 and 39.9% now — the +278-row
attributable jump the 08-29 block records was a one-off re-grade from that day's ask-corroboration work,
and nothing has replaced it since. **Estate-wide +0.2 pt over 3.5 days is not progress toward the gate;
it is drift.** ⚠ Stated because the 08-29 entry reads as momentum and a reader could extrapolate it.

⛔ **AND NOTHING SHIPPED 2026-08-31/09-01 WAS AIMED AT THIS METRIC, deliberately.** That session's work —
the fmv-recalc historical fallback, the LATERAL rewrites, the UFC RPC, the pack-reality honesty fix —
writes only `ASK_ONLY`/`SALES_ONLY`/`STALE`/`LOW` labels or changes copy, **so it cannot move HIGH/MEDIUM
by construction and must not be credited with the +0.2 pt.** The levers that move this metric are
sales-density and ask-corroboration, not pipeline reliability.

## [SUPERSEDED] ⭐ HEADLINE METRIC + DEMAND + OPS — re-read live 2026-08-29 17:25 PT (2026-08-30 00:25Z) (supersedes the 08-28 16:20 PT block below)

**All-rows basis (Trevor's 08-28 decision). Fresh `fmv_current` read; numerators and denominators recorded, per the 08-28 rule.**

| collection | priced | HIGH/MEDIUM | share | vs 08-28 |
|---|---:|---:|---:|---:|
| nba_top_shot | 19,742 | **7,868** | **39.9%** | +278 rows, +1.5 pts on an UNCHANGED denominator |
| nfl_all_day | 6,190 | 1,521 | 24.6% | flat |
| laliga_golazos | 575 | 2 | 0.3% | flat |
| ufc_strike | 518 | 0 | 0.0% | flat |
| candy_mlb | 125 | 76 | 60.8% | −3 rows |
| **estate-wide** | **27,150** | **9,467** | **34.9%** | **+275 rows, +1.0 pt** |

⭐ **The Top Shot move is attributable this time, because the denominator did not move:** +278 HIGH/MEDIUM rows on the same 19,742 is the day's ask-corroboration work (the 7-day ask age gate `c537b390d`, the 30 h ask-staleness markers) re-grading rows, not new pricing. It is the first same-denominator delta this file has recorded. ⚠ Still n = 2 same-basis points; not yet a trend. Pinnacle remains in neither total.

**DEMAND — 23 accounts · newest 2026-08-25 · WAU 2 · 104 saved wallets.** Fourth consecutive confirmation of the 08-26 reading. The 50+ WAU gate has not moved. Same single-instrument caution as every prior block.

**OPS, same pass (desktop-VM Cowork session WITH git — the first Cowork pass that could both apply and commit):**
- 🚨→✅ **`/api/analytics/sales/leaderboard`**, the one user-facing route failing on the day, is fixed at the mechanism (collection push-down, `20260829234203`): ufc 41,361 → 2,194 buffers, topshot 162,717 → 27,642. Known-issues **#49** carries the residual (the all-collections leg) and the watch.
- ✅ **Sentinel**: all four WARN arms addressed at the mechanism, not the threshold — grail-MV refresh moved to pg_cron (jobid 384) so lambda kills stop reading as silence; board-liveness sweeps moved off the 12Z/18Z truncation hours (jobid 288 → `28 0,6,11,20`, probe window 600); log purges off the 09Z storm band (jobid 198 → 11:46Z); fmv-recalc un-wedged on its own. `unmapped_resolution_backlog_max` stays red **on purpose** (D37 is a real backlog).
- ✅ **jobid 380 → 383**: the never-completed sales_2026 vacuum is re-owned to cron_heavy at `53 10,20`.
- ✅ **Migration parity**: 13 drifted Cowork migrations + 6 new committed byte-exact (`scripts/recover-fileless-migrations.mjs`, 19/19 md5-verified). Drift is ZERO at `2307184`.
- ✅ **Git push from Cowork is durable** (Trevor-approved): `<repo>/.rpc-git-cred`, recipe in `docs/reference/tooling-gotchas.md`. Cloud passes still cannot push.
- 🟡 **Open, user-visible next:** **#50** `/insights/pack-reality` top-EV ranker drains to zero rows within ~20 h (dead pack-ask source — Trevor's source decision) · **#51** the pg_net 4xx detector cannot attribute its own probes · `topshot-active-listings-ingest` GHA is 12/12 red (WAF block via Atlas, #20, operator) · Sentry still dark (#34, operator).

---

## [SUPERSEDED] ⭐ HEADLINE METRIC + DEMAND — re-read live 2026-08-28 16:20 PT (23:20Z) (supersedes the 08-27 20:45 PT block below)

**On Trevor's 08-28 ALL-ROWS decision, which is the gate basis. Every figure below is a fresh
`fmv_current` read, not a re-quote.**

| collection | priced | HIGH/MEDIUM | share |
|---|---:|---:|---:|
| nba_top_shot | 19,742 | 7,590 | **38.4%** |
| nfl_all_day | 6,190 | 1,521 | 24.6% |
| laliga_golazos | 575 | 2 | 0.3% |
| ufc_strike | 518 | 0 | 0.0% |
| candy_mlb | 125 | 79 | 63.2% |
| **estate-wide** | **27,150** | **9,192** | **33.9%** |

⚠ **Pinnacle is still in NEITHER total** — zero rows in `fmv_current`, priced through its own
triple-keyed path. This covers four of five published collections, as every prior capture has warned.

🚨 **NEW, AND IT IS A CEILING ON THE GATE ITSELF — the all-rows basis has a ~32.5% floor-drag that NO
pricing work can move.** Decomposing Top Shot by the canonical predicate:

| Top Shot rows | count | share of denominator | HIGH/MEDIUM |
|---|---:|---:|---:|
| canonical `^[0-9]+:[0-9]+(::[0-9]+)?$` | 13,316 | 67.5% | **55.8%** |
| non-canonical (dupe residue) | 6,426 | **32.5%** | **2.5%** |

⭐ **So if canonical pricing reached a PERFECT 100%, Top Shot's all-rows gate figure would read
(13,316 + 163) / 19,742 = 68.3%, not 100%.** The residue is a third of the denominator and contributes
163 HIGH/MEDIUM rows in total. **This is not an argument to switch bases** — Trevor's decision stands and
the reasoning for it (pricing dupe residue is not an accuracy achievement) is sound. It is an argument
that **the gate's practical ceiling is ~68% on this basis, and a plan that treats 100% as the target is
mis-scaled.** Whoever sets the next accuracy milestone should set it against 68.3, not 100.

⭐ **THE RESIDUE IS NOT GROWING RIGHT NOW, which changes what to do about it.** New non-canonical Top
Shot editions by day: **27 on 08-18, 9 on 08-20, and ZERO on every one of the eight days since**
(08-21 → 08-28, while 79 canonical editions were created). So the source is **sporadic, not continuous**
— a de-duplication backfill would not be immediately re-polluted, and there is no active leak to chase
first. ⛔ Do NOT read "zero for 8 days" as "fixed": two bursts in ten days is a low-frequency event, not
an absence, and nothing here identifies what produced them.

⚠ **I COULD NOT DECOMPOSE THE 39.2 → 38.4 MOVE, AND THE REASON IS A LESSON ABOUT THIS FILE.** The two
bases moved in OPPOSITE directions since 08-27 (all-rows 39.2 → 38.4, canonical 55.0 → **55.8**).
Arithmetically that requires the residue's share or its quality to have shifted — but **the 08-27 entry
recorded the RATIOS and not the numerators and denominators**, so the move cannot be attributed without
re-deriving a stock that no longer exists. ⛔ **New rule for whoever writes the next block: record
`priced` and `high_med` alongside every percentage.** A ratio on its own cannot be differenced later —
CLAUDE.md's "a delta between two STOCKS is neither a rate nor a sign", met in the wild. **⚠ Do not treat
the −0.8 as a regression: with n = 1 prior point and no denominators it is not yet a direction.**

**DEMAND — 23 accounts · +2 in 7 d (newest 2026-08-25) · WAU 2 · MAU 4.** ⭐ **Identical to both the
08-26 and 08-27 readings — that is a THIRD consecutive confirmation, not a new number.** The roadmap gate
is 50+ WAU; it has not moved. ⛔ Standing caution unchanged: `funnel_events` sessions are NOT users
(wrong by ~3 orders of magnitude) and Vercel Web Analytics is still not enabled, so this remains an
uncorroborated single instrument.

---

## [SUPERSEDED] ⭐ HEADLINE METRIC + DEMAND + OPS — re-read live 2026-08-27 20:45 PT (2026-08-28 03:45Z) (supersedes the 08-27 09:55 PT block below)

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

## Displaced from CLAUDE.md 2026-09-06 (verbatim; the self-link re-pointed to this file so the link guard resolves it)

- **The one measured-but-unshipped DB fix is LOW-STAKES** (numbers: [roadmap-status.md](roadmap-status.md)). ⭐ Another stated blocker was itself a MEASUREMENT — **re-read a "blocked" item's blocker before inheriting it.**
