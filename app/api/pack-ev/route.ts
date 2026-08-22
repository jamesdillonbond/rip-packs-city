import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { computeDualPrice, bestPrice, serialPremiumLabel, priceIsCallerInfluenced } from "@/lib/pack-ev-pricing"
import { apiErrorResponse } from "@/lib/api-error"

const TOPSHOT_GRAPHQL = "https://public-api.nbatopshot.com/graphql"

const GRAPHQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
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

// ─── Secondary ask lookup (P2P market) ───────────────────────────────────────
//
// /api/pack-listings paginates Dapper Studio's searchPackNftAggregation and
// returns a per-distId lowestAsk. We call it internally — pack-listings has a
// 2-minute in-process cache so cron-tick callers share a single Dapper roundtrip.
type PackListingsRow = { distId: string; lowestAsk: number; listingCount: number }

async function fetchSecondaryAsk(distId: string | null, reqUrl: string): Promise<number | null> {
  if (!distId) return null
  try {
    const url = new URL("/api/pack-listings", reqUrl)
    const res = await fetch(url, { cache: "no-store" })
    if (!res.ok) return null
    const json = await res.json() as { listings?: PackListingsRow[] }
    const listings = json?.listings ?? []
    const match = listings.find((l) => String(l.distId) === String(distId))
    if (!match) return null
    if (!Number.isFinite(match.lowestAsk) || match.lowestAsk <= 0) return null
    return match.lowestAsk
  } catch (err) {
    console.warn(`[pack-ev] secondary ask lookup failed for distId=${distId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
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

    // Latest FMV per edition from fmv_current (DISTINCT ON latest-per-edition, 1
    // row/edition) — NOT a raw fmv_snapshots DESC scan, which overflows PostgREST's
    // 1000-row cap (~35 history rows/edition) and silently drops cold editions,
    // understating pack EV. Chunk the id list at 1000 so a >1000-edition pool can't cap.
    const editionDbIds = editionRows.map((r: any) => r.id)
    const FMV_CHUNK = 1000
    for (let i = 0; i < editionDbIds.length; i += FMV_CHUNK) {
      const { data: snapshots } = await supabaseAdmin
        .from("fmv_current")
        .select("edition_id, fmv_usd")
        .in("edition_id", editionDbIds.slice(i, i + FMV_CHUNK))
      for (const snap of snapshots ?? []) {
        const extId = editionIdToExternal.get(snap.edition_id)
        if (extId && typeof snap.fmv_usd === "number" && snap.fmv_usd > 0) {
          fmvMap.set(extId, snap.fmv_usd)
        }
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

// deep-audit R24 — R2's sibling. The R2 fix gated /api/edition-floor's persist
// path; the same shape was left open here.
//
// `proxy.ts` opens /api/pack-ev to ANONYMOUS POST (it sits in the "batch
// read-compute, no writes" block, which is where R2 also lived). The handler is
// not write-free: `computeDualPrice()` takes `requestedPrice` straight from the
// body and, when the pack has primary supply and is for sale, that number
// becomes `dual.packPrice` — which a SERVICE_ROLE client then inserts into
// `pack_ev_history` as the persisted `pack_price`, driving `pack_ev`,
// `value_ratio` and `is_positive_ev`.
//
// ⚠ `check_anon_write_surface()` is blind to this BY CONSTRUCTION — it tests the
// anon DB ROLE, and this route holds the service-role key. Same guard-scope
// class the R2 comment records.
//
// ⚠ `gross_ev` and `pack_ev` are clamped a few lines below; `pack_price` is NOT.
//
// Measured 2026-08-22 over 30d (n=111,736 rows / 3,852 packs): the
// caller-influenced path had been exercised on 25 rows (0.022%), all at
// pack_price = 10.00, and no pack carried more than one distinct primary price.
// So this was LATENT, not abused — gated rather than deleted, because writing
// history for a primary-priced pack is legitimate work for an authorised caller.
function persistAuthorized(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? ""
  const cronSecret = process.env.CRON_SECRET
  const ingest = process.env.INGEST_SECRET_TOKEN
  return (
    (!!cronSecret && auth === `Bearer ${cronSecret}`) ||
    (!!ingest && auth === `Bearer ${ingest}`)
  )
}

export async function POST(req: NextRequest) {
  let packListingId = ""

  try {
    const body = await req.json().catch(() => ({})) as { packListingId?: string; packPrice?: number; packName?: string; collectionId?: string; distId?: string | null }
    packListingId = body.packListingId ?? ""
    const requestedPrice: number = body.packPrice ?? 0
    const packName: string | null = body.packName ?? null
    const collectionId: string = typeof body.collectionId === "string" ? body.collectionId : "nba-top-shot"
    const distId: string | null = body.distId ? String(body.distId) : null

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
        body: JSON.stringify({ packListingId, packPrice: requestedPrice, packName }),
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

    console.log(`[pack-ev] Request for ${packListingId} requestedPrice=${requestedPrice} distId=${distId ?? "null"}`)

    // ── Check cache ─────────────────────────────────────────────────────────
    // grossEV / editions / supply are cached; the dual-price (primary vs.
    // secondary) is volatile so we re-derive it every request. Cached
    // supplySnapshot tells us whether the primary listing is still live.
    const cached = packCache.get(packListingId)
    if (cached && cached.expiresAt > Date.now()) {
      const d = cached.data
      const secondaryAsk = await fetchSecondaryAsk(distId, req.url)
      const dual = computeDualPrice({
        requestedPrice,
        totalUnopened: d.supplySnapshot.totalUnopened,
        forSale: d.supplySnapshot.forSale,
        secondaryAsk,
      })
      const packEV = Math.round((d.grossEV - dual.packPrice) * 100) / 100
      const isPositiveEV = dual.priceSource !== "none" && packEV > 0
      return NextResponse.json({
        packListingId,
        packPrice: dual.packPrice,
        primaryPrice: dual.primaryPrice,
        secondaryAsk: dual.secondaryAsk,
        priceSource: dual.priceSource,
        primaryAvailable: dual.primaryAvailable,
        secondaryAvailable: dual.secondaryAvailable,
        packEV,
        grossEV: d.grossEV,
        isPositiveEV,
        evVerdict: dual.priceSource === "none"
          ? "Pack not currently available for purchase"
          : isPositiveEV
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
        methodology: "EV = Σ(remaining_i / total_unopened × avg_sale_price_i × 0.95) − pack_price. pack_price anchors against the cheaper of primary retail or secondary low ask.",
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

    // ── Resolve dual price (primary listing live? secondary ask?) ───────────
    const listingData = dynamicData?.getPackListing?.data
    const forSale = listingData?.forSale === true
    const secondaryAsk = await fetchSecondaryAsk(distId, req.url)
    const dual = computeDualPrice({
      requestedPrice,
      totalUnopened,
      forSale,
      secondaryAsk,
    })

    // ── Fetch RPC FMV data ─────────────────────────────────────────────────
    const rpcFmvMap = await fetchRpcFmvMap(editions)

    console.log(`[pack-ev] Computing EV: ${editions.length} editions, ${totalUnopened} unopened, ${rpcFmvMap.size} RPC FMVs, priceSource=${dual.priceSource} packPrice=${dual.packPrice}`)

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
    const packEV = Math.round((totalEV - dual.packPrice) * 100) / 100
    const isPositiveEV = dual.priceSource !== "none" && packEV > 0

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

    const supplySnapshot = {
      totalUnopened,
      totalPackCount,
      depletionPct,
      remainingByTier,
      originalByTier,
      forSale,
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

    console.log(`[pack-ev] Done: grossEV=${grossEV} packEV=${packEV} priceSource=${dual.priceSource} primary=${dual.primaryPrice ?? "—"} secondary=${dual.secondaryAsk ?? "—"} editions=${editionEVs.length} fmvSource=${fmvSource} fmvCoverage=${fmvCoverage}%`)

    // ── EV history snapshot + flip detection (fire-and-forget) ──────────────
    ;(async () => {
      try {
        const TOP_SHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
        const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString()

        // ⚠ Gate on PRICE PROVENANCE, not on the request being a POST.
        // priceSource "primary"/"min" means dual.packPrice came from (or was
        // tied to) the caller's requestedPrice; "secondary"/"none" means it was
        // derived from data we hold. Only the former is caller-controlled, so
        // only the former needs authorisation — a secondary-priced pack keeps
        // recording history anonymously exactly as before.
        const callerInfluencedPrice = priceIsCallerInfluenced(dual.priceSource)
        if (callerInfluencedPrice && !persistAuthorized(req)) {
          console.log(
            `[pack-ev] history insert SKIPPED for ${packListingId}: priceSource=${dual.priceSource} is caller-influenced and the request is unauthorised (R24)`
          )
          return
        }

        const { data: recent } = await supabaseAdmin
          .from("pack_ev_history")
          .select("id")
          .eq("pack_listing_id", packListingId)
          .gt("snapshotted_at", fifteenMinAgo)
          .limit(1)

        if (recent && recent.length > 0) return

        const valueRatio = dual.packPrice > 0 ? Math.round((grossEV / dual.packPrice) * 1000) / 1000 : null

        // Clamp pack_ev / gross_ev to the CHECK-constrained range so a bad
        // FMV reading can't reject the whole insert. Anything outside this
        // range is almost certainly a bug upstream.
        const clamp = (v: number) => Math.max(-10000, Math.min(1000000, v))
        const safeGrossEV = clamp(grossEV)
        const safePackEV = clamp(packEV)

        const { error: insertErr } = await supabaseAdmin.from("pack_ev_history").insert({
          pack_listing_id: packListingId,
          collection_id: TOP_SHOT_COLLECTION_ID,
          dist_id: distId,
          pack_name: packName,
          pack_price: dual.packPrice,
          primary_price: dual.primaryPrice,
          secondary_ask: dual.secondaryAsk,
          price_source: dual.priceSource,
          primary_available: dual.primaryAvailable,
          secondary_available: dual.secondaryAvailable,
          gross_ev: safeGrossEV,
          pack_ev: safePackEV,
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
      packPrice: dual.packPrice,
      primaryPrice: dual.primaryPrice,
      secondaryAsk: dual.secondaryAsk,
      priceSource: dual.priceSource,
      primaryAvailable: dual.primaryAvailable,
      secondaryAvailable: dual.secondaryAvailable,
      packEV,
      grossEV,
      isPositiveEV,
      evVerdict: dual.priceSource === "none"
        ? "Pack not currently available for purchase"
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
      methodology: "EV = Σ(remaining_i / total_unopened × best_price_i × 0.95) − pack_price. pack_price anchors against the cheaper of primary retail or secondary low ask. best_price prefers RPC FMV when available.",
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[pack-ev] Unhandled error for ${packListingId}:`, msg)
    return apiErrorResponse(e, "api/pack-ev", "Pack EV isn't available right now.")
  }
}
