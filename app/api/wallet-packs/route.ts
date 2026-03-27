import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"

const STUDIO_GRAPHQL = "https://api.production.studio-platform.dapperlabs.com/graphql"

const STUDIO_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
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

type UsernameProfileResponse = {
  getUserProfileByUsername?: {
    publicInfo?: {
      flowAddress?: string | null
    } | null
  } | null
}

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

function isWalletAddress(value: string) {
  return /^0x[a-fA-F0-9]{16}$/.test(value.trim())
}

function ensureFlowPrefix(v: string) {
  return v.startsWith("0x") ? v : "0x" + v
}

async function resolveWallet(input: string): Promise<string> {
  const trimmed = input.trim()
  if (isWalletAddress(trimmed)) return ensureFlowPrefix(trimmed)

  const cleanedUsername = trimmed.replace(/^@+/, "")
  const query = `
    query GetUserProfileByUsername($username: String!) {
      getUserProfileByUsername(input: { username: $username }) {
        publicInfo { flowAddress }
      }
    }
  `
  const data = await topshotGraphql<UsernameProfileResponse>(query, { username: cleanedUsername })
  const rawWallet = data?.getUserProfileByUsername?.publicInfo?.flowAddress ?? null
  if (!rawWallet) throw new Error("Could not resolve username to wallet address.")
  return ensureFlowPrefix(rawWallet)
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const input = searchParams.get("wallet")?.trim()
    if (!input) return NextResponse.json({ error: "wallet param required" }, { status: 400 })

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
                type_name: { eq: "A.0b2a3299cc857e29.PackNFT.NFT" },
              },
            ],
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

    // Count owned packs by dist_id
    const owned: Record<string, number> = {}
    for (const node of allNodes) {
      const distId = node.dist_id?.value
      if (!distId) continue
      owned[distId] = (owned[distId] ?? 0) + 1
    }

    return NextResponse.json({
      walletAddress,
      totalSealedPacks: allNodes.length,
      owned,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "wallet-packs failed" },
      { status: 500 }
    )
  }
}