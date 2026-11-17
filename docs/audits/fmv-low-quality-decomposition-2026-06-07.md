# TS FMV quality decomposition — where the LOW tier can honestly move (2026-06-07)

Read-only analysis (Cowork). Context: TS FMV coverage is complete (9,135/9,135 canonical labeled; NO_DATA tail proven unpriceable — see ts-nodata troll-asks note in the 06-07 handoff). The remaining lever is QUALITY: LOW → MEDIUM/HIGH. This decomposes the 4,840 LOW editions and identifies the two honest movers. No changes shipped — both movers touch FMV inputs/logic and are review-gated.

## Decomposition of latest-LOW canonical TS editions (4,840)

- 221 meet HIGH's volume+recency bar (sales_count_30d >= 5 AND days_since_sale <= 14) but sit LOW → bound ONLY by the dispersion gate (serial-residual / CV in lib/fmv-confidence.ts).
- 708 meet >=3 sales/30d + <=30d recency (MEDIUM-or-better volume) → dispersion gate is the binder for ~15% of LOW.
- 3,635 have 1-2 sales/30d → honestly thin; they move only as sales accumulate. Structural, no action.
- 497 have zero 30d sales (older 30-60d sales keep them off STALE) → working as designed.

## Mover 1 — dispersion-gate review (potential +200-700 MED/HIGH, code-side, review-gated)

SAMPLE ANALYSIS DONE (2026-06-07, top-25 by volume — eliminates two hypotheses, confirms the third):
- All on the main writer: 220/221 latest snapshots are algo `1.7.0` (1 on 1.5.0) — the gate IS running; this is not a writer-path bypass.
- Serials reach the gate: 0 of the cohort's 10,749 last-30d sales have NULL serial_number — the OLS is not falling back to raw CV for lack of data.
- The structure is real and SPIKY, not noisy: ln(price)~ln(serial) corr is -0.52..-0.82 on almost every edition, with chase-serial blowouts (Wemby 2026 Playoffs common: $2 floor → $527 top across 184 sales, CV 4.03; Stephon Castle fandom: $1.50 → $248). A single log-linear term can't absorb serial #1/jersey-match spikes, so a handful of chase sales blow the residual past the HIGH/MED threshold even though the MEDIAN copy is tightly priced.

**IMPACT SIMULATION (2026-06-08 ~01:00Z — read this before scoping the session; it TEMPERS the expected win):** simulated both fix variants on the live cohort (214 editions, drifted from 221):
- Serial-band trim (drop serials <= max(10, 1% of circ)) then CV: only **22** pass the HIGH bar (<0.40), **63** land in a 0.40-0.80 MED band, **124 (58%) remain genuinely dispersed** even in the trimmed core, 5 lose their sample. Avg CV only improves 1.29 → 1.05 — the spread is NOT concentrated in the chase-serial band.
- Robust IQR/median on untrimmed sales: **39** tight (<0.35), 96 under 0.60, 66 above 1.0, avg ratio 1.41 — same story.
CONCLUSION: the honest ceiling from this cohort is ~40-95 promotions (threshold-dependent), NOT "a few hundred" as first framed — the majority of these editions are CORRECTLY labeled LOW (their core market genuinely trades at wide spreads). The session's real decision is whether ~22-39 honest HIGH promotions + ~60 MED promotions justify touching lib/fmv-confidence.ts at all, or whether LOW-with-real-spread is the right answer and this lever closes as working-as-intended. Either outcome is fine; do not force the change to hit a number.

Honest improvement to evaluate (NOT a threshold loosen): edition-level FMV already prices the median copy (outlier-filtered WAP), so the dispersion gate should measure the same population — compute the residual/CV on a serial-band-trimmed core (drop serials <= max(10, 1% of circ) and jersey-match serials before the fit), or switch the gate to a robust spread measure (IQR/median) that chase sales can't dominate. Either is defensible; both need lib/fmv-confidence.ts changes + a before/after modeled-count check on this cohort (expect a few hundred honest LOW→MED/HIGH promotions). Review-gated per the FMV-restraint rule. One anomaly to re-check during that session: 90:3069 Max Strus reads raw CV 0.35 / corr 0.08 with 167 sales and STILL sits LOW — that one may be a different binder (recency window or the 1.7.0 internal CV computed on a different sale set) and is the perfect unit test.

## Mover 2 — F1/F2 Tier-B mis-mapped sales cleanup (data fix, Cowork-executable after review)

342 sales in the last 365d carry serial_number > circulation_count across 52 TS editions — physically impossible, so each sale row sits on the WRONG edition (the Tier-A precedent: Clamps 226:7541 got 22 sales re-mapped 2026-06-03). The F3 guard already excludes these from WAP, so current prices are protected — but the TRUE owner editions are missing that volume, deflating their sales_count_30d and pinning some at LOW/MEDIUM that deserve better. Cleanup method per edition: find the sibling edition (same player+set+play, different series/circulation) whose circulation_count >= the sale's serial; re-map; re-run fmv-recalc for both editions. Top offenders (bad_sales desc):

| edition | player | set | circ | bad sales | max bad serial |
|---|---|---|---|---|---|
| 8:62 | Giannis Antetokounmpo | Cosmic | 49 | 65 | 972 |
| 124:4841 | Sam Merrill | Base Set | 8,000 | 22 | 11,662 |
| 64:2375 | Russell Westbrook | Throwdowns | 442 | 18 | 1,675 |
| 127:4681 | Jalen Green | Throwdowns | 699 | 17 | 888 |
| 2:62 | Giannis Antetokounmpo | Base Set | 1,000 | 17 | 2,378 |
| 127:4683 | Kawhi Leonard | Throwdowns | 386 | 17 | 1,744 |
| 2:313 | Deandre Ayton | Base Set | 1,500 | 16 | 2,846 |
| 127:4676 | Kristaps Porziņģis | Throwdowns | 699 | 15 | 1,669 |
| 94:3955 | Zion Williamson | Throwdowns | 473 | 12 | 1,775 |
| 166:6034 | Rudy Gobert | Metallic Gold LE | 299 | 11 | 742 |

Pattern: Throwdowns/Base Set names recur across series — name-based mapping landed sales on the wrong series' sibling. The 8:62 case also explains the known "Giannis Cosmic reads low" eyeball note (its 14 in-range sales price a circ-49 Cosmic at $5.95; the true comps are polluted). Recommended: one focused Cowork data session — dry-run the sibling resolution for all 52, re-map where the sibling is unambiguous, leave ambiguous documented, fmv-recalc the touched editions, verify 8:62's FMV moves to a sane Cosmic number. Migration-tagged, backup table, per the merge playbook.

## Explicitly not proposed

- Loosening any confidence threshold to inflate HIGH/MED counts.
- Cohort/comparable pricing for thin editions (rejected 2026-05-23, stays rejected).
