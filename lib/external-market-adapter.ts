import { getOrSetCache } from "@/lib/cache"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type ExternalMarketRow = {
  scopeKey?: string | null
  editionKey?: string | null
  setName?: string | null
  playerName?: string | null
  parallel?: string | null
  subedition?: string | null

  lowAsk?: number | string | null
  bestOffer?: number | string | null
  lastSale?: number | string | null

  askCount?: number | string | null
  offerCount?: number | string | null
  saleCount?: number | string | null

  source?: string | null
  notes?: string[] | null
  tags?: string[] | null
}

export type ExternalEditionMarketResolved = {
  scopeKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string | null
  notes: string[]
  tags: string[]
}

const TTL_MS = 1000 * 60 * 2

function toNum(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function toCount(value: unknown) {
  const parsed = toNum(value)
  if (parsed === null) return 0
  return Math.max(0, Math.floor(parsed))
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
}

function buildScopeKey(row: ExternalMarketRow) {
  if (typeof row.scopeKey === "string" && row.scopeKey.trim().length > 0) {
    return row.scopeKey.trim()
  }

  return buildEditionScopeKey({
    editionKey: row.editionKey ?? null,
    setName: normalizeSetName(row.setName ?? null),
    playerName: row.playerName ?? null,
    parallel: normalizeParallel(row.parallel ?? row.subedition ?? ""),
    subedition: normalizeParallel(row.subedition ?? row.parallel ?? ""),
  })
}

async function fetchExternalRows(): Promise<ExternalMarketRow[]> {
  const url = process.env.RPC_EXTERNAL_MARKET_URL?.trim()
  if (!url) return []

  return getOrSetCache(`external-market-url:${url}`, TTL_MS, async () => {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    })

    if (!response.ok) {
      throw new Error(`External market adapter failed with ${response.status}`)
    }

    const json = (await response.json()) as unknown
    return Array.isArray(json) ? (json as ExternalMarketRow[]) : []
  })
}

export async function getExternalEditionMarketMap() {
  const rows = await fetchExternalRows()
  const map = new Map<string, ExternalEditionMarketResolved>()

  for (const row of rows) {
    const scopeKey = buildScopeKey(row)

    map.set(scopeKey, {
      scopeKey,
      lowAsk: toNum(row.lowAsk),
      bestOffer: toNum(row.bestOffer),
      lastSale: toNum(row.lastSale),
      askCount: toCount(row.askCount),
      offerCount: toCount(row.offerCount),
      saleCount: toCount(row.saleCount),
      source: row.source ?? "external-market-json",
      notes: toStringArray(row.notes),
      tags: toStringArray(row.tags),
    })
  }

  return map
}
