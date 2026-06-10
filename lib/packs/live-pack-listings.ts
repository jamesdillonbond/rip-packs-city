// lib/packs/live-pack-listings.ts
//
// Shared live sealed-pack listings fetch against the Dapper Studio internal
// GraphQL endpoint (api.production.studio-platform.dapperlabs.com). This was
// previously inline in app/api/pack-listings/route.ts; extracted 2026-06-09 so
// the Pack Sniper deal feed (lib/packs/pack-deals.ts) and the packs page
// (/api/pack-listings) share one fetch + one 2-minute cache instead of hitting
// Dapper Studio twice.
//
// The endpoint is a unified internal API across all Dapper marketplaces — same
// searchPackNftAggregation schema, different `type_name` and reserve owner per
// collection. AllDay was added 2026-05-19 as part of the packs page cleanup:
// AllDay is secondary-only going forward (no primary pack drops), so the live
// secondary low ask is the only meaningful price anchor for AllDay pack EV.
//
// reserveOwner: the contract account address (without 0x) that holds
// pre-minted PackNFTs before sale. We exclude listings from this address so the
// lowest ask reflects collector-held secondary listings, not primary retail
// inventory.

import { normalizePackRetailPrice } from "@/lib/packs/normalize-retail-price"

const TOPSHOT_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  Origin: "https://nbatopshot.com",
  Referer: "https://nbatopshot.com/",
}

const PACK_LISTINGS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!], $sortBy: PackNftSortAggregation) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters, sortBy: $sortBy}) {
      pageInfo { endCursor hasNextPage }
      totalCount
      edges {
        node {
          dist_id { key value }
          listing { price { min } }
          distribution {
            id { value }
            uuid { value }
            image_urls { value }
            number_of_pack_slots { value }
            pack_type { value }
            price { value }
            start_time { value }
            tier { value }
            title { value }
          }
        }
      }
    }
  }
`

export type PackCollectionSlug = "nba-top-shot" | "nfl-all-day"

const COLLECTION_CONFIG: Record<
  PackCollectionSlug,
  { typeName: string; reserveOwner: string; cacheKey: string }
> = {
  "nba-top-shot": {
    typeName: "A.0b2a3299cc857e29.PackNFT.NFT",
    reserveOwner: "0b2a3299cc857e29",
    cacheKey: "listings:nba-top-shot",
  },
  "nfl-all-day": {
    typeName: "A.e4cf4bdc1751c65d.PackNFT.NFT",
    reserveOwner: "e4cf4bdc1751c65d",
    cacheKey: "listings:nfl-all-day",
  },
}

export const SUPPORTED_PACK_COLLECTIONS = Object.keys(COLLECTION_CONFIG) as PackCollectionSlug[]

export function isSupportedPackCollection(slug: string): slug is PackCollectionSlug {
  return slug in COLLECTION_CONFIG
}

function buildFilters(cfg: { typeName: string; reserveOwner: string }) {
  return [
    {
      status: { eq: "Sealed" },
      listing: {
        exists: true,
        ft_vault_type: { eq: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault" },
      },
      owner_address: { ne: cfg.reserveOwner },
      excludeReserved: { eq: true },
      type_name: { eq: cfg.typeName },
      distribution: {
        tier: { ignore_case: true, in: [] },
        series_ids: { contains: [], contains_type: "ANY" },
        title: { ignore_case: true, partial_match: true, in: [] },
      },
    },
  ]
}

// Every scalar can come back null on a node — AllDay distributions in
// particular carry a null `title` (the known AllDay data-parity gap), which
// crashed the whole map before the null-guards below (handoff 2026-06-09).
type PackDistribution = {
  id?: { value: string | null } | null
  uuid?: { value: string | null } | null
  image_urls?: { value: string[] | null } | null
  number_of_pack_slots?: { value: string | null } | null
  pack_type?: { value: string | null } | null
  price?: { value: number | null } | null
  start_time?: { value: string | null } | null
  tier?: { value: string | null } | null
  title?: { value: string | null } | null
}

type PackNode = {
  dist_id: { key: string; value: string }
  listing: { price: { min: string } }
  distribution: PackDistribution
}

type GraphQLResponse = {
  data?: {
    searchPackNftAggregation?: {
      pageInfo: { endCursor: string; hasNextPage: boolean }
      totalCount: number
      edges: { node: PackNode }[]
    }
  }
  errors?: { message: string }[]
}

export type PackType = "standard" | "topper" | "chance_hit" | "reward" | "bundle"

export type PackListing = {
  packListingId: string
  distId: string
  title: string
  tier: string
  imageUrl: string
  momentsPerPack: number
  retailPrice: number
  lowestAsk: number
  startTime: string
  /**
   * NOTE (2026-06-09): structurally ALWAYS 1. searchPackNftAggregation returns
   * one aggregated node per dist_id (measured: 1,901 nodes = 1,901 distinct
   * dists), so the per-dist group below never accumulates more than one node.
   * This is NOT the true "X For Sale" count Top Shot shows — do not present it
   * as a listing count. The Pack Sniper board dropped its LISTINGS column for
   * this reason; the field stays here only so /api/pack-listings consumers
   * (PackPageClient) keep their shape.
   */
  listingCount: number
  packType: PackType
  seriesLabel: string
}

function seriesLabelFromStartTime(startTime: string): string {
  if (!startTime) return "Unknown"
  const d = new Date(startTime)
  if (isNaN(d.getTime())) return "Unknown"
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() // 0-indexed
  // July = 6
  if (y < 2021 || (y === 2021 && m < 6)) return "Series 1"
  if ((y === 2021 && m >= 6) || (y === 2022 && m < 6)) return "Series 2"
  if ((y === 2022 && m >= 6) || (y === 2023 && m < 6)) return "Series 3"
  if ((y === 2023 && m >= 6) || (y === 2024 && m < 6)) return "Series 2023-24"
  if ((y === 2024 && m >= 6) || (y === 2025 && m < 6)) return "Series 2024-25"
  return "Series 2025-26"
}

// Per-collection cache, keyed by COLLECTION_CONFIG.cacheKey so AllDay and TS
// responses don't stomp each other. Module-level so it survives across requests
// on a warm lambda (Fluid Compute reuses instances).
const listingsCache = new Map<string, { data: PackListing[]; expiresAt: number }>()
const CACHE_TTL_MS = 2 * 60 * 1000

function tierOrder(tier: string): number {
  if (tier === "ultimate") return 0
  if (tier === "legendary") return 1
  if (tier === "rare") return 2
  if (tier === "fandom") return 3
  return 4
}

function classifyPackType(title: string | null | undefined, slots: number, retailPrice: number): PackType {
  const t = (title ?? "").toLowerCase()
  if (slots >= 10) return "bundle"
  if (t.includes("topper")) return "topper"
  if (t.includes("chance hit") || t.includes("chance-hit")) return "chance_hit"
  if (slots === 1) {
    if (retailPrice === 0) return "reward"
    if (t.includes("reward") || t.includes("airdrop")) return "reward"
    return "chance_hit"
  }
  if (slots <= 3) {
    if (retailPrice === 0) return "reward"
    if (t.includes("reward") || t.includes("airdrop") || t.includes("fast break")) return "reward"
    if (t.includes("chance") || t.includes("premium")) return "chance_hit"
  }
  return "standard"
}

/**
 * Fetch + aggregate live sealed-pack secondary listings for a collection.
 * Returns one PackListing per dist_id (lowest collector ask + listing count),
 * sorted bundle-last / tier / lowest-ask. Memoized for 2 minutes per collection.
 *
 * Throws on a GraphQL error so the caller can surface it.
 */
export async function fetchLivePackListings(
  collection: PackCollectionSlug,
  opts: { force?: boolean } = {},
): Promise<{ listings: PackListing[]; cached: boolean }> {
  const cfg = COLLECTION_CONFIG[collection]

  if (!opts.force) {
    const cached = listingsCache.get(cfg.cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return { listings: cached.data, cached: true }
    }
  }

  const filters = buildFilters(cfg)
  const allNodes: PackNode[] = []
  let cursor: string | undefined = undefined
  let hasMore = true

  while (hasMore) {
    const res = await fetch(TOPSHOT_GRAPHQL, {
      method: "POST",
      headers: GRAPHQL_HEADERS,
      body: JSON.stringify({
        operationName: "searchPackNftAggregation_searchPacks",
        query: PACK_LISTINGS_QUERY,
        variables: { first: 2000, after: cursor, filters },
      }),
    })

    const json = (await res.json()) as GraphQLResponse
    if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error")

    const connection = json.data?.searchPackNftAggregation
    const edges = connection?.edges ?? []
    for (const edge of edges) {
      if (edge?.node) allNodes.push(edge.node)
    }

    hasMore = connection?.pageInfo?.hasNextPage === true
    cursor = connection?.pageInfo?.endCursor ?? undefined
  }

  const packMap = new Map<string, { node: PackNode; count: number; lowestAsk: number }>()
  for (const node of allNodes) {
    const distId = node.dist_id?.value
    if (!distId) continue
    const askRaw = parseInt(node.listing?.price?.min ?? "0", 10)
    const ask = askRaw / 100000000
    const existing = packMap.get(distId)
    if (existing) {
      existing.count += 1
      if (ask > 0 && (existing.lowestAsk === 0 || ask < existing.lowestAsk)) existing.lowestAsk = ask
    } else {
      packMap.set(distId, { node, count: 1, lowestAsk: ask > 0 ? ask : 0 })
    }
  }

  const listings: PackListing[] = Array.from(packMap.entries()).map(
    ([distId, { node, count, lowestAsk }]) => {
      // Defensive: any distribution scalar can be null on a node (AllDay's
      // null-title gap is the one that crashed the whole map). Every field
      // below must tolerate a missing distribution / value object.
      const d = node.distribution ?? null
      const retailPrice = normalizePackRetailPrice(d?.price?.value ?? 0)
      const slots = parseInt(d?.number_of_pack_slots?.value ?? "1", 10) || 1
      const title = d?.title?.value ?? `Pack #${distId}`
      const packType = classifyPackType(title, slots, retailPrice)
      const startTime = d?.start_time?.value ?? ""
      return {
        packListingId: d?.uuid?.value ?? distId,
        distId,
        title,
        tier: d?.tier?.value ?? "common",
        imageUrl: d?.image_urls?.value?.[0] ?? "",
        momentsPerPack: slots,
        retailPrice,
        lowestAsk,
        startTime,
        listingCount: count,
        packType,
        seriesLabel: seriesLabelFromStartTime(startTime),
      }
    },
  )

  listings.sort((a, b) => {
    const aIsBundle = a.packType === "bundle" ? 1 : 0
    const bIsBundle = b.packType === "bundle" ? 1 : 0
    if (aIsBundle !== bIsBundle) return aIsBundle - bIsBundle
    const tierDiff = tierOrder(a.tier) - tierOrder(b.tier)
    if (tierDiff !== 0) return tierDiff
    return (a.lowestAsk || 99999) - (b.lowestAsk || 99999)
  })

  listingsCache.set(cfg.cacheKey, { data: listings, expiresAt: Date.now() + CACHE_TTL_MS })
  return { listings, cached: false }
}
