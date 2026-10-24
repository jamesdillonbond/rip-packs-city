# FMV pricing — feature roadmap (refreshed 2026-10-17, PT)
> Dated snapshot; re-derive any number before quoting. Canonical plan: [roadmap-2026-10-17.md](../roadmap-2026-10-17.md). Per-collection detail: [collections/](../collections/). Defects: [known-issues.md](../../reference/known-issues.md).

## What it is today

FMV is the product's core claim and the accuracy gate's subject. One engine per data model:
- **Flow sales-priced collections** (Top Shot, All Day, Golazos, UFC, Candy): `app/api/fmv-recalc/route.ts` → `fmv_snapshots` (delete-then-insert, never upsert), model **1.8.1**: the median of the edition's 7 most recent typical sales, dropping any print more than 30 d older than the newest and keeping at least 3 (1.8.0 shipped 10-03, 1.8.1 on 10-10). It reads the `sales_market` view (buy-backs excluded, #169). Confidence is HIGH / MEDIUM / LOW / ASK_ONLY / STALE / NO_DATA, with a 0.35 dispersion gate.
- **Disney Pinnacle**: render grain, `pinnacle_catalog.fmv_confidence` (recency-weighted median since #155).
- **Panini**: engine `panini-1.3.0` (10-15). Prices are unchanged from 1.2.0; confidence is re-graded by how closely the last ≤3 sales agree.
- **Read path**: `edition_fmv_current` (denormalised; R107/R126 keep it in sync with haircut writes) plus the display and thin-FMV guards.

**Headline metric M1/M2.** HIGH/MED share from `rpc_trust_health_precompute`. Read the series in `rpc_trust_health_history`, never a single leg. Weekly means of the six-hourly legs (weeks start Monday; wk 10-19 = 16 legs to 10-22 ~6:50 PM PT), read 10-22 ~9:30 PM PT:

| week | Top Shot (M1, bar 50) | All Day (M2, bar 30) | Candy | Pinnacle* | Panini* | Golazos | UFC |
|---|---|---|---|---|---|---|---|
| 10-05 | 57.1 | 27.2 | 23.0 | 31.5 | — | 1.0 | 0.0 |
| 10-12 | 54.8 | 26.7 | 56.0 | 32.8 | 29.0 | 1.0 | 0.0 |
| **10-19 (partial)** | **44.5** (44.0–44.7) | **27.3** (27.0–27.6) | 54.1 | 33.4 | 42.4 | 0.1 | 0.0 |

\* Pinnacle and Panini come from different tables and grains. Never average them into an estate figure. **M1 reads BELOW its bar for the first time since 09-21 — by the 10-17 decision, not by a pricing regression:** 1.8.2 (`gateMediumToRecentSale`) made MEDIUM need a usable sale in 30 days, and the decision record priced that at "M1 reads ~44 % until more editions trade" (below). The 10-19 week landed at 44.5 with a 0.7-point spread, i.e. the predicted level, not a drift. The out-of-sample accuracy (next paragraph) is the gate's other half and did not move. M2 has had 0 legs at the bar since the week of 09-28 except the 10-18 12:48 AM leg (30.8, the corroboration fix). Golazos's 0.1 is its newest sale (10-01) leaving the window.

**Out-of-sample accuracy** (`fmv_sales_backtest` / `topshot_fmv_backtest`, R125): Top Shot 7 d, published median absolute error 14.3 % at ratio 1.000; HIGH 9.5 % (10-17 afternoon pass). R125 closed 10-17 on a PAIRED read: published matches or beats a naive last-3 median on TS HIGH/MED and AD MED/LOW. **Re-read 10-22 ~9:40 PM PT (7 d):** Top Shot published 16.0 % MdAPE, within ±25 % 65.1, **ratio 0.952** (naive last-3: 15.0 / 66.8 / 1.000; HIGH level at 10.0 / 81.4 vs 10.0 / 81.9; MEDIUM 18.2 / 61.5 vs 16.7 / 62.9 — 1.4 points, inside the 3-point reopen rule). The ratio sitting ~5 % under 1.0 is new this week — and splitting it by PT day (~10:50 PM PT) places it: **10-19 and 10-20 only** (MEDIUM published 0.880 / 0.833, naive last-3 0.958 / 0.920 — BOTH estimators ran under a two-day price jump at Series 2026-27 tip-off; HIGH 0.959 / 0.897 vs 1.000 / 0.917), while 10-16 → 10-18 and 10-21 → 10-22 read 1.000 on both. A two-day market move, not a model drift; the published/naive ratio never left 0.96–1.00. Nothing to act on; the weekly read continues. All Day published HIGH 7.1 / 84.5 (beats naive 12.5 / 70.8), MEDIUM 20.0 / 59.7 (level), LOW 25.9 / 49.5 vs 23.1 / 51.9; **ASK_ONLY 170 % / 8.6 / ratio 2.70 (n 105)** → shipped as the cap in the 10-22 bullet below (#208).

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
- **10-22 (#208, Cowork cloud, `20261023044923`):** an **All Day ASK_ONLY** price is capped at the median of the edition's last 3 market sales within 180 days, by a BEFORE INSERT guard on `fmv_snapshots` that covers all three writers of that price (fmv-recalc 1.8.x, `drain_fmv_cold_tail`, `allday-listing-ask-v1`). Why: the ask × 0.90 price backtested at ratio 1.80 over 30 d (n 326; offer fills 2.70) and `min(ask price, last-3 median)` at 1.00 / within25 34.4 / WAPE 61.6 — the "do 31–180-day sales predict today's price" backtest the 10-18 note asked for. Scope is All Day only by measurement (Top Shot's ASK_ONLY reads 0.97; the cap would not help it). 682 current rows re-stamped in place (backup table). Exit ~10-30: the 7-day ASK_ONLY row near ratio 1.0, within ±25 % ≥ 30 %.

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
  - ~~Golazos's last sale was 10-01.~~ **10-23: Golazos woke on 10-20/21 (87 sales in two days); its ASK_ONLY tier read All Day's pre-cap shape (1.80 / 20.0 / MdAPE 80, n 70) and #208's cap now covers it (`20261023134231`).** UFC is closed.
  - Confidence on those must decay honestly. Candy's 56.8 % is a relabel from `a56214193` (10-11; the lifted cohort was backtested at 19.2 % before ship), not a failed read. But no sale has scored it since, and it should fall from ~11-10 as pre-freeze sales leave the 30 d window ([candy-mlb.md](../collections/candy-mlb.md)).
- **#208 residue (10-22):** 591 All Day ASK_ONLY editions have no sale in 180 d, so the ask × 0.90 is still their only input (70 of the 326 backtest sales); pricing them between a bid and the ask needs an All Day bid book RPC does not index. Side finding (wording corrected the same night): `fmv_apply_thin_sale_haircut` reaches only rows written AT the floor (`fmv ≈ floor`): LOW rows capped at the ask and the `ultimate-v1` / `ask_only_v2` ASK_ONLY writers — alive, $7,964 removed across 18 rows on 10-22. The × 0.90 ASK_ONLY writers (1.8.x, cold tail, `allday-listing-ask-v1`) sit outside it by construction, so those rows carry a flat 10 % off the ask with no listing-depth term. Measure before deciding whether the depth term should reach them too (it would stack with the new cap).
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
1. ✅ **VERIFIED 2026-10-20 ~6:45 PM PT (Claude Code cloud).** `v_fmv_sweep_wedge`: 0.04 h since the last cursor advance, **150 advances in 24 h** (falsifier 1: > 3 h — not hit). The only `step1b_refetch_empty` row in 7 days (10-18 1:08 AM PT, after the fix) logged `sales_fetch_errors 0`, `cursor_held false`, `cursor_wrapped true`, `cursor_after` NULL — an empty page with no fetch error WRAPPED instead of holding (falsifier 2: not hit). ⚠ That path is rare (1 row/week), so falsifier 2 has a sample of one; `v_fmv_sweep_wedge` is the instrument that watches continuously. (original item) **Verify the 10-17 sweep-wedge fix on production rows.** Why: a wedged sweep silently stops repricing while every run reads ok. Falsifier: `fmv_sweep_wedge_hours` stays above 3 after one full cycle, or a step1b row logs `cursor_held=true` with 0 fetch errors.
2. **Re-measure Panini 1.3.0 label monotonicity** in `panini_published_fmv_backtest` (algo `panini-1.3.0`, gated on `first_seen_at`) once ~4 days of re-walks have landed. Why: the shipped claim was a projection (~72/63/~35 % within ±25 %). Falsifier: HIGH is not the best tier, or MEDIUM falls below LOW.
3. **Confirm the frozen-market share decays.** Check that Candy's 56.8 % falls toward LOW/STALE as its sales age out (expected from ~11-10), and backtest the 90-day-only MEDIUM path (Golazos's 6 MEDIUM editions have 0 sales in 30 d; re-derived 10-17 as the 08-07 design, Step 2a-quater/quinquies, not a defect). Why: a label that outlives its sales becomes a claim nothing backs. Gate: sale ingest resumes, or the decay is seen.

**Next**
4. **Run the R125 paired backtest weekly** for TS and AD, and add Candy (14 d). Why: the share (M1) cannot see price error, and this backtest can. Falsifier: the reopen rule above.
   - ↳ **Read 10-18 ~12:58 PM PT (`fmv_sales_backtest(…, 7)`; within ±25 %, published vs last-3):** TS HIGH 84.2 vs 82.4 · MEDIUM 60.8 vs 62.4 (−1.6) · LOW 57.6 vs 57.9 · ALL 65.0 vs 66.1. AD HIGH 73.2 vs 74.5 (−1.3) · MEDIUM 56.8 vs 54.0 · LOW 48.8 vs 48.5. **No reopen** (largest gap 1.6 < 3). ⚠ The two estimators score slightly different sale sets (published n is larger), so this is near-paired, not strictly paired. Candy: no sales since 10-11, nothing to score. ASK_ONLY stays the worst bucket (TS ratio 1.283, AD 1.800). Next read ~10-24.
   - ↳ **Candy added 10-19 ~8:25 PM PT (`fmv_sales_backtest('candy_mlb', 14)`, n 516, nearly all before the 10-11 8:21 PM PT freeze; within ±25 % / MdAPE, published vs last-3):** ALL **54.8 vs 48.6** · 22.2 % vs 26.1 % · LOW (n 456) 53.7 vs 46.7 · MEDIUM (n 60) 63.3 vs 63.3 · HIGH none scored. Published beats the naive baseline by 6 pts. ⚠ The labels scored are the ones in force at each sale, so this does **not** score the 10-11 relabel (Candy roadmap item 2 still waits on new sales). The window drains with the freeze: by ~10-25 a 14-day read holds almost nothing.
5. ✅ **MEASURED 2026-10-18 ~9:22 AM PT (Claude Code cloud; paired, out of sample; 14 d n 2,472 + prior 14 d n 3,347; harness reproduces `fmv_sales_backtest` LOW within 0.1 pt): no variant clears the 3-pt bar.** A shorter N gains +1.8–2.3 pts within ±25 % on LOW over an N=7 replica (consistent sign in every liquidity bucket, SE ~0.8 pt); against the real published value (with its typical-serial filter, dampener and ceiling) N=3 gains only +0.5. A global N=3 would cost HIGH ~1 pt. About half the 10-17 "2.3-pt gap" is the last-3 baseline seeing sales NEWER than the snapshot (anchored at the snapshot: 1.8). The ask-cap variant is untestable: no Top Shot ask history (`edition_offers.low_ask` is overwritten in place). ⭐ LOW is not mostly thin: 65 % of LOW sales are ~140 liquid sub-$1 editions demoted by the dispersion rule. **Next lever to test is the dispersion-LOW class, not N**; re-run after 7 d of 1.8.3 LOW snapshots.
   - ↳ **The dispersion-LOW split was run 10-23 ~4:45 PM PT (Cowork cloud) and the worst cell was not dispersion at all: `_haircut` rows with 0 sales in 30 d (n 104 of the 7-day LOW read) at ratio 0.441 / 5.8 % within ±25 %.** The haircut’s depth term had no input (`listing_count` NULL on every haircut row), so every 0-sale edition took the 0.55 “unknown” cut. Re-priced at each multiplier over two 30-day halves, 0.75 beat 0.55 on both metrics in both (days 0–30 n 123: 11.4 → 30.9 % within ±25, WAPE 54 → 39; days 30–60 n 15: 33 → 60 %, 39 → 22). **Shipped as a Top-Shot-LOW-only arm (`20261023235545`), 497 rows re-stamped; #210.** The 0.85 band is a wash and stays; TS ASK_ONLY and All Day LOW were not clearly better at any other multiplier. Exit: the TS LOW `median_ratio` (0.892 on 10-23) moves toward ≥ 0.93 by the 10-30 read.
   - (original item) **TS LOW residual.** Test whether a shorter N, or an ask-informed cap, closes the 2.3-point gap without hurting HIGH/MED. Gate: out-of-sample, paired, before shipping. 1.8.0's choice of N was settled by measurement.

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
