export type UnifiedMarketTruth = {
  marketKey: string
  marketBackedAsk: number | null
  marketBackedLastSale: number | null
  marketBackedBestOffer: number | null
  topShotAsk: number | null
  flowtyAsk: number | null
  topShotBestOffer: number | null
  flowtyBestOffer: number | null
  flowscanLatestSale: number | null
  flowscanRecentSales: number[]
  flowscanAverageRecentSale: number | null
  flowscanSaleCount7d: number | null
  flowscanSaleCount30d: number | null
  observedSourceCount: number
  probeStatus:
    | "observed-only"
    | "docs-probe-success"
    | "docs-probe-partial"
    | "docs-probe-failed"
    | "flowty-local-json"
    | "flowty-configured"
    | "flowty-partial"
    | "flowty-failed"
    | "combined"
  sourceSummary: string
  probeNotes: string[]
}

export type MarketConfidence = "low" | "medium" | "high"
export type MarketStatus =
  | "Deal"
  | "Watch"
  | "Fair"
  | "Premium"
  | "No Ask"
  | "Illiquid"

export type PriceAnchorType =
  | "ask+sale"
  | "sale"
  | "ask"
  | "modeled"

export type LiquidityBand = "Low" | "Medium" | "High"
export type DealBand = "Weak" | "Medium" | "Strong"
export type BestMarketplace = "Top Shot" | "Flowty" | "Tie" | "Unknown"

export type SnapshotInput = {
  momentId: number | string
  editionKey: string | null
  parallel?: string | null
  bestAsk: number | null
  lastPurchasePrice: number | null
  specialSerialTraits: string[]
  truth?: UnifiedMarketTruth | null
}

export type MarketSnapshot = {
  momentId: string
  editionKey: string | null
  parallel: string | null
  marketKey: string | null

  lastPurchase: number | null
  asp5: number | null
  asp10: number | null
  asp30d: number | null

  bestOffer: number | null
  bestOfferSource:
    | "Top Shot Edition"
    | "Top Shot Serial"
    | "Flowty Serial"
    | "Top Shot Truth"
    | null
  bestOfferType: "edition" | "serial" | null

  bestBuyMarketplace: BestMarketplace
  bestSellMarketplace: BestMarketplace
  marketEdgeBuyLabel: string
  marketEdgeSellLabel: string

  anchorPrice: number | null
  anchorType: PriceAnchorType
  observedInputsCount: number
  truthScore: number
  truthLabel: "Observed+" | "Observed" | "Hybrid" | "Modeled"

  truthProbeStatus: UnifiedMarketTruth["probeStatus"]
  truthSourceSummary: string
  truthProbeNotes: string[]

  marketBackedAsk: number | null
  marketBackedLastSale: number | null
  marketBackedBestOffer: number | null

  topShotAsk: number | null
  flowtyAsk: number | null
  topShotBestOffer: number | null
  flowtyBestOffer: number | null
  flowscanLatestSale: number | null
  flowscanRecentSales: number[]
  flowscanAverageRecentSale: number | null
  flowscanSaleCount7d: number | null
  flowscanSaleCount30d: number | null

  fmvLow: number | null
  fmvMid: number | null
  fmvHigh: number | null
  fmvRangeWidthPct: number | null
  fmvMethod: string
  valuationScope: "Parallel" | "Edition" | "Modeled"

  discountPct: number | null
  premiumPct: number | null
  spreadPct: number | null
  priceGapToLastPurchasePct: number | null

  hasAsk: boolean
  hasBestOffer: boolean

  liquidityScore: number
  liquidityBand: LiquidityBand
  dealScore: number
  dealBand: DealBand
  confidence: MarketConfidence
  marketStatus: MarketStatus
  marketPriority: number
}

function hashString(input: string) {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function toRange(seed: number, min: number, max: number) {
  const normalized = (seed % 10000) / 10000
  return min + (max - min) * normalized
}

function round2(value: number | null) {
  return value === null ? null : Number(value.toFixed(2))
}

function computeModeledEditionBase(
  scopeKey: string | null,
  fallback: number | null
) {
  const seed = hashString(scopeKey ?? "none")
  const modeledBase = toRange(seed, 2, 180)

  if (fallback !== null) {
    return round2(fallback * 0.75 + modeledBase * 0.25)
  }

  return round2(modeledBase)
}

function hasSpecialSerialPremium(traits: string[]) {
  return traits.length > 0
}

function applySerialPremium(base: number | null, traits: string[]) {
  if (base === null) return null

  let multiplier = 1

  if (traits.includes("#1 Serial")) multiplier *= 1.35
  if (traits.includes("Perfect Mint")) multiplier *= 1.18
  if (traits.includes("Jersey Match")) multiplier *= 1.2
  if (traits.includes("First Mint")) multiplier *= 1.12
  if (traits.includes("Last Mint")) multiplier *= 1.08

  return round2(base * multiplier)
}

function computeConfidence(seed: number): MarketConfidence {
  const bucket = seed % 3
  if (bucket === 0) return "low"
  if (bucket === 1) return "medium"
  return "high"
}

function confidenceBonus(confidence: MarketConfidence) {
  if (confidence === "high") return 20
  if (confidence === "medium") return 10
  return 0
}

function safePct(numerator: number | null, denominator: number | null) {
  if (
    numerator === null ||
    denominator === null ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return null
  }

  return round2((numerator / denominator) * 100)
}

function computeMarketPriority(
  status: MarketStatus,
  dealScore: number,
  liquidity: number,
  truthScore: number
) {
  const base =
    status === "Deal"
      ? 500
      : status === "Watch"
        ? 400
        : status === "Fair"
          ? 300
          : status === "Premium"
            ? 200
            : status === "No Ask"
              ? 150
              : 100

  return base + dealScore + liquidity + Math.round(truthScore / 4)
}

function computeAnchor(
  bestAsk: number | null,
  lastPurchase: number | null,
  modeledBase: number | null
): {
  anchorPrice: number | null
  anchorType: PriceAnchorType
  observedInputsCount: number
} {
  const hasAsk = bestAsk !== null
  const hasSale = lastPurchase !== null

  if (hasAsk && hasSale) {
    return {
      anchorPrice: round2(bestAsk * 0.3 + lastPurchase * 0.7),
      anchorType: "ask+sale",
      observedInputsCount: 2,
    }
  }

  if (hasSale) {
    return {
      anchorPrice: round2(lastPurchase),
      anchorType: "sale",
      observedInputsCount: 1,
    }
  }

  if (hasAsk) {
    return {
      anchorPrice: round2(bestAsk),
      anchorType: "ask",
      observedInputsCount: 1,
    }
  }

  return {
    anchorPrice: round2(modeledBase),
    anchorType: "modeled",
    observedInputsCount: 0,
  }
}

function computeTruthScore(
  observedInputsCount: number,
  confidence: MarketConfidence,
  probeStatus: UnifiedMarketTruth["probeStatus"]
) {
  let score = 20 + observedInputsCount * 25

  if (confidence === "medium") score += 10
  if (confidence === "high") score += 20

  if (
    probeStatus === "docs-probe-success" ||
    probeStatus === "flowty-configured" ||
    probeStatus === "flowty-local-json" ||
    probeStatus === "combined"
  ) {
    score += 10
  } else if (
    probeStatus === "docs-probe-partial" ||
    probeStatus === "flowty-partial"
  ) {
    score += 5
  } else if (
    probeStatus === "docs-probe-failed" ||
    probeStatus === "flowty-failed"
  ) {
    score -= 5
  }

  return Math.max(0, Math.min(100, score))
}

function computeTruthLabel(
  anchorType: PriceAnchorType,
  truthScore: number
): "Observed+" | "Observed" | "Hybrid" | "Modeled" {
  if (anchorType === "ask+sale" && truthScore >= 70) return "Observed+"
  if (anchorType === "sale" || anchorType === "ask") return "Observed"
  if (anchorType === "modeled" && truthScore <= 35) return "Modeled"
  return "Hybrid"
}

function computeLiquidityBand(score: number): LiquidityBand {
  if (score >= 70) return "High"
  if (score >= 40) return "Medium"
  return "Low"
}

function computeDealBand(score: number): DealBand {
  if (score >= 60) return "Strong"
  if (score >= 30) return "Medium"
  return "Weak"
}

function computeBestMarketplaceForBuy(
  topShotAsk: number | null,
  flowtyAsk: number | null
): BestMarketplace {
  if (topShotAsk === null && flowtyAsk === null) return "Unknown"
  if (topShotAsk !== null && flowtyAsk === null) return "Top Shot"
  if (topShotAsk === null && flowtyAsk !== null) return "Flowty"
  if (topShotAsk === flowtyAsk) return "Tie"
  return (topShotAsk as number) < (flowtyAsk as number) ? "Top Shot" : "Flowty"
}

function computeBestMarketplaceForSell(
  topShotOffer: number | null,
  flowtyOffer: number | null
): BestMarketplace {
  if (topShotOffer === null && flowtyOffer === null) return "Unknown"
  if (topShotOffer !== null && flowtyOffer === null) return "Top Shot"
  if (topShotOffer === null && flowtyOffer !== null) return "Flowty"
  if (topShotOffer === flowtyOffer) return "Tie"
  return (topShotOffer as number) > (flowtyOffer as number) ? "Top Shot" : "Flowty"
}

function computeMarketEdgeBuyLabel(best: BestMarketplace) {
  if (best === "Top Shot") return "Buy on Top Shot"
  if (best === "Flowty") return "Buy on Flowty"
  if (best === "Tie") return "Buy anywhere"
  return "No buy edge"
}

function computeMarketEdgeSellLabel(best: BestMarketplace) {
  if (best === "Top Shot") return "Sell to Top Shot demand"
  if (best === "Flowty") return "Sell to Flowty demand"
  if (best === "Tie") return "Sell anywhere"
  return "No sell edge"
}

export function buildMarketSnapshot(input: SnapshotInput): MarketSnapshot {
  const momentId = String(input.momentId)
  const seed = hashString(
    `${momentId}:${input.editionKey ?? "none"}:${input.parallel ?? "base"}`
  )

  const truth = input.truth ?? null
  const probeStatus = truth?.probeStatus ?? "observed-only"
  const isSpecial = hasSpecialSerialPremium(input.specialSerialTraits)

  const topShotAsk = truth?.topShotAsk ?? input.bestAsk ?? null
  const flowtyAsk = truth?.flowtyAsk ?? null
  const topShotBestOffer = truth?.topShotBestOffer ?? null
  const flowtyBestOffer = truth?.flowtyBestOffer ?? null

  const effectiveAsk = truth?.marketBackedAsk ?? input.bestAsk ?? null
  const effectiveLastSale =
    truth?.marketBackedLastSale ?? input.lastPurchasePrice ?? null

  const modeledBase = computeModeledEditionBase(
    truth?.marketKey ?? input.editionKey ?? null,
    effectiveLastSale ?? effectiveAsk
  )

  const lastPurchase = round2(effectiveLastSale ?? modeledBase ?? null)
  const anchor = computeAnchor(effectiveAsk, lastPurchase, modeledBase)

  const asp5 = round2((modeledBase ?? 0) * toRange(seed + 11, 0.98, 1.04))
  const asp10 = round2((modeledBase ?? 0) * toRange(seed + 29, 0.96, 1.03))
  const asp30d = round2((modeledBase ?? 0) * toRange(seed + 47, 0.94, 1.02))

  const fallbackOffer =
    seed % 4 !== 0
      ? round2(Math.max(1, (modeledBase ?? 10) * toRange(seed + 71, 0.62, 0.97)))
      : null

  const bestOffer = truth?.marketBackedBestOffer ?? fallbackOffer ?? null

  const bestOfferSource =
    truth?.marketBackedBestOffer !== null &&
    truth?.marketBackedBestOffer !== undefined
      ? "Top Shot Truth"
      : bestOffer !== null
        ? (seed % 3 === 0
            ? "Top Shot Edition"
            : seed % 3 === 1
              ? "Top Shot Serial"
              : "Flowty Serial")
        : null

  const bestOfferType = bestOfferSource
    ? bestOfferSource === "Top Shot Truth" || bestOfferSource === "Top Shot Edition"
      ? "edition"
      : "serial"
    : null

  const confidence = computeConfidence(seed)

  const truthScore = computeTruthScore(
    truth?.observedSourceCount ?? anchor.observedInputsCount,
    confidence,
    probeStatus
  )

  const chainLatestSale = truth?.flowscanLatestSale ?? null
  const chainAverageSale = truth?.flowscanAverageRecentSale ?? null

  let baseFmv: number | null = null
  let fmvMethod = "modeled"

  if (!isSpecial) {
    if (effectiveAsk !== null && bestOffer !== null && bestOffer <= effectiveAsk) {
      const salesAnchor = chainAverageSale ?? chainLatestSale ?? lastPurchase
      let placement = 0.65

      if ((truth?.flowscanSaleCount30d ?? 0) >= 5) placement += 0.1
      if ((truth?.flowscanSaleCount7d ?? 0) >= 1) placement += 0.05
      if (confidence === "low") placement -= 0.1
      if (effectiveAsk - bestOffer > effectiveAsk * 0.35) placement -= 0.1

      placement = Math.max(0.25, Math.min(0.9, placement))

      const bandBased = bestOffer + (effectiveAsk - bestOffer) * placement
      baseFmv = round2(bandBased)

      if (salesAnchor !== null) {
        baseFmv = round2(baseFmv * 0.78 + salesAnchor * 0.22)
      }

      if (baseFmv !== null && effectiveAsk !== null) {
        baseFmv = round2(Math.min(baseFmv, effectiveAsk))
      }

      fmvMethod = "offer-ask band"
    } else if (effectiveAsk !== null) {
      if (chainAverageSale !== null) {
        baseFmv = round2(Math.min(effectiveAsk, effectiveAsk * 0.74 + chainAverageSale * 0.26))
        fmvMethod = "lowest ask + chain avg sale"
      } else if (chainLatestSale !== null) {
        baseFmv = round2(Math.min(effectiveAsk, effectiveAsk * 0.78 + chainLatestSale * 0.22))
        fmvMethod = "lowest ask + chain sale"
      } else if (lastPurchase !== null) {
        baseFmv = round2(Math.min(effectiveAsk, effectiveAsk * 0.8 + lastPurchase * 0.2))
        fmvMethod = "lowest ask + recent sale"
      } else {
        baseFmv = round2(effectiveAsk * 0.95)
        fmvMethod = "lowest ask anchored"
      }
    }
  }

  if (baseFmv === null) {
    baseFmv = round2(
      ((chainAverageSale ?? chainLatestSale ?? lastPurchase ?? anchor.anchorPrice ?? modeledBase ?? 0) *
        0.58) +
        ((effectiveAsk ?? anchor.anchorPrice ?? modeledBase ?? 0) * 0.18) +
        ((asp5 ?? 0) * 0.12) +
        ((asp10 ?? 0) * 0.07) +
        ((asp30d ?? 0) * 0.05)
    )

    fmvMethod = isSpecial ? "special serial premium model" : "blended market model"
  }

  const fmvCore = isSpecial
    ? applySerialPremium(
        baseFmv && baseFmv > 0 ? baseFmv : modeledBase,
        input.specialSerialTraits
      )
    : round2(baseFmv && baseFmv > 0 ? baseFmv : modeledBase)

  const widthMultiplier =
    truthScore >= 80 ? 0.05 : truthScore >= 60 ? 0.065 : truthScore >= 40 ? 0.08 : 0.1

  const fmvMid = fmvCore
  const fmvLow = round2(fmvMid === null ? null : fmvMid * (1 - widthMultiplier))
  const fmvHigh = round2(fmvMid === null ? null : fmvMid * (1 + widthMultiplier))

  const fmvRangeWidthPct =
    fmvLow !== null && fmvHigh !== null && fmvMid !== null
      ? safePct(fmvHigh - fmvLow, fmvMid)
      : null

  const discountPct =
    effectiveAsk !== null && fmvMid !== null && effectiveAsk < fmvMid
      ? safePct(fmvMid - effectiveAsk, fmvMid)
      : null

  const premiumPct =
    effectiveAsk !== null && fmvMid !== null && effectiveAsk > fmvMid
      ? safePct(effectiveAsk - fmvMid, fmvMid)
      : null

  const spreadPct =
    effectiveAsk !== null && bestOffer !== null
      ? safePct(effectiveAsk - bestOffer, effectiveAsk)
      : null

  const priceGapToLastPurchasePct =
    effectiveAsk !== null && lastPurchase !== null
      ? safePct(effectiveAsk - lastPurchase, lastPurchase)
      : null

  const hasAsk = effectiveAsk !== null
  const hasBestOffer = bestOffer !== null

  let liquidityScore = 0
  if (hasBestOffer) liquidityScore += 35

  if (spreadPct !== null) {
    if (spreadPct <= 8) liquidityScore += 35
    else if (spreadPct <= 18) liquidityScore += 25
    else if (spreadPct <= 35) liquidityScore += 15
    else liquidityScore += 5
  }

  if ((truth?.flowscanSaleCount30d ?? 0) >= 3) liquidityScore += 10
  if ((truth?.flowscanSaleCount7d ?? 0) >= 1) liquidityScore += 5

  liquidityScore += confidenceBonus(confidence)
  liquidityScore = Math.max(0, Math.min(100, liquidityScore))

  let dealScore = 0
  if (discountPct !== null) {
    dealScore += Math.max(0, Math.min(100, discountPct * 2.2))
  }
  dealScore += confidenceBonus(confidence)
  if (hasBestOffer) dealScore += 5
  dealScore += Math.round((truth?.observedSourceCount ?? anchor.observedInputsCount) * 3)
  dealScore = Math.max(0, Math.min(100, Math.round(dealScore)))

  let marketStatus: MarketStatus = "Watch"

  if (!hasAsk) {
    marketStatus = !hasBestOffer ? "Illiquid" : "No Ask"
  } else if ((discountPct ?? 0) >= 12) {
    marketStatus = "Deal"
  } else if ((discountPct ?? 0) > 0) {
    marketStatus = "Watch"
  } else if ((premiumPct ?? 0) <= 5) {
    marketStatus = "Fair"
  } else {
    marketStatus = "Premium"
  }

  const marketPriority = computeMarketPriority(
    marketStatus,
    dealScore,
    liquidityScore,
    truthScore
  )

  const bestBuyMarketplace = computeBestMarketplaceForBuy(topShotAsk, flowtyAsk)
  const bestSellMarketplace = computeBestMarketplaceForSell(
    topShotBestOffer,
    flowtyBestOffer
  )

  return {
    momentId,
    editionKey: input.editionKey,
    parallel: input.parallel ?? null,
    marketKey: truth?.marketKey ?? null,

    lastPurchase,
    asp5,
    asp10,
    asp30d,

    bestOffer,
    bestOfferSource,
    bestOfferType,

    bestBuyMarketplace,
    bestSellMarketplace,
    marketEdgeBuyLabel: computeMarketEdgeBuyLabel(bestBuyMarketplace),
    marketEdgeSellLabel: computeMarketEdgeSellLabel(bestSellMarketplace),

    anchorPrice: anchor.anchorPrice,
    anchorType: anchor.anchorType,
    observedInputsCount: truth?.observedSourceCount ?? anchor.observedInputsCount,
    truthScore,
    truthLabel: computeTruthLabel(anchor.anchorType, truthScore),

    truthProbeStatus: probeStatus,
    truthSourceSummary: truth?.sourceSummary ?? "Observed values only",
    truthProbeNotes: truth?.probeNotes ?? [],

    marketBackedAsk: effectiveAsk,
    marketBackedLastSale: effectiveLastSale,
    marketBackedBestOffer: bestOffer,

    topShotAsk,
    flowtyAsk,
    topShotBestOffer,
    flowtyBestOffer,
    flowscanLatestSale: truth?.flowscanLatestSale ?? null,
    flowscanRecentSales: truth?.flowscanRecentSales ?? [],
    flowscanAverageRecentSale: truth?.flowscanAverageRecentSale ?? null,
    flowscanSaleCount7d: truth?.flowscanSaleCount7d ?? null,
    flowscanSaleCount30d: truth?.flowscanSaleCount30d ?? null,

    fmvLow,
    fmvMid,
    fmvHigh,
    fmvRangeWidthPct,
    fmvMethod,
    valuationScope: input.parallel ? "Parallel" : input.editionKey ? "Edition" : "Modeled",

    discountPct,
    premiumPct,
    spreadPct,
    priceGapToLastPurchasePct,

    hasAsk,
    hasBestOffer,

    liquidityScore,
    liquidityBand: computeLiquidityBand(liquidityScore),
    dealScore,
    dealBand: computeDealBand(dealScore),
    confidence,
    marketStatus,
    marketPriority,
  }
}