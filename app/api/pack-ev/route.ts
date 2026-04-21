import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (rip-packs-city.vercel.app)",
  "Origin": "https://nbatopshot.com",
  "Referer": "https://nbatopshot.com/",
}

const supabaseAdmin: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

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
  fmvCoverage: number
  fmvCoverageNote: string | null
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
  priceSource: string
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

function bestPrice(node: EditionNode, rpcFmv?: number): { price: number; priceSource: string } {
  if (rpcFmv && rpcFmv > 0) return { price: rpcFmv, priceSource: "rpc" }
  if (node.averageSalePrice > 0) return { price: node.averageSalePrice, priceSource: "pack_wap" }
  const marketAvg = parseFloat(node.edition.marketplaceInfo.averageSaleData.averagePrice)
  if (marketAvg > 0) return { price: marketAvg, priceSource: "market_wap" }
  if (node.lowAsk > 0) return { price: node.lowAsk * 0.95, priceSource: "ask" }
  if (node.lastPurchasePrice > 0) return { price: node.lastPurchasePrice * 0.80, priceSource: "last_sale" }
  return { price: 0, priceSource: "none" }
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

// ─── RPC FMV lookup ─────────────────────────────────────────────────────────

async function fetchRpcFmvMap(editions: EditionNode[]): Promise<Map<string, number>> {
  const fmvMap = new Map<string, number>()
  try {
    // Build external IDs from edition set.id + play.id
    const externalIds = editions
      .map((n) => n.edition.set?.id && n.edition.play?.id ? `${n.edition.set.id}:${n.edition.play.id}` : null)
      .filter((id): id is string => id !== null)

    if (externalIds.length === 0) return fmvMap

    const uniqueIds = [...new Set(externalIds)]

    // Look up edition rows by external_id
    const { data: editionRows } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .in("external_id", uniqueIds)

    if (!editionRows || editionRows.length === 0) return fmvMap

    const editionIdToExternal = new Map<string, string>()
    for (const row of editionRows) {
      editionIdToExternal.set(row.id, row.external_id)
    }

    // Get latest fmv_snapshots for these edition_ids
    const editionDbIds = editionRows.map((r: any) => r.id)
    const { data: snapshots } = await supabaseAdmin
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd, computed_at")
      .in("edition_id", editionDbIds)
      .order("computed_at", { ascending: false })

    if (!snapshots || snapshots.length === 0) return fmvMap

    // Keep only the most recent snapshot per edition_id
    const seen = new Set<string>()
    for (const snap of snapshots) {
      if (seen.has(snap.edition_id)) continue
      seen.add(snap.edition_id)
      const extId = editionIdToExternal.get(snap.edition_id)
      if (extId && typeof snap.fmv_usd === "number" && snap.fmv_usd > 0) {
        fmvMap.set(extId, snap.fmv_usd)
      }
    }

    console.log(`[pack-ev] RPC FMV: ${fmvMap.size}/${uniqueIds.length} editions matched`)
  } catch (err) {
    console.warn(`[pack-ev] RPC FMV lookup failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return fmvMap
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
    const body = await req.json().catch(() => ({})) as { packListingId?: string; packPrice?: number; packName?: string; collectionId?: string }
    packListingId = body.packListingId ?? ""
    const packPrice: number = body.packPrice ?? 0
    const packName: string | null = body.packName ?? null
    const collectionId: string = typeof body.collectionId === "string" ? body.collectionId : "nba-top-shot"

    if (!packListingId) {
      return NextResponse.json({ error: "packListingId is required" }, { status: 400 })
    }

    // ── Phase 2: dispatch by collectionId ─────────────────────────────────────
    // Top Shot keeps the in-file logic below. AllDay forwards to
    // /api/allday-pack-ev which has a parallel implementation. Other
    // collections don't support pack EV yet — return a 404 with a clear
    // message so the UI can render a graceful empty state.
    if (collectionId === "nfl-all-day") {
      const forwardUrl = new URL("/api/allday-pack-ev", req.url)
      const forwardRes = await fetch(forwardUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ packListingId, packPrice, packName }),
        cache: "no-store",
      })
      const forwardBody = await forwardRes.text()
      return new NextResponse(forwardBody, {
        status: forwardRes.status,
        headers: { "Content-Type": "application/json" },
      })
    }
    if (collectionId !== "nba-top-shot") {
      return NextResponse.json(
        { error: "Packs not available for this collection", collectionId },
        { status: 404 }
      )
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
        fmvCoverage: d.fmvCoverage,
        fmvCoverageNote: d.fmvCoverageNote,
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

    // ── Handle bundle/case packs with 0 editions ────────────────────────────
    if (editions.length === 0) {
      console.warn(`[pack-ev] No editions for ${packListingId} — likely a bundle/case pack`)
      return NextResponse.json({
        error: "bundle_not_supported",
        message: "Bundle and case packs are not yet supported for EV analysis.",
      }, { status: 200 })
    }

    const contentRemaining = dynamicData?.getPackListing?.data?.packListingContentRemaining
    const totalUnopened: number = contentRemaining?.unopened ?? 0
    const remainingByTier: TierCounts = contentRemaining?.remainingByTier ?? {} as TierCounts
    const originalByTier: TierCounts = contentRemaining?.originalCountsByTier ?? {} as TierCounts

    if (totalUnopened === 0) {
      console.warn(`[pack-ev] No unopened packs for ${packListingId}`)
      return NextResponse.json({ error: "No pack data available" }, { status: 404 })
    }

    // ── Fetch RPC FMV data ─────────────────────────────────────────────────
    const rpcFmvMap = await fetchRpcFmvMap(editions)

    console.log(`[pack-ev] Computing EV: ${editions.length} editions, ${totalUnopened} unopened, ${rpcFmvMap.size} RPC FMVs`)

    // Diagnostic: log first 3 edition nodes' raw IDs for key-format analysis
    for (const node of editions.slice(0, 3)) {
      const e = node.edition
      console.log(`[pack-ev] EDITION-DEBUG: edition.id=${e.id} set.id=${e.set?.id} play.id=${e.play?.id} parallelID=${e.parallelID} setFlowName=${e.set?.flowName} player=${e.play?.stats?.playerName}`)
    }

    // ── Compute EV per edition ──────────────────────────────────────────────
    let rpcFmvUsed = 0
    const editionEVs: EditionEV[] = editions.map((node) => {
      const prob = totalUnopened > 0 ? node.remaining / totalUnopened : 0
      const externalId = node.edition.set?.id && node.edition.play?.id
        ? `${node.edition.set.id}:${node.edition.play.id}`
        : null
      const rpcFmv = externalId ? rpcFmvMap.get(externalId) : undefined
      if (rpcFmv && rpcFmv > 0) rpcFmvUsed++
      const { price, priceSource } = bestPrice(node, rpcFmv)
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
        priceSource,
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

    // ── FMV coverage stats ───────────────────────────────────────────────────
    const fmvCoverage = editionEVs.length > 0
      ? Math.round((rpcFmvUsed / editionEVs.length) * 100)
      : 0
    const fmvSource = rpcFmvUsed > 0 ? "rpc" : "topshot"
    const fmvCoverageNote = fmvCoverage < 10
      ? "FMV data is limited (" + fmvCoverage + "% coverage). EV uses Top Shot marketplace prices for most editions. As more sales are ingested, RPC FMV coverage will improve."
      : fmvCoverage < 50
        ? "Partial FMV coverage (" + fmvCoverage + "%). Some editions use Top Shot marketplace prices instead of RPC FMV."
        : null

    // ── Proactive edition seeding (fire-and-forget) ──────────────────────────
    const unseeded = editions
      .filter((n) => {
        const extId = n.edition.set?.id && n.edition.play?.id
          ? `${n.edition.set.id}:${n.edition.play.id}`
          : null
        return extId && !rpcFmvMap.has(extId)
      })
      .map((n) => ({ external_id: `${n.edition.set.id}:${n.edition.play.id}` }))

    if (unseeded.length > 0) {
      supabaseAdmin
        .from("editions")
        .upsert(unseeded, { onConflict: "external_id,collection_id", ignoreDuplicates: true })
        .then(({ error }: { error: any }) => {
          if (error) console.warn(`[pack-ev] Edition seed error: ${error.message}`)
          else console.log(`[pack-ev] Seeded ${unseeded.length} new editions`)
        })
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
        fmvCoverage,
        fmvCoverageNote,
      },
      expiresAt: Date.now() + CACHE_TTL_MS,
    })

    console.log(`[pack-ev] Done: grossEV=${grossEV} packEV=${packEV} editions=${editionEVs.length} fmvSource=${fmvSource} fmvCoverage=${fmvCoverage}%`)

    // ── EV history snapshot + flip detection (fire-and-forget) ──────────────
    ;(async () => {
      try {
        const TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()

        const { data: recent } = await supabaseAdmin
          .from("pack_ev_history")
          .select("id")
          .eq("pack_listing_id", packListingId)
          .gt("snapshotted_at", fifteenMinAgo)
          .limit(1)

        if (recent && recent.length > 0) return

        const valueRatio = packPrice > 0 ? Math.round((grossEV / packPrice) * 1000) / 1000 : null

        const { error: insertErr } = await supabaseAdmin.from("pack_ev_history").insert({
          pack_listing_id: packListingId,
          collection_id: TOP_SHOT_COLLECTION_ID,
          pack_name: packName,
          pack_price: packPrice,
          gross_ev: grossEV,
          pack_ev: packEV,
          is_positive_ev: isPositiveEV,
          value_ratio: valueRatio,
          fmv_coverage_pct: fmvCoverage,
          edition_count: editionEVs.length,
          total_unopened: supplySnapshot.totalUnopened,
          depletion_pct: supplySnapshot.depletionPct,
        })
        if (insertErr) {
          console.warn(`[pack-ev] history insert error: ${insertErr.message}`)
          return
        }

        // Flip detection: look at the most recent prior snapshot (>15m old)
        const { data: prev } = await supabaseAdmin
          .from("pack_ev_history")
          .select("is_positive_ev, snapshotted_at")
          .eq("pack_listing_id", packListingId)
          .lt("snapshotted_at", fifteenMinAgo)
          .order("snapshotted_at", { ascending: false })
          .limit(1)
        const prevPositive = prev?.[0]?.is_positive_ev
        if (prevPositive === false && isPositiveEV === true) {
          console.log(`[pack-ev] EV FLIP TO POSITIVE: ${packName ?? ""} ${packListingId} grossEV=${grossEV} packEV=${packEV}`)
        }
      } catch (err) {
        console.warn(`[pack-ev] history snapshot error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })()

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
      fmvSource,
      fmvCoverage,
      fmvCoverageNote,
      cached: false,
      methodology: "EV = Σ(remaining_i / total_unopened × best_price_i × 0.95) − pack_price. best_price prefers RPC FMV when available.",
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
