// Display-time FMV staleness penalty for the sniper feed. Extracted from
// app/api/sniper-feed/route.ts so the pricing guard can be unit-tested. Pure.
//
// Editions whose only recent print is a single sale from weeks ago routinely
// produce inflated FMVs after a market move. The recalc job already weights ASP
// by days_since_sale, but a lone old sale still anchors the curve. This applies
// a display-only haircut at deal-build time so the sniper stops surfacing fake
// bargains. It does NOT mutate fmv_snapshots.
//
// Rules:
//   - daysSinceSale > 14 AND salesCount30d <= 1 → multiply FMV by 0.7
//   - confidence LOW AND daysSinceSale > 30      → cap FMV at askPrice (0% discount)
export function applyFmvStalenessPenalty(
  adjustedFmv: number,
  askPrice: number,
  confidence: string,
  daysSinceSale: number | null,
  salesCount30d: number | null
): number {
  if (adjustedFmv <= 0) return adjustedFmv
  let result = adjustedFmv
  const days = daysSinceSale ?? 0
  const sales = salesCount30d ?? 0

  if (days > 14 && sales <= 1) {
    result = result * 0.7
  }

  const isLow = confidence === "LOW" || confidence === "low"
  if (isLow && days > 30) {
    result = Math.min(result, askPrice)
  }

  return result
}
