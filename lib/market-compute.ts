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

  specialSerialTraits?: string[]
}

export type MarketTruthRow = {
  momentId: string
  fmv: number | null
  bestOffer: number | null
  lowAsk: number | null

  valuationScope: "Parallel" | "Edition" | "Modeled"
  isSpecialSerial: boolean
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
    | "none"

  marketConfidence: "high" | "medium" | "low" | "none"

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
}

function minNullable(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  if (!nums.length) return null
  return Math.min(...nums)
}

function maxNullable(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  if (!nums.length) return null
  return Math.max(...nums)
}

export function isSpecialSerial(traits?: string[] | null) {
  if (!Array.isArray(traits)) return false
  return traits.some((t) => ["#1", "Perfect Mint", "Jersey Match"].includes(t))
}

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
  const editionAskCount = typeof input.editionAskCount === "number" ? input.editionAskCount : 0
  const editionOfferCount = typeof input.editionOfferCount === "number" ? input.editionOfferCount : 0
  const editionSaleCount = typeof input.editionSaleCount === "number" ? input.editionSaleCount : 0
  const editionMarketTags = Array.isArray(input.editionMarketTags)
    ? input.editionMarketTags.filter((t): t is string => typeof t === "string")
    : []
  const editionMarketSourceChain = Array.isArray(input.editionMarketSourceChain)
    ? input.editionMarketSourceChain.filter((t): t is string => typeof t === "string")
    : []

  const mergedLowAsk = minNullable([rowLowAsk, editionLowAsk])
  const mergedBestOffer = maxNullable([rowBestOffer, editionBestOffer])

  const special = isSpecialSerial(input.specialSerialTraits)

  let fmv: number | null = null
  let marketSource: MarketTruthRow["marketSource"] = "none"
  let fmvMethod: MarketTruthRow["fmvMethod"] = "none"
  let marketConfidence: MarketTruthRow["marketConfidence"] = "none"

  const hasRowMarket = rowLowAsk !== null || rowBestOffer !== null
  const hasEditionAskOffer = editionLowAsk !== null || editionBestOffer !== null
  const hasEditionSale = editionLastSale !== null

  if (hasRowMarket && hasEditionAskOffer) marketSource = "row+edition"
  else if (hasRowMarket) marketSource = "row"
  else if (hasEditionAskOffer) marketSource = "edition"
  else if (hasEditionSale) marketSource = "edition-sale"

  if (!special) {
    if (mergedLowAsk !== null && mergedBestOffer !== null) {
      const midpoint = (mergedLowAsk + mergedBestOffer) / 2
      fmv = Math.max(mergedBestOffer, Math.min(mergedLowAsk, midpoint))
      fmvMethod = "band"
      marketConfidence =
        editionAskCount > 0 && editionOfferCount > 0 ? "high" : "medium"
    } else if (mergedLowAsk !== null) {
      fmv = mergedLowAsk
      fmvMethod = "low-ask-only"
      marketConfidence =
        rowLowAsk !== null
          ? "medium"
          : editionAskCount >= 2
            ? "medium"
            : "low"
    } else if (mergedBestOffer !== null) {
      fmv = mergedBestOffer
      fmvMethod = "best-offer-only"
      marketConfidence = editionOfferCount >= 2 ? "low" : "low"
    } else if (editionLastSale !== null) {
      fmv = editionLastSale
      fmvMethod = "edition-last-sale"
      marketSource = "edition-sale"
      marketConfidence = editionSaleCount >= 2 ? "low" : "low"
    }
  } else {
    const base =
      mergedLowAsk ?? mergedBestOffer ?? editionLastSale ?? input.lastPurchasePrice ?? null

    if (base !== null) {
      let multiplier = 1.5

      if (input.specialSerialTraits?.includes("#1")) multiplier = 2.5
      else if (input.specialSerialTraits?.includes("Perfect Mint")) multiplier = 2.2
      else if (input.specialSerialTraits?.includes("Jersey Match")) multiplier = 1.8

      fmv = base * multiplier
      fmvMethod = "special-serial-premium"
      marketSource = "special-serial"
      marketConfidence = "low"
    }
  }

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
    valuationScope: input.parallel ? "Parallel" : input.editionKey ? "Edition" : "Modeled",
    isSpecialSerial: special,
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
  }
}