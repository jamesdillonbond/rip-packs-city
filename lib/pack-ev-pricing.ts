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

/**
 * Did the CALLER's supplied price end up in the resulting packPrice?
 *
 * deep-audit R24. `/api/pack-ev` is open to anonymous POST and its handler
 * persists `dual.packPrice` into `pack_ev_history` with a SERVICE_ROLE client.
 * `requestedPrice` comes straight from the request body, so when the pack has
 * primary supply and is for sale that number IS the persisted price — and it
 * drives `pack_ev`, `value_ratio` and `is_positive_ev`.
 *
 * "primary" — packPrice IS requestedPrice.
 * "min"     — the two anchors agreed within 1%, so requestedPrice still set it.
 * "secondary" / "none" — derived from data we hold; the caller had no influence.
 *
 * ⚠ This is a SECURITY predicate, not a display one. Extracted so the rule is a
 * tested unit rather than an inline expression in a route whose happy path is
 * upstream-GQL-driven and therefore effectively untestable.
 */
export function priceIsCallerInfluenced(priceSource: PriceSource): boolean {
  return priceSource === "primary" || priceSource === "min"
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

// ─── Per-edition FMV fallback ladder ─────────────────────────────────────────
//
// Picks the best available price signal for a single edition inside a pack pool,
// in strict priority order, and tags which tier won so the UI/telemetry can show
// the provenance. Extracted from app/api/pack-ev/route.ts (bestPrice) so the
// fallback ladder is unit-testable — it decides the FMV each edition contributes
// to the pack's gross EV, so a reordered/broken tier silently mis-values packs.
//
// Ladder (first positive wins):
//   rpc         : our own RPC FMV (authoritative when present)
//   pack_wap    : the pack pool's own average sale price
//   market_wap   : the edition's marketplace average sale price
//   ask         : lowest ask, discounted 5% (a listing is an upper bound)
//   last_sale   : last purchase price, discounted 20% (stalest signal)
//   none        : no usable signal → 0

/** Minimal structural shape bestPrice reads off an edition node. */
export interface BestPriceNode {
  averageSalePrice: number
  lowAsk: number
  lastPurchasePrice: number
  edition: { marketplaceInfo: { averageSaleData: { averagePrice: string } } }
}

export function bestPrice(
  node: BestPriceNode,
  rpcFmv?: number,
): { price: number; priceSource: string } {
  if (rpcFmv && rpcFmv > 0) return { price: rpcFmv, priceSource: "rpc" }
  if (node.averageSalePrice > 0) return { price: node.averageSalePrice, priceSource: "pack_wap" }
  const marketAvg = parseFloat(node.edition.marketplaceInfo.averageSaleData.averagePrice)
  if (marketAvg > 0) return { price: marketAvg, priceSource: "market_wap" }
  if (node.lowAsk > 0) return { price: node.lowAsk * 0.95, priceSource: "ask" }
  if (node.lastPurchasePrice > 0) return { price: node.lastPurchasePrice * 0.8, priceSource: "last_sale" }
  return { price: 0, priceSource: "none" }
}

// ─── Special-serial premium label ────────────────────────────────────────────
//
// Human-readable badge summarizing why a serial is special (chase serials the
// simulator surfaces). Extracted from app/api/pack-ev/route.ts (serialPremiumLabel).

/** Minimal structural shape serialPremiumLabel reads off an edition node.
 *  `jerseyNumber` is a boolean match-flag; the rendered value comes from
 *  `edition.play.stats.jerseyNumber`. */
export interface SerialPremiumNode {
  serialOne?: boolean
  lastMint?: boolean
  jerseyNumber?: boolean
  edition: { play: { stats: { jerseyNumber?: number | string | null } } }
}

export function serialPremiumLabel(node: SerialPremiumNode): string | null {
  const labels: string[] = []
  if (node.serialOne) labels.push("#1 Serial")
  if (node.lastMint) labels.push("Last Mint")
  if (node.jerseyNumber) labels.push("Jersey #" + node.edition.play.stats.jerseyNumber + " Match")
  return labels.length > 0 ? labels.join(" + ") : null
}
