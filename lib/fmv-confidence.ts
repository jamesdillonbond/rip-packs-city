// lib/fmv-confidence.ts
//
// Canonical FMV confidence-tier logic — the single source of truth shared by
// the fmv-recalc and fmv-backfill routes. Extracted 2026-05-20 (audit F11):
// the two routes kept their own copies and had drifted (recalc gated HIGH at
// >=10 sales, backfill at >=5), producing inconsistent labels.
//
//   HIGH   = >= MIN_SALES_30D_HIGH sales in window AND price dispersion
//            (stddev / mean) < HIGH_MAX_DISPERSION
//   MEDIUM = >= MIN_SALES_30D_MEDIUM sales, but not HIGH
//   LOW    = everything else

export type FmvConfidence = "HIGH" | "MEDIUM" | "LOW"

export const MIN_SALES_30D_HIGH = 7
export const MIN_SALES_30D_MEDIUM = 5
// Max coefficient of variation (stddev / mean) allowed for a HIGH rating:
// prices must agree within ~40% before an edition is marketed as reliable FMV.
export const HIGH_MAX_DISPERSION = 0.4

// Volume-only base tier. HIGH is deliberately never assigned here — it requires
// the price-dispersion gate in escalateConfidence().
export function computeConfidence(salesCount: number): FmvConfidence {
  if (salesCount >= MIN_SALES_30D_MEDIUM) return "MEDIUM"
  return "LOW"
}

// Refine the base tier. Promotes to HIGH only when the volume gate is met AND
// prices are tight; editions with enough sales but dispersed prices stay MEDIUM.
export function escalateConfidence(
  base: FmvConfidence,
  salesCount30d: number,
  prices: number[],
): FmvConfidence {
  let confidence = base

  if (confidence === "LOW" && salesCount30d >= MIN_SALES_30D_MEDIUM) {
    confidence = "MEDIUM"
  }

  if (
    confidence !== "HIGH" &&
    salesCount30d >= MIN_SALES_30D_HIGH &&
    prices.length >= MIN_SALES_30D_HIGH
  ) {
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length
    if (mean > 0) {
      const variance =
        prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
      const stddev = Math.sqrt(variance)
      if (stddev / mean < HIGH_MAX_DISPERSION) {
        confidence = "HIGH"
      }
    }
  }

  return confidence
}
