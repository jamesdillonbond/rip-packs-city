// lib/sniper/pinnacle.ts
//
// Shared Pinnacle sniper compute — extracted from /api/pinnacle-sniper so
// that /api/sniper-feed can dispatch `collection=disney-pinnacle` through
// the same code path as the dedicated route. Returns deals shaped to match
// the unified SniperDeal contract used by the other compute functions in
// /api/sniper-feed/route.ts.

import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchFlowtyPinnacleListings,
  flowtyNftToSniperDeals,
  type FlowtyPinnacleNft,
} from "@/lib/pinnacle/pinnacleFlowty"

interface FmvRow {
  legacy_edition_key: string | null
  fmv_usd: number
  fmv_confidence: string
}

async function loadFmvMap(): Promise<Map<string, { fmv: number; confidence: string }>> {
  // PIN-FMV-REKEY Wave 3: per-render source (pinnacle_catalog) instead of the
  // retiring per-edition blend. The map is still keyed by the legacy edition id
  // (legacy_edition_key) because the Flowty NFT lookup keys on it; for each
  // legacy key we keep the representative render (most-liquid, then highest FMV),
  // matching the Wave 2 collapse. (This Flowty leg is dormant since the 2026-05-13
  // shutdown, but we keep it off the legacy table for consistency.)
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_catalog")
    .select("legacy_edition_key, fmv_usd, fmv_confidence, fmv_sales_count_30d")
    .not("fmv_usd", "is", null)
    .order("fmv_sales_count_30d", { ascending: false, nullsFirst: false })
    .order("fmv_usd", { ascending: false, nullsFirst: false })

  if (error || !data) {
    console.warn("[pinnacle-sniper] FMV fetch error:", error?.message)
    return new Map()
  }

  const map = new Map<string, { fmv: number; confidence: string }>()
  for (const row of data as FmvRow[]) {
    if (row.legacy_edition_key && !map.has(row.legacy_edition_key)) {
      map.set(row.legacy_edition_key, { fmv: row.fmv_usd, confidence: row.fmv_confidence })
    }
  }
  return map
}

export interface PinnacleSniperOpts {
  /** UI alias for variant filter — accepts "tier" or "variant". */
  variantFilter?: string
  maxPrice?: number
  minDiscount?: number
  playerFilter?: string
  sortBy?: string
}

export interface PinnacleSniperResult {
  count: number
  tsCount: number
  flowtyCount: number
  fmvCoverage: number
  lastRefreshed: string
  deals: Array<Record<string, unknown>>
}

export async function computePinnacleSniperFeed(opts: PinnacleSniperOpts = {}): Promise<PinnacleSniperResult> {
  const variantFilter = opts.variantFilter ?? "all"
  const maxPrice = Number(opts.maxPrice ?? 0)
  const minDiscount = Number(opts.minDiscount ?? 0)
  const playerFilter = opts.playerFilter ?? ""
  const sortBy = opts.sortBy ?? "discount"

  // 4 pages of 24 = 96 listed NFTs (matches the long-standing baseline).
  const [page0, page1, page2, page3, fmvMap] = await Promise.all([
    fetchFlowtyPinnacleListings({ limit: 24, offset: 0, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 24, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 48, listedOnly: true, timeoutMs: 10000 }),
    fetchFlowtyPinnacleListings({ limit: 24, offset: 72, listedOnly: true, timeoutMs: 10000 }),
    loadFmvMap(),
  ])

  const allNfts: FlowtyPinnacleNft[] = [...page0, ...page1, ...page2, ...page3]

  const seen = new Set<string>()
  const uniqueNfts = allNfts.filter((nft) => {
    if (seen.has(nft.id)) return false
    seen.add(nft.id)
    return true
  })

  console.log(`[pinnacle-sniper] Flowty: ${uniqueNfts.length} unique listed NFTs, FMV coverage: ${fmvMap.size} editions`)

  let deals = uniqueNfts.flatMap((nft) => flowtyNftToSniperDeals(nft, fmvMap))

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

  return {
    count: mappedDeals.length,
    tsCount: 0,
    flowtyCount: uniqueNfts.length,
    fmvCoverage: fmvMap.size,
    lastRefreshed: new Date().toISOString(),
    deals: mappedDeals,
  }
}
