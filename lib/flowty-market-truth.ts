import { getOrSetCache } from "@/lib/cache"
import { loadLocalJsonFeed } from "@/lib/local-market-files"
import { buildMarketScopeKey, normalizeParallel } from "@/lib/market-scope"

export type FlowtyTruthProbeStatus =
  | "disabled"
  | "local-json"
  | "configured"
  | "partial"
  | "failed"

export type FlowtyMarketTruth = {
  editionKey: string | null
  parallel: string | null
  marketKey: string
  flowtyFloorAsk: number | null
  flowtyLatestSale: number | null
  flowtyBestOffer: number | null
  sourceUrl: string | null
  lastVerifiedAt: string | null
  notes: string[]
  probeStatus: FlowtyTruthProbeStatus
  sourceSummary: string
  probeNotes: string[]
}

type FlowtyTruthInput = {
  editionKey: string | null
  parallel?: string | null
}

type FlowtyApiRow = {
  marketKey?: string | null
  editionKey?: string | null
  parallel?: string | null
  floorAsk?: number | string | null
  latestSale?: number | string | null
  bestOffer?: number | string | null
  sourceUrl?: string | null
  lastVerifiedAt?: string | null
  notes?: string[] | null
}

const TTL_MS = 1000 * 60 * 5

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

async function fetchFromConfiguredEndpoint(
  editionKey: string,
  parallel: string | null
): Promise<FlowtyApiRow | null> {
  const baseUrl = process.env.FLOWTY_MARKET_BASE_URL?.trim()
  if (!baseUrl) return null

  const url = new URL(baseUrl)
  url.searchParams.set("editionKey", editionKey)
  if (parallel) {
    url.searchParams.set("parallel", parallel)
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
  })

  if (!res.ok) {
    throw new Error(`Flowty endpoint failed with ${res.status}`)
  }

  const json = (await res.json()) as unknown

  if (Array.isArray(json)) {
    const marketKey = buildMarketScopeKey(editionKey, parallel)
    const match = json.find((item) => {
      if (!item || typeof item !== "object") return false
      const row = item as FlowtyApiRow
      const rowKey =
        row.marketKey ?? buildMarketScopeKey(row.editionKey, row.parallel)
      return rowKey === marketKey
    })
    return (match as FlowtyApiRow | undefined) ?? null
  }

  if (json && typeof json === "object") {
    return json as FlowtyApiRow
  }

  return null
}

export async function getFlowtyMarketTruth(
  input: FlowtyTruthInput
): Promise<FlowtyMarketTruth> {
  const parallel = normalizeParallel(input.parallel)
  const marketKey = buildMarketScopeKey(input.editionKey, parallel)

  const cacheKey = [
    "flowty-truth",
    marketKey,
    process.env.ENABLE_FLOWTY_MARKET_PROBES ?? "false",
    process.env.FLOWTY_MARKET_BASE_URL ?? "unset",
  ].join(":")

  return getOrSetCache(cacheKey, TTL_MS, async () => {
    const notes: string[] = []

    if (!input.editionKey) {
      return {
        editionKey: null,
        parallel,
        marketKey,
        flowtyFloorAsk: null,
        flowtyLatestSale: null,
        flowtyBestOffer: null,
        sourceUrl: null,
        lastVerifiedAt: null,
        notes: [],
        probeStatus: "failed",
        sourceSummary: "No edition key available for Flowty probe",
        probeNotes: ["editionKey missing"],
      }
    }

    const localRows = await loadLocalJsonFeed<FlowtyApiRow>("flowty-market-data.json")
    const localMatch =
      localRows.find((row) => {
        const rowKey =
          row.marketKey ?? buildMarketScopeKey(row.editionKey, row.parallel)
        return rowKey === marketKey
      }) ?? null

    if (localMatch) {
      return {
        editionKey: input.editionKey,
        parallel,
        marketKey,
        flowtyFloorAsk: toNum(localMatch.floorAsk),
        flowtyLatestSale: toNum(localMatch.latestSale),
        flowtyBestOffer: toNum(localMatch.bestOffer),
        sourceUrl: localMatch.sourceUrl ?? null,
        lastVerifiedAt: localMatch.lastVerifiedAt ?? null,
        notes: toStringArray(localMatch.notes),
        probeStatus: "local-json",
        sourceSummary: "Flowty local JSON feed returned market data",
        probeNotes: notes,
      }
    }

    if (process.env.ENABLE_FLOWTY_MARKET_PROBES !== "true") {
      return {
        editionKey: input.editionKey,
        parallel,
        marketKey,
        flowtyFloorAsk: null,
        flowtyLatestSale: null,
        flowtyBestOffer: null,
        sourceUrl: null,
        lastVerifiedAt: null,
        notes: [],
        probeStatus: "disabled",
        sourceSummary: "Flowty probes disabled and no local JSON match",
        probeNotes: [
          ...notes,
          "Add public/flowty-market-data.json rows or enable FLOWTY probes",
        ],
      }
    }

    if (!process.env.FLOWTY_MARKET_BASE_URL) {
      return {
        editionKey: input.editionKey,
        parallel,
        marketKey,
        flowtyFloorAsk: null,
        flowtyLatestSale: null,
        flowtyBestOffer: null,
        sourceUrl: null,
        lastVerifiedAt: null,
        notes: [],
        probeStatus: "failed",
        sourceSummary: "Flowty probes enabled but no configured endpoint",
        probeNotes: [...notes, "Set FLOWTY_MARKET_BASE_URL in .env.local"],
      }
    }

    try {
      const row = await fetchFromConfiguredEndpoint(input.editionKey, parallel)

      if (!row) {
        return {
          editionKey: input.editionKey,
          parallel,
          marketKey,
          flowtyFloorAsk: null,
          flowtyLatestSale: null,
          flowtyBestOffer: null,
          sourceUrl: null,
          lastVerifiedAt: null,
          notes: [],
          probeStatus: "partial",
          sourceSummary: "Flowty endpoint reachable but returned no scope row",
          probeNotes: [...notes, "No matching Flowty row returned"],
        }
      }

      const populatedCount =
        (toNum(row.floorAsk) !== null ? 1 : 0) +
        (toNum(row.latestSale) !== null ? 1 : 0) +
        (toNum(row.bestOffer) !== null ? 1 : 0)

      return {
        editionKey: input.editionKey,
        parallel,
        marketKey,
        flowtyFloorAsk: toNum(row.floorAsk),
        flowtyLatestSale: toNum(row.latestSale),
        flowtyBestOffer: toNum(row.bestOffer),
        sourceUrl: row.sourceUrl ?? null,
        lastVerifiedAt: row.lastVerifiedAt ?? null,
        notes: toStringArray(row.notes),
        probeStatus: populatedCount >= 2 ? "configured" : "partial",
        sourceSummary:
          populatedCount >= 2
            ? "Flowty configured endpoint returned market data"
            : "Flowty configured endpoint returned partial market data",
        probeNotes: notes,
      }
    } catch (e) {
      return {
        editionKey: input.editionKey,
        parallel,
        marketKey,
        flowtyFloorAsk: null,
        flowtyLatestSale: null,
        flowtyBestOffer: null,
        sourceUrl: null,
        lastVerifiedAt: null,
        notes: [],
        probeStatus: "failed",
        sourceSummary: "Flowty endpoint probe failed",
        probeNotes: [...notes, e instanceof Error ? e.message : "Unknown Flowty probe error"],
      }
    }
  })
}