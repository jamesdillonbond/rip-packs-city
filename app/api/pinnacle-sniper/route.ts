// app/api/pinnacle-sniper/route.ts
// GET /api/pinnacle-sniper — Disney Pinnacle sniper deals (Flowty-only)
// Fetches listed Pinnacle NFTs from Flowty, enriches with FMV from
// pinnacle_fmv_snapshots, calculates discount, returns sorted deals.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchFlowtyPinnacleListings,
  flowtyNftToSniperDeals,
  type FlowtyPinnacleNft,
} from "@/lib/pinnacle/pinnacleFlowty"

export const dynamic = "force-dynamic"
export const maxDuration = 25

interface FmvRow {
  edition_id: string
  fmv_usd: number
  confidence: string
}

async function loadFmvMap(): Promise<Map<string, { fmv: number; confidence: string }>> {
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_fmv_snapshots")
    .select("edition_id, fmv_usd, confidence")
    .order("computed_at", { ascending: false })

  if (error || !data) {
    console.warn("[pinnacle-sniper] FMV fetch error:", error?.message)
    return new Map()
  }

  const map = new Map<string, { fmv: number; confidence: string }>()
  for (const row of data as FmvRow[]) {
    // DISTINCT ON equivalent: first row per edition (ordered by computed_at DESC)
    if (!map.has(row.edition_id)) {
      map.set(row.edition_id, { fmv: row.fmv_usd, confidence: row.confidence })
    }
  }
  return map
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const variantFilter = url.searchParams.get("tier") ?? url.searchParams.get("variant") ?? "all"
  const maxPrice = parseFloat(url.searchParams.get("maxPrice") ?? "0")
  const minDiscount = parseFloat(url.searchParams.get("minDiscount") ?? "0")
  const playerFilter = url.searchParams.get("player") ?? ""
  const sortBy = url.searchParams.get("sortBy") ?? "discount"

  // Fetch Flowty listings and FMV in parallel
  // 4 pages of 24 = 96 listed NFTs
  const [page0, page1, page2, page3, fmvMap] = await Promise.all([
    fetchFlowtyPinnacleListings({ limit: 24, offset: 0, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 24, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 48, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 72, listedOnly: true, timeoutMs: 10000 }),
    loadFmvMap(),
  ])

  const allNfts: FlowtyPinnacleNft[] = [...page0, ...page1, ...page2, ...page3]

  // Dedup by NFT id
  const seen = new Set<string>()
  const uniqueNfts = allNfts.filter((nft) => {
    if (seen.has(nft.id)) return false
    seen.add(nft.id)
    return true
  })

  console.log(`[pinnacle-sniper] Flowty: ${uniqueNfts.length} unique listed NFTs, FMV coverage: ${fmvMap.size} editions`)

  // Convert NFTs to sniper deals
  let deals = uniqueNfts.flatMap((nft) => flowtyNftToSniperDeals(nft, fmvMap))

  // Apply filters
  if (variantFilter !== "all") {
    deals = deals.filter((d) => d.variantType.toLowerCase() === variantFilter.toLowerCase())
  }
  if (maxPrice > 0) {
    deals = deals.filter((d) => d.askPrice <= maxPrice)
  }
  if (minDiscount > 0) {
    deals = deals.filter((d) => d.discount >= minDiscount)
  }
  if (playerFilter) {
    const q = playerFilter.toLowerCase()
    deals = deals.filter((d) =>
      d.characterName.toLowerCase().includes(q) ||
      d.franchise.toLowerCase().includes(q) ||
      d.setName.toLowerCase().includes(q)
    )
  }

  // Sort
  switch (sortBy) {
    case "price_asc":
      deals.sort((a, b) => a.askPrice - b.askPrice)
      break
    case "price_desc":
      deals.sort((a, b) => b.askPrice - a.askPrice)
      break
    case "fmv_desc":
      deals.sort((a, b) => b.adjustedFmv - a.adjustedFmv)
      break
    case "listed_desc":
      deals.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      break
    case "discount":
    default:
      deals.sort((a, b) => b.discount - a.discount)
      break
  }

  // Map PinnacleSniperDeal to the SniperDeal shape the sniper page expects.
  // playerName = characterName, teamName = franchise, tier = variantType.
  const mappedDeals = deals.slice(0, 200).map((d) => ({
    flowId: d.flowId,
    momentId: d.nftId,
    editionKey: d.editionKey,
    intEditionKey: null,
    playerName: d.characterName,
    teamName: d.franchise,
    setName: d.setName,
    seriesName: d.seriesYear ? String(d.seriesYear) : "",
    tier: d.variantType,
    parallel: "",
    parallelId: 0,
    serial: d.serial ?? 0,
    circulationCount: d.mintCount ?? 0,
    askPrice: d.askPrice,
    baseFmv: d.baseFmv,
    adjustedFmv: d.adjustedFmv,
    wapUsd: null,
    daysSinceSale: null,
    salesCount30d: null,
    discount: d.discount,
    confidence: d.confidence.toLowerCase(),
    confidenceSource: "rpc_fmv",
    hasBadge: false,
    badgeSlugs: [] as string[],
    badgeLabels: [] as string[],
    badgePremiumPct: 0,
    serialMult: d.serialMult,
    isSpecialSerial: d.isSpecialSerial,
    isJersey: false,
    serialSignal: d.serialSignal,
    thumbnailUrl: d.thumbnailUrl,
    isLocked: d.isLocked,
    updatedAt: d.updatedAt,
    packListingId: null,
    packName: null,
    packEv: null,
    packEvRatio: null,
    buyUrl: d.buyUrl,
    listingResourceID: d.listingResourceID,
    listingOrderID: d.listingOrderID,
    storefrontAddress: d.storefrontAddress,
    source: "pinnacle" as const,
    paymentToken: "DUC" as const,
    offerAmount: d.offerAmount,
    offerFmvPct: d.offerFmvPct,
    dealRating: d.discount,
    isLowestAsk: false,
  }))

  return NextResponse.json(
    {
      count: mappedDeals.length,
      flowtyCount: uniqueNfts.length,
      fmvCoverage: fmvMap.size,
      lastRefreshed: new Date().toISOString(),
      deals: mappedDeals,
    },
    {
      headers: {
        "Cache-Control": "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
      },
    }
  )
}
