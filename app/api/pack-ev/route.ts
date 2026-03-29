import { NextRequest, NextResponse } from "next/server"

const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

// ─── Cache ───────────────────────────────────────────────────────────────────

type CachedPackData = {
  grossEV: number
  topPulls: EditionEV[]
  serialPremiumAlerts: string[]
  tierBreakdown: Record<string, TierEVSummary>
  supplySnapshot: {
    totalUnopened: number
    totalPackCount: number
    depletionPct: number
    remainingByTier: TierCounts
    originalByTier: TierCounts
    forSale: boolean
    isSoldOut: boolean
  }
  editionCount: number
}

const packCache = new Map<string, { data: CachedPackData; expiresAt: number }>()
const CACHE_TTL_MS = 5 * 60 * 1000

// ─── Fetch helper with timeout ───────────────────────────────────────────────

async function topshotFetch<T extends object>(
  query: string,
  variables: Record<string, unknown>,
  timeoutMs = 12000
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let res: Response
  try {
    res = await fetch(TOPSHOT_GRAPHQL, {
      method: "POST",
      headers: GRAPHQL_HEADERS,
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`TopShot GQL ${res.status}: ${body.slice(0, 200)}`)
  }

  const json = await res.json() as { errors?: { message: string }[]; data?: T }
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0]?.message ?? "GraphQL error")
  }
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
  query GetPackEditions($input: GetPackListingInput!, $after: ID) {
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
  if (node.jerseyNumber) labels.push("Jersey #" + node.edition.play.stats.jerseyNumber + " Match")
  return labels.length > 0 ? labels.join(" + ") : null
}

// ─── Fetch all editions with pagination ─────────────────────────────────────

type PackEditionsResponse = {
  getPackListing?: {
    data?: {
      packEditionsV3?: {
        pageInfo: { endCursor: string; hasNextPage: boolean }
        edges: { node: EditionNode }[]
      }
    }
  }
}

async function fetchAllEditions(packListingId: string): Promise<EditionNode[]> {
  const allEditions: EditionNode[] = []
  let cursor: string | null = null
  let hasMore = true
  let pageNum = 0

  while (hasMore) {
    pageNum++
    if (pageNum > 20) {
      // Safety valve — no pack has >2000 editions
      console.warn(`[pack-ev] fetchAllEditions exceeded 20 pages for ${packListingId}`)
      break
    }

    const result: PackEditionsResponse = await topshotFetch<PackEditionsResponse>(PACK_EDITIONS_QUERY, {
      input: { packListingId },
      after: cursor ?? undefined,
    })

    const packEditionsV3 = result?.getPackListing?.data?.packEditionsV3
    const edges: { node: EditionNode }[] = packEditionsV3?.edges ?? []

    for (const edge of edges) {
      if (edge?.node) allEditions.push(edge.node)
    }

    hasMore = packEditionsV3?.pageInfo?.hasNextPage === true
    cursor = packEditionsV3?.pageInfo?.endCursor ?? null
  }

  return allEditions
}

// ─── Main handler ────────────────────────────────────────────────────────────

type PackDynamicResponse = {
  getPackListing?: {
    data?: {
      id?: string
      forSale?: boolean
      isSoldOut?: boolean
      remaining?: number
      dropType?: string
      packListingContentRemaining?: {
        unopened?: number
        totalPackCount?: number
        remainingByTier?: TierCounts
        originalCountsByTier?: TierCounts
      }
    }
  }
}

export async function POST(req: NextRequest) {
  let packListingId = ""

  try {
    const body = await req.json().catch(() => ({})) as { packListingId?: string; packPrice?: number }
    packListingId = body.packListingId ?? ""
    const packPrice: number = body.packPrice ?? 0

    if (!packListingId) {
      return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
    }

    console.log(`[pack-ev] Request for ${packListingId} price=${packPrice}`)

    // ── Check cache ─────────────────────────────────────────────────────────
    const cached = packCache.get(packListingId)
    if (cached && cached.expiresAt > Date.now()) {
      const d = cached.data
      const packEV = Math.round((d.grossEV - packPrice) * 100) / 100
      return NextResponse.json({
        packListingId,
        packPrice,
        packEV,
        grossEV: d.grossEV,
        isPositiveEV: packEV > 0,
        evVerdict: packPrice === 0
          ? "Set pack price to calculate verdict"
          : packEV > 0
          ? "+EV by $" + Math.abs(packEV).toFixed(2) + " — opening beats buying on marketplace"
          : "-EV by $" + Math.abs(packEV).toFixed(2) + " — cheaper to buy moments directly",
        topPulls: d.topPulls,
        serialPremiumAlerts: d.serialPremiumAlerts,
        tierBreakdown: d.tierBreakdown,
        supplySnapshot: d.supplySnapshot,
        editionCount: d.editionCount,
        cached: true,
        methodology: "EV = Σ(remaining_i / total_unopened × avg_sale_price_i × 0.95) − pack_price",
      })
    }

    // ── Fetch fresh data — sequential to avoid memory pressure ──────────────
    let dynamicData: PackDynamicResponse
    let editions: EditionNode[]

    try {
      dynamicData = await topshotFetch<PackDynamicResponse>(PACK_DYNAMIC_QUERY, { input: { packListingId } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pack-ev] Dynamic query failed for ${packListingId}: ${msg}`)
      return NextResponse.json(
        { error: "Failed to fetch pack supply data: " + msg },
        { status: 502 }
      )
    }

    try {
      editions = await fetchAllEditions(packListingId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pack-ev] Editions query failed for ${packListingId}: ${msg}`)
      return NextResponse.json(
        { error: "Failed to fetch pack editions: " + msg },
        { status: 502 }
      )
    }

    const contentRemaining = dynamicData?.getPackListing?.data?.packListingContentRemaining
    const totalUnopened: number = contentRemaining?.unopened ?? 0
    const remainingByTier: TierCounts = contentRemaining?.remainingByTier ?? {} as TierCounts
    const originalByTier: TierCounts = contentRemaining?.originalCountsByTier ?? {} as TierCounts

    if (totalUnopened === 0 || editions.length === 0) {
      console.warn(`[pack-ev] No data: unopened=${totalUnopened} editions=${editions.length} for ${packListingId}`)
      return NextResponse.json({ error: "No pack data available" }, { status: 404 })
    }

    console.log(`[pack-ev] Computing EV: ${editions.length} editions, ${totalUnopened} unopened`)

    // ── Compute EV per edition ──────────────────────────────────────────────
    const editionEVs: EditionEV[] = editions.map((node) => {
      const prob = totalUnopened > 0 ? node.remaining / totalUnopened : 0
      const price = bestPrice(node)
      const ev = prob * price * 0.95

      const circ = node.edition.setPlay?.circulations
      const circCount = circ?.circulationCount ?? 0
      const lockedPct = circCount > 0
        ? Math.round(((circ?.locked ?? 0) / circCount) * 100)
        : 0
      const depletionPct = node.count > 0
        ? Math.round(((node.count - node.remaining) / node.count) * 100)
        : 0

      return {
        editionId: node.edition.id,
        playerName: node.edition.play?.stats?.playerName ?? "Unknown",
        setName: node.edition.set?.flowName ?? "Unknown",
        tier: normalizeTier(node.edition.tier),
        parallelName: node.edition.parallelSetPlay?.parallelName || null,
        probability: Math.round(prob * 10000) / 100,
        averageSalePrice: price,
        lowAsk: node.lowAsk,
        editionEV: Math.round(ev * 100) / 100,
        remaining: node.remaining,
        count: node.count,
        circulationCount: node.edition.circulationCount,
        hiddenInPacks: circ?.hiddenInPacks ?? 0,
        forSaleByCollectors: circ?.forSaleByCollectors ?? 0,
        locked: circ?.locked ?? 0,
        burned: circ?.burned ?? 0,
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
    const grossEV = Math.round(totalEV * 100) / 100
    const packEV = Math.round((totalEV - packPrice) * 100) / 100
    const isPositiveEV = packEV > 0

    // ── Top pulls by EV ─────────────────────────────────────────────────────
    const topPulls = [...editionEVs]
      .sort((a, b) => b.editionEV - a.editionEV)
      .slice(0, 10)

    // ── Serial premium alerts ───────────────────────────────────────────────
    const serialPremiumAlerts = editionEVs
      .filter((e) => e.serialPremiumLabel !== null && e.remaining > 0)
      .map((e) => e.playerName + " — " + e.serialPremiumLabel + " (" + e.setName + ")")

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
    const totalPackCount: number = contentRemaining?.totalPackCount ?? 0
    const depletionPct = totalPackCount > 0
      ? Math.round(((totalPackCount - totalUnopened) / totalPackCount) * 100)
      : 0

    const listingData = dynamicData?.getPackListing?.data
    const supplySnapshot = {
      totalUnopened,
      totalPackCount,
      depletionPct,
      remainingByTier,
      originalByTier,
      forSale: listingData?.forSale ?? false,
      isSoldOut: listingData?.isSoldOut ?? false,
    }

    // ── Store in cache ──────────────────────────────────────────────────────
    packCache.set(packListingId, {
      data: {
        grossEV,
        topPulls,
        serialPremiumAlerts,
        tierBreakdown,
        supplySnapshot,
        editionCount: editionEVs.length,
      },
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    console.log(`[pack-ev] Done: grossEV=${grossEV} packEV=${packEV} editions=${editionEVs.length}`)

    return NextResponse.json({
      packListingId,
      packPrice,
      packEV,
      grossEV,
      isPositiveEV,
      evVerdict: packPrice === 0
        ? "Set pack price to calculate verdict"
        : isPositiveEV
        ? "+EV by $" + Math.abs(packEV).toFixed(2) + " — opening beats buying on marketplace"
        : "-EV by $" + Math.abs(packEV).toFixed(2) + " — cheaper to buy moments directly",
      topPulls,
      serialPremiumAlerts,
      tierBreakdown,
      supplySnapshot,
      editionCount: editionEVs.length,
      cached: false,
      methodology: "EV = Σ(remaining_i / total_unopened × avg_sale_price_i × 0.95) − pack_price",
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[pack-ev] Unhandled error for ${packListingId}:`, msg)
    return NextResponse.json(
      { error: msg || "pack-ev failed" },
      { status: 500 }
    )
  }
}