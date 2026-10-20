import { NextRequest, NextResponse } from "next/server"
import {safeApiError, isUnresolvedIdentifierError, unresolvedIdentifierResponse} from "@/lib/api-error";
import { resolveToFlowAddress } from "@/lib/chains/flow/flow-resolve"
import { packNftTypeName } from "@/lib/packs/live-pack-listings"

const STUDIO_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql"

const STUDIO_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

const OWNED_PACKS_QUERY = `
  query searchPackNftAggregation_searchPacks($after: String, $first: Int, $filters: [PackNftFilter!]) {
    searchPackNftAggregation(searchInput: {after: $after, first: $first, filters: $filters}) {
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
          distribution {
            uuid { value }
            title { value }
          }
        }
      }
    }
  }
`

type OwnedPackNode = {
  dist_id: { key: string; value: string }
  distribution: {
    uuid: { value: string }
    title: { value: string }
  }
}

type GraphQLResponse = {
  data?: {
    searchPackNftAggregation?: {
      pageInfo: { endCursor: string; hasNextPage: boolean }
      totalCount: number
      edges: { node: OwnedPackNode }[]
    }
  }
  errors?: { message: string }[]
}

// 2026-09-29: usernames resolve through the shared ladder (cache → live Atlas →
// Top Shot GQL). The local copy went cache → the dead Top Shot host only, so a
// username not already cached could never resolve here.
const resolveWallet = resolveToFlowAddress

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const input = searchParams.get("wallet")?.trim()
    if (!input) return NextResponse.json({ error: "wallet param required" }, { status: 400 })

    // ⛔ SUBSTITUTION (2026-10-19). The PackNFT type was hardcoded to Top Shot's,
    // and the Collection tab called this on EVERY collection, matching an All Day
    // or Golazos set name against the wallet's Top Shot pack titles. The read is
    // now scoped to the collection asked about; one this lane cannot read is
    // refused, never answered with another collection's packs. An ABSENT param
    // keeps the historical Top Shot default.
    const collection = searchParams.get("collection")?.trim() || "nba-top-shot"
    const typeName = packNftTypeName(collection)
    if (!typeName) {
      return NextResponse.json(
        { error: "Sealed pack holdings are not available for this collection." },
        { status: 400 },
      )
    }

    const walletAddress = await resolveWallet(input)

    // Strip 0x prefix for the filter — the API uses the address without prefix
    const addressWithout0x = walletAddress.replace(/^0x/, "")

    const allNodes: OwnedPackNode[] = []
    let cursor: string | undefined = undefined
    let hasMore = true

    while (hasMore) {
      const res = await fetch(STUDIO_GRAPHQL, {
        method: "POST",
        headers: STUDIO_HEADERS,
        body: JSON.stringify({
          operationName: "searchPackNftAggregation_searchPacks",
          query: OWNED_PACKS_QUERY,
          variables: {
            first: 2000,
            after: cursor,
            filters: [
              {
                status: { eq: "Sealed" },
                owner_address: { eq: addressWithout0x },
                type_name: { eq: typeName },
              },
            ],
          },
        }),
      })

      // Every failure shape throws: an HTTP error or a `{ data: null }` reply
      // used to fall through as an empty last page — "holds no sealed packs".
      if (!res.ok) throw new Error(`wallet packs HTTP ${res.status}`)
      const json = (await res.json()) as GraphQLResponse
      if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error")

      const connection = json.data?.searchPackNftAggregation
      if (!connection) throw new Error("wallet packs response carried no searchPackNftAggregation")
      const edges = connection?.edges ?? []
      for (const edge of edges) {
        if (edge?.node) allNodes.push(edge.node)
      }

      hasMore = connection?.pageInfo?.hasNextPage === true
      cursor = connection?.pageInfo?.endCursor ?? undefined
    }

    // Count owned packs by dist_id, include title for client-side matching
    const owned: Record<string, number> = {}
    const packsByTitle: Record<string, number> = {}
    for (const node of allNodes) {
      const distId = node.dist_id?.value
      if (!distId) continue
      owned[distId] = (owned[distId] ?? 0) + 1
      const title = node.distribution?.title?.value ?? ""
      if (title) packsByTitle[title] = (packsByTitle[title] ?? 0) + 1
    }

    return NextResponse.json({
      walletAddress,
      collection,
      totalSealedPacks: allNodes.length,
      owned,
      packsByTitle,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : "wallet-packs failed"

    // Username resolution failures and similar client errors → 400. Reading the
    // message SERVER-SIDE to classify is fine; what is published is fixed copy,
    // since `message` here is whatever the resolver threw.
    if (isUnresolvedIdentifierError(e)) return unresolvedIdentifierResponse()

    // GraphQL / network failures → return empty result instead of 500. That
    // degradation is deliberate (the caller reads packsByTitle and renders
    // nothing), but the `error` key must not carry the upstream's own text.
    console.error("[wallet-packs] error:", message)
    return NextResponse.json({
      walletAddress: null,
      totalSealedPacks: 0,
      owned: {},
      packsByTitle: {},
      error: safeApiError(e, "Sealed pack data is unavailable right now.").error,
    })
  }
}