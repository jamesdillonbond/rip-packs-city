# Decision document — the `DUST_PRICE_USD = 0.5` filter in fmv-recalc

**Date:** 2026-08-02 · **Status:** analysis only, nothing shipped · **Decision owner:** Trevor
**Scope:** `lib/fmv-recalc-math.ts` + `app/api/fmv-recalc/route.ts` (FMV pricing logic — hand-off-only per CLAUDE.md)
**All figures measured live against `bxcqstmqfzmuolpuynti` on 2026-08-02. Read-only; no migration, no code change, no git operation was performed.**

---

## 0. One-paragraph summary

An absolute `$0.50` price floor is applied to every sale before FMV is computed. It discards **46.0% of Top Shot** and **76.3% of All Day** transactions in the current 30-day window. Those discarded sales are not dust in any defensible sense: 1,094 distinct Top Shot buyers and 883 distinct sellers transacted below $0.50 in 30 days, there are **zero** self-trades platform-wide, and the price distribution is smooth and continuous straight through $0.50 — the constant cuts through the densest part of the market, not a separated noise mode. The resulting error is a clean dose-response: on editions the filter does not touch, published FMV sits at **1.03×** the edition's own realized 30d median; on editions it partially cuts, **1.55×**; on editions it fully empties, **2.28×** (All Day: 1.00× / 1.97× / 3.38×). Mark-to-market, the affected editions transacted **$24,464** of real volume in 30 days that RPC's published FMV values at **$35,503 — +45%**. Removing the floor moves **2,632 editions closer** to their own realized median against **451 further** (5.8:1), and drops the count of editions published at >2× their own median from **1,789 to 269**. The dust protection the constant was assumed to provide already exists twice over in the same code path, so removing it does not remove a guard.

---

## 1. Diagnosis — confirmed, with three corrections

### Confirmed exactly as stated

| Claim | Verified |
|---|---|
| `lib/fmv-recalc-math.ts:8` — `export const DUST_PRICE_USD = 0.5` | ✅ |
| `lib/fmv-recalc-math.ts:116` — `let cleaned = sales.filter(s => s.price >= DUST_PRICE_USD)`, first operation in `dampenGrailSpike()`, before any pricing math | ✅ |
| `route.ts:777` — `const { cleaned: sales, capValue } = dampenGrailSpike(edEntry.sales, { isCommonish })` — the downstream identifier `sales` **is** the filtered set | ✅ |
| `route.ts:807` — `computeConfidence(sales.length)` reads the post-filter count | ✅ (also `route.ts:811` `escalateConfidence(..., sales.length, prices, serials, ...)`) |
| `route.ts:849–850` — `sales_count_7d` and `sales_count_30d` both = `sales.length`, post-filter | ✅ |
| Top Shot ≈ 46% of 30d sales discarded | ✅ **40,227 of 87,445 = 46.0%** |
| All Day ≈ 76.6% discarded | ✅ **13,193 of 17,283 = 76.3%** |
| A cohort averaging ~16 real sales/30d is recorded at ~1.6, priced far above its own median | ✅ in kind — see correction (c) |

### Correction (a) — the filter is **not** the only FMV writer, and that changes where the damage lands

`fmv_current` for actively-traded editions is split across two writers:

| Writer | `algo_version` | Top Shot eds | All Day eds | Dust floor? |
|---|---|---|---|---|
| `/api/fmv-recalc` | `1.7.0*` | 3,958 | 780 | **Yes — $0.50** |
| `drain_fmv_cold_tail()` (DB fn, `/api/admin/drain-fmv-cold-tail`) | `cold-tail-1.0*` | 4,504 | 2,099 | **No** |

`drain_fmv_cold_tail` picks up any edition whose latest snapshot is >7 days stale and, if it has *any* 30d sales, writes `fmv_usd = PERCENTILE_CONT(0.5)` over **all** of them — no dust floor, no outlier removal, no grail guard. So an edition the dust filter empties out of fmv-recalc falls silent, ages 7 days, and is then rescued by a writer that prices it honestly.

This is why a naïve platform-wide scan looks fine: dust-only editions show `published_fmv / own_median = 1.000`. **The published error is concentrated in the editions fmv-recalc still writes**, and is invisible unless you split by writer. It also means the system is already, accidentally, publishing raw-median prices for ~4,500 Top Shot editions — which is itself evidence that the $0.50 floor is not load-bearing.

Two side effects worth noting (neither is the subject of this document):
- The cold-tail rescue is **7+ days stale by construction**. Mean snapshot age for the dust-emptied Top Shot cohort is **73.6 hours** vs **41.7 hours** for the partially-cut cohort fmv-recalc still writes.
- `purge_fmv_snapshots_today()` deletes *all* of today's snapshots for the editions on a recalc page regardless of `algo_version`, then fmv-recalc re-inserts only the editions that survived the dust filter. A cold-tail row written earlier the same day for a dust-only edition is therefore deleted and not replaced. Code-inspection finding, not separately measured; it disappears entirely under the recommended fix, because fmv-recalc would price those editions itself.

### Correction (b) — the second-order haircut claim is directionally right but financially negligible

`fmv_apply_thin_sale_haircut` has a gate the brief omits: besides `sales_count_30d <= 2` and `confidence IN ('LOW','ASK_ONLY')`, it also requires `ABS(fmv_usd - floor_price_usd) < 0.01` — i.e. FMV must already equal the floor, which in practice means a one-sale edition.

Measured today: it fires on **424 Top Shot** and **267 All Day** editions that actually trade ≥3×/30d (Top Shot mean: **13.6** real sales/month). So the misfire is real. But the total dollars it removes from those misfires is **$57 (TS)** and **$70 (All Day)**, and — decisively — the median haircut edition is *still* published at **1.97× (TS)** / **2.83× (All Day)** its own realized median after the haircut. The haircut is a wrong-mechanism partial offset of the dust filter's inflation, not an additional error stacked on top. **Do not treat the haircut as a thing to fix; it is a symptom that disappears when counts become honest.**

### Correction (c) — the cited cohort reproduces, at slightly different magnitudes

Reproducing "≥5 real sales, ≤2 surviving, still written by fmv-recalc" against today's window:

| | editions | mean real sales/30d | mean count the engine recorded | median published FMV ÷ own 30d median |
|---|---|---|---|---|
| Top Shot | 483 | 13.5 | **2.30** | **2.11×** (mean 2.31×) |
| All Day | 225 | 9.7 | **1.52** | **3.24×** (mean 6.70×) |

Same phenomenon, same order of magnitude as the "16.7 real / 1.6 recorded, +44% to +134%" figures quoted. The window has rolled since that measurement; the cohort boundary is slightly different. Treat the numbers in this document as current.

---

## 2. Why does the filter exist?

### Origin

Commit **`e3aee286`** (2026-06-10, "fix(fmv): kill grail-spike + troll-ask poison"), implementing Item 1 of `docs/audits/fmv-badge-all-user-audit-2026-06-09.md`. The constant was introduced as step 1 of a four-step `dampenGrailSpike()` whose actual target was the **"$9,000 Serial #1 Jokić"** class — a single grail-serial sale owning the FMV of a circ-3,525 common once the 30d window thinned to two sales. Original comment, verbatim:

```
// Sales priced below this are dust — they distort medians on cheap editions and
// are excluded from every FMV computation here.
const DUST_PRICE_USD = 0.5
```

The dust drop is step 1 of 4; steps 2–4 (low-serial grail removal, >5×-median outlier removal, commonish thin-window safeguard) are the ones the commit message, the audit, and all 40 unit tests actually describe and exercise. **`0.5` was never derived from data.** There is no ledger entry, audit line, or test that justifies the magnitude; the number appears once, fully formed, inside a commit about high-side spikes. It was moved verbatim into `lib/` by `2b158a33` (behaviour-preserving extraction) and has not been touched since.

The one later doc that leans on it — `docs/archive/handoffs/handoff-2026-06-15-dense-low-fmv-findings.md` — treats the $0.50 drop as an established fact of the pipeline and uses it to explain why cheap dense editions score LOW. That analysis is internally consistent, but it inherits the constant rather than validating it.

### What is it actually protecting against? Nothing that survives inspection.

**(i) It is not defending against wash trading.** Zero self-trades (`buyer_address = seller_address`) exist in the 30-day window across Top Shot, All Day and Golazos. Sub-$0.50 Top Shot volume involves **1,094 distinct buyers and 883 distinct sellers**. The dedicated wash-trade filter (`route.ts:397–442`, 3+ sales in a 10-minute window) already handles clustering and is untouched by this decision.

**(ii) It is not defending against a separated dust mode.** The price histogram is continuous through the cut:

| Top Shot 30d | <$0.05 | 0.05–0.10 | 0.10–0.20 | 0.20–0.30 | 0.30–0.40 | 0.40–0.50 | **cut** | 0.50–0.75 | 0.75–1.00 | 1–2 |
|---|---|---|---|---|---|---|---|---|---|---|
| sales | 2 | 5 | 403 | **19,928** | **14,564** | 5,325 | ⟵ | 5,559 | 3,476 | 11,405 |

Seven Top Shot sales in 30 days fall below $0.10. The modal price is **$0.25 × 5,354 sales** — the Top Shot marketplace minimum — transacted between 235 distinct buyers and 260 distinct sellers. There is no gap at $0.50 to justify a cut there; the constant slices the single densest decile of the order book.

**(iii) All Day's cheap tape is concentrated but genuine.** 56 distinct buyers / 74 distinct sellers below $0.50; the top two buyers account for 7,930 of 13,193 (60%) — floor-sweeping bots — but they buy from a long tail of real sellers (largest seller = 2,230, 17%), and no self-trades. That is one-sided demand at a real clearing price, not fabricated volume. **The clearing price of most All Day editions genuinely is ~$0.20.**

**(iv) The downside protection it was assumed to provide already exists, twice.** `wapWithoutOutliers()` (`lib/fmv-recalc-math.ts:76`) already drops every sale below `0.2 × median` before the weighted average, and `dampenGrailSpike` steps 2–4 handle the high side. A lone $0.01 sale among $2 sales is already discarded by the relative filter and cannot set a price. This is confirmed empirically in §3: with the absolute floor removed entirely, the minimum published FMV is **$0.19** (Top Shot) and only **72 of 8,481** editions land below half their own realized median.

**(v) Removing it entirely moves prices DOWN, and toward reality.** Median simulated FMV ÷ own realized 30d median goes **1.139 → 1.026** (Top Shot) and **1.273 → 1.000** (All Day). The floor was not holding a floor up; it was holding a ceiling up.

---

## 3. Blast radius

### 3.1 Method and fidelity

The four options were simulated in SQL by replicating the production pricing path: 30-day window; 90-day widening when `raw30 < 5 OR typical-serial30 < 3` and the wider set is larger (the widen test reads the **pre-dust** count, matching `route.ts:588–602`); impossible-serial mis-key filter; `isPremiumSerial` typical-serial selection with the `TYPICAL_SERIAL_MIN = 3` fallback; `wapWithoutOutliers` (0.2×/5× median band, recency weights 3.0/2.0/1.0). ULTIMATE editions excluded (owned by `recalc_ultimate_fmv`). Not replicated: the wash-trade cluster filter, `dampenGrailSpike` steps 2–4, and the ask-corroboration confidence lift — all four apply identically to every option, so they cancel in the option-vs-option comparison.

**Fidelity check — simulated status quo vs the live published `1.7.0` snapshot:**

| | editions | median sim ÷ published | within ±10% | within ±25% |
|---|---|---|---|---|
| Top Shot | 3,294 | **1.000** | 2,888 (87.7%) | 3,133 (95.1%) |
| All Day | 471 | **1.000** | 422 (89.6%) | 458 (97.2%) |

Residual dispersion is the omitted wash/grail steps plus the few hours between the live snapshot and the simulation window. Good enough to trust the deltas.

**Benchmark for "accuracy":** each edition's own **unfiltered 30-day sales median**. Every sale, no floor, no outlier removal — the price the market actually cleared at. "Closer" means `|ln(FMV / own median)|` decreased.

### 3.2 Options

- **A — remove the floor entirely** (delete the filter).
- **B — relative floor:** drop sales below `0.2 × the edition's own 30d median`.
- **C — keep the floor for pricing, fix `sales_count_30d` to the pre-filter count.**
- **D — gated floor:** apply the $0.50 floor only when the edition's own median is ≥ $0.50.

### 3.3 Price outcome (editions traded in the last 30d)

**Top Shot — 8,482 editions**

| | status quo | A (remove) | B (relative 0.2×) | C (count fix only) | D (gated) |
|---|---|---|---|---|---|
| editions with **no** sales-derived price | **1,415** | 0 | 0 | 1,415 | 0 |
| median FMV ÷ own 30d median | **1.139** | **1.026** | 1.026 | 1.139 *(unchanged)* | 1.033 |
| p90 FMV ÷ own median | **2.768** | **1.434** | 1.434 | 2.768 *(unchanged)* | 1.453 |
| editions >2× own median | **1,191** | **185** | 185 | 1,191 | 241 |
| editions >5× own median | **210** | **7** | 7 | 210 | 12 |
| price changes | — | 2,175 (+1,415 newly priced) | 2,175 | **0** | 1,570 |
| **moves closer / further** | — | **1,843 / 332** (5.6:1) | 1,843 / 332 | 0 / 0 | **1,474 / 96** (15.4:1) |
| mean sales count used | 11.7 | **15.9** | 15.9 | 11.7 (label 15.9) | 14.8 |

**All Day — 2,954 editions**

| | status quo | A | B | C | D |
|---|---|---|---|---|---|
| editions with no sales-derived price | **969** | 0 | 0 | 969 | 0 |
| median FMV ÷ own 30d median | **1.273** | **1.000** | 1.000 | 1.273 | 1.000 |
| p90 FMV ÷ own median | **4.668** | **1.517** | 1.520 | 4.668 | 1.556 |
| editions >2× own median | **598** | **84** | 84 | 598 | 121 |
| editions >5× own median | **165** | **7** | 7 | 165 | 11 |
| price changes | — | 908 (+968 newly priced) | 908 | **0** | 653 |
| **moves closer / further** | — | **789 / 119** (6.6:1) | 789 / 119 | 0 / 0 | **617 / 36** (17.1:1) |
| mean sales count used | 4.7 | **8.5** | 8.5 | 4.7 (label 8.5) | 7.9 |

**Option B is empirically identical to Option A.** This is not a coincidence: `wapWithoutOutliers` already applies a `0.2 × median` floor at `lib/fmv-recalc-math.ts:76`. Adding B's relative floor upstream duplicates a filter that runs downstream regardless. B is A plus dead code.

**Option C changes no price at all.** It only relabels. That is its fatal flaw and it is discussed in §5.

### 3.4 Confidence tiers (simulated; ask-corroboration omitted, applies equally to both arms)

| | Top Shot SQ → A | All Day SQ → A |
|---|---|---|
| HIGH | 1,186 → **2,017** | 182 → **281** |
| MEDIUM | 2,472 → **3,575** | 509 → **1,214** |
| LOW | 3,410 → 2,890 | 1,295 → 1,459 |
| no sales-derived snapshot | 1,414 → **0** | 968 → **0** |
| **editions whose tier changes** | **2,888** | **1,473** |

LOW rises slightly on All Day because ~968 previously-unpriced editions enter the population, most of them thin. That is correct behaviour: an honest LOW beats no price.

### 3.5 Thin-sale haircut domain

Editions with `sales_count_30d ≤ 2` — the haircut's addressable set:

| | status quo | Option A | editions leaving the haircut's reach |
|---|---|---|---|
| Top Shot | 2,711 | **460** | 2,251 |
| All Day | 1,704 | **297** | 1,407 |

Options C and D also shrink this set (C by relabelling only, D partially). Under A the haircut is left exactly as it is and simply stops selecting actively-traded editions, because their counts become true.

### 3.6 The mark-to-market number

For the editions fmv-recalc still writes **and** the filter cuts, compare the last 30 days of realised transactions against the same moments valued at RPC's published FMV:

| | affected editions | sales | real GMV | valued at published FMV | **overstatement** |
|---|---|---|---|---|---|
| Top Shot | 1,491 | 37,939 | $22,395 | $30,598 | **+36.6%** |
| All Day | 532 | 4,493 | $2,069 | $4,905 | **+137.1%** |
| **combined** | **2,023** | **42,432** | **$24,464** | **$35,503** | **+45.1%** |

### 3.7 The dose-response — why attribution is airtight

Published FMV ÷ own raw 30d median, split by writer and by how much of the edition's market the filter removed:

| Collection | Writer | Filter impact | editions | median ratio | p90 | >2× own median |
|---|---|---|---|---|---|---|
| Top Shot | fmv-recalc `1.7.0` | untouched | 2,463 | **1.030** | 1.408 | 39 (1.6%) |
| Top Shot | fmv-recalc `1.7.0` | partially cut | 1,023 | **1.545** | 4.049 | 350 (34%) |
| Top Shot | fmv-recalc `1.7.0` | all sales dropped | 475 | **2.276** | 3.400 | 309 (65%) |
| Top Shot | cold-tail (raw median) | any | 4,508 | 1.000 / 0.850 | ≤1.08 | 7 |
| All Day | fmv-recalc `1.7.0` | untouched | 245 | **1.000** | 1.300 | 0 |
| All Day | fmv-recalc `1.7.0` | partially cut | 412 | **1.973** | 7.710 | 201 (49%) |
| All Day | fmv-recalc `1.7.0` | all sales dropped | 124 | **3.384** | 5.658 | 101 (81%) |
| All Day | cold-tail (raw median) | any | 2,098 | 1.000 / 0.850 | ≤1.03 | 10 |

The engine is accurate exactly where the filter does not bite (1.03× / 1.00×) and the error scales monotonically with how much of the edition's own market it removes. The cold-tail writer, which has no dust floor, is accurate everywhere. No other explanation fits this shape.

*(The 475 Top Shot / 124 All Day "all sales dropped" editions still carry a `1.7.0` snapshot because the 90-day widening pulled in older, pricier sales. Their published price is a >30-day-old $2 trade while the edition currently trades ~11×/month at $0.29 — the single worst failure mode in the system.)*

### 3.8 Worked examples (all Top Shot `1.7.0`-written, WNBA Base Set, COMMON)

| edition | player | real sales/30d | surviving | own median | published FMV | ratio | count RPC shows |
|---|---|---|---|---|---|---|---|
| `258:8910` | Sarah Ashlee Barker | 394 | 161 | $0.40 | $1.09 | **2.73×** | 63 |
| `258:8909` | Karlie Samuelson | 314 | 28 | $0.32 | $0.65 | 2.03× | 27 |
| `258:8904` | Kayla McBride | 302 | 26 | $0.29 | $0.66 | 2.28× | 22 |
| `258:8901` | Kelsey Plum | 297 | 35 | $0.35 | $0.77 | 2.20× | 24 |
| `258:8890` | Aneesah Morrow | 209 | 53 | $0.30 | $1.09 | **3.63×** | 51 |

A collector who sold 20 Kelsey Plums at $0.35 this month sees RPC quote $0.77 and a sales count of 24 against a real 297.

### 3.9 Other collections

| Collection | 30d sales | sub-$0.50 | verdict |
|---|---|---|---|
| **Disney Pinnacle** | 7,224 (`pinnacle_sales`) | **0** | **Out of scope on both counts.** Pinnacle is render-keyed in `pinnacle_fmv_history` via engine `pinnacle-2.0.0-render`, and `fmv-recalc` explicitly excludes it (`.neq("collection_id", PINNACLE_COLLECTION_ID)`, `route.ts:325` and `:622`). Even if it shared the path, the filter would be a no-op. |
| **LaLiga Golazos** | 131 | 87 (66.4%) | Affected, small. 89 traded editions: **37 currently get no sales-derived price → priced**; 10 change price, **10 closer / 0 further**. |
| **Candy MLB** | 3,426 | 4 (0.1%) | **No change** — 125 editions, 0 price changes. The $10-pack market never trades at these levels. |
| **UFC Strike** | **0** | — | No sales in 30 days. Market dead since 2026-05-13 (Aptos migration). Nothing to change. |

---

## 4. Risks

**R1 — Does a $0.01 wash trade set an edition's price? No.** `wapWithoutOutliers` retains the `0.2 × median` band. Measured under Option A: minimum published FMV is **$0.19** (Top Shot) and **$0.07** (All Day); **zero** Top Shot editions land below $0.10; only **72 of 8,481** Top Shot and **44 of 2,954** All Day editions fall below half their own realized median (p01 of FMV ÷ own median = 0.517 / 0.415). The low tail is bounded by an existing guard.

**R2 — 332 Top Shot and 119 All Day editions move *further* from their own median under A.** Real, and the honest counterweight to the 2,632 that improve. These are editions where the 90-day widening or the typical-serial selection interacts with the newly-included cheap tape. Option D reduces this to 96/36 but fixes 25% fewer editions overall. Neither option is monotone; A wins on total error reduction, D wins on regression count.

**R3 — Pack EV moves on roughly a third of distributions.** Median EV ratio is exactly **1.0000** for both collections, but the tails move:

| | distributions | affected | p10 EV ratio | p90 EV ratio | down >10% | up >10% |
|---|---|---|---|---|---|---|
| Top Shot | 1,291 | 1,070 | 0.766 | 1.196 | **250** | 233 |
| All Day | 3,117 | 1,309 | 0.794 | 1.078 | **479** | 248 |

Public pack-EV surfaces lead with Typical Pull median, so headline numbers barely move — but 250 Top Shot and 479 All Day distributions lose >10% of gross EV, and some verdicts will flip. The "up" cases are mostly currently-unpriced editions entering the pool at a real price (a strict gain). **This is the single largest visible knock-on and should be watched post-ship.** Any distribution whose EV verdict flips should be spot-checked against its pool's realized sales, not reverted reflexively — the new number is the more defensible one.

**R4 — ASK_ONLY population: unchanged.** `drain_fmv_cold_tail` writes `ASK_ONLY` only when an edition has **zero** 30d sales, a condition the dust floor does not affect. What does change is freshness: editions currently rescued at a mean snapshot age of 73.6h would be priced by fmv-recalc daily and stop being cold-tail candidates at all. Strictly better.

**R5 — All Day starts looking like a penny market, because it is one.** Under Option A, **1,025 of 2,954** All Day editions publish an FMV below $0.25 and 15 below $0.10. Today many of those show $0.50–$2.00. Nothing is wrong with the new numbers — they are what the moments trade for — but it is a visible change in how the collection presents. It is also the honest presentation, and CLAUDE.md's own standard (`dense-low-fmv-is-honest`) has already settled this class of question.

**R6 — Wallet valuations fall for holders of cheap commons.** Per-copy error is cents, but the affected editions are the highest-volume commons on the platform, so bulk holders will see portfolio totals drop. Direction is toward truth: the same moments transacted at $24,464 while RPC values them at $35,503.

**R7 — More sales enter every computation, raising fmv-recalc's cost.** Mean sales per edition rises 11.7 → 15.9 (Top Shot) and 4.7 → 8.5 (All Day) — roughly +40% to +80% rows through the in-memory math. All of them are *already fetched* by Step 1b (the SQL query has no price floor); the filter discards them after the round-trip. **Zero additional DB reads, zero additional IOPS** — the extra cost is CPU inside the Vercel lambda only. Relevant given the standing IOPS-saturation alert: this change does not touch it.

**R8 — The dispersion gate will now see the true price spread.** Cheap dense editions have genuinely wide dollar spreads; the `escalateConfidence` residual gate is designed to demote them, and it does — LOW rises on All Day (1,295 → 1,459). This is the gate working, not a regression. Do not "fix" it afterwards by loosening `MEDIUM_MAX_DISPERSION`; `handoff-2026-06-15-dense-low-fmv-findings.md` already tested and rejected that.

**R9 — Fixing the count without fixing the price is actively harmful.** Under Option C, 2,888 Top Shot editions would gain a higher confidence tier while their published price stays 1.139× (median) / 2.768× (p90) their own realized median. Today a wrong price at least carries a LOW badge. Option C would put a MEDIUM or HIGH badge on the same wrong number. **This is the strongest argument against shipping C alone**, and against the intuition that the count fix is the "safe half" of the change.

---

## 5. Recommendation

### Ship Option A — delete the dust filter. Do not ship B, C, or D.

**The number that decides it:** the filter's own dose-response. Where it removes nothing, published FMV is **1.03×** the edition's realized median. Where it removes some sales, **1.55×**. Where it removes all of them, **2.28×** (All Day: 1.00× / 1.97× / 3.38×). Nothing else in the pipeline produces that gradient, and the writer with no dust floor is accurate everywhere. Removing it moves **2,632 editions closer** to their own realized median against **451 further**, cuts editions published above 2× their own median from **1,789 to 269**, and gives a sales-derived daily price to **2,383 editions that currently have none**.

**Why not B:** empirically identical output to A (§3.3), because `wapWithoutOutliers` already applies a `0.2 × median` floor. B is A with a redundant filter to maintain.

**Why not C:** it changes zero prices and puts confident labels on prices that are still wrong (R9). Its only genuine benefit — taking 2,251 + 1,407 editions out of the haircut's reach — is delivered by A as a side effect.

**Why not D:** defensible and lower-variance (15:1 closer:further vs 5.6:1), but it only helps editions whose *entire* market is sub-$0.50. It leaves **241** Top Shot and **121** All Day editions above 2× their own median, against A's **185** and **84**, because it does nothing for the mixed-market case — a $2-median edition with half its trades at $0.30. It also keeps an arbitrary undocumented constant in the codebase, now with a second arbitrary constant (the gate threshold) beside it. Take D only if R2's 332 regressions are judged unacceptable relative to the 369 extra editions A fixes.

### Exact diff

**File `lib/fmv-recalc-math.ts`**

Line 8 — delete (no other reference exists outside this file and its test):
```ts
// BEFORE
export const DUST_PRICE_USD = 0.5

// AFTER — line removed
```

Lines 112–120 — `dampenGrailSpike`, drop step 1:
```ts
// BEFORE
export function dampenGrailSpike(
  sales: SerialSale[],
  opts: { isCommonish: boolean },
): { cleaned: SerialSale[]; capValue: number } {
  let cleaned = sales.filter(s => s.price >= DUST_PRICE_USD)
  if (cleaned.length <= 1) {

// AFTER
export function dampenGrailSpike(
  sales: SerialSale[],
  opts: { isCommonish: boolean },
): { cleaned: SerialSale[]; capValue: number } {
  // 2026-08-02: the absolute $0.50 dust floor was removed. It discarded 46% of
  // Top Shot and 76% of All Day transactions — the real bottom of both order
  // books, not noise (1,094 distinct TS buyers below $0.50 in 30d, zero
  // self-trades) — and inflated published FMV to 1.55x/2.28x the edition's own
  // realized median wherever it bit. The downside protection it was assumed to
  // give is already provided by wapWithoutOutliers' 0.2x-median band; the high
  // side is handled by steps 2-4 below.
  let cleaned = sales.slice()
  if (cleaned.length <= 1) {
```
Also update the step-numbering comment at lines 108–114 (the header block lists "1. Drop dust (< $0.50)" as step 1 of 4) so the remaining three steps renumber cleanly.

**File `__tests__/fmv-recalc-math.test.ts`** — the `DUST_PRICE_USD` import and any case asserting sub-$0.50 sales are dropped must be inverted to assert they are **retained** and that `wapWithoutOutliers` still rejects a sale below `0.2 × median`. Run `npx tsc --noEmit` before pushing (vitest does not typecheck).

**No change to `app/api/fmv-recalc/route.ts`.** Lines 807, 811, 849 and 850 already read `sales.length`; once the filter is gone that is the true count, so Option C's fix arrives for free.

**No change to `fmv_apply_thin_sale_haircut`.** It stops selecting actively-traded editions on its own.

### Applying it to existing rows

No migration. The change is code-only and self-healing:

1. Deploy. `fmv-recalc` pages 2,500 editions per run ordered by `MAX(sold_at) DESC`; ~11,400 traded editions across Top Shot + All Day + Golazos means a **full re-price in ~5 runs**. At the current cadence that is complete within hours.
2. Existing `*_haircut` rows are in-place `UPDATE`s on today's snapshot. Step 3's delete-then-insert replaces them on the next run that covers the edition — **self-clears within 24–48h**, no manual unwind.
3. Editions currently on `cold-tail-1.0` migrate to `1.7.0` naturally as fmv-recalc starts producing rows for them; snapshot age for that cohort should fall from ~73h to <24h. Use that as the confirmation signal.
4. `wmc` FMV denorm follows via the existing `wmc-fmv-populate` loop; no separate action.

### Verification after ship (24–48h)

- `SELECT count(*) FROM fmv_current f JOIN … WHERE f.algo_version LIKE '1.7.0%' AND f.fmv_usd > own_30d_median * 2` — should fall from **1,789 → ~269**.
- Mean `sales_count_30d` on Top Shot `1.7.0` rows: **11.7 → ~15.9**.
- Editions with no sales-derived price: **2,383 → ~0**.
- `v_rpc_trust_health` — watch `fmv_sanity_flags` and the per-collection freshness arms.
- Pack EV: spot-check 5 of the 250 Top Shot distributions whose EV drops >10%; the new figure should reconcile against the pool's realized sales.
- Sentry + `pipeline_runs` for `fmv-recalc`: the extra rows are CPU-only, but confirm no new timeouts on the largest pages.

### Revert path

`git revert <sha>`. No DB unwind — no migration is applied and no data is destroyed (`fmv_snapshots` history is append-only per day). FMV returns to current behaviour on the next `fmv-recalc` sweep, ~1 run per 2,500 editions.

### One thing this document does not settle

`drain_fmv_cold_tail` prices with a **plain median and no outlier, grail, or wash protection at all**. Today that is a virtue — it is the only reason dust-heavy editions carry honest prices. After this change it becomes a redundant second pricing philosophy sitting behind the first, and `purge_fmv_snapshots_today` can delete its output the same day it is written. Worth a separate look once the primary fix has soaked; out of scope here.
