import { getEditionMarketMap, type EditionMarketResolved } from "@/lib/edition-market"
import { getExternalEditionMarketMap, type ExternalEditionMarketResolved } from "@/lib/external-market-adapter"
import {
  buildLiveEditionMarketMap,
  type LiveEditionMarketResolved,
  type LiveMarketInputRow,
} from "@/lib/edition-market-live"
import {
  buildEditionScopeKey,
  normalizeParallel,
  normalizeSetName,
} from "@/lib/wallet-normalize"

export type UnifiedMarketInputRow = {
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

export type UnifiedEditionMarket = {
  scopeKey: string
  lowAsk: number | null
  bestOffer: number | null
  lastSale: number | null
  askCount: number
  offerCount: number
  saleCount: number
  source: string | null
  sourceChain: string[]
  notes: string[]
  tags: string[]
}

function dedupeStrings(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))
  )
}

function toLiveRows(rows: UnifiedMarketInputRow[]): LiveMarketInputRow[] {
  return rows.map((row) => ({
    momentId: row.momentId,
    editionKey: row.editionKey ?? null,
    setName: row.setName ?? null,
    playerName: row.playerName ?? null,
    parallel: row.parallel ?? null,
    subedition: row.subedition ?? null,
    lowAsk: row.lowAsk ?? null,
    bestAsk: row.bestAsk ?? null,
    bestOffer: row.bestOffer ?? null,
    lastPurchasePrice: row.lastPurchasePrice ?? null,
  }))
}

function mergeResolvedMarkets(input: {
  scopeKey: string
  live?: LiveEditionMarketResolved | null
  external?: ExternalEditionMarketResolved | null
  seeded?: EditionMarketResolved | null
  futureDb?: Partial<UnifiedEditionMarket> | null
}): UnifiedEditionMarket {
  const { scopeKey, live, external, seeded, futureDb } = input

  const lowAsk =
    external?.lowAsk ??
    live?.lowAsk ??
    futureDb?.lowAsk ??
    seeded?.lowAsk ??
    null

  const bestOffer =
    external?.bestOffer ??
    live?.bestOffer ??
    futureDb?.bestOffer ??
    seeded?.bestOffer ??
    null

  const lastSale =
    futureDb?.lastSale ??
    external?.lastSale ??
    seeded?.lastSale ??
    live?.lastSale ??
    null

  const askCount =
    external?.askCount ??
    live?.askCount ??
    futureDb?.askCount ??
    0

  const offerCount =
    external?.offerCount ??
    live?.offerCount ??
    futureDb?.offerCount ??
    0

  const saleCount =
    external?.saleCount ??
    live?.saleCount ??
    futureDb?.saleCount ??
    0

  const sourceChain = dedupeStrings([
    external?.source ?? null,
    live?.source ?? null,
    futureDb?.source ?? null,
    seeded?.source ?? null,
  ])

  const notes = dedupeStrings([
    ...(external?.notes ?? []),
    ...(live?.notes ?? []),
    ...(futureDb?.notes ?? []),
    ...(seeded?.notes ?? []),
  ])

  const tags = dedupeStrings([
    ...(external?.tags ?? []),
    ...(live?.tags ?? []),
    ...(futureDb?.tags ?? []),
    ...(seeded?.tags ?? []),
  ])

  return {
    scopeKey,
    lowAsk,
    bestOffer,
    lastSale,
    askCount,
    offerCount,
    saleCount,
    source: sourceChain[0] ?? null,
    sourceChain,
    notes,
    tags,
  }
}

// Placeholder DB adapter.
// This remains intentionally empty today, but the slot is preserved so a
// future RPC DB or indexed Flowscan sales layer can be merged without
// changing the wallet page contract again.
async function getFutureDbMarketMap(
  scopeKeys: string[]
): Promise<Map<string, Partial<UnifiedEditionMarket>>> {
  const out = new Map<string, Partial<UnifiedEditionMarket>>()
  for (const key of scopeKeys) {
    out.set(key, {})
  }
  return out
}

export async function buildUnifiedEditionMarketMap(rows: UnifiedMarketInputRow[]) {
  const liveMap = buildLiveEditionMarketMap(toLiveRows(rows))
  const externalMap = await getExternalEditionMarketMap()
  const seededMap = await getEditionMarketMap()

  const scopeKeys = Array.from(
    new Set(
      rows.map((row) =>
        buildEditionScopeKey({
          editionKey: row.editionKey ?? null,
          setName: normalizeSetName(row.setName ?? null),
          playerName: row.playerName ?? null,
          parallel: normalizeParallel(row.parallel ?? row.subedition ?? ""),
          subedition: normalizeParallel(row.subedition ?? row.parallel ?? ""),
        })
      )
    )
  )

  const futureDbMap = await getFutureDbMarketMap(scopeKeys)

  const out = new Map<string, UnifiedEditionMarket>()

  for (const scopeKey of scopeKeys) {
    out.set(
      scopeKey,
      mergeResolvedMarkets({
        scopeKey,
        live: liveMap.get(scopeKey) ?? null,
        external: externalMap.get(scopeKey) ?? null,
        seeded: seededMap.get(scopeKey) ?? null,
        futureDb: futureDbMap.get(scopeKey) ?? null,
      })
    )
  }

  return out
}
