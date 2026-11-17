# Findings 2026-06-15 — "~249 dense TS editions stuck at LOW" — DECISION: labels are honest, gate unchanged

Investigation of [docs/handoff-2026-06-15-stuck-low-fmv-anomaly.md](handoff-2026-06-15-stuck-low-fmv-anomaly.md).
Read-only DB analysis; **no code shipped, no pricing-gate change.** Conclusion: the LOW labels are
correct. The handoff's premise (hot high-volume editions wrongly demoted) does not survive a
production-faithful look at the actual sales. Detail below so this doesn't get re-opened.

## Population (reproduced exactly)

249 canonical int-keyed TS editions, latest snapshot `confidence=LOW` AND `sales_count_30d >= 10`.
All 249 on algo `1.7`, all `computed_at` < 7d. 78 under $2, 175 under $5 (70%), 46 over $10,
median FMV $2.61, avg stored count 32.2. (Matches the handoff's decomposition.)

## What the handoff got wrong (the key correction)

The handoff flagged **Cade Cunningham "2026 NBA Playoffs"** as "tight yet LOW — fmv=$1.00=wap=
wap_without_outliers, zero dispersion, should be HIGH." That read the **smoothed summary fields**, not
the sales. The actual 30-day sales: **n=137, range $0.42 → $30.00, 8 sales above 5× median**,
serial-residual SD 0.51 (0.39 even on the outlier-stripped inner cluster). It is genuinely scattered.
`fmv = wap_without_outliers = $1.00` looks "tight" only because `wapWithoutOutliers` drops >5×/<0.2×-median
sales and recency-weights what's left — i.e. the FMV is *designed* to be robust to exactly the spread the
confidence gate is *designed* to penalize. Reading the smoothed FMV as evidence the sales are tight is the
trap. The gate is honest here.

**Teonni Key "WNBA Rookie Debut"** (handoff's "genuinely wide, correct to demote") confirmed: $1.75–$50,
resid 0.53. Correct LOW.

## Production-faithful replication (the decisive number)

The gate (`escalateConfidence`) does **not** see raw sales. By the time prices reach it, `dampenGrailSpike`
has already (1) dropped dust < $0.50 and (2) removed >5×-survivor-median outliers (step 3 fires on every
high-volume edition). A naive raw-sales SQL pass *looks* like 62 editions would lift if the gate were
"outlier-robust" — but that is a **dust artifact**: those editions have a ~$0.30 raw median, so half their
sales are sub-$0.50 dust that production already drops. They are not tight.

Replicating the dampener faithfully (drop <$0.50, drop >5×survivor-median, then serial-residual gate) over
the **99 editions still actively dense in the current window**:

| metric | value |
|---|---|
| scored (≥7 non-dust serial sales) | 99 |
| **honestly LOW** (residual ≥ 0.35 after cleaning) | **93 (94%)** |
| would lift to MEDIUM/HIGH | 6 |
| LOW *and* tight in dollars (p90/p10 ≤ 2.0) | **1** |
| avg cleaned-band spread p90/p10 | **5.6×** |
| avg residual SD | 0.49 |

After outlier removal the surviving sales still span ~5.6× from the 10th to 90th percentile. These are
cheap commons that genuinely trade in a wide band — **high volume ≠ tight price.** LOW confidence is the
honest label: you cannot publish one confident FMV for an arbitrary serial when the cleaned sales scatter
that widely.

The other ~150 of 249 are not "actively dense now" — their stored count was captured a few days ago when
the 30d window was fuller; the window has since rolled. That is benign aging, not a mislabel.

## Hypotheses, resolved

1. **Relative-dispersion over-penalizes cheap high-volume editions — REJECTED.** The cheap dense editions
   have genuinely wide dollar spreads (p90/p10 ≈ 5.6×) even after dust+outlier removal. They are not
   tight-in-dollars-but-penalized-in-log-space. An absolute-spread floor or volume override would
   **overstate** confidence on genuinely noisy editions — the exact thing the gate exists to prevent.
2. **`sales_count_30d` staleness / window artifact — BENIGN, no corruption.** The 14 editions with a dense
   stored count but ~0 live-30d sales (Trae Young 2:1 stored 68 / live-90d 70; Dylan Harper 223:7528;
   Dillon Brooks 2:129; etc.) all last traded ~2026-05-11–05-17 (`days_since_sale` ≈ 30) and `live_90d ≈
   stored_count`. The snapshot was computed while those sales were in-window; they are cooling editions
   aging out. The stored count was correct as of compute time. (Minor freshness gap: Step 1 only revisits
   editions with in-window sales and Step 6 only re-stamps HIGH/MEDIUM, so a cold LOW edition isn't
   actively aged to STALE until it trades again — low-value, not in scope.)
3. **Ask-corroboration not rescuing — WORKING AS DESIGNED.** The borderline (disp 0.23–0.35) editions each
   carry a live `edition_offers.low_ask` that sits **below** their sales median (Markkanen gmed $0.72 vs
   ask $0.43; Dillon Brooks $0.75 vs $0.33; Austin Reaves $0.75 vs $0.56). The ask is a floor and only
   corroborates when median is within ±25% — a lowball floor correctly does not lift confidence.

## Decision

**Do not change `lib/fmv-confidence.ts` or the fmv-recalc gate.** TS edition FMV is honestly dialed; this
"anomaly" is the gate doing its job. Only ~1 of 99 actively-dense editions is tight-but-LOW and ~6 sit near
the boundary — far too small (and too close to the genuinely-wide cohort) to justify loosening a gate that
would, in exchange, overstate confidence on noisy editions. No LiveToken validation pass is warranted
because there is no proposed pricing change to validate.

### If the perceived-trust cost is still a concern (product, not pricing)

The real issue is presentation: a collector who watches a moment trade 100×/week reads "LOW confidence" as
RPC being wrong, when it actually means "trades often but at scattered prices." A **UI** change — surface
the cleaned price *range* next to a high-volume LOW badge (e.g. "LOW · trades $0.50–$3.00, n=137") — would
make the label self-explanatory without touching the gate. That's a separate, non-pricing product call.

### Method note for any re-investigation

Replicate the dampener before judging the gate: drop `< $0.50` dust and `> 5× survivor-median` outliers
first, then score serial-residual SD = `sqrt(var_pop(ln price) × (1 − regr_r2(ln price, ln serial)))`.
Scoring raw sales (with dust included) inflates apparent dispersion AND inflates the apparent lift from a
"robust" gate — both artifacts of the same un-dropped dust.
