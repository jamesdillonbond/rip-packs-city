import { NextRequest, NextResponse } from "next/server"

const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function topshotFetch<T = any>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(TOPSHOT_GRAPHQL, {
    method: "POST",
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({ query, variables }),
  })
  const json = await res.json()
  if (json.errors) throw new Error(json.errors[0]?.message ?? "GraphQL error")
  return json.data as T
}

// ─── Queries ────────────────────────────────────────────────────────────────

const PACK_DYNAMIC_QUERY = `
  query GetPackListing_DynamicData($input: GetPackListingInput!) {
    getPackListing(input: $input) {
      data {
        id
        forSale
        isSoldOut
        remaining
        dropType
        packListingContentRemaining {
          unopened
          totalPackCount
          remainingByTier {
            common rare legendary ultimate fandom autograph anthology
          }
          originalCountsByTier {
            common rare legendary ultimate fandom autograph anthology
          }
        }
      }
    }
  }
`

const PACK_EDITIONS_QUERY = `
  query GetPackEditions($input: GetPackListingInput!, $after: String) {
    getPackListing(input: $input) {
      data {
        packEditionsV3(after: $after) {
          pageInfo {
            endCursor
            hasNextPage
          }
          edges {
            node {
              count
              remaining
              lastPurchasePrice
              lowAsk
              averageSalePrice
              minSerialNumber
              maxSerialNumber
              jerseyNumber
              serialOne
              lastMint
              edition {
                id
                circulationCount
                tier
                marketplaceInfo {
                  averageSaleData {
                    averagePrice
                  }
                }
                set {
                  id
                  flowName
                  flowSeriesNumber
                }
                play {
                  id
                  headline
                  stats {
                    playerName
                    jerseyNumber
                    teamAtMoment
                    playCategory
                  }
                }
                setPlay {
                  circulations {
                    burned
                    circulationCount
                    forSaleByCollectors
                    hiddenInPacks
                    locked
                    effectiveSupply
                  }
                }
                parallelID
                parallelSetPlay {
                  parallelName
                }
              }
            }
          }
        }
      }
    }
  }
`

// ─── Types ──────────────────────────────────────────────────────────────────

type TierCounts = {
  common: number
  rare: number
  legendary: number
  ultimate: number
  fandom: number
  autograph: number
  anthology: number
}

type EditionNode = {
  count: number
  remaining: number
  lastPurchasePrice: number
  lowAsk: number
  averageSalePrice: number
  minSerialNumber: number
  maxSerialNumber: number
  jerseyNumber: boolean
  serialOne: boolean
  lastMint: boolean
  edition: {
    id: string
    circulationCount: number
    tier: string
    marketplaceInfo: { averageSaleData: { averagePrice: string } }
    set: { id: string; flowName: string; flowSeriesNumber: number }
    play: {
      id: string
      headline: string
      stats: {
        playerName: string
        jerseyNumber: string
        teamAtMoment: string
        playCategory: string
      }
    }
    setPlay: {
      circulations: {
        burned: number
        circulationCount: number
        forSaleByCollectors: number
        hiddenInPacks: number
        locked: number
        effectiveSupply: number
      }
    }
    parallelID: number
    parallelSetPlay: { parallelName: string }
  }
}

type EditionEV = {
  editionId: string
  playerName: string
  setName: string
  tier: string
  parallelName: string | null
  probability: number
  averageSalePrice: number
  lowAsk: number
  editionEV: number
  remaining: number
  count: number
  circulationCount: number
  hiddenInPacks: number
  forSaleByCollectors: number
  locked: number
  burned: number
  lockedPct: number
  depletionPct: number
  hasSerialOne: boolean
  hasLastMint: boolean
  hasJerseyMatch: boolean
  serialPremiumLabel: string | null
}

type TierEVSummary = {
  editionCount: number
  totalEV: number
  avgEditionEV: number
  remainingMoments: number
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeTier(tier: string): string {
  return tier.replace("MOMENT_TIER_", "").toLowerCase()
}

function bestPrice(node: EditionNode): number {
  if (node.averageSalePrice > 0) return node.averageSalePrice
  const marketAvg = parseFloat(node.edition.marketplaceInfo.averageSaleData.averagePrice)
  if (marketAvg > 0) return marketAvg
  if (node.lowAsk > 0) return node.lowAsk
  if (node.lastPurchasePrice > 0) return node.lastPurchasePrice
  return 0
}

function serialPremiumLabel(node: EditionNode): string | null {
  const labels: string[] = []
  if (node.serialOne) labels.push("#1 Serial")
  if (node.lastMint) labels.push("Last Mint")
  if (node.jerseyNumber) labels.push(`Jersey #${node.edition.play.stats.jerseyNumber} Match`)
  return labels.length > 0 ? labels.join(" + ") : null
}

// ─── Fetch all editions with pagination ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchAllEditions(packListingId: string): Promise<EditionNode[]> {
  const allEditions: EditionNode[] = []
  let cursor: string | null = null
  let hasMore = true

  while (hasMore) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await topshotFetch(PACK_EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connection: any = data?.getPackListing?.data?.packEditionsV3

    const edges: { node: EditionNode }[] = connection?.edges ?? []

    for (const edge of edges) {
      if (edge?.node) allEditions.push(edge.node)
    }

    hasMore = connection?.pageInfo?.hasNextPage === true
    cursor = connection?.pageInfo?.endCursor ?? null
  }

  return allEditions
}

// ─── Main handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const packListingId: string = body.packListingId
    const packPrice: number = body.packPrice ?? 0

    if (!packListingId) {
      return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
    }

    const [dynamicData, editions] = await Promise.all([
      topshotFetch(PACK_DYNAMIC_QUERY, { input: { packListingId } }),
      fetchAllEditions(packListingId),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listing: any = (dynamicData as any)?.getPackListing?.data

    const totalUnopened: number = listing?.packListingContentRemaining?.unopened ?? 0
    const remainingByTier: TierCounts = listing?.packListingContentRemaining?.remainingByTier ?? {}
    const originalByTier: TierCounts = listing?.packListingContentRemaining?.originalCountsByTier ?? {}

    if (totalUnopened === 0 || editions.length === 0) {
      return NextResponse.json({ error: "No pack data available" }, { status: 404 })
    }

    // ── Compute EV per edition ──────────────────────────────────────────────
    const editionEVs: EditionEV[] = editions.map((node) => {
      const prob = totalUnopened > 0 ? node.remaining / totalUnopened : 0
      const price = bestPrice(node)
      const ev = prob * price * 0.95

      const circ = node.edition.setPlay.circulations
      const lockedPct = circ.circulationCount > 0
        ? Math.round((circ.locked / circ.circulationCount) * 100)
        : 0
      const depletionPct = node.count > 0
        ? Math.round(((node.count - node.remaining) / node.count) * 100)
        : 0

      return {
        editionId: node.edition.id,
        playerName: node.edition.play.stats.playerName,
        setName: node.edition.set.flowName,
        tier: normalizeTier(node.edition.tier),
        parallelName: node.edition.parallelSetPlay.parallelName || null,
        probability: Math.round(prob * 10000) / 100,
        averageSalePrice: price,
        lowAsk: node.lowAsk,
        editionEV: Math.round(ev * 100) / 100,
        remaining: node.remaining,
        count: node.count,
        circulationCount: node.edition.circulationCount,
        hiddenInPacks: circ.hiddenInPacks,
        forSaleByCollectors: circ.forSaleByCollectors,
        locked: circ.locked,
        burned: circ.burned,
        lockedPct,
        depletionPct,
        hasSerialOne: node.serialOne,
        hasLastMint: node.lastMint,
        hasJerseyMatch: node.jerseyNumber,
        serialPremiumLabel: serialPremiumLabel(node),
      }
    })

    // ── Total pack EV ───────────────────────────────────────────────────────
    const totalEV = editionEVs.reduce((sum, e) => sum + e.editionEV, 0)
    const packEV = Math.round((totalEV - packPrice) * 100) / 100
    const isPositiveEV = packEV > 0

    // ── Top pulls by EV ─────────────────────────────────────────────────────
    const topPulls = [...editionEVs]
      .sort((a, b) => b.editionEV - a.editionEV)
      .slice(0, 10)

    // ── Serial premium alerts ───────────────────────────────────────────────
    const serialPremiumAlerts = editionEVs
      .filter((e) => e.serialPremiumLabel !== null && e.remaining > 0)
      .map((e) => `${e.playerName} — ${e.serialPremiumLabel} (${e.setName})`)

    // ── Tier breakdown ──────────────────────────────────────────────────────
    const tierBreakdown: Record<string, TierEVSummary> = {}
    for (const e of editionEVs) {
      if (!tierBreakdown[e.tier]) {
        tierBreakdown[e.tier] = { editionCount: 0, totalEV: 0, avgEditionEV: 0, remainingMoments: 0 }
      }
      tierBreakdown[e.tier].editionCount++
      tierBreakdown[e.tier].totalEV = Math.round((tierBreakdown[e.tier].totalEV + e.editionEV) * 100) / 100
      tierBreakdown[e.tier].remainingMoments += e.remaining
    }
    for (const tier of Object.keys(tierBreakdown)) {
      const t = tierBreakdown[tier]
      t.avgEditionEV = t.editionCount > 0
        ? Math.round((t.totalEV / t.editionCount) * 100) / 100
        : 0
    }

    // ── Supply snapshot ─────────────────────────────────────────────────────
    const totalPackCount: number = listing?.packListingContentRemaining?.totalPackCount ?? 0
    const depletionPct = totalPackCount > 0
      ? Math.round(((totalPackCount - totalUnopened) / totalPackCount) * 100)
      : 0

    return NextResponse.json({
      packListingId,
      packPrice,
      packEV,
      grossEV: Math.round(totalEV * 100) / 100,
      isPositiveEV,
      evVerdict: isPositiveEV
        ? `+EV by $${Math.abs(packEV).toFixed(2)} — opening beats buying on marketplace`
        : packPrice === 0
        ? "Set pack price to calculate verdict"
        : `-EV by $${Math.abs(packEV).toFixed(2)} — cheaper to buy moments directly`,
      topPulls,
      serialPremiumAlerts,
      tierBreakdown,
      supplySnapshot: {
        totalUnopened,
        totalPackCount,
        depletionPct,
        remainingByTier,
        originalByTier,
        forSale: listing?.forSale,
        isSoldOut: listing?.isSoldOut,
      },
      editionCount: editionEVs.length,
      methodology: "EV = Σ(remaining_i / total_unopened × avg_sale_price_i × 0.95) − pack_price",
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "pack-ev failed" },
      { status: 500 }
    )
  }
}