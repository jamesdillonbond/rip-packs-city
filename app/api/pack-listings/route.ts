import { NextResponse } from "next/server"

const TOPSHOT_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

const PACK_LISTINGS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!], $sortBy: PackNftSortAggregation) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters, sortBy: $sortBy}) {
      pageInfo {
        endCursor
        hasNextPage
      }
      totalCount
      edges {
        node {
          dist_id {
            key
            value
          }
          listing {
            price {
              min
            }
          }
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

const ACTIVE_FILTERS = [
  {
    status: { eq: "Sealed" },
    listing: {
      exists: true,
      ft_vault_type: { eq: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault" },
    },
    owner_address: { ne: "0b2a3299cc857e29" },
    excludeReserved: { eq: true },
    type_name: { eq: "A.0b2a3299cc857e29.PackNFT.NFT" },
    distribution: {
      tier: { ignore_case: true, in: [] },
      series_ids: { contains: [], contains_type: "ANY" },
      title: { ignore_case: true, partial_match: true, in: [] },
    },
  },
]

type PackDistribution = {
  id: { value: string }
  uuid: { value: string }
  image_urls: { value: string[] }
  number_of_pack_slots: { value: string }
  pack_type: { value: string | null }
  price: { value: number }
  start_time: { value: string }
  tier: { value: string }
  title: { value: string }
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

type PackListing = {
  packListingId: string
  distId: string
  title: string
  tier: string
  imageUrl: string
  momentsPerPack: number
  retailPrice: number
  lowestAsk: number
  startTime: string
  listingCount: number
}

const listingsCache = new Map<string, { data: PackListing[]; expiresAt: number }>()
const CACHE_TTL_MS = 2 * 60 * 1000

function tierOrder(tier: string): number {
  if (tier === "ultimate") return 0
  if (tier === "legendary") return 1
  if (tier === "rare") return 2
  if (tier === "fandom") return 3
  return 4
}

export async function GET() {
  try {
    const cached = listingsCache.get("listings")
    if (cached && cached.expiresAt > Date.now()) {
      return NextResponse.json({ listings: cached.data, cached: true })
    }

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
          variables: {
            first: 2000,
            after: cursor,
            filters: ACTIVE_FILTERS,
          },
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
      const uuid = node.distribution?.uuid?.value
      if (!uuid) continue

      const askRaw = parseInt(node.listing?.price?.min ?? "0", 10)
      const ask = askRaw / 100000000

      const existing = packMap.get(uuid)
      if (existing) {
        existing.count += 1
        if (ask > 0 && ask < existing.lowestAsk) existing.lowestAsk = ask
      } else {
        packMap.set(uuid, { node, count: 1, lowestAsk: ask > 0 ? ask : 0 })
      }
    }

    const listings: PackListing[] = Array.from(packMap.entries()).map(([uuid, { node, count, lowestAsk }]) => {
      const d = node.distribution
      return {
        packListingId: uuid,
        distId: d.id.value,
        title: d.title.value,
        tier: d.tier.value ?? "common",
        imageUrl: d.image_urls?.value?.[0] ?? "",
        momentsPerPack: parseInt(d.number_of_pack_slots.value, 10) || 1,
        retailPrice: d.price.value ?? 0,
        lowestAsk,
        startTime: d.start_time.value,
        listingCount: count,
      }
    })

    listings.sort((a, b) => {
      const tierDiff = tierOrder(a.tier) - tierOrder(b.tier)
      if (tierDiff !== 0) return tierDiff
      return a.lowestAsk - b.lowestAsk
    })

    listingsCache.set("listings", { data: listings, expiresAt: Date.now() + CACHE_TTL_MS })

    return NextResponse.json({ listings, cached: false, totalPacks: listings.length })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pack-listings failed" },
      { status: 500 }
    )
  }
}