# FMV pricing — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

FMV is the product's core claim and the accuracy gate's subject. One engine per data model:
- **Flow sales-priced collections** (Top Shot, All Day, Golazos, UFC, Candy): `app/api/fmv-recalc/route.ts` → `fmv_snapshots` (delete-then-insert, never upsert), model **1.8.1**: the median of the edition's 7 most recent typical sales, dropping any print more than 30 d older than the newest and keeping at least 3 (1.8.0 shipped 10-03, 1.8.1 on 10-10). It reads the `sales_market` view (buy-backs excluded, #169). Confidence is HIGH / MEDIUM / LOW / ASK_ONLY / STALE / NO_DATA, with a 0.35 dispersion gate.
- **Disney Pinnacle**: render grain, `pinnacle_catalog.fmv_confidence` (recency-weighted median since #155).
- **Panini**: engine `panini-1.3.0` (10-15). Prices are unchanged from 1.2.0; confidence is re-graded by how closely the last ≤3 sales agree.
- **Read path**: `edition_fmv_current` (denormalised; R107/R126 keep it in sync with haircut writes) plus the display and thin-FMV guards.

**Headline metric M1/M2.** HIGH/MED share from `rpc_trust_health_precompute`. Read the series in `rpc_trust_health_history`, never a single leg. Live 10-17 ~12:48 PM PT:

| Top Shot (M1, bar 50) | All Day (M2, bar 30) | Candy | Pinnacle* | Panini* | Golazos | UFC |
|---|---|---|---|---|---|---|
| **55.2** | **26.4** | 56.8 | 33.9 | 32.0 | 1.0 | 0.0 |

\* Pinnacle and Panini come from different tables and grains. Never average them into an estate figure. M1 has been met on every leg since 09-21. M2 has had 0 legs at the bar since the week of 09-28.

**Out-of-sample accuracy** (`fmv_sales_backtest` / `topshot_fmv_backtest`, R125): Top Shot 7 d, published median absolute error 14.3 % at ratio 1.000; HIGH 9.5 % (10-17 afternoon pass). R125 closed 10-17 on a PAIRED read: published matches or beats a naive last-3 median on TS HIGH/MED and AD MED/LOW.

## Shipped recently (since mid-September)

- **09-25 #140:** cold-population writers keep only sales within 90 d of the edition's newest sale.
- **09-27 #155:** Pinnacle render FMV switched to a recency-weighted median.
- **09-30:** Panini `panini-1.2.0` (LOW priced from the last ≤3 sales) and `panini_published_fmv_backtest`.
- **10-02 R107:** `edition_fmv_current` sees corrected FMV within the hour.
- **10-03:**
  - Backtests built (R125).
  - Model 1.8.0, after a measurement showed the old WAP was tiered 3/2/1 and was never a "7-day half-life".
  - #169 `sales_market` view.
  - R103: ask age is read from `low_ask_confirmed_at`.
- **10-09:** backtests read `sales_market`. Pinnacle young renders cannot read HIGH in drop week.
- **10-10:**
  - Model 1.8.1.
  - #177: the sweep pages a snapshot of its own order, with tie-break.
  - #18: `/api/fmv` serials use the fitted model and the real print run.
  - The buy-back-only page skip was fixed.
  - All Day's dispersion gate was kept (decision below).
- **10-11:** Candy's confirmed ask corroborates confidence, not only caps it. Candy LOW fell from 91 to the 84/41 re-grade.
- **10-14:**
  - Panini share gets an owner (`rpc_thp_leg_panini_fmv_share`; first value 23.7).
  - The accuracy table is public at `/legal/fmv-methodology#accuracy`.
  - The concierge stopped reciting the retired 1.7.0 model.
  - The homepage's hardcoded "$148.00" preview was removed.
- **10-15:** `panini-1.3.0`, and the R126 trigger (haircut writes bump `updated_at`).
- **10-17:**
  - The sweep cursor advances past a genuinely-empty page. This fixes the `fmv_sweep_wedge_hours` breach of 4.53 h: every run logged `ok` while wedged.
  - The thin-FMV and display guards compute before they TRUNCATE, which ends the `[edition] insight_links` statement timeouts.

## Open issues

- **#193 (new 10-17): Pinnacle HIGH trails a naive last-5 median** in the first realised-sales read of Pinnacle FMV (since 10-11: within ±25 % 68.1 vs 74.2; 45 d: 53.9 vs 69.8), and MEDIUM beats HIGH. Cause: a 90-day recency-weighted median that lags falling liquid renders. Fix gated on ≥ 500 post-10-09 HIGH sales ([disney-pinnacle.md](../collections/disney-pinnacle.md)).
- **M2 is not met.** All Day's LOW population is mostly a volume floor: of 1,661 LOW editions sized on 10-10, 1,307 had 1–4 sales in 30 d. Only the 269 dispersion-gated editions are code-shaped, and that gate stays by decision.
- **R125 residuals:**
  - TS LOW is 23.7 % vs 21.4 % for last-3.
  - AD HIGH is 13.3 % vs 9.5 %, but that is $0.02, under one tick.
  - Reopen if a paired within-±25 % share falls more than 3 points below last-3 two weeks running.
- **Panini labels.**
  - Under 1.2.0 they were not monotone: HIGH worst at $100+.
  - 1.3.0 should fix that, but it has not been re-measured since it ran.
  - Sales land a median ~53 h late (an ingest latency, not an estimator problem). Any Panini backtest must gate on `first_seen_at`.
- **Frozen markets.**
  - Candy's last indexed sale was 10-11 8:21 PM PT: Magic Eden silent, OpenSea unkeyed (#58).
  - Golazos's last sale was 10-01. UFC is closed.
  - Confidence on those must decay honestly. Candy's 56.8 % is a relabel from `a56214193` (10-11; the lifted cohort was backtested at 19.2 % before ship), not a failed read. But no sale has scored it since, and it should fall from ~11-10 as pre-freeze sales leave the 30 d window ([candy-mlb.md](../collections/candy-mlb.md)).
- **#174:** `/api/fmv-backfill` still stamps `1.5.0` with the old formula. Decided no change, but it is a second writer of one column.
- **`fmv-recalc` cost:** "wasteful, not broken" (roadmap-status 09-04 sizing). Re-derive per-call blocks before any lever.

## Next — prioritized

**Now**
- ✅ **DECIDED 10-17 ~9:35 PM PT (Trevor delegated: "decide the rest of this yourself"): yes — option (b), shipped as 1.8.2 (`gateMediumToRecentSale`).** Reason: the same ±25 %-within-3-points tolerance used tonight to PROMOTE ask-corroborated All Day editions rejects this set (Top Shot 5.7 pts short, All Day 15.3); applying the backtest only when it flatters the metric would be dishonest. Cost accepted: M1 reads ~44 % until more editions trade. Watch: M1/M2 on the 10-18 legs; revert = `git revert` the 1.8.2 commit.
- (original question) **Should MEDIUM require a sale in the last 30 days?** Measured 10-17 ~9:30 PM PT (published FMV vs the next realised sale, ≥ 1 day after the snapshot, serial > 25; split on the snapshot's `sales_count_30d = 0`, i.e. the 08-07 90-day-widening path):
  - **Top Shot, 14 d:** 90-day-only MEDIUM 20.0 % median error / 59.0 % within ±25 % / ratio 1.000 (n 483) · 30-day MEDIUM 14.0 / 64.7 / 1.000 (n 18,854) · 30-day LOW 25.0 / 53.3 (n 2,553). Halfway between MEDIUM and LOW; 5.7 pts below MEDIUM on within ±25 % (the R125 tolerance is 3).
  - **All Day, 21 d:** 90-day-only MEDIUM 33.5 / 41.4 / 1.045 (n 145) · 30-day MEDIUM 20.0 / 56.7 (n 6,956) · HIGH 13.8 / 72.7. No better than All Day LOW (38.0 / 37.6, 14 d).
  - **Cost of demoting them to LOW** (latest snapshot, the M1/M2 instrument's population): Top Shot 55.0 % → **44.4 %** (1,539 editions; fails M1 ≥ 50), All Day 28.3 % → 24.6 % (227), Golazos 1.0 % → 0.0 (6). Panini excluded (its engine fills `sales_count_30d` differently; 8,254 of 8,473 MEDIUM read 0).
  - Options: (a) keep the 08-07 rule (the label overstates on ~1.8 k editions); (b) demote 90-day-only to LOW (honest, costs M1); (c) a middle tier or a visible "last sale N days ago" qualifier on 90-day-only MEDIUM. Not changed — estate-wide and Trevor's rule.
1. **Verify the 10-17 sweep-wedge fix on production rows.** Why: a wedged sweep silently stops repricing while every run reads ok. Falsifier: `fmv_sweep_wedge_hours` stays above 3 after one full cycle, or a step1b row logs `cursor_held=true` with 0 fetch errors.
2. **Re-measure Panini 1.3.0 label monotonicity** in `panini_published_fmv_backtest` (algo `panini-1.3.0`, gated on `first_seen_at`) once ~4 days of re-walks have landed. Why: the shipped claim was a projection (~72/63/~35 % within ±25 %). Falsifier: HIGH is not the best tier, or MEDIUM falls below LOW.
3. **Confirm the frozen-market share decays.** Check that Candy's 56.8 % falls toward LOW/STALE as its sales age out (expected from ~11-10), and backtest the 90-day-only MEDIUM path (Golazos's 6 MEDIUM editions have 0 sales in 30 d; re-derived 10-17 as the 08-07 design, Step 2a-quater/quinquies, not a defect). Why: a label that outlives its sales becomes a claim nothing backs. Gate: sale ingest resumes, or the decay is seen.

**Next**
4. **Run the R125 paired backtest weekly** for TS and AD, and add Candy (14 d). Why: the share (M1) cannot see price error, and this backtest can. Falsifier: the reopen rule above.
5. **TS LOW residual.** Test whether a shorter N, or an ask-informed cap, closes the 2.3-point gap without hurting HIGH/MED. Gate: out-of-sample, paired, before shipping. 1.8.0's choice of N was settled by measurement.

**Later**
6. **Dual-scale valuation** (roadmap §6.1) stays behind the gate.
7. **Per-edition "sales disagree" pill**, deferred 09-25. Revisit when the analytics area has weekly signed-in users. The writer must record the reason; no stored field recovers it.

## Decisions on record (do not re-litigate)

- **Gate denominator** (08-28): Top Shot ALL ROWS, not canonical-only.
- **Pinnacle and Panini shares** are never folded into an estate average.
- **All Day dispersion gate stays** (10-10). M2 is met by accuracy or by more sales, not by relabelling. Q3 drift was ACCEPTED (09-25).
- **UFC 0.0 % is the honest label** of a closed market. Do not loosen Candy's gate to lift its share (10-10).
- **Panini:**
  - Keep serials as the HIGH/MED input (09-30).
  - The ASK_ONLY multiplier is unchanged (10-15).
  - The ASK_ONLY cap was decided against on a backtest (10-10).
  - The ingest-latency fix is infra spend: held.
- **No public per-edition confidence chips** (`invariants-no-confidence-chips`).
- **Measure the published value, not a candidate estimator.** A refresh-order change moves a share by composition alone (Panini 09-20). Split the repeat and newly-reached cohorts before attributing a change to pricing.

## Where the detail lives

- Current metric blocks: [roadmap-status.md](../../reference/roadmap-status.md) ("HEADLINE METRIC", 10-10; "TOP SHOT FMV MEASURED OUT OF SAMPLE", 10-03; Panini 09-20/10-14).
- R-register: [deep-audit-register.md](../../audits/deep-audit-register.md) (R103, R107, R125, R126).
- Enums and confidence vocabularies: [database.md](../../reference/database.md). Grain: [schema-truth.md](../../reference/schema-truth.md).
- Honesty helpers: [key-files-and-honesty.md](../../reference/key-files-and-honesty.md).
- Code: `app/api/fmv-recalc/route.ts`, `lib/fmv-recalc-math.ts`, `lib/fmv-confidence.ts`. Public rule: `/legal/fmv-methodology`.
