// app/api/ufc-sniper-feed/route.ts
// GET /api/ufc-sniper-feed — UFC Strike sniper deals (Flowty-only).
// Fetches listed UFC NFTs from Flowty, enriches with FMV from fmv_snapshots
// (ASK_ONLY fallback when no FMV exists), returns sorted deals.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchFlowtyUfcListings,
  flowtyUfcNftToSniperDeals,
  type FlowtyUfcNft,
} from "@/lib/ufc/ufcFlowty"

export const dynamic = "force-dynamic"
export const maxDuration = 25

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

interface FmvRow {
  edition_id: string
  edition_external_id: string | null
  fmv_usd: number
  confidence: string
}

async function loadFmvMap(): Promise<Map<string, { fmv: number; confidence: string }>> {
  // Pull latest fmv_snapshots joined with editions to map by external_id (edition_key).
  const { data: editions, error: eErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id")
    .eq("collection_id", UFC_COLLECTION_ID)

  if (eErr || !editions) {
    console.warn("[ufc-sniper] editions fetch error:", eErr?.message)
    return new Map()
  }

  const idToKey = new Map<string, string>()
  const ids: string[] = []
  for (const e of editions as Array<{ id: string; external_id: string | null }>) {
    if (e.external_id) {
      idToKey.set(e.id, e.external_id)
      ids.push(e.id)
    }
  }
  if (ids.length === 0) return new Map()

  const map = new Map<string, { fmv: number; confidence: string }>()
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK)
    const { data, error } = await (supabaseAdmin as any)
      .from("fmv_snapshots")
      .select("edition_id, fmv_usd, confidence, computed_at")
      .in("edition_id", batch)
      .order("computed_at", { ascending: false })
    if (error || !data) continue
    for (const row of data as Array<Pick<FmvRow, "edition_id" | "fmv_usd" | "confidence">>) {
      const key = idToKey.get(row.edition_id)
      if (!key) continue
      if (!map.has(key)) map.set(key, { fmv: row.fmv_usd, confidence: row.confidence })
    }
  }
  return map
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const tierFilter = url.searchParams.get("tier") ?? "all"
  const maxPrice = parseFloat(url.searchParams.get("maxPrice") ?? "0")
  const minDiscount = parseFloat(url.searchParams.get("minDiscount") ?? "0")
  const playerFilter = url.searchParams.get("player") ?? ""
  const sortBy = url.searchParams.get("sortBy") ?? "discount"

  const [page0, page1, page2, page3, fmvMap] = await Promise.all([
    fetchFlowtyUfcListings({ limit: 24, offset: 0, timeoutMs: 10000 }),
    fetchFlowtyUfcListings({ limit: 24, offset: 24, timeoutMs: 10000 }),
    fetchFlowtyUfcListings({ limit: 24, offset: 48, timeoutMs: 10000 }),
    fetchFlowtyUfcListings({ limit: 24, offset: 72, timeoutMs: 10000 }),
    loadFmvMap(),
  ])

  const allNfts: FlowtyUfcNft[] = [...page0, ...page1, ...page2, ...page3]

  const seen = new Set<string>()
  const uniqueNfts = allNfts.filter((nft) => {
    const id = nft.id !== undefined && nft.id !== null ? String(nft.id) : ""
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })

  console.log(`[ufc-sniper] Flowty: ${uniqueNfts.length} unique NFTs, FMV coverage: ${fmvMap.size} editions`)

  let deals = uniqueNfts.flatMap((nft) => flowtyUfcNftToSniperDeals(nft, fmvMap))

  if (tierFilter !== "all") {
    deals = deals.filter((d) => d.tier.toLowerCase() === tierFilter.toLowerCase())
  }
  if (maxPrice > 0) {
    deals = deals.filter((d) => d.askPrice <= maxPrice)
  }
  if (minDiscount > 0) {
    deals = deals.filter((d) => d.discount >= minDiscount)
  }
  if (playerFilter) {
    const q = playerFilter.toLowerCase()
    deals = deals.filter((d) => d.playerName.toLowerCase().includes(q))
  }

  switch (sortBy) {
    case "price_asc": deals.sort((a, b) => a.askPrice - b.askPrice); break
    case "price_desc": deals.sort((a, b) => b.askPrice - a.askPrice); break
    case "fmv_desc": deals.sort((a, b) => b.adjustedFmv - a.adjustedFmv); break
    case "listed_desc": deals.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()); break
    case "discount":
    default: deals.sort((a, b) => b.discount - a.discount); break
  }

  const mappedDeals = deals.slice(0, 200).map((d) => ({
    flowId: d.flowId,
    momentId: d.momentId,
    editionKey: d.editionKey,
    intEditionKey: null,
    playerName: d.playerName,
    teamName: "",
    setName: "",
    seriesName: "",
    tier: d.tier,
    parallel: "",
    parallelId: 0,
    serial: d.serial,
    circulationCount: d.circulationCount,
    askPrice: d.askPrice,
    baseFmv: d.baseFmv,
    adjustedFmv: d.adjustedFmv,
    wapUsd: null,
    daysSinceSale: null,
    salesCount30d: null,
    discount: d.discount,
    confidence: d.confidence,
    confidenceSource: "rpc_fmv",
    hasBadge: false,
    badgeSlugs: [] as string[],
    badgeLabels: [] as string[],
    badgePremiumPct: 0,
    serialMult: 1,
    isSpecialSerial: false,
    isJersey: false,
    serialSignal: null,
    thumbnailUrl: d.thumbnailUrl,
    isLocked: d.isLocked,
    updatedAt: d.updatedAt,
    packListingId: null,
    packName: null,
    packEv: null,
    packEvRatio: null,
    buyUrl: d.buyUrl,
    listingResourceID: d.listingResourceID,
    listingOrderID: null,
    storefrontAddress: d.storefrontAddress,
    source: "flowty" as const,
    paymentToken: "DUC" as const,
    offerAmount: null,
    offerFmvPct: null,
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
