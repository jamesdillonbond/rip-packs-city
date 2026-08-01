// Pure pull-odds math for the pack-distribution page's "Pull odds by tier" panel
// (app/(collections)/[collection]/pack/dist/[distId]/page.tsx — the ~2,740-line
// server monolith neither coverage gate measures). This is the fabricated-data
// class: a wrong denominator or ordering here prints false pull odds on a public
// pack page, so it's worth pinning. Bodies are byte-identical to the page's
// TierOddsPanel; the page imports these.

/** Rarity display order (Top Shot + cross-collection tiers). */
export const TIER_RARITY_ORDER = ["ultimate", "legendary", "anthology", "autograph", "rare", "fandom", "common"]

/** Denominator for pull odds: total remaining POOL ENTRIES across all tiers. */
export function sumPoolRemaining(remainingByTier: Record<string, number>): number {
  return Object.values(remainingByTier).reduce<number>((s, v) => s + (Number(v) || 0), 0)
}

/** Tiers to render, in rarity order, then any non-standard tiers with supply
 * appended in their original key order — only tiers whose ORIGINAL count > 0. */
export function orderedTiersWithSupply(
  originalByTier: Record<string, number>,
  order: string[] = TIER_RARITY_ORDER,
): string[] {
  const tiers = order.filter((t) => Number(originalByTier[t] ?? 0) > 0)
  for (const k of Object.keys(originalByTier)) {
    if (!order.includes(k) && Number(originalByTier[k] ?? 0) > 0) tiers.push(k)
  }
  return tiers
}

/** The "% of pool" cell label. null pool -> "—"; a positive sub-0.1% share ->
 * "<0.1%"; otherwise 0 decimals at/above 10%, 1 decimal below. */
export function pctOfPoolLabel(remaining: number, poolRemaining: number): string {
  const pctOfPool = poolRemaining > 0 ? (remaining / poolRemaining) * 100 : null
  if (pctOfPool === null) return "—"
  if (pctOfPool < 0.1 && pctOfPool > 0) return "<0.1%"
  return `${pctOfPool.toFixed(pctOfPool >= 10 ? 0 : 1)}%`
}

// ── Dual-price KPI derivation (DualPriceKpi) ────────────────────────────────

export type PriceSource = "primary" | "secondary" | "min" | "none" | null

export interface DualPriceInput {
  primaryPrice: number | null
  secondaryAsk: number | null
  priceSource: PriceSource
  primaryAvailable: boolean
  secondaryAvailable: boolean
}

export interface DualPriceDerived {
  /** priceSource === null → the legacy single-line fallback KPI. */
  legacy: boolean
  /** Primary leg has a real, positive, available price (else "SOLD OUT"). */
  primaryLive: boolean
  /** Secondary ask has a real, positive, available price (else "—"). */
  secondaryLive: boolean
  /** Primary is (one of) the chosen anchor(s) — the red-highlighted leg. */
  primaryAnchor: boolean
  /** Secondary is (one of) the chosen anchor(s). */
  secondaryAnchor: boolean
}

/** Decide which pack-price legs are live and which is the anchor. Byte-identical
 * to DualPriceKpi's inline derivation. */
export function deriveDualPrice(input: DualPriceInput): DualPriceDerived {
  const { primaryPrice, secondaryAsk, priceSource, primaryAvailable, secondaryAvailable } = input
  if (priceSource === null) {
    return { legacy: true, primaryLive: false, secondaryLive: false, primaryAnchor: false, secondaryAnchor: false }
  }
  const primaryLive = primaryAvailable && primaryPrice != null && primaryPrice > 0
  const secondaryLive = secondaryAvailable && secondaryAsk != null && secondaryAsk > 0
  const primaryAnchor = priceSource === "primary" || priceSource === "min"
  const secondaryAnchor = priceSource === "secondary" || priceSource === "min"
  return { legacy: false, primaryLive, secondaryLive, primaryAnchor, secondaryAnchor }
}
