// lib/sniper/ufc-aptos.ts
//
// The UFC Strike sniper (2026-11-26, Trevor: "specific listings in sniper … a Flow or Aptos tag"). UFC
// trades on Aptos (Rarible) since its Flow market closed 2026-05-13, so the board is every LIVE single-
// Moment Rarible ask in RPC's index (ufc_aptos_listings, fed by scripts/ufc-aptos-listings.mjs, which
// re-checks each listing's owner every run), priced against RPC FMV and tagged Aptos.
//
// ⚠ NOT A "BELOW FMV" BOARD BY CONSTRUCTION. UFC FMV is capped at the live Aptos ask (migration
// 20261126174033), so a floor listing sits AT FMV and nothing is below it — measured 2026-11-26 PT:
// 465 live singles, 0 below FMV, 351 at it. Every ask is listed with its signed discount (negative =
// above FMV); the header copy says "asks", not "deals" (lib/sniper/header-copy.ts).
//
// Freshness: a listing not re-checked in 3 days is not shown (the lane runs every few hours; an older
// row may have sold). A failed read THROWS — the route turns that into a degraded board, never "none".

import { supabaseAdmin } from "@/lib/supabase"
import { raribleAptosCollectionUrl } from "@/lib/ufc-aptos"
import { textIncludes } from "@/lib/filter-match"

const FRESH_MS = 3 * 86_400_000

export interface UfcAptosSniperOpts {
  minDiscount?: number
  rarity?: string
  maxPrice?: number
  player?: string
  sortBy?: string
}

type Row = Record<string, unknown>
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

export async function computeUfcAptosSniperFeed(opts: UfcAptosSniperOpts = {}) {
  const db = supabaseAdmin
  const since = new Date(Date.now() - FRESH_MS).toISOString()
  const [lr, ar] = await Promise.all([
    db.from("ufc_aptos_listings")
      .select("listing_address, token_data_id, aptos_collection_id, edition_id, serial_number, marketplace, price_apt, seller, listed_at, last_checked_at")
      .eq("kind", "single")
      .gt("price_apt", 0)
      .not("edition_id", "is", null)
      .gte("last_checked_at", since)
      .order("listing_address", { ascending: true })
      .order("token_data_id", { ascending: true })
      .limit(1000),
    db.from("apt_usd_daily").select("day, usd").order("day", { ascending: false }).limit(1),
  ])
  if (lr.error) throw new Error("ufc_aptos_listings: " + lr.error.message)
  if (ar.error) throw new Error("apt_usd_daily: " + ar.error.message)
  const listings = (lr.data ?? []) as Row[]
  // A page at the cap is a partial book — never published as the whole board.
  if (listings.length >= 1000) throw new Error("ufc_aptos_listings: read hit the 1,000-row cap")
  const aptUsd = num(((ar.data ?? []) as Row[])[0]?.usd)
  if (aptUsd == null || aptUsd <= 0) throw new Error("apt_usd_daily: no APT/USD rate")

  const editionIds = [...new Set(listings.map((l) => String(l.edition_id)))]
  const editions = new Map<string, Row>()
  const fmv = new Map<string, Row>()
  for (let i = 0; i < editionIds.length; i += 200) {
    const slice = editionIds.slice(i, i + 200)
    const [er, fr] = await Promise.all([
      db.from("editions").select("id, external_id, player_name, team_name, set_name, tier, circulation_count, thumbnail_url").in("id", slice),
      db.from("edition_fmv_current").select("edition_id, fmv_usd, confidence").in("edition_id", slice),
    ])
    if (er.error) throw new Error("editions: " + er.error.message)
    if (fr.error) throw new Error("edition_fmv_current: " + fr.error.message)
    for (const e of (er.data ?? []) as Row[]) editions.set(String(e.id), e)
    for (const f of (fr.data ?? []) as Row[]) fmv.set(String(f.edition_id), f)
  }

  let deals = listings.flatMap((l) => {
    const e = editions.get(String(l.edition_id))
    const f = fmv.get(String(l.edition_id))
    const priceApt = num(l.price_apt)
    const fmvUsd = num(f?.fmv_usd)
    if (!e || priceApt == null || fmvUsd == null || fmvUsd <= 0) return []
    const ask = Math.round(priceApt * aptUsd * 100) / 100
    const discount = Math.round(((fmvUsd - ask) / fmvUsd) * 1000) / 10
    const serial = num(l.serial_number) ?? 0
    const listedAt = typeof l.listed_at === "string" ? l.listed_at : typeof l.last_checked_at === "string" ? l.last_checked_at : null
    return [{
      flowId: String(l.token_data_id),
      momentId: String(l.token_data_id),
      editionKey: e.external_id == null ? "" : String(e.external_id),
      intEditionKey: null,
      playerName: String(e.player_name ?? "UFC Strike Moment"),
      teamName: String(e.team_name ?? ""),
      setName: String(e.set_name ?? ""),
      seriesName: "",
      tier: String(e.tier ?? ""),
      parallel: "",
      parallelId: 0,
      serial,
      circulationCount: num(e.circulation_count) ?? 0,
      askPrice: ask,
      askApt: priceApt,
      baseFmv: fmvUsd,
      adjustedFmv: fmvUsd,
      aspUsd: null,
      daysSinceSale: null,
      salesCount30d: null,
      discount,
      confidence: String(f?.confidence ?? "").toLowerCase(),
      confidenceSource: "rpc_fmv",
      hasBadge: false,
      badgeSlugs: [] as string[],
      badgeLabels: [] as string[],
      badgePremiumPct: 0,
      serialMult: 1,
      isSpecialSerial: false,
      isJersey: false,
      serialSignal: null,
      thumbnailUrl: typeof e.thumbnail_url === "string" ? e.thumbnail_url : null,
      isLocked: false,
      updatedAt: listedAt,
      packListingId: null,
      packName: null,
      packEv: null,
      packEvRatio: null,
      buyUrl: raribleAptosCollectionUrl(typeof l.aptos_collection_id === "string" ? l.aptos_collection_id : null) ?? "",
      listingResourceID: String(l.listing_address),
      listingOrderID: null,
      storefrontAddress: typeof l.seller === "string" ? l.seller : null,
      source: "ufc_aptos" as const,
      paymentToken: "APT" as const,
      chain: "aptos" as const,
      venue: "Rarible",
      offerAmount: null,
      offerFmvPct: null,
      dealRating: discount,
      isLowestAsk: false,
    }]
  })

  const { minDiscount = 0, rarity = "all", maxPrice = 0, player = "", sortBy = "listed_desc" } = opts
  if (minDiscount > 0) deals = deals.filter((d) => d.discount >= minDiscount)
  if (maxPrice > 0) deals = deals.filter((d) => d.askPrice <= maxPrice)
  if (rarity && rarity !== "all") deals = deals.filter((d) => d.tier.toLowerCase() === rarity.toLowerCase())
  if (player.trim()) {
    const q = player.trim().toLowerCase()
    deals = deals.filter((d) => textIncludes(d.playerName, q) || textIncludes(d.setName, q))
  }
  const lowest = new Map<string, number>()
  for (const d of deals) lowest.set(d.editionKey, Math.min(lowest.get(d.editionKey) ?? Infinity, d.askPrice))
  for (const d of deals) d.isLowestAsk = lowest.get(d.editionKey) === d.askPrice
  const ts = (d: { updatedAt: string | null }) => (d.updatedAt ? Date.parse(d.updatedAt) : 0)
  switch (sortBy) {
    case "price_asc": deals.sort((a, b) => a.askPrice - b.askPrice); break
    case "price_desc": deals.sort((a, b) => b.askPrice - a.askPrice); break
    case "fmv_desc": deals.sort((a, b) => b.adjustedFmv - a.adjustedFmv); break
    case "serial_asc": deals.sort((a, b) => a.serial - b.serial); break
    case "discount": deals.sort((a, b) => b.discount - a.discount); break
    case "listed_desc":
    default: deals.sort((a, b) => ts(b) - ts(a)); break
  }
  const newest = listings.reduce<string | null>((m, l) => {
    const c = typeof l.last_checked_at === "string" ? l.last_checked_at : null
    return c && (!m || c > m) ? c : m
  }, null)
  return { count: deals.length, tsCount: 0, flowtyCount: 0, lastRefreshed: newest ?? new Date().toISOString(), deals, sourcesFailed: [] as string[] }
}
