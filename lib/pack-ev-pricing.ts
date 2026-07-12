// Pack-EV dual-price model — extracted from app/api/pack-ev/route.ts so the
// pricing logic can be unit-tested and shared with the compute-*-pack-ev edge
// functions (which carry a verbatim port of computeDualPrice today).
//
// Answers "what can I buy this pack for right now?" and picks the EV denominator.
//
// Anchor priority:
//   primary  : primary listing still live (totalUnopened > 0 AND forSale)
//   secondary: P2P low ask exists on the secondary market
//   min      : both are present and within 1% — show both as anchors in UI
//   none     : nothing buyable; UI hides the EV verdict
//
// The chosen anchor becomes the EV denominator. This replaced the old behavior
// where the caller-supplied primary retail price was always used, which made
// Series 1 EV ratios meaningless once primary sold out (or once a secondary
// market formed at a fraction of retail).

export type PriceSource = "primary" | "secondary" | "min" | "none"

export type DualPrice = {
  packPrice: number
  primaryPrice: number | null
  secondaryAsk: number | null
  primaryAvailable: boolean
  secondaryAvailable: boolean
  priceSource: PriceSource
}

export function computeDualPrice(args: {
  requestedPrice: number
  totalUnopened: number
  forSale: boolean
  secondaryAsk: number | null
}): DualPrice {
  const primaryAvailable = args.totalUnopened > 0 && args.forSale === true
  const secondaryAvailable = args.secondaryAsk != null && args.secondaryAsk > 0
  const primaryPrice = primaryAvailable && args.requestedPrice > 0 ? args.requestedPrice : null
  const secondaryAskValue = secondaryAvailable ? args.secondaryAsk : null

  let packPrice = 0
  let priceSource: PriceSource = "none"

  if (primaryPrice != null && secondaryAskValue != null) {
    if (primaryPrice <= secondaryAskValue) {
      packPrice = primaryPrice
      priceSource = "primary"
    } else {
      packPrice = secondaryAskValue
      priceSource = "secondary"
    }
    // Within 1% — render both as anchors so the user knows EV is robust
    if (primaryPrice > 0 && Math.abs(primaryPrice - secondaryAskValue) / primaryPrice <= 0.01) {
      priceSource = "min"
    }
  } else if (primaryPrice != null) {
    packPrice = primaryPrice
    priceSource = "primary"
  } else if (secondaryAskValue != null) {
    packPrice = secondaryAskValue
    priceSource = "secondary"
  }

  return {
    packPrice,
    primaryPrice,
    secondaryAsk: secondaryAskValue,
    primaryAvailable,
    secondaryAvailable,
    priceSource,
  }
}
