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
  render_id: string
  legacy_edition_key: string | null
  fmv_usd: number
  fmv_confidence: string
  fmv_sales_count_30d: number | null
}

async function loadFmvMap(): Promise<Map<string, { fmv: number; confidence: string }>> {
  // PIN-FMV-REKEY Wave 3: per-render source (pinnacle_catalog) instead of the
  // retiring per-edition blend. The map is still keyed by the legacy edition id
  // (legacy_edition_key) because the Flowty NFT lookup keys on it; for each
  // legacy key we keep the representative render (most-liquid, then highest FMV),
  // matching the Wave 2 collapse. (This Flowty leg is dormant since the 2026-05-13
  // shutdown, but we keep it off the legacy table for consistency.)
  // 🚨 THIS READ WAS CAPPED AND THE MISSES WERE INVISIBLE. It was unbounded, and
  // PostgREST caps every read at 1,000 rows with no error and no short page.
  // Measured live 2026-09-02: **2,470 rows carry an fmv_usd**, and the first
  // 1,000 under the old ordering cover only **290 of the 416 distinct
  // legacy_edition_keys — 69.7%**. A map miss is not cosmetic here:
  // flowtyNftToSniperDeals DROPS the listing (`if (!fmvData || fmvData.fmv <= 0)
  // return []`), so ~30% of Pinnacle editions could never appear on the sniper
  // board however they were priced, and the board looked honestly quiet.
  //
  // Paged by KEYSET on render_id, which is unique (2,600 of 2,600 verified live).
  // ⚠ The representative row per key is now chosen by an EXPLICIT comparison
  // rather than by first-wins over a global sort. That is not a refactor for its
  // own sake: the old `ORDER BY fmv_sales_count_30d DESC, fmv_usd DESC` has no
  // unique tiebreak, so which render represented a key could differ between two
  // identical requests — and under paging, first-wins over a page order that is
  // not the ranking order is simply wrong.
  const best = new Map<string, FmvRow>()
  const PAGE = 1000
  const MAX_PAGES = 100
  let cursor = ""
  for (let page = 0; page < MAX_PAGES; page++) {
    let q = (supabaseAdmin as any)
      .from("pinnacle_catalog")
      .select("render_id, legacy_edition_key, fmv_usd, fmv_confidence, fmv_sales_count_30d")
      .not("fmv_usd", "is", null)
      .order("render_id", { ascending: true })
      .limit(PAGE)
    if (cursor) q = q.gt("render_id", cursor)
    const { data, error } = await q

    if (error || !data) {
      // ⚠ A partial map DROPS LISTINGS, so this is not a cosmetic degradation.
      // Reported with the page index and the rows kept so a truncated map is
      // distinguishable in the logs from a genuinely small catalog.
      console.warn(
        `[pinnacle-sniper] FMV fetch error @page ${page} (kept ${best.size} keys):`,
        error?.message,
      )
      break
    }
    const rows = data as FmvRow[]
    for (const row of rows) {
      const key = row.legacy_edition_key
      if (!key) continue
      const prev = best.get(key)
      if (!prev || moreRepresentative(row, prev)) best.set(key, row)
    }
    if (rows.length < PAGE) break
    const next = rows[rows.length - 1]?.render_id
    // No cursor means no progress — stop rather than re-read page 0 forever.
    if (!next || next === cursor) break
    cursor = next
  }

  const map = new Map<string, { fmv: number; confidence: string }>()
  for (const [key, row] of best) {
    map.set(key, { fmv: row.fmv_usd, confidence: row.fmv_confidence })
  }
  return map
}

/**
 * Which of two catalog renders represents its legacy edition key: most liquid
 * first, then highest FMV, then the lowest render_id so the answer is stable
 * across requests. The old code expressed the first two as a global ORDER BY
 * plus first-wins, which needs the read to be complete AND totally ordered —
 * neither held.
 */
function moreRepresentative(candidate: FmvRow, incumbent: FmvRow): boolean {
  const cSales = candidate.fmv_sales_count_30d ?? -1
  const iSales = incumbent.fmv_sales_count_30d ?? -1
  if (cSales !== iSales) return cSales > iSales
  if (candidate.fmv_usd !== incumbent.fmv_usd) return candidate.fmv_usd > incumbent.fmv_usd
  return candidate.render_id < incumbent.render_id
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
    aspUsd: null,
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
