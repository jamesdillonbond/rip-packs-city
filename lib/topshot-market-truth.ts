import { topshotGraphql } from "@/lib/topshot"
import { getOrSetCache } from "@/lib/cache"

export type TopShotTruthProbeStatus =
  | "observed-only"
  | "docs-probe-success"
  | "docs-probe-partial"
  | "docs-probe-failed"

export type TopShotMarketTruth = {
  editionKey: string | null
  setId: string | null
  playId: string | null

  marketBackedAsk: number | null
  marketBackedLastSale: number | null
  marketBackedBestOffer: number | null

  editionListingFloor: number | null
  editionLatestSale: number | null
  editionOfferMin: number | null
  editionOfferMax: number | null

  observedSourceCount: number
  probeStatus: TopShotTruthProbeStatus
  sourceSummary: string
  probeNotes: string[]
}

type TruthInput = {
  editionKey: string | null
  bestAsk: number | null
  lastPurchasePrice: number | null
}

const TTL_MS = 1000 * 60 * 5

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseEditionKey(editionKey: string | null) {
  if (!editionKey) {
    return {
      setId: null,
      playId: null,
    }
  }

  const [setId, playId] = editionKey.split(":")
  return {
    setId: setId ?? null,
    playId: playId ?? null,
  }
}

function firstNumberFromUnknown(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string") return toNum(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      const n = firstNumberFromUnknown(item)
      if (n !== null) return n
    }
  }

  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const n = firstNumberFromUnknown(v)
      if (n !== null) return n
    }
  }

  return null
}

function extractCandidateNumber(
  obj: Record<string, unknown> | null | undefined,
  candidateKeys: string[]
) {
  if (!obj) return null

  for (const key of candidateKeys) {
    if (key in obj) {
      const n = firstNumberFromUnknown(obj[key])
      if (n !== null) return n
    }
  }

  return null
}

async function probeEditionListings(setId: string, playId: string) {
  const query = `
    query SearchEditionListingsTruth($input: SearchEditionListingsInput!) {
      searchEditionListings(input: $input) {
        summary
        data
      }
    }
  `

  const input = {
    searchInput: {},
    filters: {
      editions: [{ setID: setId, playID: playId }],
    },
  }

  const data = await topshotGraphql<Record<string, unknown>>(query, { input })
  const root = data?.searchEditionListings as Record<string, unknown> | undefined

  const floorFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["floorPrice", "minPrice", "lowestPrice"]
  )

  let floorFromData: number | null = null
  const listingData = Array.isArray(root?.data) ? root?.data : []

  for (const item of listingData) {
    const n = firstNumberFromUnknown(item)
    if (n !== null) {
      floorFromData = floorFromData === null ? n : Math.min(floorFromData, n)
    }
  }

  return {
    editionListingFloor: floorFromSummary ?? floorFromData,
  }
}

async function probeOffersAggregation(setId: string, playId: string) {
  const query = `
    query SearchOffersAggregationTruth($input: SearchOffersAggregationInput!) {
      searchOffersAggregation(input: $input) {
        total
        summary
        data
      }
    }
  `

  const input = {
    searchInput: {},
    filters: {
      editions: [{ setID: setId, playID: playId }],
    },
  }

  const data = await topshotGraphql<Record<string, unknown>>(query, { input })
  const root = data?.searchOffersAggregation as Record<string, unknown> | undefined

  const minFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["minOffer", "minOfferAmount", "minimumOffer", "floorOffer"]
  )

  const maxFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["maxOffer", "maxOfferAmount", "highestOffer", "ceilingOffer"]
  )

  const dataField = Array.isArray(root?.data) ? root?.data : []
  let minFromData: number | null = null
  let maxFromData: number | null = null

  for (const item of dataField) {
    const n = firstNumberFromUnknown(item)
    if (n !== null) {
      minFromData = minFromData === null ? n : Math.min(minFromData, n)
      maxFromData = maxFromData === null ? n : Math.max(maxFromData, n)
    }
  }

  return {
    editionOfferMin: minFromSummary ?? minFromData,
    editionOfferMax: maxFromSummary ?? maxFromData,
  }
}

async function probeMarketplaceTransactions(setId: string, playId: string) {
  const query = `
    query SearchMarketplaceTransactionsTruth($input: SearchMarketplaceTransactionsInput!) {
      searchMarketplaceTransactions(input: $input) {
        summary
        data
      }
    }
  `

  const input = {
    searchInput: {},
    filters: {
      editions: [{ setID: setId, playID: playId }],
    },
  }

  const data = await topshotGraphql<Record<string, unknown>>(query, { input })
  const root = data?.searchMarketplaceTransactions as Record<string, unknown> | undefined

  const latestFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["latestSalePrice", "lastSalePrice", "recentSalePrice"]
  )

  const txData = Array.isArray(root?.data) ? root?.data : []
  const firstTx = txData[0]
  const latestFromData = firstNumberFromUnknown(firstTx)

  return {
    editionLatestSale: latestFromSummary ?? latestFromData,
  }
}

async function probeEditionStats(setId: string, playId: string) {
  const query = `
    query GetMarketplaceTransactionEditionStatsTruth($input: GetMarketplaceTransactionEditionStatsInput!) {
      getMarketplaceTransactionEditionStats(input: $input) {
        data
        summary
      }
    }
  `

  const input = {
    setID: setId,
    playID: playId,
  }

  const data = await topshotGraphql<Record<string, unknown>>(query, { input })
  const root = data?.getMarketplaceTransactionEditionStats as
    | Record<string, unknown>
    | undefined

  const latestFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["latestSalePrice", "lastSalePrice", "recentSalePrice"]
  )

  const avgFromSummary = extractCandidateNumber(
    (root?.summary as Record<string, unknown>) ?? undefined,
    ["averageSalePrice", "avgSalePrice"]
  )

  return {
    editionLatestSale: latestFromSummary ?? null,
    averageSalePrice: avgFromSummary,
  }
}

export async function getTopShotMarketTruth(
  input: TruthInput
): Promise<TopShotMarketTruth> {
  const cacheKey = [
    "topshot-truth",
    input.editionKey ?? "none",
    input.bestAsk ?? "na",
    input.lastPurchasePrice ?? "na",
    process.env.ENABLE_TOPSHOT_DOCS_PROBES ?? "false",
  ].join(":")

  return getOrSetCache(cacheKey, TTL_MS, async () => {
    const { setId, playId } = parseEditionKey(input.editionKey)

    const notes: string[] = []
    let editionListingFloor: number | null = null
    let editionLatestSale: number | null = null
    let editionOfferMin: number | null = null
    let editionOfferMax: number | null = null

    let probeStatus: TopShotTruthProbeStatus = "observed-only"

    if (
      setId &&
      playId &&
      process.env.ENABLE_TOPSHOT_DOCS_PROBES === "true"
    ) {
      let successCount = 0
      let failCount = 0

      try {
        const result = await probeEditionListings(setId, playId)
        editionListingFloor = result.editionListingFloor
        successCount += 1
      } catch (e) {
        failCount += 1
        notes.push(
          `editionListings: ${
            e instanceof Error ? e.message : "probe failed"
          }`
        )
      }

      try {
        const result = await probeOffersAggregation(setId, playId)
        editionOfferMin = result.editionOfferMin
        editionOfferMax = result.editionOfferMax
        successCount += 1
      } catch (e) {
        failCount += 1
        notes.push(
          `offersAggregation: ${
            e instanceof Error ? e.message : "probe failed"
          }`
        )
      }

      try {
        const result = await probeMarketplaceTransactions(setId, playId)
        editionLatestSale = result.editionLatestSale
        successCount += 1
      } catch (e) {
        failCount += 1
        notes.push(
          `marketplaceTransactions: ${
            e instanceof Error ? e.message : "probe failed"
          }`
        )
      }

      try {
        const result = await probeEditionStats(setId, playId)
        editionLatestSale = editionLatestSale ?? result.editionLatestSale ?? null
        successCount += 1
      } catch (e) {
        failCount += 1
        notes.push(
          `editionStats: ${e instanceof Error ? e.message : "probe failed"}`
        )
      }

      if (successCount > 0 && failCount === 0) probeStatus = "docs-probe-success"
      else if (successCount > 0) probeStatus = "docs-probe-partial"
      else probeStatus = "docs-probe-failed"
    }

    const marketBackedAsk = editionListingFloor ?? input.bestAsk ?? null
    const marketBackedLastSale = editionLatestSale ?? input.lastPurchasePrice ?? null
    const marketBackedBestOffer = editionOfferMax ?? null

    const observedSourceCount =
      (marketBackedAsk !== null ? 1 : 0) +
      (marketBackedLastSale !== null ? 1 : 0) +
      (marketBackedBestOffer !== null ? 1 : 0)

    const sourceSummary =
      probeStatus === "observed-only"
        ? "Observed minted-moment ask/sale only"
        : probeStatus === "docs-probe-success"
          ? "Observed values plus Top Shot docs-backed market probes"
          : probeStatus === "docs-probe-partial"
            ? "Observed values plus partial Top Shot docs-backed probes"
            : "Observed values; docs-backed probes attempted but failed"

    return {
      editionKey: input.editionKey,
      setId,
      playId,
      marketBackedAsk,
      marketBackedLastSale,
      marketBackedBestOffer,
      editionListingFloor,
      editionLatestSale,
      editionOfferMin,
      editionOfferMax,
      observedSourceCount,
      probeStatus,
      sourceSummary,
      probeNotes: notes,
    }
  })
}