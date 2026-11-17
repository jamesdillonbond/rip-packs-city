export type MarketDebugReason =
  | "OK"
  | "NO_LOW_ASK"
  | "NO_BEST_OFFER"
  | "NO_MARKET_INPUTS"
  | "SPECIAL_SERIAL_NO_BASE"

export function explainMarketBlankState(input: {
  lowAsk: number | null
  bestOffer: number | null
  isSpecialSerial: boolean
  lastPurchasePrice?: number | null
}) {
  if (input.isSpecialSerial) {
    if (
      input.lowAsk === null &&
      input.bestOffer === null &&
      (input.lastPurchasePrice === null || input.lastPurchasePrice === undefined)
    ) {
      return "SPECIAL_SERIAL_NO_BASE" satisfies MarketDebugReason
    }
    return "OK" satisfies MarketDebugReason
  }

  if (input.lowAsk === null && input.bestOffer === null) {
    return "NO_MARKET_INPUTS" satisfies MarketDebugReason
  }

  if (input.lowAsk === null) {
    return "NO_LOW_ASK" satisfies MarketDebugReason
  }

  if (input.bestOffer === null) {
    return "NO_BEST_OFFER" satisfies MarketDebugReason
  }

  return "OK" satisfies MarketDebugReason
}