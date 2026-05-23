# FMV Confidence — Diagnosis & Improvement Plan

**Date:** 2026-05-23
**Author:** Claude (Cowork session)
**Scope:** Why HIGH-confidence FMV sits at ~2% of editions, and a prioritized plan to lift it.
**Method:** Read-only queries against production Supabase `bxcqstmqfzmuolpuynti` (`fmv_snapshots`, `sales`, `editions`, `cached_listings_v2`) + the confidence logic in `lib/fmv-confidence.ts` and `app/api/fmv-recalc/route.ts`.

---

## 1. The number

FMV is what the Pro tier sells. Latest-snapshot confidence across **24,713 editions**:

| Confidence | Editions | Share |
|---|---:|---:|
| NO_DATA | 12,323 | 49.9% |
| LOW | 9,722 | 39.3% |
| SALES_ONLY | 1,404 | 5.7% |
| STALE | 504 | 2.0% |
| **HIGH** | **493** | **2.0%** |
| MEDIUM | 210 | 0.8% |
| ASK_ONLY | 56 | 0.2% |

HIGH + MEDIUM together is **2.8%**. For a product whose pitch is "real-time FMV across every Flow collection," this is the single most important number to move.

## 2. How a HIGH rating is earned

From `lib/fmv-confidence.ts` (the shared source of truth for `fmv-recalc` and `fmv-backfill`):

- **HIGH** = ≥ 7 sales in the 30-day window **AND** price dispersion (coefficient of variation = stddev ÷ mean) < **0.40**.
- **MEDIUM** = ≥ 5 sales, not HIGH.
- **LOW** = everything else with sales.

## 3. The funnel — where editions fall out

Measured against the live 30-day `sales` window:

| Stage | Editions | Note |
|---|---:|---|
| All editions | 24,713 | |
| Zero sales in 30d | 15,871 (64%) | Cannot be priced from sales at all |
| 1–4 sales | 6,205 | → LOW |
| 5–6 sales | 835 | → MEDIUM |
| **≥7 sales (HIGH-eligible by volume)** | **1,768** | |
| &nbsp;&nbsp;↳ pass the <40% dispersion gate | 904 | → HIGH-eligible |
| &nbsp;&nbsp;↳ **blocked by the dispersion gate** | **864** | stay MEDIUM |

So there are **two ceilings**, and they need different fixes.

### Ceiling A — liquidity (64% of editions never trade)

15,871 editions had zero sales in 30 days. No sales-based method can price them. Of those, **1,487 do have an open priced ask** in `cached_listings_v2` — but only 56 editions are currently labeled `ASK_ONLY`, so ~1,431 priceable-by-ask editions are sitting in `NO_DATA`. The remaining **14,384 are genuinely dark** (no sales, no asks).

### Ceiling B — the dispersion gate mismeasures serial spread

864 editions trade enough (≥7 sales) but fail the 40% dispersion gate. The critical finding:

> **835 of the 864 blocked editions (97%) fail because their sales span a wide serial range** (max serial number > 5× the min). Only 29 fail with a narrow serial span.

For serially-numbered NFTs this is expected structure, not noise: a `#1` serial and a `#25000` serial of the same moment legitimately trade 10×+ apart. The dispersion gate runs CV on **raw** prices, so it reads that legitimate serial-driven spread as "unreliable FMV" and caps the edition at MEDIUM. **The gate is penalizing structure it should be normalizing out.**

### A third, smaller gap — recalc lag

904 editions already satisfy ≥7 sales + CV<0.40 on raw prices, but only 493 are *labeled* HIGH. The ~411-edition gap is almost certainly recalc lag: `fmv-recalc` is paginated (500 editions/tick) and editions awaiting recompute sit as `STALE`. This is HIGH coverage we already earned but haven't written.

## 4. Improvement plan — by impact ÷ effort

### Lever 1 (headline) — serial-aware dispersion gate · ✅ IMPLEMENTED 2026-05-23

Two approaches were modelled against live production sales before building:

- **Global power-law normalization** — divide each sale price by a modelled serial multiplier (the `lib/market-compute.ts` power law) before measuring dispersion. Result: only **+132 net** HIGH, *and 189 demotions* — the global model mis-corrects editions whose real serial premium differs from the model. **Rejected.**
- **Per-edition regression (chosen)** — fit `ln(price) = a + b·ln(serial)` over each edition's *own* sales and gate HIGH on the residual spread. Self-calibrating, so it never mis-corrects: **+362 net** (1,261 editions pass vs 899 on raw prices) with only **21 demotions**.

Shipped: `serialResidualDispersion()` added to `lib/fmv-confidence.ts`; `escalateConfidence()` now takes an optional `serials` array and gates HIGH on the residual log-dispersion when serials are present, falling back to the raw coefficient of variation otherwise. Both call sites (`fmv-recalc`, `fmv-backfill`) updated to select and pass per-sale `serial_number`. The `HIGH_MAX_DISPERSION = 0.40` threshold is unchanged.

- **Impact:** HIGH-eligible editions ~899 → ~1,261. Labelled HIGH (493 today, lagged behind eligibility) climbs toward ~1,150–1,260 (**≈4.5–5%**) as the recalc cron cycles through.
- **Verified:** the algorithm was unit-tested against the SQL model on a real edition (8 sales, raw CV 0.62 → residual 0.35 → correctly promoted to HIGH); 9/9 cases pass, including the raw-CV fallback path.

### Lever 2 (root cause) — fix the recalc pagination · ✅ FIXED 2026-05-23

Investigation found something bigger than "lag". `fmv-recalc` paginates its sales scan by `{offset, limit}`, but the cron and the sales-indexer chains call it with **no offset — so every run reprocessed page 0**. It only ever recomputed ~41 editions (the lowest edition_ids). Of the 1,768 editions with ≥7 sales in 30 days, only **90** were actually owned by the current `1.7.0` algo; the rest were left labelled by whatever pipeline last touched them — **842 by `drain-fmv-cold-tail`** (which gives them 0 HIGH / 0 MEDIUM despite heavy trading) and **612 by the obsolete `1.1.0`** algo. This — not a STALE queue — is why labelled HIGH (493) lags the ~900 raw-eligible, and it means the Lever 1 serial-residual gate would otherwise never reach most editions.

Fixed: `fmv-recalc` now resumes the sweep from the previous run's `cursor_after` (already logged in `pipeline_runs`), wrapping to 0 at the end of the table; page size raised 500 → 1000. With ~28 triggers/day the route now sweeps all ~58k window sales — every edition — roughly every **2 days**, recomputing each under the current `1.7.0` algo + the serial-residual gate.

- **Impact:** ~1,450 well-traded editions migrate off `cold-tail` / `1.1.0` onto the current algo over ~2 days — this is what makes Lever 1's +362 actually land.
- **Effort:** Small — one route, no schema, no new cron.

### Lever 3 — ask-based pricing · investigated, closed as a non-issue

The plan assumed ~1,400 AllDay editions were unpriced (`NO_DATA`) and could be "rescued" with asks. Reading the `allday-fmv-populate` route and the `upsert_allday_marketplace_fmv` RPC on 2026-05-23 disproved the premise: **`allday-gql-v1` already consumes asks.** Per AllDay edition it reads AllDay's marketplace GraphQL and:

- writes `LOW` with a sale-backed FMV when AllDay reports an `averageSale`;
- writes `ASK_ONLY` (FMV = lowest ask, gated by a $5,000 ceiling) when there is only a `lowestPrice`;
- skips — leaving the edition `NO_DATA` via cold-tail — only when AllDay GQL reports neither.

So AllDay is already fully priced. Of 6,191 AllDay editions only **531 are genuinely `NO_DATA`**, and just **6 of those have an ask** in `cached_listings_v2`. The 3,776 `LOW`/`allday-gql-v1` editions are *priced* (via `averageSale`), not unpriced — the original "1,400 unpriced editions" figure was a misread of "0 sales in our 30-day window" as "no price".

**Net:** Lever 3 is **closed — no build needed.** The `drain_fmv_cold_tail` ask fallback shipped earlier (migration `audit_20260523_drain_cold_tail_ask_only_fallback`) stays as correct belt-and-braces, but its real surface is tiny (~6 AllDay editions plus any future stale no-data edition that has an ask).

The genuinely unpriced bulk is **~11,000 Top Shot `NO_DATA` editions**, which have no ask data in `cached_listings_v2` at all. Pricing that illiquid tail is Lever 4 territory (cohort / comparable-edition pricing) — a real, separate effort.

### Lever 4 (defer) — comparable-edition / cohort pricing

The 14,384 genuinely-dark editions can only be priced by inference — a cohort median over the same set / player / tier / series. Real project; defer until 1–3 land.

## 5. Recommended order & outcome

1. **Lever 2** — quick, no-risk, ~+400 HIGH.
2. **Lever 1** — the headline; HIGH to ~1,300–1,600.
3. **Lever 3** — closed: investigation showed `allday-gql-v1` already prices AllDay editions from asks + sale averages; no gap to fix.
4. **Lever 4** — later.

After Levers 1+2, HIGH-confidence FMV moves from **2.0% → roughly 4.5–5%** of editions — a ~2.3–2.5× improvement in the metric the Pro tier is sold on, with no new data sources required. Levers 1 and 2 are both shipped (2026-05-23); the gain materialises over ~2 days as the recalc sweep cycles through every edition.
