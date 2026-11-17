import { buildEditionScopeKey } from "@/lib/wallet-normalize"

export type LiveMarketInputRow = {
  momentId: string
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null
  lowAsk?: number | null
  bestAsk?: number | null
  bestOffer?: number | null
  lastPurchasePrice?: number | null
}

export type LiveEditionMarketResolved = {
  scopeKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string
  notes: string[]
  tags: string[]
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

function median(values: number[]) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

export function buildLiveEditionMarketMap(rows: LiveMarketInputRow[]) {
  const grouped = new Map<
    string,
    {
      lowAsks: number[]
      bestOffers: number[]
      lastSales: number[]
    }
  >()

  for (const row of rows) {
    const scopeKey = buildEditionScopeKey({
      editionKey: row.editionKey ?? null,
      setName: row.setName ?? null,
      playerName: row.playerName ?? null,
      parallel: row.parallel ?? row.subedition ?? null,
      subedition: row.subedition ?? row.parallel ?? null,
    })

    const current = grouped.get(scopeKey) ?? {
      lowAsks: [],
      bestOffers: [],
      lastSales: [],
    }

    const rowLowAsk = minNullable([row.lowAsk, row.bestAsk])
    const rowBestOffer = maxNullable([row.bestOffer])
    const rowLastSale =
      typeof row.lastPurchasePrice === "number" && Number.isFinite(row.lastPurchasePrice)
        ? row.lastPurchasePrice
        : null

    if (rowLowAsk !== null) current.lowAsks.push(rowLowAsk)
    if (rowBestOffer !== null) current.bestOffers.push(rowBestOffer)
    if (rowLastSale !== null) current.lastSales.push(rowLastSale)

    grouped.set(scopeKey, current)
  }

  const out = new Map<string, LiveEditionMarketResolved>()

  for (const [scopeKey, value] of grouped.entries()) {
    const lowAsk = value.lowAsks.length ? Math.min(...value.lowAsks) : null
    const bestOffer = value.bestOffers.length ? Math.max(...value.bestOffers) : null

    const saleMedian = median(value.lastSales)
    const lastSale =
      saleMedian !== null
        ? Number(saleMedian.toFixed(2))
        : value.lastSales.length
          ? value.lastSales[0]
          : null

    out.set(scopeKey, {
      scopeKey,
      lowAsk,
      bestOffer,
      lastSale,
      askCount: value.lowAsks.length,
      offerCount: value.bestOffers.length,
      saleCount: value.lastSales.length,
      source: "live-row-aggregate",
      notes: ["Built from currently loaded live row market inputs"],
      tags: ["live", "aggregate"],
    })
  }

  return out
}