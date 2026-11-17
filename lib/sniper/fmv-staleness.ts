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
//   - confidence LOW, SALES_ONLY or STALE AND daysSinceSale > 30 → cap FMV at askPrice (0% discount)
/**
 * An FMV that must NOT anchor a confident discount %: ASK_ONLY (0.90 × one
 * seller's ask, no sales), STALE (carried forward from a prior cycle, nothing
 * re-priced it) and SALES_ONLY (sales with no ask to corroborate — measured
 * 2026-09-25: 11 of 17 All Day SALES_ONLY editions with recent sales carry an
 * FMV more than 3× the median of their own last-180-day prints; the Cowboys
 * Banner Year RARE read $46.78 against 2026 prints of $1–$2). Rows carrying one render with the low-confidence
 * caveat and sort below verified rows (2026-09-25: STALE added — it was
 * rendering "95% off" on a Legendary priced from 2024 sales).
 */
export function fmvCannotAnchorDiscount(confidence: string | null | undefined): boolean {
  const c = String(confidence ?? "").toUpperCase()
  return c === "ASK_ONLY" || c === "STALE" || c === "SALES_ONLY"
}

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

  // STALE is weaker than LOW, not stronger: it is an FMV carried forward from a
  // prior cycle that nothing re-priced. 2026-09-25: Dalton Kincaid's All Day
  // Dynamic LEGENDARY showed $30 vs a STALE $570.86 (built on 2024 sales of
  // $450–$580; its real 2026 prints were $199 and $25) — a "95% off" deal on the
  // Sniper feed and in the concierge. The 0.7 haircut alone left it at 93%.
  // SALES_ONLY is a LOW-level estimate (sales with no ask to corroborate).
  const isWeak = /^(low|sales_only|stale)$/i.test(confidence)
  if (isWeak && days > 30) {
    result = Math.min(result, askPrice)
  }

  return result
}
