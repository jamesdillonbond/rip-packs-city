import { explainMarketBlankState, type MarketDebugReason } from "@/lib/market-debug"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type MarketTruthInput = {
  momentId: string
  editionKey?: string | null
  parallel?: string | null
  setName?: string | null
  playerName?: string | null

  // Serial number — required for power-law premium calculation
  // Pass as number when available from GraphQL searchMintedMoments
  serialNumber?: number | null
  // Total edition size (circulationCount from GraphQL, NOT maxEditionSize)
  circulationCount?: number | null
  // Rarity tier — used to select correct power-law exponent
  tier?: "Common" | "Fandom" | "Rare" | "Legendary" | "Ultimate" | null

  bestAsk?: number | null
  lowAsk?: number | null
  bestOffer?: number | null
  lastPurchasePrice?: number | null

  editionLowAsk?: number | null
  editionBestOffer?: number | null
  editionLastSale?: number | null
  editionAskCount?: number | null
  editionOfferCount?: number | null
  editionSaleCount?: number | null
  editionMarketSource?: string | null
  editionMarketSourceChain?: string[] | null
  editionMarketTags?: string[] | null

  // Supabase FMV snapshot fields (passed through from market-sources)
  topshotAsk?: number | null
  flowtyAsk?: number | null
  fmvUsd?: number | null
  fmvConfidence?: string | null
  fmvComputedAt?: string | null

  // Badge-based serial tier flags from GraphQL badges field
  // Confirmed badge strings from Top Shot GraphQL searchMintedMoments:
  //   "#1 Serial", "Jersey", "Original Perfect Mint Serial"
  specialSerialTraits?: string[]
}

export type MarketTruthRow = {
  momentId: string
  fmv: number | null
  bestOffer: number | null
  lowAsk: number | null

  valuationScope: "Parallel" | "Edition" | "Modeled"
  isSpecialSerial: boolean
  serialMultiplier: number
  debugReason: MarketDebugReason

  normalizedParallel: string
  normalizedSetName: string
  scopeKey: string

  marketSource:
    | "row"
    | "edition"
    | "row+edition"
    | "edition-sale"
    | "special-serial"
    | "none"

  fmvMethod:
    | "band"
    | "low-ask-only"
    | "best-offer-only"
    | "edition-last-sale"
    | "special-serial-premium"
    | "serial-power-law"
    | "none"

  // Six-tier confidence model aligned with research spec
  marketConfidence: "liquid" | "trading" | "thin" | "illiquid" | "autograph" | "parallel-thin" | "none"

  rowLowAsk: number | null
  rowBestOffer: number | null

  editionLowAsk: number | null
  editionBestOffer: number | null
  editionLastSale: number | null
  editionAskCount: number
  editionOfferCount: number
  editionSaleCount: number
  editionMarketSource: string | null
  editionMarketSourceChain: string[]
  editionMarketTags: string[]

  topshotAsk: number | null
  flowtyAsk: number | null
  fmvUsd: number | null
  fmvConfidence: string | null
  fmvComputedAt: string | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minNullable(values: Array<number | null | undefined>) {
  const nums = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  )
  if (!nums.length) return null
  return Math.min(...nums)
}

function maxNullable(values: Array<number | null | undefined>) {
  const nums = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  )
  if (!nums.length) return null
  return Math.max(...nums)
}

// ─── Special serial detection ─────────────────────────────────────────────────

/**
 * Confirmed badge strings from Top Shot GraphQL `badges` field on MintedMoment.
 * These come from searchMintedMoments → badges → description.
 *
 * Do NOT use "Jersey Match" — the actual GraphQL value is "Jersey".
 * Do NOT use "#1" — the actual value is "#1 Serial".
 * Do NOT use "Perfect Mint" — the actual value is "Original Perfect Mint Serial".
 */
const SPECIAL_SERIAL_BADGES = [
  "#1 Serial",
  "Jersey",
  "Original Perfect Mint Serial",
] as const

export type SpecialSerialBadge = (typeof SPECIAL_SERIAL_BADGES)[number]

export function isSpecialSerial(traits?: string[] | null): boolean {
  if (!Array.isArray(traits)) return false
  return traits.some((t) => (SPECIAL_SERIAL_BADGES as readonly string[]).includes(t))
}

// ─── Special serial multipliers ──────────────────────────────────────────────
//
// Calibrated from peer-reviewed research (Lee 2022, Pelechrinis 2023) and
// real Top Shot sale data. These are conservative mid-range estimates.
//
// Research ranges:
//   #1 Serial:                   15×–60× floor (2021 peak); reduce ~40% for 2025-26 market
//   Jersey:                      10×–35× floor
//   Original Perfect Mint Serial: 8×–25× floor (LE only)
//
// We use the lower bound of the calibrated range as the base multiplier,
// since we're applying it to lowAsk (floor) rather than an isolated comp.
// These will be replaced by isolated comp lookups once 90d crawler is live.

const SPECIAL_SERIAL_MULTIPLIERS: Record<SpecialSerialBadge, number> = {
  "#1 Serial": 12,                    // Conservative: ~20% below 15× lower bound
  "Jersey": 8,                         // Conservative: lower end of 10×–35× range
  "Original Perfect Mint Serial": 6,  // Conservative: lower end of 8×–25× range
}

function getSpecialSerialMultiplier(traits: string[]): number {
  // #1 takes priority over everything
  if (traits.includes("#1 Serial")) return SPECIAL_SERIAL_MULTIPLIERS["#1 Serial"]
  if (traits.includes("Original Perfect Mint Serial"))
    return SPECIAL_SERIAL_MULTIPLIERS["Original Perfect Mint Serial"]
  if (traits.includes("Jersey")) return SPECIAL_SERIAL_MULTIPLIERS["Jersey"]
  return 1
}

// ─── Power-law serial premium ─────────────────────────────────────────────────
//
// Formula: multiplier = max(1.0, (serial / median_serial)^exponent)
// where exponent is negative (lower serial = higher premium).
//
// Tier exponents from Lee (2022) elasticity model, calibrated to Top Shot:
//   Common:     -0.52
//   Fandom:     -0.55
//   Rare:       -0.60
//   Legendary:  -0.65
//   Ultimate:   -0.72
//
// Edition-size dampening: large editions get smaller serial premium
//   ≥10,000 minted → multiply exponent by 0.80
//   ≥1,000 minted  → multiply exponent by 0.90
//   <1,000 minted  → no dampening (1.0×)
//
// This only applies to non-special serials. Special serials use their
// own isolated multiplier above.

const TIER_EXPONENTS: Record<string, number> = {
  Common: -0.52,
  Fandom: -0.55,
  Rare: -0.60,
  Legendary: -0.65,
  Ultimate: -0.72,
}

function computeSerialMultiplier(
  serialNumber: number,
  circulationCount: number,
  tier: string | null | undefined
): number {
  if (circulationCount <= 0) return 1.0

  const medianSerial = circulationCount / 2
  if (serialNumber >= medianSerial) return 1.0 // below-median serials get no premium

  const baseExponent = TIER_EXPONENTS[tier ?? "Common"] ?? -0.52

  // Edition-size dampening
  const dampening =
    circulationCount >= 10_000
      ? 0.80
      : circulationCount >= 1_000
        ? 0.90
        : 1.0

  const exponent = baseExponent * dampening

  const multiplier = Math.pow(serialNumber / medianSerial, exponent)
  return Math.max(1.0, multiplier)
}

// ─── Confidence tier mapping ──────────────────────────────────────────────────
//
// Six-tier model from research spec:
//   LIQUID:        ≥10 sales/90d + active listings
//   TRADING:       3-9 sales/90d
//   THIN:          1-2 sales/90d
//   ILLIQUID:      0 sales/90d (~70% of all editions)
//   AUTOGRAPH:     1-of-1 autograph/inscription
//   PARALLEL-THIN: new parallel tier with no sales history

function resolveConfidenceTier(
  editionSaleCount: number,
  editionAskCount: number,
  isParallel: boolean,
  isSpecial: boolean,
  hasAnyMarket: boolean
): MarketTruthRow["marketConfidence"] {
  if (isSpecial && editionSaleCount === 0 && !hasAnyMarket) return "autograph"
  if (isParallel && editionSaleCount < 3) return "parallel-thin"
  if (editionSaleCount >= 10 && editionAskCount > 0) return "liquid"
  if (editionSaleCount >= 3) return "trading"
  if (editionSaleCount >= 1) return "thin"
  if (hasAnyMarket) return "illiquid"
  return "none"
}

// ─── Main compute function ────────────────────────────────────────────────────

export function computeFmv(input: MarketTruthInput): MarketTruthRow {
  const normalizedSetName = normalizeSetName(input.setName ?? "")
  const normalizedParallel = normalizeParallel(input.parallel ?? "")

  const scopeKey = buildEditionScopeKey({
    editionKey: input.editionKey ?? null,
    setName: normalizedSetName,
    playerName: input.playerName ?? null,
    parallel: normalizedParallel,
    subedition: normalizedParallel,
  })

  const rowLowAsk = minNullable([input.lowAsk, input.bestAsk])
  const rowBestOffer = maxNullable([input.bestOffer])

  const editionLowAsk = input.editionLowAsk ?? null
  const editionBestOffer = input.editionBestOffer ?? null
  const editionLastSale = input.editionLastSale ?? null
  const editionAskCount =
    typeof input.editionAskCount === "number" ? input.editionAskCount : 0
  const editionOfferCount =
    typeof input.editionOfferCount === "number" ? input.editionOfferCount : 0
  const editionSaleCount =
    typeof input.editionSaleCount === "number" ? input.editionSaleCount : 0
  const editionMarketTags = Array.isArray(input.editionMarketTags)
    ? input.editionMarketTags.filter((t): t is string => typeof t === "string")
    : []
  const editionMarketSourceChain = Array.isArray(input.editionMarketSourceChain)
    ? input.editionMarketSourceChain.filter((t): t is string => typeof t === "string")
    : []

  const mergedLowAsk = minNullable([rowLowAsk, editionLowAsk])
  const mergedBestOffer = maxNullable([rowBestOffer, editionBestOffer])

  const special = isSpecialSerial(input.specialSerialTraits)
  const isParallel = normalizedParallel !== "Base"
  const hasAnyMarket =
    mergedLowAsk !== null || mergedBestOffer !== null || editionLastSale !== null

  let fmv: number | null = null
  let marketSource: MarketTruthRow["marketSource"] = "none"
  let fmvMethod: MarketTruthRow["fmvMethod"] = "none"
  let serialMultiplier = 1.0

  const hasRowMarket = rowLowAsk !== null || rowBestOffer !== null
  const hasEditionAskOffer = editionLowAsk !== null || editionBestOffer !== null
  const hasEditionSale = editionLastSale !== null

  if (hasRowMarket && hasEditionAskOffer) marketSource = "row+edition"
  else if (hasRowMarket) marketSource = "row"
  else if (hasEditionAskOffer) marketSource = "edition"
  else if (hasEditionSale) marketSource = "edition-sale"

  if (special) {
    // ── Special serial path ──────────────────────────────────────────────────
    // Use isolated comps if available (future), otherwise base × multiplier.
    // IMPORTANT: base is the edition floor, not the moment's own ask.
    // We want the edition baseline so the multiplier is applied relative to
    // what a standard serial of this edition is worth.
    const base =
      editionLowAsk ??
      mergedLowAsk ??
      mergedBestOffer ??
      editionLastSale ??
      input.lastPurchasePrice ??
      null

    if (base !== null) {
      serialMultiplier = getSpecialSerialMultiplier(input.specialSerialTraits ?? [])
      fmv = base * serialMultiplier
      fmvMethod = "special-serial-premium"
      marketSource = "special-serial"
    }
  } else {
    // ── Standard serial path ─────────────────────────────────────────────────

    // Base FMV from market signals
    if (mergedLowAsk !== null && mergedBestOffer !== null) {
      // Band: midpoint between best offer and low ask, clamped to [bestOffer, lowAsk]
      const midpoint = (mergedLowAsk + mergedBestOffer) / 2
      fmv = Math.max(mergedBestOffer, Math.min(mergedLowAsk, midpoint))
      fmvMethod = "band"
    } else if (mergedLowAsk !== null) {
      fmv = mergedLowAsk
      fmvMethod = "low-ask-only"
    } else if (mergedBestOffer !== null) {
      fmv = mergedBestOffer
      fmvMethod = "best-offer-only"
    } else if (editionLastSale !== null) {
      // ILLIQUID path: discount last sale for time decay
      // Research spec: lowestAsk × 0.75–0.85 for 0-sales editions.
      // We use 0.80 as the midpoint discount.
      fmv = editionLastSale * 0.80
      fmvMethod = "edition-last-sale"
      marketSource = "edition-sale"
    }

    // ── Serial power-law premium ─────────────────────────────────────────────
    // Apply on top of base FMV if we have serial + circulation data.
    // Only applies to below-median serials (above median = no premium).
    if (
      fmv !== null &&
      typeof input.serialNumber === "number" &&
      input.serialNumber > 0 &&
      typeof input.circulationCount === "number" &&
      input.circulationCount > 1
    ) {
      serialMultiplier = computeSerialMultiplier(
        input.serialNumber,
        input.circulationCount,
        input.tier
      )

      if (serialMultiplier > 1.0) {
        fmv = fmv * serialMultiplier
        fmvMethod = "serial-power-law"
      }
    }
  }

  // Final fallback: use Supabase fmv_snapshots if no live market data produced an FMV
  if (fmv === null && typeof input.fmvUsd === "number" && input.fmvUsd > 0) {
    fmv = input.fmvUsd
    fmvMethod = "low-ask-only"
    marketSource = "edition"
  }

  const marketConfidence = resolveConfidenceTier(
    editionSaleCount,
    editionAskCount,
    isParallel,
    special,
    hasAnyMarket
  )

  const debugReason = explainMarketBlankState({
    lowAsk: mergedLowAsk,
    bestOffer: mergedBestOffer,
    isSpecialSerial: special,
    lastPurchasePrice: input.lastPurchasePrice ?? editionLastSale ?? null,
  })

  return {
    momentId: String(input.momentId),
    fmv: fmv !== null ? Number(fmv.toFixed(2)) : null,
    bestOffer: mergedBestOffer,
    lowAsk: mergedLowAsk,
    valuationScope: input.parallel
      ? "Parallel"
      : input.editionKey
        ? "Edition"
        : "Modeled",
    isSpecialSerial: special,
    serialMultiplier,
    debugReason,
    normalizedParallel,
    normalizedSetName,
    scopeKey,
    marketSource,
    fmvMethod,
    marketConfidence,
    rowLowAsk,
    rowBestOffer,
    editionLowAsk,
    editionBestOffer,
    editionLastSale,
    editionAskCount,
    editionOfferCount,
    editionSaleCount,
    editionMarketSource: input.editionMarketSource ?? null,
    editionMarketSourceChain,
    editionMarketTags,

    topshotAsk: input.topshotAsk ?? null,
    flowtyAsk: input.flowtyAsk ?? null,
    fmvUsd: input.fmvUsd ?? null,
    fmvConfidence: input.fmvConfidence ?? null,
    fmvComputedAt: input.fmvComputedAt ?? null,
  }
}