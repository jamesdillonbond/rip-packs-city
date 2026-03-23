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
  jerseyNumber: number | null
  marketBackedAsk: number | null
  marketBackedLastSale: number | null
  marketBackedBestOffer: number | null
  editionListingFloor: number | null
  editionLatestSale: number | null
  editionAverageSale: number | null
  editionOfferMax: number | null
  editionListingCount: number | null
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
  if (!editionKey) return { setId: null, playId: null }
  const [setId, playId] = editionKey.split(":")
  return { setId: setId ?? null, playId: playId ?? null }
}

async function probeMarketplaceEdition(setId: string, playId: string) {
  const query = `
    query SearchMarketplaceEditions(
      $byEditions: [EditionsFilterInput] = []
      $searchInput: BaseSearchInput = {pagination: {direction: RIGHT, limit: 1, cursor: ""}}
    ) {
      searchMarketplaceEditions(input: {
        filters: { byEditions: $byEditions }
        sortBy: EDITION_CREATED_AT_DESC
        searchInput: $searchInput
      }) {
        data {
          searchSummary {
            data {
              size
              data {
                ... on MarketplaceEdition {
                  lowAsk
                  highestOffer
                  priceRange { min max __typename }
                  editionListingCount
                  averageSaleData { averagePrice numDays numSales __typename }
                  marketplaceStats {
                    averageSalePrice
                    highestOffer
                    __typename
                  }
                  play {
                    stats {
                      jerseyNumber
                      playerName
                      __typename
                    }
                    __typename
                  }
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
    }
  `

  const data = await topshotGraphql<Record<string, unknown>>(query, {
    byEditions: [{ setID: setId, playID: playId }],
    searchInput: { pagination: { direction: "RIGHT", limit: 1, cursor: "" } },
  })

  const editions =
    (data as any)
      ?.searchMarketplaceEditions
      ?.data
      ?.searchSummary
      ?.data
      ?.data ?? []

  const edition = editions[0] ?? null

  return {
    editionListingFloor: toNum(edition?.lowAsk ?? edition?.priceRange?.min),
    editionListingCount: toNum(edition?.editionListingCount),
    editionAverageSale: toNum(
      edition?.averageSaleData?.averagePrice ??
      edition?.marketplaceStats?.averageSalePrice
    ),
    editionOfferMax: toNum(
      edition?.highestOffer ??
      edition?.marketplaceStats?.highestOffer
    ),
    jerseyNumber: toNum(edition?.play?.stats?.jerseyNumber),
  }
}

async function probeRecentSales(setId: string, playId: string) {
  const query = `
    query SearchMarketplaceTransactions($input: SearchMarketplaceTransactionsInput!) {
      searchMarketplaceTransactions(input: $input) {
        data {
          searchSummary {
            data {
              ... on MarketplaceTransactions {
                data {
                  ... on MarketplaceTransaction {
                    price
                    updatedAt
                    __typename
                  }
                  __typename
                }
                __typename
              }
              __typename
            }
            __typename
          }
          __typename
        }
        __typename
      }
    }
  `

  const data = await topshotGraphql<Record<string, unknown>>(query, {
    input: {
      sortBy: "UPDATED_AT_DESC",
      filters: { byEditions: [{ setID: setId, playID: playId }] },
      searchInput: { pagination: { cursor: "", direction: "RIGHT", limit: 5 } },
    },
  })

  const transactions =
    (data as any)
      ?.searchMarketplaceTransactions
      ?.data
      ?.searchSummary
      ?.data
      ?.[0]
      ?.data ?? []

  const prices = transactions
    .map((tx: any) => toNum(tx?.price))
    .filter((p: number | null): p is number => p !== null)

  return { editionLatestSale: prices[0] ?? null }
}

async function probeTopOffers(setId: string, playId: string) {
  const query = `
    query GetTopOffers(
      $byEdition: EditionsFilterInput
      $byOfferTypes: [OfferType!]
      $limit: Int!
    ) {
      getTopOffers(input: {
        filters: { byEdition: $byEdition, byOfferTypes: $byOfferTypes }
        limit: $limit
      }) {
        offers {
          price
          offerType
          __typename
        }
        __typename
      }
    }
  `

  const data = await topshotGraphql<Record<string, unknown>>(query, {
    byEdition: { setID: setId, playID: playId },
    byOfferTypes: ["Edition"],
    limit: 5,
  })

  const offers = (data as any)?.getTopOffers?.offers ?? []
  const prices = offers
    .map((o: any) => toNum(o?.price))
    .filter((p: number | null): p is number => p !== null)

  return {
    editionOfferMax: prices.length > 0 ? Math.max(...prices) : null,
  }
}

export async function getTopShotMarketTruth(
  input: TruthInput
): Promise<TopShotMarketTruth> {
  const cacheKey = [
    "topshot-truth-v3",
    input.editionKey ?? "none",
    process.env.ENABLE_TOPSHOT_DOCS_PROBES ?? "false",
  ].join(":")

  return getOrSetCache(cacheKey, TTL_MS, async () => {
    const { setId, playId } = parseEditionKey(input.editionKey)

    const notes: string[] = []
    let editionListingFloor: number | null = null
    let editionLatestSale: number | null = null
    let editionAverageSale: number | null = null
    let editionOfferMax: number | null = null
    let editionListingCount: number | null = null
    let jerseyNumber: number | null = null
    let probeStatus: TopShotTruthProbeStatus = "observed-only"

    if (setId && playId && process.env.ENABLE_TOPSHOT_DOCS_PROBES === "true") {
      let successCount = 0
      let failCount = 0

      try {
        const result = await probeMarketplaceEdition(setId, playId)
        editionListingFloor = result.editionListingFloor
        editionListingCount = result.editionListingCount
        editionAverageSale = result.editionAverageSale
        editionOfferMax = result.editionOfferMax
        jerseyNumber = result.jerseyNumber
        successCount++
      } catch (e) {
        failCount++
        notes.push(`marketplaceEdition: ${e instanceof Error ? e.message : "failed"}`)
      }

      try {
        const result = await probeRecentSales(setId, playId)
        editionLatestSale = result.editionLatestSale
        successCount++
      } catch (e) {
        failCount++
        notes.push(`recentSales: ${e instanceof Error ? e.message : "failed"}`)
      }

      try {
        const result = await probeTopOffers(setId, playId)
        editionOfferMax = editionOfferMax ?? result.editionOfferMax
        successCount++
      } catch (e) {
        failCount++
        notes.push(`topOffers: ${e instanceof Error ? e.message : "failed"}`)
      }

      if (successCount > 0 && failCount === 0) probeStatus = "docs-probe-success"
      else if (successCount > 0) probeStatus = "docs-probe-partial"
      else probeStatus = "docs-probe-failed"
    }

    const marketBackedAsk = editionListingFloor ?? input.bestAsk ?? null
    const marketBackedLastSale =
      editionLatestSale ?? editionAverageSale ?? input.lastPurchasePrice ?? null
    const marketBackedBestOffer = editionOfferMax ?? null

    const observedSourceCount =
      (marketBackedAsk !== null ? 1 : 0) +
      (marketBackedLastSale !== null ? 1 : 0) +
      (marketBackedBestOffer !== null ? 1 : 0)

    return {
      editionKey: input.editionKey,
      setId,
      playId,
      jerseyNumber,
      marketBackedAsk,
      marketBackedLastSale,
      marketBackedBestOffer,
      editionListingFloor,
      editionLatestSale,
      editionAverageSale,
      editionOfferMax,
      editionListingCount,
      observedSourceCount,
      probeStatus,
      sourceSummary:
        probeStatus === "docs-probe-success"
          ? "Top Shot live market data"
          : probeStatus === "docs-probe-partial"
            ? "Top Shot partial market data"
            : probeStatus === "docs-probe-failed"
              ? "Top Shot probes failed"
              : "Observed values only",
      probeNotes: notes,
    }
  })
}