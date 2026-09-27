// lib/sniper/pinnacle.ts
//
// Shared Pinnacle sniper compute — extracted from /api/pinnacle-sniper so
// that /api/sniper-feed can dispatch `collection=disney-pinnacle` through
// the same code path as the dedicated route. Returns deals shaped to match
// the unified SniperDeal contract used by the other compute functions in
// /api/sniper-feed/route.ts.

import { supabaseAdmin } from "@/lib/supabase"
import { pinnacleRenderImageUrl } from "@/lib/pinnacle/pinnacleFlowty"
import {
  PINNACLE_MARKETPLACE_URL,
  pinnacleSerialMultiplier,
  isPinnacleSpecialSerial,
  type PinnacleSniperDeal,
} from "@/lib/pinnacle/pinnacleTypes"
import { isSerialisedEditionType } from "@/lib/pinnacle/serialisation"

/** Oldest live-listing sweep the Sniper will publish. The sweep runs 5×/day
 *  (vercel.json: 45 1,7,13,19 UTC + the 21:37 daily), so > 13 h means at least
 *  two consecutive sweeps failed — the board says so rather than show old asks. */
export const PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS = 13

/** Rows the Sniper reads per request (best base discount first). */
const LIVE_READ_LIMIT = 2000

interface LiveListingRow {
  nft_id: string
  render_id: string
  serial_number: number | null
  price_usd: number | string
  seen_at: string
  character_name: string | null
  set_name: string | null
  series_name: string | null
  variant: string | null
  total_minted: number | null
  edition_type: string | null
  is_chaser: boolean | null
  legacy_edition_key: string | null
  franchises: string[] | null
  fmv_usd: number | string
  fmv_confidence: string | null
}

/**
 * The live Pinnacle listings, as deals.
 *
 * ⚠ 2026-09-27 — THIS USED TO READ FLOWTY, whose marketplace shut down
 * 2026-05-13: the board was built from 96 Flowty NFTs whose newest listing was
 * 2026-08-21 and showed 2 deals (the same pin twice). It now reads
 * `pinnacle_live_listings` — every listing Disney's own Studio GraphQL returned
 * on the catalog sweep's last COMPLETE pass — through
 * `get_pinnacle_live_listings_for_sniper`, already joined to each pin's render
 * (its own FMV, art, page) in pinnacle_catalog.
 *
 * Throws on a failed read AND on a live set older than
 * PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS (or never written): the sniper-feed
 * route turns a throw into a degraded response, so a dead sweep reads as a
 * failure rather than as "no deals right now".
 */
async function loadLiveDeals(nowMs: number): Promise<{ deals: PinnacleSniperDeal[]; listed: number; asOf: string }> {
  const db = supabaseAdmin as any
  const [newest, live] = await Promise.all([
    db.from("pinnacle_live_listings").select("seen_at", { count: "exact" }).order("seen_at", { ascending: false }).limit(1),
    db.rpc("get_pinnacle_live_listings_for_sniper", { p_limit: LIVE_READ_LIMIT }),
  ])
  if (newest?.error) throw new Error(`pinnacle_live_listings read failed: ${newest.error.message}`)
  if (live?.error) throw new Error(`get_pinnacle_live_listings_for_sniper failed: ${live.error.message}`)
  const asOf: string | null = newest?.data?.[0]?.seen_at ?? null
  if (!asOf) throw new Error("pinnacle_live_listings is empty — the listing sweep has not written a live set")
  const ageH = (nowMs - new Date(asOf).getTime()) / 3_600_000
  if (!(ageH <= PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS)) {
    throw new Error(`pinnacle live listings are ${ageH.toFixed(1)} h old (max ${PINNACLE_LIVE_LISTINGS_MAX_AGE_HOURS} h) — the listing sweep is not completing`)
  }

  const deals: PinnacleSniperDeal[] = []
  for (const r of (live?.data ?? []) as LiveListingRow[]) {
    const askPrice = Number(r.price_usd)
    const baseFmv = Number(r.fmv_usd)
    if (!(askPrice > 0) || !(baseFmv > 0)) continue
    const serial = r.serial_number != null && Number.isFinite(Number(r.serial_number)) ? Number(r.serial_number) : null
    const mintCount = r.total_minted != null ? Number(r.total_minted) : null
    const isSerialized = isSerialisedEditionType(r.edition_type) === true
    const serialMult = pinnacleSerialMultiplier(serial, mintCount, isSerialized)
    const adjustedFmv = baseFmv * serialMult
    const discount = Math.round(((adjustedFmv - askPrice) / adjustedFmv) * 1000) / 10
    // Same floor the Flowty mapper applied: only a meaningful discount is a deal.
    if (discount < 5) continue
    const { isSpecial, signal } = isPinnacleSpecialSerial(serial, mintCount)
    const setName = r.set_name ?? ""
    // pinnacle_catalog has no studio column; the set name is "<Studio> • <Set>".
    const studio = setName.includes(" • ") ? setName.slice(0, setName.indexOf(" • ")) : "Unknown"
    const seriesYear = parseInt(r.series_name ?? "", 10)
    deals.push({
      flowId: r.nft_id,
      nftId: r.nft_id,
      editionKey: r.legacy_edition_key ?? r.render_id,
      characterName: r.character_name ?? "Unknown",
      franchise: r.franchises?.[0] ?? "Unknown",
      studio,
      setName,
      seriesYear: Number.isFinite(seriesYear) ? seriesYear : null,
      variantType: (r.variant ?? "Standard") as PinnacleSniperDeal["variantType"],
      editionType: (isSerialized ? "Limited Edition" : "Open Edition"),
      serial,
      mintCount,
      askPrice,
      baseFmv,
      adjustedFmv,
      discount,
      confidence: r.fmv_confidence ?? "LOW",
      serialMult,
      isSpecialSerial: isSpecial,
      serialSignal: signal,
      thumbnailUrl: pinnacleRenderImageUrl(r.render_id, { thumb: true }),
      renderId: r.render_id,
      pinName: r.character_name ?? null,
      isChaser: r.is_chaser === true,
      isLocked: false,
      // When the sweep last SAW this listing live — not when it was listed; the
      // GraphQL sweep does not return a listing time.
      updatedAt: r.seen_at,
      buyUrl: PINNACLE_MARKETPLACE_URL,
      listingResourceID: null,
      listingOrderID: null,
      storefrontAddress: null,
      source: "pinnacle",
      offerAmount: null,
      offerFmvPct: null,
    })
  }
  return { deals, listed: Number(newest?.count ?? 0), asOf }
}

export interface PinnacleSniperOpts {
  /** UI alias for variant filter — accepts "tier" or "variant". */
  variantFilter?: string
  maxPrice?: number
  minDiscount?: number
  playerFilter?: string
  /** The page's studio tabs: "Disney" | "Pixar" | "Star Wars" (anything else = all). */
  franchiseFilter?: string
  chaserOnly?: boolean
  sortBy?: string
}

/**
 * Whether a deal belongs under one of the Sniper page's studio tabs. Matched on
 * the Studios trait AND the set-name prefix ("Pixar Animation Studios • …"),
 * because the trait is often absent where the set name still says it. A joint
 * "Walt Disney & Pixar" set belongs to both tabs; 20th Century is under neither.
 * An unknown tab value filters nothing rather than emptying the board.
 */
export function matchesPinnacleStudioTab(tab: string, studio: string | null | undefined, setName: string | null | undefined): boolean {
  const hay = `${studio ?? ""} ${setName ?? ""}`
  switch (tab.trim().toLowerCase()) {
    case "disney":
      return /disney/i.test(hay)
    case "pixar":
      return /pixar/i.test(hay)
    case "star wars":
      return /lucasfilm|star wars/i.test(hay)
    default:
      return true
  }
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
  const franchiseFilter = opts.franchiseFilter ?? "all"
  const chaserOnly = opts.chaserOnly === true
  const sortBy = opts.sortBy ?? "discount"

  const { deals: liveDeals, listed, asOf } = await loadLiveDeals(Date.now())
  let deals = liveDeals

  if (variantFilter !== "all") {
    deals = deals.filter((d) => d.variantType.toLowerCase() === variantFilter.toLowerCase())
  }
  if (maxPrice > 0) {
    deals = deals.filter((d) => d.askPrice <= maxPrice)
  }
  if (minDiscount > 0) {
    deals = deals.filter((d) => d.discount >= minDiscount)
  }
  // ⚠ Both of these were SENT by /disney-pinnacle/sniper (its studio tabs and
  // "Chasers only" box) and read by nothing until 2026-09-26, so the page showed
  // a filter as applied while listing every deal.
  if (franchiseFilter !== "all") {
    deals = deals.filter((d) => matchesPinnacleStudioTab(franchiseFilter, d.studio, d.setName))
  }
  if (chaserOnly) {
    deals = deals.filter((d) => d.isChaser === true)
  }
  if (playerFilter) {
    const q = playerFilter.toLowerCase()
    deals = deals.filter((d) =>
      d.characterName.toLowerCase().includes(q) ||
      (d.pinName ?? "").toLowerCase().includes(q) ||
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
    // The exact catalog render (null when unresolved). Consumers link the per-pin
    // page and art on this; `editionKey` stays the legacy key that owned-matching
    // (wallet_moments_cache.edition_key) uses.
    renderId: d.renderId ?? null,
    intEditionKey: null,
    // The pin's own name ("Just Keep Swimming"), as the catalog and the per-pin
    // page call it; the Characters trait ("Dory") is the fallback.
    playerName: d.pinName || d.characterName,
    teamName: d.franchise,
    studio: d.studio,
    isChaser: d.isChaser === true,
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
    // Kept for the response shape: now the number of live listings in the last
    // complete sweep (Flowty is no longer read).
    flowtyCount: listed,
    fmvCoverage: liveDeals.length,
    // When the live listing set was last swept, not when this request ran.
    lastRefreshed: asOf,
    deals: mappedDeals,
  }
}
