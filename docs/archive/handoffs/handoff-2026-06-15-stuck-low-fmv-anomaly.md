# Handoff 2026-06-15 — Investigate: ~249 recently-dense TS editions stuck at LOW confidence

Context. This is an INVESTIGATION + pricing-gate REVIEW handoff, not a ship-this. Cowork found it while measuring whether there's a TS FMV coverage lever before the AllDay port. There is NOT a broad lever (TS edition FMV is honestly dialed — see below), but there's one real anomaly worth a focused review of the confidence gate. Pricing logic is preview-first / review-required per the FMV discipline, and ANY change must clear the LiveToken cross-check before shipping. Nothing here should be blind-changed.

HEAD at write time: origin/main = a3db423 (post serial-FMV deepen). No code touched by this doc.

---

The reassuring half (context, not a task)

TS edition FMV is NOT secretly broken. Of the 4,657 canonical int-keyed TS editions at LOW: 100% are on the current 1.7 algo with a fresh (<7-day) snapshot — fmv-recalc is fully caught up (not_on_1_7_algo = 0, snap_older_7d = 0). The 35% HIGH+MEDIUM coverage is mostly recency-by-design: the gate wants recent (30-day) density, and most TS editions that traded 10x over 180d only trade ~3x in the last 30 (avg sales_count_30d among LOW = 3.2). That's defensible. So do not chase a "lift all the LOW editions" project — it's working as intended for the bulk.

---

The anomaly (the task)

249 TS editions have sales_count_30d >= 10 in their latest snapshot yet are labeled LOW. Many are the HOTTEST current moments — 2026 NBA Playoffs commons, Rookie Debuts — trading 100+ times per week. A collector who watches those trade constantly and sees "LOW confidence" on RPC reads it as RPC being wrong. That's the trust cost.

Decomposition (read-only, Cowork):
- Price: 78 under $2, 175 under $5 (70%), 46 over $10 (18%). Median FMV $2.61. So it skews cheap but is NOT purely a cheap-edition story.
- Dispersion sample is MIXED:
  - Genuinely wide (gate correct to demote): e.g. "Teonni Key — WNBA Rookie Debut", 37 recent sales, $1.75–$50.00, raw log-price SD 0.700. Wide real spread → LOW is honest.
  - Tight yet LOW (gate questionable): e.g. "Cade Cunningham — 2026 NBA Playoffs", sales_count_30d=125, fmv=$1.00=wap=wap_without_outliers (zero central dispersion) — by escalateConfidence() this should be HIGH, so something the gate actually received differs from the stored summary.
- A summary-vs-live mismatch: for several, the snapshot's sales_count_30d (>=30) does NOT match a fresh count of sales in the last 30 days by sold_at (~4). Since the snapshot is <7d old and fmv-recalc windows by sold_at, the windows should nearly agree — they don't.

How the gate works (verified in lib/fmv-confidence.ts):
- escalateConfidence(): once salesCount30d >= 7 AND prices.length >= 7, the edition is graded purely by dispersion — serialResidualDispersion (ln(price) ~ ln(serial) OLS residual SD) if serials are supplied, else raw coefficient of variation. <0.20 → HIGH, <0.35 → MEDIUM, >=0.35 → LOW (demote). Ask-corroboration (edition_offers.low_ask within +/-25% of the sales median) can rescue LOW → MEDIUM but evidently isn't for these.
- fmv-recalc/route.ts computes sales_count_30d = count of in-window (sold_at >= now-30d) sales, pages editions by MAX(sold_at) DESC, delete-then-insert. Note the documented Step 6 "fossil" class (a stale snapshot re-stamped forward) that this file already guards against — the count mismatch smells related.

Hypotheses to test (in priority order):
1. Relative-dispersion over-penalizes cheap, high-volume editions. A $0.85–$1.50 common has high log-space / CV dispersion (log(1.5/0.85)=0.57) even though its FMV is highly reliable (100+ tight recent sales, wap_without_outliers == fmv). The 0.35 demote bound may be too strict for sub-$5 editions. Consider an absolute-spread floor (e.g. if max-min < $X OR wap_without_outliers within Y% of fmv, don't demote) or a high-volume override (sales_count_30d >= N with tight wap_without_outliers grants at least MEDIUM). 70% being under $5 supports this for the bulk.
2. sales_count_30d staleness / window artifact. Verify, for a sample, that the latest snapshot's sales_count_30d equals a live COUNT of sales WHERE sold_at >= computed_at - interval '30 days'. If they diverge, the recompute window or a backfill interaction (topshot-sales-history-backfill injecting historical sold_at sales) is feeding the gate a different sales set than exists — mislabeling some editions. This would explain the tight-yet-LOW cases (the gate saw wide historical sales the live 30d window no longer contains, or vice-versa).
3. Why ask-corroboration isn't rescuing them. Are edition_offers.low_ask rows populated for these hot editions? If not, the LOW→MEDIUM rescue can never fire even when a live ask agrees.

The 18% over-$10 stuck-LOW are the most likely genuine-wide-dispersion or serial-premium cases (e.g. Metallic Gold LEs whose #1/jersey sales widen the residual) — confirm they're honest before trying to rescue them; don't loosen the gate enough to overstate genuinely noisy editions.

Suggested approach: instrument first (log, for the 249, the actual dispersion value the gate computed + the prices/serials array length it received) so you can SEE whether each is a true wide-spread (leave LOW) or a tight-but-demoted / stale-count case (fix). Then decide between an absolute-spread floor, a volume override, or a count-window fix. Validate any rule against the LiveToken serial/edition FMV on a sample (the mandatory pricing-change gate) before shipping, and keep it additive/honest (never overstate).

Revert: whatever lands is a lib/fmv-confidence.ts and/or fmv-recalc change — git revert the commit; the next fmv-recalc sweep re-labels editions off the reverted logic.

---

Guardrails (standard)
- Direct-to-main, no branches, no PRs. PowerShell git on Windows; re-verify push with git rev-list --count origin/main..HEAD (expect 0).
- Pricing-logic change → preview-first, LiveToken-validate, never blind-ship (this is exactly the class the FMV scoping doc flags for review).
- Vercel Pro maxDuration cap 800s. Full-file writes on Windows (CRLF).
- Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual fmv-recalc shape (the line cites above are from a 2026-06-15 read).

Expected end state: either a reviewed, LiveToken-validated gate refinement that lifts the genuinely-tight high-volume editions out of LOW (the hot 2026 Playoffs moments read MEDIUM/HIGH), or a documented decision that the current labels are honest — with the count-mismatch sub-question resolved either way.
