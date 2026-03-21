import { getOrSetCache } from "@/lib/cache"

export type MarketSource =
  | "live-row-aggregate"
  | "edition-sale"
  | "row-fallback"
  | "none"

export type FMVMethod =
  | "edition-low-ask"
  | "edition-last-sale"
  | "low-ask-only"
  | "none"

export type MarketTruth = {
  scopeKey: string

  rowLowAsk: number | null
  rowOffer: number | null

  editionLowAsk: number | null
  editionOffer: number | null
  lastSale: number | null

  askCount: number
  offerCount: number
  saleCount: number

  fmv: number | null
  fmvMethod: FMVMethod
  confidence: "high" | "medium" | "low"

  marketSource: MarketSource
  reason: string
}

const TTL = 1000 * 60 * 2

type InputRow = {
  editionKey: string | null
  parallel: string
  bestAsk?: number | null
  lastPurchasePrice?: number | null
}

export async function getMarketTruth(rows: InputRow[]): Promise<Map<string, MarketTruth>> {
  return getOrSetCache("market-truth:v2", TTL, async () => {
    const map = new Map<string, MarketTruth>()

    const groups = new Map<string, InputRow[]>()

    for (const row of rows) {
      const key = `${row.editionKey ?? "unknown"}::${row.parallel}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }

    for (const [scopeKey, group] of groups.entries()) {
      const asks = group
        .map((r) => r.bestAsk ?? null)
        .filter((v): v is number => v !== null)

      const sales = group
        .map((r) => r.lastPurchasePrice ?? null)
        .filter((v): v is number => v !== null)

      const editionLowAsk =
        asks.length > 0 ? Math.min(...asks) : null

      const lastSale =
        sales.length > 0
          ? sales.sort((a, b) => b - a)[0]
          : null

      let fmv: number | null = null
      let fmvMethod: FMVMethod = "none"
      let confidence: "high" | "medium" | "low" = "low"
      let reason = "No market inputs"
      let marketSource: MarketSource = "none"

      if (editionLowAsk !== null) {
        fmv = editionLowAsk
        fmvMethod = "edition-low-ask"
        confidence = "high"
        reason = "Using edition low ask"
        marketSource = "live-row-aggregate"
      } else if (lastSale !== null) {
        fmv = lastSale
        fmvMethod = "edition-last-sale"
        confidence = "low"
        reason = "Using last sale fallback"
        marketSource = "edition-sale"
      }

      map.set(scopeKey, {
        scopeKey,

        rowLowAsk: editionLowAsk,
        rowOffer: null,

        editionLowAsk,
        editionOffer: null,
        lastSale,

        askCount: asks.length,
        offerCount: 0,
        saleCount: sales.length,

        fmv,
        fmvMethod,
        confidence,
        marketSource,
        reason,
      })
    }

    return map
  })
}