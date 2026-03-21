export function computeFMV({
  lowAsk,
  bestOffer,
  isSpecialSerial,
}: {
  lowAsk?: number
  bestOffer?: number
  isSpecialSerial?: boolean
}) {
  if (!lowAsk && !bestOffer) return null

  // Non-special serials → STRICT discipline
  if (!isSpecialSerial) {
    if (!lowAsk) return bestOffer || null

    if (!bestOffer) return lowAsk

    const mid = (lowAsk + bestOffer) / 2

    // Clamp inside band
    return Math.min(lowAsk, Math.max(bestOffer, mid))
  }

  // Special serials → allow premium (basic for now)
  let base = lowAsk || bestOffer || 0

  return base * 1.5
}